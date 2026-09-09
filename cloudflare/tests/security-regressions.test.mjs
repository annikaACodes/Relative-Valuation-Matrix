import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";

import worker from "../worker/index.js";
import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  createCsrfToken,
  createSessionToken,
  parseCookies
} from "../worker/auth.js";

const ACCESS_CODE = "qa-only-high-entropy-access-code";
const AUTH_ACCESS_CODE_HASH = createHash("sha256").update(ACCESS_CODE).digest("base64url");
const AUTH_SESSION_SECRET = randomBytes(32).toString("base64url");
const ORIGIN = "https://research.example";

function environment(overrides = {}) {
  const state = { assetFetches: [] };
  const env = {
    AUTH_ACCESS_CODE_HASH,
    AUTH_SESSION_SECRET,
    ASSETS: {
      async fetch(request) {
        state.assetFetches.push({ method: request.method, path: new URL(request.url).pathname });
        return new Response(`private-asset:${new URL(request.url).pathname}`, {
          headers: { "Content-Type": "text/plain" },
          status: 200
        });
      }
    },
    AUTH_RATE_LIMITER: {
      async limit() {
        return { success: true };
      }
    },
    ...overrides
  };
  return { env, state };
}

function makeRequest(path, init = {}) {
  return new Request(`${ORIGIN}${path}`, init);
}

function cookieValue(response, name) {
  return (response.headers.get("Set-Cookie") ?? "").match(new RegExp(`${name}=([^;,]*)`, "u"))?.[1] ?? "";
}

function assertSecurityHeaders(response) {
  assert.equal(response.headers.get("Cache-Control"), "private, no-store, max-age=0");
  assert.equal(response.headers.get("Pragma"), "no-cache");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  assert.match(response.headers.get("X-Robots-Tag") ?? "", /\bnoindex\b/u);
  assert.match(response.headers.get("Content-Security-Policy") ?? "", /frame-ancestors 'none'/u);
}

async function authenticatedCookie(host = "research.example") {
  const token = await createSessionToken({ host, encodedSecret: AUTH_SESSION_SECRET });
  return `${SESSION_COOKIE_NAME}=${token}`;
}

test("GET and HEAD never reach protected assets without a session", async () => {
  const protectedPaths = [
    "/",
    "/index.html",
    "/content.json",
    "/assets/app.js",
    "/assets/chart.js",
    "/companies/AAPL/",
    "/companies/AAPL/index.html",
    "/data/companies/AAPL.json",
    "/benchmarks/RLV-1000/",
    "/files/companies/AAPL/report.md",
    "/files/companies/AAPL/market-data.csv",
    "/files/benchmarks/RLV-1000/market-data.csv",
    "/not-found"
  ];
  const { env, state } = environment();

  for (const path of protectedPaths) {
    for (const method of ["GET", "HEAD"]) {
      const response = await worker.fetch(makeRequest(path, { method }), env);
      assert.equal(response.status, 303, `${method} ${path}`);
      assert.match(response.headers.get("Location") ?? "", /^\/login\/\?next=/u, `${method} ${path}`);
      assert.equal(cookieValue(response, SESSION_COOKIE_NAME), "", `${method} ${path}`);
      assertSecurityHeaders(response);
    }
  }

  assert.deepEqual(state.assetFetches, []);
});

test("only the exact documented login assets and robots file are public", async () => {
  const { env, state } = environment();
  const publicPaths = [
    "/robots.txt",
    "/login",
    "/login/",
    "/login/index.html",
    "/login/login.css",
    "/login/login.js",
    "/login/favicon.svg"
  ];

  for (const path of publicPaths) {
    const response = await worker.fetch(makeRequest(path), env);
    assert.equal(response.status, 200, path);
    assert.ok(cookieValue(response, CSRF_COOKIE_NAME), path);
    assert.equal(cookieValue(response, SESSION_COOKIE_NAME), "", path);
    assertSecurityHeaders(response);
  }

  for (const path of [
    "/login/content.json",
    "/login/private.csv",
    "/login/login.js.map",
    "/login%2Flogin.js",
    "/login/%2e%2e/content.json",
    "/LOGIN/login.js"
  ]) {
    const response = await worker.fetch(makeRequest(path), env);
    assert.equal(response.status, 303, path);
  }

  assert.equal(state.assetFetches.length, publicPaths.length);
});

test("worker responses remove permissive static-asset CORS headers", async () => {
  const { env } = environment({
    ASSETS: {
      async fetch() {
        return new Response("public", {
          headers: {
            "Access-Control-Allow-Credentials": "true",
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Allow-Methods": "GET",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Expose-Headers": "*",
            "Access-Control-Max-Age": "86400"
          }
        });
      }
    }
  });
  const response = await worker.fetch(makeRequest("/login/"), env);

  for (const name of [
    "Access-Control-Allow-Credentials",
    "Access-Control-Allow-Headers",
    "Access-Control-Allow-Methods",
    "Access-Control-Allow-Origin",
    "Access-Control-Expose-Headers",
    "Access-Control-Max-Age"
  ]) assert.equal(response.headers.has(name), false, `${name} must be removed`);
});

test("unsupported methods cannot fetch assets or mutate auth state", async () => {
  const { env, state } = environment();
  const session = await authenticatedCookie();

  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const response = await worker.fetch(makeRequest("/content.json", {
      headers: { Cookie: session },
      method
    }), env);
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("Allow"), "GET, HEAD", method);
    assertSecurityHeaders(response);
  }

  for (const path of ["/auth/login", "/auth/logout"]) {
    const response = await worker.fetch(makeRequest(path), env);
    assert.equal(response.status, 405, path);
    assert.equal(response.headers.get("Allow"), "POST", path);
  }

  assert.deepEqual(state.assetFetches, []);
});

test("duplicate, malformed, wrong-host, and tampered session cookies fail closed", async () => {
  const { env, state } = environment();
  const valid = await authenticatedCookie();
  const token = valid.slice(valid.indexOf("=") + 1);
  const modified = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
  const wrongHost = await authenticatedCookie("other.example");
  const cookieHeaders = [
    `${valid}; ${valid}`,
    `${SESSION_COOKIE_NAME}=not-a-token`,
    `${SESSION_COOKIE_NAME}=${modified}`,
    wrongHost,
    `${SESSION_COOKIE_NAME}=`,
    `${SESSION_COOKIE_NAME}=v1.${"A".repeat(3000)}.invalid`
  ];

  for (const Cookie of cookieHeaders) {
    const response = await worker.fetch(makeRequest("/content.json", { headers: { Cookie } }), env);
    assert.equal(response.status, 303);
  }
  assert.deepEqual(state.assetFetches, []);
});

test("invalid configuration and downstream failures never fall through to assets", async () => {
  for (const overrides of [
    { AUTH_ACCESS_CODE_HASH: undefined },
    { AUTH_SESSION_SECRET: undefined },
    { AUTH_ACCESS_CODE_HASH: "invalid" },
    { AUTH_SESSION_SECRET: "invalid" },
    { ASSETS: undefined }
  ]) {
    const { env, state } = environment(overrides);
    const response = await worker.fetch(makeRequest("/login/"), env);
    assert.equal(response.status, 503);
    assert.deepEqual(state.assetFetches, []);
    assertSecurityHeaders(response);
  }

  const failingAssets = environment({
    ASSETS: {
      async fetch() {
        throw new Error("simulated asset failure");
      }
    }
  });
  const session = await authenticatedCookie();
  const response = await worker.fetch(makeRequest("/content.json", { headers: { Cookie: session } }), failingAssets.env);
  assert.equal(response.status, 503);
  assertSecurityHeaders(response);
});

test("a rate-limiter exception fails closed before code verification", async () => {
  const csrf = createCsrfToken();
  const { env, state } = environment({
    AUTH_RATE_LIMITER: {
      async limit() {
        throw new Error("simulated limiter outage");
      }
    }
  });
  const response = await worker.fetch(makeRequest("/auth/login", {
    body: JSON.stringify({ code: ACCESS_CODE, next: "/" }),
    headers: {
      "Content-Type": "application/json",
      Cookie: `${CSRF_COOKIE_NAME}=${csrf}`,
      Origin: ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      "X-CSRF-Token": csrf
    },
    method: "POST"
  }), env);
  assert.equal(response.status, 503);
  assert.deepEqual(state.assetFetches, []);
  assert.equal(cookieValue(response, SESSION_COOKIE_NAME), "");
});

test("CSRF validation rejects duplicate cookies and cross-site fetch metadata", async () => {
  const csrf = createCsrfToken();
  const { env } = environment();
  const cases = [
    {
      Cookie: `${CSRF_COOKIE_NAME}=${csrf}; ${CSRF_COOKIE_NAME}=${csrf}`,
      Origin: ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      "X-CSRF-Token": csrf
    },
    {
      Cookie: `${CSRF_COOKIE_NAME}=${csrf}`,
      Origin: ORIGIN,
      "Sec-Fetch-Site": "cross-site",
      "X-CSRF-Token": csrf
    },
    {
      Cookie: `${CSRF_COOKIE_NAME}=${csrf}`,
      Origin: ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      "X-CSRF-Token": `${csrf.slice(0, -1)}A`
    }
  ];

  for (const headers of cases) {
    const response = await worker.fetch(makeRequest("/auth/login", {
      body: JSON.stringify({ code: ACCESS_CODE }),
      headers: { "Content-Type": "application/json", ...headers },
      method: "POST"
    }), env);
    assert.equal(response.status, 403);
    assert.equal(cookieValue(response, SESSION_COOKIE_NAME), "");
  }
});

test("oversized and non-JSON login bodies are rejected without a session", async () => {
  const csrf = createCsrfToken();
  const common = {
    Cookie: `${CSRF_COOKIE_NAME}=${csrf}`,
    Origin: ORIGIN,
    "Sec-Fetch-Site": "same-origin",
    "X-CSRF-Token": csrf
  };
  const { env } = environment();
  const cases = [
    { body: ACCESS_CODE, contentType: "text/plain" },
    { body: "{", contentType: "application/json" },
    { body: JSON.stringify({ code: "x".repeat(2049) }), contentType: "application/json" }
  ];
  for (const entry of cases) {
    const response = await worker.fetch(makeRequest("/auth/login", {
      body: entry.body,
      headers: { ...common, "Content-Type": entry.contentType },
      method: "POST"
    }), env);
    assert.equal(response.status, 401);
    assert.equal(cookieValue(response, SESSION_COOKIE_NAME), "");
  }
});

test("authenticated logout requires CSRF and clears both cookies", async () => {
  const session = await authenticatedCookie();
  const csrf = createCsrfToken();
  const { env } = environment();

  const missingCsrf = await worker.fetch(makeRequest("/auth/logout", {
    body: "{}",
    headers: { Cookie: session, Origin: ORIGIN },
    method: "POST"
  }), env);
  assert.equal(missingCsrf.status, 403);

  const logout = await worker.fetch(makeRequest("/auth/logout", {
    body: "{}",
    headers: {
      Cookie: `${session}; ${CSRF_COOKIE_NAME}=${csrf}`,
      Origin: ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      "X-CSRF-Token": csrf
    },
    method: "POST"
  }), env);
  assert.equal(logout.status, 200);
  const cookies = logout.headers.get("Set-Cookie") ?? "";
  assert.match(cookies, new RegExp(`${SESSION_COOKIE_NAME}=;[^,]*Max-Age=0`, "u"));
  assert.match(cookies, new RegExp(`${CSRF_COOKIE_NAME}=;[^,]*Max-Age=0`, "u"));
  assertSecurityHeaders(logout);
});

test("cookie parsing rejects ambiguity instead of selecting an attacker-controlled duplicate", () => {
  const parsed = parseCookies("a=1; session=first; malformed; session=second; b=2=3");
  assert.equal(parsed.cookies.get("a"), "1");
  assert.equal(parsed.cookies.get("b"), "2=3");
  assert.equal(parsed.cookies.get("session"), "second");
  assert.equal(parsed.duplicates.has("session"), true);
});

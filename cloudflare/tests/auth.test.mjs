import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";

import worker from "../worker/index.js";
import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  clearSessionCookie,
  constantTimeEqual,
  createCsrfCookie,
  createCsrfToken,
  createSessionCookie,
  createSessionToken,
  hasValidAuthEnvironment,
  safeRedirectPath,
  verifyAccessCode,
  verifySessionToken
} from "../worker/auth.js";

const ACCESS_CODE = "test-only-access-code-with-128-bits";
const AUTH_ACCESS_CODE_HASH = createHash("sha256").update(ACCESS_CODE).digest("base64url");
const AUTH_SESSION_SECRET = randomBytes(32).toString("base64url");

function mockEnvironment(overrides = {}) {
  const state = { assetFetches: 0 };
  const env = {
    AUTH_ACCESS_CODE_HASH,
    AUTH_SESSION_SECRET,
    ASSETS: {
      async fetch(request) {
        state.assetFetches += 1;
        return new Response(`asset:${new URL(request.url).pathname}`, {
          headers: { "Content-Type": "text/plain" }
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

function request(path, init = {}) {
  return new Request(`https://research.example${path}`, init);
}

function extractCookie(setCookieHeader, name) {
  return setCookieHeader.match(new RegExp(`${name}=([^;,]+)`, "u"))?.[1] ?? "";
}

test("access codes are compared using fixed-length hashes", async () => {
  assert.equal(await verifyAccessCode(ACCESS_CODE, AUTH_ACCESS_CODE_HASH), true);
  assert.equal(await verifyAccessCode(`${ACCESS_CODE}x`, AUTH_ACCESS_CODE_HASH), false);
  assert.equal(await verifyAccessCode(ACCESS_CODE, "invalid"), false);
  assert.equal(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])), true);
  assert.equal(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3])), false);
});

test("sessions are signed, host-bound, expiring, and tamper evident", async () => {
  const now = Date.UTC(2026, 8, 8);
  const token = await createSessionToken({
    host: "research.example",
    encodedSecret: AUTH_SESSION_SECRET,
    now
  });

  assert.equal(await verifySessionToken(token, {
    host: "research.example",
    encodedSecret: AUTH_SESSION_SECRET,
    now: now + 1_000
  }), true);
  assert.equal(await verifySessionToken(token, {
    host: "preview.example",
    encodedSecret: AUTH_SESSION_SECRET,
    now: now + 1_000
  }), false);
  assert.equal(await verifySessionToken(token, {
    host: "research.example",
    encodedSecret: AUTH_SESSION_SECRET,
    now: now + (SESSION_TTL_SECONDS + 1) * 1_000
  }), false);

  const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
  assert.equal(await verifySessionToken(tampered, {
    host: "research.example",
    encodedSecret: AUTH_SESSION_SECRET,
    now: now + 1_000
  }), false);
});

test("session cookies use a host-only prefix and hardened attributes", async () => {
  const token = await createSessionToken({
    host: "research.example",
    encodedSecret: AUTH_SESSION_SECRET
  });
  const cookie = createSessionCookie(token);
  assert.match(cookie, new RegExp(`^${SESSION_COOKIE_NAME}=`));
  assert.match(cookie, /; Path=\//u);
  assert.match(cookie, /; Max-Age=31536000/u);
  assert.match(cookie, /; HttpOnly/u);
  assert.match(cookie, /; Secure/u);
  assert.match(cookie, /; SameSite=Strict/u);
  assert.doesNotMatch(cookie, /; Domain=/u);
  assert.match(clearSessionCookie(), /Max-Age=0/u);
});

test("configuration validation and redirect validation fail closed", () => {
  assert.equal(hasValidAuthEnvironment({ AUTH_ACCESS_CODE_HASH, AUTH_SESSION_SECRET }), true);
  assert.equal(hasValidAuthEnvironment({ AUTH_ACCESS_CODE_HASH }), false);
  assert.equal(hasValidAuthEnvironment({ AUTH_ACCESS_CODE_HASH: "bad", AUTH_SESSION_SECRET }), false);
  assert.equal(safeRedirectPath("/companies/AAPL/?view=chart"), "/companies/AAPL/?view=chart");
  assert.equal(safeRedirectPath("https://attacker.example/"), "/");
  assert.equal(safeRedirectPath("//attacker.example/"), "/");
  assert.equal(safeRedirectPath("/login/?next=/content.json"), "/");
  assert.equal(safeRedirectPath("/auth/logout"), "/");
});

test("missing secrets prevent even public assets from being served", async () => {
  const { env, state } = mockEnvironment({ AUTH_SESSION_SECRET: undefined });
  const response = await worker.fetch(request("/login/"), env);
  assert.equal(response.status, 503);
  assert.equal(state.assetFetches, 0);
});

test("only exact login files and robots.txt are public", async () => {
  const { env, state } = mockEnvironment();
  const login = await worker.fetch(request("/login/"), env);
  assert.equal(login.status, 200);
  assert.match(login.headers.get("Set-Cookie") ?? "", new RegExp(`${CSRF_COOKIE_NAME}=`));

  const robots = await worker.fetch(request("/robots.txt"), env);
  assert.equal(robots.status, 200);

  const protectedAsset = await worker.fetch(request("/assets/app.js"), env);
  assert.equal(protectedAsset.status, 303);
  assert.match(protectedAsset.headers.get("Location") ?? "", /^\/login\/\?next=/u);

  const normalizedTraversal = await worker.fetch(request("/login/%2e%2e/content.json"), env);
  assert.equal(normalizedTraversal.status, 303);
  assert.equal(state.assetFetches, 2);
});

test("a valid login unlocks every direct asset request", async () => {
  const { env, state } = mockEnvironment();
  const csrfToken = createCsrfToken();
  const loginResponse = await worker.fetch(request("/auth/login", {
    method: "POST",
    headers: {
      "CF-Connecting-IP": "192.0.2.10",
      "Content-Type": "application/json",
      "Cookie": `${CSRF_COOKIE_NAME}=${csrfToken}`,
      "Origin": "https://research.example",
      "Sec-Fetch-Site": "same-origin",
      "X-CSRF-Token": csrfToken
    },
    body: JSON.stringify({ code: ACCESS_CODE, next: "/companies/AAPL/report.md" })
  }), env);

  assert.equal(loginResponse.status, 200);
  const setCookie = loginResponse.headers.get("Set-Cookie") ?? "";
  const session = extractCookie(setCookie, SESSION_COOKIE_NAME);
  assert.ok(session);
  assert.match(setCookie, /HttpOnly/u);
  assert.match(setCookie, /SameSite=Strict/u);

  const reportResponse = await worker.fetch(request("/companies/AAPL/report.md", {
    headers: { "Cookie": `${SESSION_COOKIE_NAME}=${session}` }
  }), env);
  assert.equal(reportResponse.status, 200);
  assert.equal(await reportResponse.text(), "asset:/companies/AAPL/report.md");
  assert.equal(reportResponse.headers.get("Cache-Control"), "private, no-store, max-age=0");
  assert.equal(reportResponse.headers.get("X-Robots-Tag"), "noindex, nofollow, noarchive, nosnippet");
  assert.equal(state.assetFetches, 1);
});

test("login rejects cross-origin, missing-CSRF, incorrect, and rate-limited attempts", async () => {
  const csrfToken = createCsrfToken();
  const baseHeaders = {
    "Content-Type": "application/json",
    "Cookie": createCsrfCookie(csrfToken).split(";", 1)[0],
    "Origin": "https://research.example",
    "X-CSRF-Token": csrfToken
  };

  const { env } = mockEnvironment();
  const crossOrigin = await worker.fetch(request("/auth/login", {
    method: "POST",
    headers: { ...baseHeaders, "Origin": "https://attacker.example" },
    body: JSON.stringify({ code: ACCESS_CODE })
  }), env);
  assert.equal(crossOrigin.status, 403);

  const noCsrf = await worker.fetch(request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": "https://research.example" },
    body: JSON.stringify({ code: ACCESS_CODE })
  }), env);
  assert.equal(noCsrf.status, 403);

  const incorrect = await worker.fetch(request("/auth/login", {
    method: "POST",
    headers: baseHeaders,
    body: JSON.stringify({ code: "incorrect-code" })
  }), env);
  assert.equal(incorrect.status, 401);

  const { env: limitedEnv } = mockEnvironment({
    AUTH_RATE_LIMITER: { async limit() { return { success: false }; } }
  });
  const limited = await worker.fetch(request("/auth/login", {
    method: "POST",
    headers: baseHeaders,
    body: JSON.stringify({ code: ACCESS_CODE })
  }), limitedEnv);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("Retry-After"), "60");
});

test("the Pages-compatible fallback limiter allows login without a binding", async () => {
  const csrfToken = createCsrfToken();
  const { env } = mockEnvironment({ AUTH_RATE_LIMITER: undefined });
  const response = await worker.fetch(request("/auth/login", {
    method: "POST",
    headers: {
      "CF-Connecting-IP": "198.51.100.77",
      "Content-Type": "application/json",
      "Cookie": `${CSRF_COOKIE_NAME}=${csrfToken}`,
      "Origin": "https://research.example",
      "X-CSRF-Token": csrfToken
    },
    body: JSON.stringify({ code: ACCESS_CODE })
  }), env);
  assert.equal(response.status, 200);
});

test("logout requires an authenticated same-origin CSRF-protected POST", async () => {
  const { env } = mockEnvironment();
  const session = await createSessionToken({
    host: "research.example",
    encodedSecret: AUTH_SESSION_SECRET
  });
  const csrfToken = createCsrfToken();
  const cookies = `${SESSION_COOKIE_NAME}=${session}; ${CSRF_COOKIE_NAME}=${csrfToken}`;

  const getResponse = await worker.fetch(request("/auth/logout", {
    headers: { "Cookie": cookies }
  }), env);
  assert.equal(getResponse.status, 405);

  const crossOrigin = await worker.fetch(request("/auth/logout", {
    method: "POST",
    headers: {
      "Cookie": cookies,
      "Origin": "https://attacker.example",
      "X-CSRF-Token": csrfToken
    }
  }), env);
  assert.equal(crossOrigin.status, 403);

  const success = await worker.fetch(request("/auth/logout", {
    method: "POST",
    headers: {
      "Cookie": cookies,
      "Origin": "https://research.example",
      "Sec-Fetch-Site": "same-origin",
      "X-CSRF-Token": csrfToken
    }
  }), env);
  assert.equal(success.status, 200);
  const setCookie = success.headers.get("Set-Cookie") ?? "";
  assert.match(setCookie, new RegExp(`${SESSION_COOKIE_NAME}=;[^,]*Max-Age=0`, "u"));
  assert.match(setCookie, new RegExp(`${CSRF_COOKIE_NAME}=;[^,]*Max-Age=0`, "u"));
});

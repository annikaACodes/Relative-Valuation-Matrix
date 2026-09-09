import {
  CSRF_COOKIE_NAME,
  MAX_LOGIN_BODY_BYTES,
  SESSION_COOKIE_NAME,
  clearCsrfCookie,
  clearSessionCookie,
  createCsrfCookie,
  createCsrfToken,
  createSessionCookie,
  createSessionToken,
  getCookie,
  hasValidAuthEnvironment,
  hasValidCsrf,
  isSameOriginRequest,
  isValidCsrfToken,
  safeRedirectPath,
  verifyAccessCode,
  verifySessionToken
} from "./auth.js";

const PUBLIC_LOGIN_PATHS = new Set([
  "/robots.txt",
  "/login",
  "/login/",
  "/login/index.html",
  "/login/login.css",
  "/login/login.js",
  "/login/favicon.svg"
]);

const FALLBACK_RATE_LIMIT = 5;
const FALLBACK_RATE_WINDOW_MS = 60_000;
const FALLBACK_RATE_MAX_KEYS = 1_024;
const fallbackRateBuckets = new Map();

const SECURITY_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; upgrade-insecure-requests",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Expires": "0",
  "Permissions-Policy": "accelerometer=(), autoplay=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
  "Pragma": "no-cache",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet"
};

function secured(response, additionalHeaders = {}) {
  const headers = new Headers(response.headers);
  for (const name of [
    "Access-Control-Allow-Credentials",
    "Access-Control-Allow-Headers",
    "Access-Control-Allow-Methods",
    "Access-Control-Allow-Origin",
    "Access-Control-Expose-Headers",
    "Access-Control-Max-Age"
  ]) headers.delete(name);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  for (const [name, value] of Object.entries(additionalHeaders)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function json(payload, status = 200, additionalHeaders = {}) {
  return secured(new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  }), additionalHeaders);
}

function unavailable() {
  return secured(new Response("Portal unavailable", {
    status: 503,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "300" }
  }));
}

function methodNotAllowed(methods) {
  return secured(new Response("Method not allowed", {
    status: 405,
    headers: { "Allow": methods.join(", "), "Content-Type": "text/plain; charset=utf-8" }
  }));
}

function unauthorized(request) {
  if (request.method === "GET" || request.method === "HEAD") {
    const url = new URL(request.url);
    const destination = safeRedirectPath(`${url.pathname}${url.search}`);
    return secured(new Response(null, {
      status: 303,
      headers: { "Location": `/login/?next=${encodeURIComponent(destination)}` }
    }));
  }
  return json({ error: "Authentication required" }, 401);
}

async function hasSession(request, env) {
  const token = getCookie(request, SESSION_COOKIE_NAME);
  if (!token) return false;
  const url = new URL(request.url);
  return verifySessionToken(token, {
    host: url.host,
    encodedSecret: env.AUTH_SESSION_SECRET
  });
}

async function serveLoginAsset(request, env) {
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(["GET", "HEAD"]);

  const existingToken = getCookie(request, CSRF_COOKIE_NAME);
  const csrfToken = isValidCsrfToken(existingToken) ? existingToken : createCsrfToken();
  const assetResponse = await env.ASSETS.fetch(request);
  return secured(assetResponse, { "Set-Cookie": createCsrfCookie(csrfToken) });
}

async function readLoginPayload(request) {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") return null;

  const announcedLength = Number.parseInt(request.headers.get("Content-Length") ?? "0", 10);
  if (Number.isFinite(announcedLength) && announcedLength > MAX_LOGIN_BODY_BYTES) return null;

  const body = await request.text();
  if (new TextEncoder().encode(body).length > MAX_LOGIN_BODY_BYTES) return null;

  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || typeof parsed.code !== "string" || parsed.code.length > 1_024) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function fallbackRateLimit(key, now = Date.now()) {
  for (const [storedKey, bucket] of fallbackRateBuckets) {
    if (bucket.resetAt <= now) fallbackRateBuckets.delete(storedKey);
  }

  const safeKey = fallbackRateBuckets.has(key) || fallbackRateBuckets.size < FALLBACK_RATE_MAX_KEYS
    ? key
    : "overflow";
  const current = fallbackRateBuckets.get(safeKey);
  const bucket = !current || current.resetAt <= now
    ? { count: 0, resetAt: now + FALLBACK_RATE_WINDOW_MS }
    : current;
  bucket.count += 1;
  fallbackRateBuckets.set(safeKey, bucket);
  return { success: bucket.count <= FALLBACK_RATE_LIMIT };
}

async function checkLoginRateLimit(request, env) {
  const clientAddress = (request.headers.get("CF-Connecting-IP") ?? "unknown").slice(0, 128);
  const key = `login:${clientAddress}`;
  if (!env.AUTH_RATE_LIMITER || typeof env.AUTH_RATE_LIMITER.limit !== "function") {
    return fallbackRateLimit(key);
  }

  return env.AUTH_RATE_LIMITER.limit({ key });
}

async function handleLogin(request, env) {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  if (!isSameOriginRequest(request) || !hasValidCsrf(request)) return json({ error: "Invalid request" }, 403);

  let rateLimitResult;
  try {
    rateLimitResult = await checkLoginRateLimit(request, env);
  } catch {
    return unavailable();
  }
  if (!rateLimitResult?.success) {
    return json({ error: "Too many attempts. Try again later." }, 429, { "Retry-After": "60" });
  }

  const payload = await readLoginPayload(request);
  const suppliedCode = payload?.code ?? "";
  const codeIsValid = await verifyAccessCode(suppliedCode, env.AUTH_ACCESS_CODE_HASH);
  if (!payload || !codeIsValid) return json({ error: "Invalid access code" }, 401);

  const url = new URL(request.url);
  const token = await createSessionToken({
    host: url.host,
    encodedSecret: env.AUTH_SESSION_SECRET
  });
  const csrfToken = createCsrfToken();
  return json({ ok: true, redirect: safeRedirectPath(payload.next) }, 200, {
    "Set-Cookie": [createSessionCookie(token), createCsrfCookie(csrfToken)]
  });
}

async function handleLogout(request, env) {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  if (!await hasSession(request, env)) return json({ error: "Authentication required" }, 401);
  if (!isSameOriginRequest(request) || !hasValidCsrf(request)) return json({ error: "Invalid request" }, 403);

  return json({ ok: true, redirect: "/login/" }, 200, {
    "Set-Cookie": [clearSessionCookie(), clearCsrfCookie()]
  });
}

async function handleRequest(request, env) {
  if (!hasValidAuthEnvironment(env) || !env.ASSETS || typeof env.ASSETS.fetch !== "function") {
    return unavailable();
  }

  const url = new URL(request.url);
  if (PUBLIC_LOGIN_PATHS.has(url.pathname)) return serveLoginAsset(request, env);
  if (url.pathname === "/auth/login") return handleLogin(request, env);
  if (url.pathname === "/auth/logout") return handleLogout(request, env);

  if (!await hasSession(request, env)) return unauthorized(request);
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(["GET", "HEAD"]);

  return secured(await env.ASSETS.fetch(request));
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch {
      return unavailable();
    }
  }
};

export { handleRequest, secured };

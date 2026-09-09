const encoder = new TextEncoder();

export const SESSION_COOKIE_NAME = "__Host-rvm_session";
export const CSRF_COOKIE_NAME = "__Host-rvm_csrf";
export const SESSION_TTL_SECONDS = 365 * 24 * 60 * 60;
export const MAX_LOGIN_BODY_BYTES = 2_048;

const SESSION_VERSION = "v1";
const SESSION_AUDIENCE = "relative-valuation-matrix";
const SHA256_BYTES = 32;

let cachedSecret = "";
let cachedHmacKey;

export function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function decodeBase64Url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const remainder = value.length % 4;
  if (remainder === 1) return null;

  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - remainder) % 4);
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return encodeBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

export function constantTimeEqual(left, right) {
  const leftBytes = left instanceof Uint8Array ? left : new Uint8Array();
  const rightBytes = right instanceof Uint8Array ? right : new Uint8Array();
  const length = Math.max(leftBytes.length, rightBytes.length, 1);
  let difference = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return difference === 0;
}

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

function decodeExpectedHash(value) {
  const decoded = decodeBase64Url(value);
  return decoded?.length === SHA256_BYTES ? decoded : null;
}

function decodeSessionSecret(value) {
  const decoded = decodeBase64Url(value);
  return decoded && decoded.length >= SHA256_BYTES ? decoded : null;
}

export function hasValidAuthEnvironment(env) {
  return Boolean(
    env
    && decodeExpectedHash(env.AUTH_ACCESS_CODE_HASH)
    && decodeSessionSecret(env.AUTH_SESSION_SECRET)
  );
}

export async function verifyAccessCode(candidate, expectedHash) {
  const candidateHash = await sha256(typeof candidate === "string" ? candidate : "");
  const configuredHash = decodeExpectedHash(expectedHash) ?? new Uint8Array(SHA256_BYTES);
  return constantTimeEqual(candidateHash, configuredHash) && Boolean(decodeExpectedHash(expectedHash));
}

async function getHmacKey(encodedSecret) {
  if (cachedHmacKey && cachedSecret === encodedSecret) return cachedHmacKey;

  const secret = decodeSessionSecret(encodedSecret);
  if (!secret) throw new Error("Invalid session secret");

  cachedHmacKey = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
  cachedSecret = encodedSecret;
  return cachedHmacKey;
}

async function hmac(message, encodedSecret) {
  const key = await getHmacKey(encodedSecret);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

export async function createSessionToken({ host, encodedSecret, now = Date.now() }) {
  if (!host || !decodeSessionSecret(encodedSecret)) throw new Error("Invalid session configuration");

  const issuedAt = Math.floor(now / 1_000);
  const payload = encodeBase64Url(encoder.encode(JSON.stringify({
    a: SESSION_AUDIENCE,
    e: issuedAt + SESSION_TTL_SECONDS,
    h: host,
    i: issuedAt,
    v: 1
  })));
  const signedValue = `${SESSION_VERSION}.${payload}`;
  const signature = encodeBase64Url(await hmac(signedValue, encodedSecret));
  return `${signedValue}.${signature}`;
}

export async function verifySessionToken(token, { host, encodedSecret, now = Date.now() }) {
  if (typeof token !== "string" || token.length > 2_048 || !decodeSessionSecret(encodedSecret)) return false;

  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== SESSION_VERSION) return false;

  const signedValue = `${parts[0]}.${parts[1]}`;
  const expectedSignature = await hmac(signedValue, encodedSecret);
  const suppliedSignature = decodeBase64Url(parts[2]) ?? new Uint8Array(SHA256_BYTES);
  if (!constantTimeEqual(expectedSignature, suppliedSignature)) return false;

  const payloadBytes = decodeBase64Url(parts[1]);
  if (!payloadBytes) return false;

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return false;
  }

  const currentTime = Math.floor(now / 1_000);
  return payload?.v === 1
    && payload.a === SESSION_AUDIENCE
    && payload.h === host
    && Number.isInteger(payload.i)
    && Number.isInteger(payload.e)
    && payload.i <= currentTime + 60
    && payload.e > currentTime
    && payload.e > payload.i
    && payload.e - payload.i === SESSION_TTL_SECONDS;
}

export function parseCookies(header) {
  const cookies = new Map();
  const duplicates = new Set();

  for (const field of (header ?? "").split(";")) {
    const separator = field.indexOf("=");
    if (separator < 1) continue;
    const name = field.slice(0, separator).trim();
    const value = field.slice(separator + 1).trim();
    if (cookies.has(name)) duplicates.add(name);
    cookies.set(name, value);
  }

  return { cookies, duplicates };
}

export function getCookie(request, name) {
  const { cookies, duplicates } = parseCookies(request.headers.get("Cookie"));
  return duplicates.has(name) ? null : cookies.get(name) ?? null;
}

export function createSessionCookie(token, now = Date.now()) {
  const expires = new Date(now + SESSION_TTL_SECONDS * 1_000).toUTCString();
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; Expires=${expires}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Strict`;
}

export function createCsrfToken() {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(SHA256_BYTES)));
}

export function isValidCsrfToken(token) {
  return decodeBase64Url(token)?.length === SHA256_BYTES;
}

export function createCsrfCookie(token) {
  return `${CSRF_COOKIE_NAME}=${token}; Path=/; Max-Age=86400; Secure; SameSite=Strict`;
}

export function clearCsrfCookie() {
  return `${CSRF_COOKIE_NAME}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=Strict`;
}

export function hasValidCsrf(request) {
  const cookieToken = getCookie(request, CSRF_COOKIE_NAME);
  const headerToken = request.headers.get("X-CSRF-Token");
  const cookieBytes = decodeBase64Url(cookieToken) ?? new Uint8Array(SHA256_BYTES);
  const headerBytes = decodeBase64Url(headerToken) ?? new Uint8Array(SHA256_BYTES);
  return isValidCsrfToken(cookieToken)
    && isValidCsrfToken(headerToken)
    && constantTimeEqual(cookieBytes, headerBytes);
}

export function isSameOriginRequest(request) {
  const url = new URL(request.url);
  const expectedOrigin = url.origin;
  const suppliedOrigin = request.headers.get("Origin");
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  return suppliedOrigin === expectedOrigin && (!fetchSite || fetchSite === "same-origin");
}

export function safeRedirectPath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return "/";
  }

  try {
    const parsed = new URL(value, "https://portal.invalid");
    if (parsed.origin !== "https://portal.invalid") return "/";
    if (parsed.pathname.startsWith("/auth/") || parsed.pathname === "/login" || parsed.pathname.startsWith("/login/")) {
      return "/";
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/";
  }
}

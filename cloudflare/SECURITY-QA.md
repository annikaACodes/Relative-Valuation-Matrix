# Cloudflare private deployment QA

## Authentication

- [ ] `AUTH_ACCESS_CODE_HASH` and `AUTH_SESSION_SECRET` are encrypted Cloudflare secrets, never plaintext variables or repository files.
- [ ] The access code is unique to this dashboard and has at least 192 bits of randomness.
- [ ] The session cookie is `__Host-rvm_session` with `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, no `Domain`, and a one-year maximum age.
- [ ] The CSRF cookie is `__Host-rvm_csrf` with `Secure`, `SameSite=Strict`, `Path=/`, and no `Domain`.
- [ ] Login and logout reject cross-origin requests and missing or mismatched CSRF tokens.
- [ ] Five failed login attempts per observed IP are allowed per minute; the sixth is rejected.

## Request coverage

- [ ] `_routes.json` includes `/*` and excludes nothing.
- [ ] Every request reaches the advanced-mode `_worker.js` before static assets.
- [ ] Only the exact login assets and `robots.txt` are public.
- [ ] Direct requests for CSV, JavaScript, CSS, documentation, and unknown paths redirect to login without a valid session.
- [ ] Missing or malformed secrets and runtime errors return `503` without serving an asset.

## Privacy headers

- [ ] Responses use private/no-store caching, `X-Robots-Tag`, a restrictive same-origin CSP, frame denial, no-referrer, and same-origin opener/resource policies.
- [ ] `robots.txt` disallows `/`.
- [ ] Cloudflare Pages runtime failure mode is set to fail closed.

## Artifact review

- [ ] `npm run check:cloudflare` passes before deployment.
- [ ] `cloudflare-dist` contains no SQLite database, workflows, tests, source scripts, private configuration, source maps, or credentials.
- [ ] Spreadsheet export loads the vendored ExcelJS copy from the same origin under the strict CSP.

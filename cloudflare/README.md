# Private Cloudflare deployment

The Cloudflare Pages build is a private, unlisted copy of the Relative Valuation Matrix. It uses the same shared-access-code model as the PortCo Thesis Research Repository.

## Pages build settings

- Production branch: `main`
- Build command: `npm run check:cloudflare`
- Build output directory: `cloudflare-dist`
- Root directory: repository root
- Runtime failure mode: fail closed

The build publishes only the dashboard, its two required CSV inputs, documentation, login assets, and the advanced-mode Pages Worker. It does not publish the SQLite database, update scripts, tests, workflows, or source forecast files.

## Required encrypted secrets

- `AUTH_ACCESS_CODE_HASH`: base64url SHA-256 digest of the shared access code
- `AUTH_SESSION_SECRET`: random base64url value of at least 32 bytes

Generate fresh values with `npm run generate-auth-secrets`. Never commit the access code or either secret.

## Security behavior

- Every route passes through `_worker.js`; only exact login assets and `robots.txt` are public.
- Sessions are HMAC-SHA-256 signed, bound to the deployment host, and expire after one year.
- The session cookie is host-only, `HttpOnly`, `Secure`, and `SameSite=Strict`.
- Login and logout require same-origin POST requests and double-submit CSRF validation.
- Login attempts are limited to five per minute per observed IP in the Worker fallback.
- Missing or malformed secrets, unavailable assets, and Worker errors fail closed with `503`.
- Responses are private/no-store, non-indexable, frame-denied, and protected by a same-origin CSP.
- `robots.txt` disallows the entire site.

This makes the Cloudflare URL access-controlled and deliberately unlisted. It does not change the visibility of the GitHub repository or the existing GitHub Pages deployment.

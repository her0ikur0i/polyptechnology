# Owner authentication and public cutover

Status: live, 2026-08-14.

## What changed

The public owner URL `https://dash.surachmancenter.com` now serves the
integrated control API/dashboard from `127.0.0.1:4180` through the Cloudflare
tunnel. Instead of depending on Cloudflare Access (which needs a Cloudflare API
token this deployment does not hold), the app carries its own owner login.

The legacy `polyptech-dashboard.service` (origin `127.0.0.1:4173`, a deleted
codebase that had been failing to start) was disabled and stopped.

## How authentication works

`ACCESS_AUTH_MODE=password` (see `src/config.ts`, `src/control-api/auth.ts`,
`src/control-api/session.ts`):

1. An unauthenticated visitor is redirected to `/login`.
2. `POST /api/v1/auth/login` verifies the owner password with scrypt
   (memory-hard) and is rate-limited to 10 requests/minute to blunt brute force.
3. A successful login issues a stateless, HMAC-signed session cookie
   (`polyp_session`): `HttpOnly; SameSite=Strict; Secure`, 12-hour expiry. The
   token is signed so the server keeps no session table and a restart does not
   log the owner out.
4. `identifyOwner()` checks that cookie on every request; every API route and
   the SPA fallback are gated behind it.

The `Secure` attribute is set from `req.secure`, which is truthful only because
`TRUSTED_PROXY_HOPS=1` and `HOST=127.0.0.1` — only the local cloudflared
process can reach the server, so only it can set `X-Forwarded-Proto`.

## Owner password

The password lives in `/etc/polyp-ai-factory/control-api.env` as
`OWNER_PASSWORD` (plaintext in that root-only `0600` file, like the
`DATABASE_URL` credential it sits beside). To change it:

```sh
# edit OWNER_PASSWORD in /etc/polyp-ai-factory/control-api.env, then:
systemctl restart polyp-control-api.service
```

The hash is recomputed from the plaintext at startup; no other step is needed.
A password shorter than 8 characters is refused at boot.

## Cutover and rollback

- Tunnel ingress: `/etc/cloudflared/config.yml` now maps
  `dash.surachmancenter.com` to `http://127.0.0.1:4180`.
- Pre-cutover config backed up at
  `/etc/cloudflared/config.yml.bak-<timestamp>`; the env file is backed up at
  `/etc/polyp-ai-factory/control-api.env.bak-<timestamp>`.
- Deployments are immutable releases under `/opt/polyp-ai-factory/releases/`
  with `/opt/polyp-ai-factory/current` symlinked to the active one. Rolling back
  is a symlink swap plus a `systemctl restart polyp-control-api.service`.

## Known gaps (not blocking)

- No logout button in the dashboard UI yet — `/api/v1/auth/logout` exists and
  clearing the `polyp_session` cookie signs out.
- `NODE_ENV` stays `development` on this staging instance, so the cookie is
  `Secure` by `req.secure` rather than by a production-mode flag; promoting to
  `NODE_ENV=production` would also require Telegram credentials and a real
  `CSRF_SECRET`.

# CONTRACT-019 M2 Evidence — Authenticated Access Plan and Rollback Probe

## Status

M2 is complete as an access plan and rollback probe.

No DNS, Cloudflare Access, tunnel, service, or secret changes were made in this
milestone.

## Probe Time

- Date: 2026-08-13
- Local timezone: Asia/Jakarta
- Probe window: approximately 23:34-23:36 WIB

## Current Service State

Active dashboard/control service:

- Service: `polyp-control-api.service`
- Unit path: `/etc/systemd/system/polyp-control-api.service`
- Description: `Polyp AI Factory Control API and dashboard`
- State from `systemctl status`: active/running since 2026-08-13 22:23:59 WIB
- Main command: `/usr/bin/node --jitless dist/src/control-api/server.js`
- Working directory: `/opt/polyp-ai-factory/current`
- Ready log: `control-api.ready`, host `127.0.0.1`, port `4180`,
  `accessAuthMode=disabled`, `servingDashboard=true`
- Local probe: `http://127.0.0.1:4180/` returned HTTP 200 with dashboard HTML

Legacy dashboard service:

- Service: `polyptech-dashboard.service`
- Unit path: `/etc/systemd/system/polyptech-dashboard.service`
- Working directory: `/opt/master-orchestrator`
- Command: `/opt/master-orchestrator/node_modules/.bin/tsx src/dashboard/server.ts`
- State from `systemctl status`: failed/auto-restarting
- Failure reason observed: missing environment file
  `/opt/master-orchestrator/.env`
- Local probe: `http://127.0.0.1:4173/` failed with connection refused

Cloudflare tunnel:

- Service: `cloudflared.service`
- State from `systemctl status`: active/running since 2026-08-07 20:40:52 WIB
- Config path: `/etc/cloudflared/config.yml`
- Tunnel id in config/status: `3bb0986f-8ba2-48c7-b180-b49fad9d90c8`
- Current ingress:
  - hostname `dash.surachmancenter.com`
  - service `http://127.0.0.1:4173`
  - fallback `http_status:404`

External hostname probe:

- Command shape: `curl -fsS -D - https://dash.surachmancenter.com/`
- Result: Cloudflare HTTP 502
- `cloudflared.service` log confirms the reason:
  `dial tcp 127.0.0.1:4173: connect: connection refused`

## Finding

`dash.surachmancenter.com` is already pointed at the host through Cloudflare
Tunnel, but the tunnel origin is the broken legacy dashboard on
`127.0.0.1:4173`.

The current working dashboard is the integrated control API/dashboard on
`127.0.0.1:4180`, but its own ready log says `accessAuthMode=disabled`. That is
acceptable only because the service is bound to localhost and not directly
public. It must not be exposed through the hostname without an authenticated
edge in front of it.

## Access Plan

Target:

- Public owner URL: `https://dash.surachmancenter.com`
- Origin after cutover: `http://127.0.0.1:4180`
- Authentication layer: Cloudflare Access policy in front of the hostname
- App-level owner guard remains active for API routes through the existing
  `requireOwner`/CSRF behavior.

Cutover sequence:

1. Configure/verify a Cloudflare Access application for
   `dash.surachmancenter.com`.
2. Restrict Access to the owner-approved identity group or email allowlist.
3. Confirm unauthenticated requests receive an Access challenge, not dashboard
   HTML.
4. Back up `/etc/cloudflared/config.yml` before editing it.
5. Change only the `dash.surachmancenter.com` ingress service from
   `http://127.0.0.1:4173` to `http://127.0.0.1:4180`.
6. Restart `cloudflared.service`.
7. Probe `https://dash.surachmancenter.com/` unauthenticated and confirm it is
   protected.
8. Authenticate as owner and confirm the dashboard loads.
9. Confirm protected API behavior:
   - dashboard snapshot available after auth;
   - API routes remain owner/CSRF gated;
   - no raw environment values are exposed.
10. Record final evidence before M11 live drill.

Blocked external condition:

- This session can inspect the tunnel and local services, but cannot prove or
  configure Cloudflare Access policy from local files alone. The cutover must
  stay blocked until Cloudflare Access protection is verified for the hostname.

## Rollback Probe

Pre-cutover rollback source:

- Existing tunnel file: `/etc/cloudflared/config.yml`
- Existing origin mapping: `dash.surachmancenter.com` ->
  `http://127.0.0.1:4173`

Rollback after a future cutover:

1. Restore the saved pre-cutover `/etc/cloudflared/config.yml`.
2. Restart `cloudflared.service`.
3. Probe `https://dash.surachmancenter.com/`.
4. Expected current-state result after rollback: Cloudflare HTTP 502, because
   the pre-cutover origin `127.0.0.1:4173` is not running.

That rollback target is intentionally documented as the current external state,
not as a healthy user experience. The safe forward target is the authenticated
4180 control API/dashboard.

## Security Notes

- No raw secrets were printed into this evidence.
- The Cloudflare tunnel credentials file path exists in the tunnel config, but
  credential contents were not read.
- `/etc/polyp-ai-factory/control-api.env` was not dumped because it may contain
  secrets.
- The current dashboard service advertises `accessAuthMode=disabled`; this must
  remain acceptable only behind localhost or a verified Cloudflare Access
  boundary.

## Next Step

Proceed to M3 shell/navigation polish while keeping hostname cutover blocked
until Cloudflare Access protection can be verified.

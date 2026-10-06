# Phase 5: Gizmagick admin authentication

The authentication foundation is implemented, tested locally, and deployed to the existing `gizmagick-worker`. The administrator provisioned the admin-only Cloudflare Access application and saved `GIZMAGICK_ADMIN_EMAILS` as a private Worker secret; its name and retention were verified without reading its value. Anonymous admin requests redirect to Access, while public health and the WebSocket handshake work without login. The administrator confirmed successful real sign-in and the **Administrator verified** page on October 6, 2026. Separate signed-in session API, sign-out, and denied-account smoke checks are not yet reported. No music was uploaded, no remote D1 migrations ran, and the live frontend is unchanged. There are no upload/publication handlers yet.

## Design

Cloudflare Access handles the email one-time code and its session cookie. Gizmagick stores no passwords and issues no replacement browser session. This is a small, separate Worker-served admin page, not a login requirement on the public player.

- `/admin` and `/admin/` show a verified administrator's status, or a locked/setup-required message.
- `GET /api/admin/session` returns the verified principal and explicitly disabled upload/publication capabilities. `HEAD` is supported.
- Every `/admin/*` and `/api/admin/*` handler is behind the same guard, including unknown routes. Authenticated write requests still return 405.
- Public `/health`, `/ws`, and `/api/library/*` remain independent of admin sign-in. Room Director/Member roles are not admin credentials.

The Worker verifies the `Cf-Access-Jwt-Assertion` signature with pinned `jose` and the configured team's HTTPS certificate endpoint. It requires RS256, the exact issuer/application audience, expiry/issuance claims, an application token, a human subject ID, and an email matching the server's exact allowlist. Unsigned email headers, raw cookies, bearer headers, query flags, service tokens, and browser preferences cannot authenticate an admin. Keys are cached with a bounded refresh cooldown; upstream failures deny access. There is no localhost identity bypass or configurable alternative key server.

Principals have a stable opaque owner ID derived from the verified issuer and subject, separate from their email and role. It can be used for track ownership in the publication phase. The local import owner `gizmagick-admin-import` has **not** been reassigned; a reviewed ownership mapping is still needed for production import. Removing and re-adding a user to the Access organization can change their subject ID, so future ownership transfer must be explicit.

Admin responses are private/non-cacheable and grant no cross-origin browser access. Future mutations must include the exact configured `Origin` and `X-Gizmagick-Admin-Request: 1`; this is an origin/CSRF guard, not authentication. The admin page and API are on the same Worker origin to avoid cross-origin Access-cookie complications. Tokens never go into the player, localStorage, response bodies, or diagnostic header logs.

Implementation: `worker/src/admin-auth.js`, `worker/src/admin.js`. Future admin endpoints must remain inside this guarded dispatcher, not get added as public library mutations.

## Cloudflare setup you can do now

Use the same account as `gizmagick-worker`. These steps protect **only the new admin paths**. Do not turn on whole-Worker/account-wide Access protection: that could require your listeners to log in to the public WebSocket or library API.

1. Open **Workers & Pages → gizmagick-worker → Domains & Routes** (or its Overview) and note the existing HTTPS hostname. Use the actual Worker hostname, not `media.gizmagick.com` or the Pages frontend hostname. No rename, new DNS record, tunnel, or nameserver change is required for the existing hostname.
2. Open **Zero Trust**. If you do not have an organization yet, create one and choose the **Free** plan after reviewing its terms/billing prompts. Note the team domain: `https://YOUR-TEAM.cloudflareaccess.com`. Do not enable device enrollment, WARP, or Gateway for this task.
3. Go to **Integrations → Identity providers → Add new identity provider → One-time PIN**. Add it if it is not already present; new organizations do not necessarily enable OTP automatically.
4. Go to **Access controls → Applications → Create new application**, choose **Self-hosted** (the dashboard may label it **Self-hosted and private**), and name it **Gizmagick Admin**. Set a one-hour session duration.
5. Add public-hostname entries for the **same existing Worker hostname** and these four paths **in one application**:

   | Path field | Purpose |
   | --- | --- |
   | `admin` | Admin landing page without trailing slash |
   | `admin/*` | Trailing slash and future admin subpages |
   | `api/admin` | API namespace root |
   | `api/admin/*` | Session and future admin endpoints |

   If the hostname is a `workers.dev` address and is not in the domain dropdown, use **Switch to custom input**. Do not leave a hostname entry's path empty. Do not add a **Workers** destination in addition to these hostnames: selecting the Worker's production/preview URLs protects the whole Worker, not just the four paths. Wildcard child paths do not cover their parent, which is why all four entries are listed. If the dashboard cannot accept this hostname or these entries in one application, stop and ask before creating a new domain or separate applications with different audiences.
6. Create an **Allow** policy named **Gizmagick administrator**, with **Include → Emails → your exact email address**. Do not use Everyone, an email-domain wildcard, Bypass, or Service Auth. Enable **One-time PIN** as this application's login method; disable other login methods for this initial setup. Leave admin CORS settings unset—our page and API are same-origin.
7. Save the application. Copy its **Application Audience (AUD) tag**, the team-domain URL, and the Worker-origin URL (`https://HOSTNAME`, without `/admin`). Review that only the intended admin paths are covered and no broader policy is overriding them.

Report back with those **three non-secret values** and confirmation that your email-only Allow policy and OTP login method are configured. Keep the email allowlist in local/private configuration; you do not need to paste your email here. Do not send email codes, cookies, JWTs, passwords, API tokens, or secret keys.

The old deployed Worker may still return 404 after Access sign-in because the admin page has not been deployed. That is expected at this stage. Do not deploy, apply remote migrations, upload tracks, or switch Pages to remote source yet.

Sources: [Access on specific Worker hostnames/paths](https://developers.cloudflare.com/workers/configuration/cloudflare-access/), [application creation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/), [path matching](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/), [OTP setup](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/), [Zero Trust plans](https://www.cloudflare.com/plans/zero-trust-services/).

## Configuration and deployment handoff

These **non-secret** settings are recorded in `[vars]` in `worker/wrangler.toml`:

```toml
GIZMAGICK_ACCESS_TEAM_DOMAIN = "https://black-resonance-a976.cloudflareaccess.com"
GIZMAGICK_ACCESS_AUD = "b6e219cb96a0117d174511b52ed7df377fc4a1f7389de4d6e177388ce02a1687"
GIZMAGICK_ADMIN_ORIGIN = "https://gizmagick-worker.nin10dos.workers.dev"
```

The server allowlist is the private Worker secret `GIZMAGICK_ADMIN_EMAILS` (comma-separated exact email addresses). During the separately authorized deployment setup, enter it through Wrangler's interactive secret prompt using `--config ../worker/wrangler.toml` from `frontend`. Do not put it in `VITE_*`, commit it, or set it from browser input. Recording the public identifiers does not enable administrator access without this private allowlist.

Alternatively, enter the allowlist yourself in **Workers & Pages → gizmagick-worker → Settings → Variables and Secrets → Add**. Choose **Secret**, name it `GIZMAGICK_ADMIN_EMAILS`, use the exact email allowed by the Access policy, and select **Deploy**. This deploys the secret configuration on the existing Worker; it does not deploy the repository's new authentication code or change Pages. Do not add it as a plaintext variable or put it on the Pages project. Report only that it was saved; do not send its value or email codes. [Cloudflare's secret setup instructions](https://developers.cloudflare.com/workers/configuration/secrets/)

The initial read-only preflight found no Worker secrets configured. The latest deployed version before setup was `5b5c642e-6da3-4b81-82d9-f35a8f2b9de4` (September 24, 2026), with `ROOM_HUB` and compatibility date `2024-09-01`; D1/R2 were not yet bound. The administrator then saved the secret, creating deployed version `c46031a1-8a18-4a0f-aff1-8d2480e9409c`. This is the pre-authentication-code rollback reference; do not roll back automatically or discard the private secret.

On October 6, 2026, the authorized authentication deployment produced version `6b283865-049e-4aae-a259-737122a75563`. It added the project-configured D1/R2 bindings and Access identifiers, preserved `GIZMAGICK_ADMIN_EMAILS`, and retained `ROOM_HUB` on the existing Durable Object namespace (its historical `wizamp-worker_RoomHub` label is not a new naming choice). No remote D1 migrations, music uploads, Pages rebuilds, or DNS/Access policy edits were performed.

Production checks after deployment:

- Anonymous `/health`: 200 with `{ok: true, worker: "gizmagick-worker"}`.
- Anonymous non-upgrade `GET /ws`: 426; an actual unauthenticated WebSocket connection opened successfully and was closed without joining a room or sending playback commands. This is a handshake smoke check, not a deployed two-client playback test.
- `/admin`, `/admin/`, `/admin/not-a-real-page`, `/api/admin`, and `/api/admin/session`: 302 redirects to the configured team's Access login. Redirect query strings/tokens were not deliberately extracted or recorded.
- The browser displays **Log in to Gizmagick Admin** with **Send login code**. The administrator entered their own authentication details and confirmed the deployed **Gizmagick / Library admin / Administrator verified** page. This confirms the real login flow and Worker authorization, not just the Access login screen. No code, cookie, or session JWT was requested from the administrator. A separate session API smoke check, denied-account check, and sign-out are not yet reported.
- Anonymous `/api/library/catalog`: sanitized 503 (`Library is temporarily unavailable`) because the remote library schema/import is still pending. This is not an Access redirect or a reason to cut the player over prematurely.
- The Worker dashboard still shows `*.wizamp.app/*` after deployment despite Wrangler's local/remote route warning. No replacement route was added. Bindings show the intended existing D1, R2, and Durable Object resources.

### Dashboard and hostname review (October 6, 2026)

The **Gizmagick Admin** editor showed all four correct hostname/path entries, the supplied AUD, a one-hour application session, a single **Allow** policy with **Include → Emails** containing one exact address, and only **One-time PIN** enabled. Admin CORS fields were unset. It initially also showed an extra **Workers → gizmagick-worker → A Worker's production and preview URLs** destination. The administrator removed that extra destination and saved; a fresh reload confirmed it is gone and all four public hostnames remain. No dashboard security settings were changed by the agent during the review. The unauthenticated production `/health` check returned 200 during the initial review; post-deployment public health/WebSocket and real admin sign-in checks are still required.

The deployed `https://gizmagick.com/` bundle (`/assets/index-Cd0R8Sh7.js` at review time) contains `wss://wizamp-worker.nin10dos.workers.dev/ws`. The live frontend therefore still points at the old Worker hostname. Do not assume renaming a Worker or moving Pages to a new domain updates an already-built `VITE_WS_URL`. Before a separately authorized frontend rollout, verify which Worker currently serves rooms, review room compatibility, and explicitly set `VITE_WS_URL=wss://gizmagick-worker.nin10dos.workers.dev/ws` for the new build. Avoid interrupting active legacy rooms.

The dashboard's legacy `*.wizamp.app/*` route does not supply that `workers.dev` connection and does not automatically become a `gizmagick.com` route. Leave it unchanged during this setup; confirm no old-domain clients rely on it before cleanup. No replacement route on `gizmagick.com` is needed to use the existing Worker hostname. In particular, **do not add `gizmagick.com/*`**: it would invoke this API/room Worker for frontend requests without a Pages asset handler. If a separate API custom domain is desired later, review that as a separate routing change. `workers_dev = true` is explicit in the project configuration; reconcile dashboard-only routes before any deployment rather than silently treating the current file as a complete routing inventory.

Sources: [path-based versus whole-Worker Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/), [Worker routes](https://developers.cloudflare.com/workers/configuration/routing/routes/), [workers.dev configuration](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/).

Deploy the Worker only after reviewing the existing Phase 4 D1/R2 bindings and rollout plan. This authentication feature needs no new D1 migration and should not cut the frontend over to remote loading. After deployment:

1. In a private browser window, visit `https://HOSTNAME/admin`. Access should offer email-code login. Enter your own email and code yourself.
2. Confirm the page says **Administrator verified**, shows your email, and marks uploads/publication as not enabled. `/api/admin/session` should return the same identity.
3. Confirm a disallowed account cannot sign in. A denied OTP request may still display the generic “code sent” message without delivering a code.
4. Confirm sign-out returns you to the Access sign-in flow, and that `/health`, the public catalog, and existing online rooms still work without admin login. Check trailing-slash/path coverage too.
5. Verify direct alternate Worker URLs cannot access admin endpoints without a valid token. Do not create a bypass route to make a failing login work.

Email OTP depends on the security of your mailbox; protect it with MFA. To remove an administrator, remove them from both the Access policy and the Worker's private allowlist. Policy edits alone should not be treated as guaranteed immediate revocation of an already issued JWT on an alternate origin; the application allowlist is checked on every request. Sign-out clears Access session access, not necessarily an upstream identity-provider session.

## Local development and checks

From `frontend`:

```sh
npm ci
npm ci --prefix ../worker
npm test
npm run lint
npm run dev:worker:library
```

The Worker now has its own dependency lockfile; install both sets of dependencies after a fresh checkout. `npm test` includes a Miniflare loopback integration check and may require permission to use the local simulator in a restricted environment. Its signing keys and key-server responses are generated/mocked locally; it does not contact Cloudflare or write production storage.

Without real authentication configuration, local `/admin` displays **Admin access locked / Setup required** with status 503. With configured authentication but no signed token, requests get 401. Copy `worker/.dev.vars.example` to ignored `worker/.dev.vars` only if you need real local configuration; placeholders do not authenticate anybody. Never commit `.dev.vars` or tokens. A real signed-in browser flow is checked on the protected HTTPS hostname, not simulated by trusting a fake email header locally.

Verified: 146 tests pass, including forged/expired/wrong-audience JWTs, allowlist denial, unsafe/cross-origin requests, malformed configuration, unknown admin routes, escaped HTML, key-server errors, and verification in the local Workers runtime. Lint, the normal frontend build, and Worker deployment packaging pass. The local browser shows the expected locked page. The deployed browser shows Access's email-code login, and the administrator confirmed successful real sign-in and the verified-admin page.

## Next implementation phase

Build the admin upload/editor page and its guarded API, private draft storage, file-size/type/duration checks and audio probing, upload limits, reviewed ownership mapping, immutable version publication and audit records. Drafts/unapproved uploads must never enter the public `gizmagick-media` bucket. Future ordinary contributors need their own identity/ownership/role model; expanding the admin allowlist is not a public-user signup system.

Start with private draft intake, not automatic publication: a separate `gizmagick-drafts` R2 bucket with no public domain or `r2.dev` URL; an authenticated admin-only upload page/API using the existing verified principal and origin guard; and server-owned draft metadata in D1. Creating/binding this additional cloud resource and applying draft migrations are a separate rollout step, not part of the completed login setup. First-stage uploads must leave the existing catalog and published R2 objects untouched. Audio probing and reviewed publication must be implemented before any uploaded draft can enter the public bucket. Import the existing clip/section JSON through the canonical-manifest adapter rather than rewriting the live source files as part of upload intake.

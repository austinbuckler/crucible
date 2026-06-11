# Security

This doc covers what Crucible enforces on your behalf, what you're responsible for, and the threat model the framework was designed against.

## Threat model

Crucible's primary surface is a client-side SPA loading data from a same-origin GraphQL API. The threats that matter:

| Threat | Where Crucible defends | Where you defend |
|---|---|---|
| Stored / reflected XSS via untrusted user content | CSP nonce on inline scripts; URL safety on `<Link>` href | Sanitize user-rendered HTML; never render unsanitized markdown |
| Open-redirect via `<Link>` with attacker-controlled `to` | `isRouterTarget` rejects cross-origin from the router path | Validate URL inputs at the form layer |
| Privilege escalation via Electron IPC | Closed channel set, contextIsolation, sandbox enabled | Don't add IPC channels that accept untrusted input without validation |
| Data exfiltration via cross-origin asset injection | CSP `default-src 'self'`, `connect-src` allowlist | Don't load third-party scripts that aren't required |
| Session theft via service worker | SW only caches same-origin GET responses | Don't put auth tokens in URLs (always cookies + Authorization headers) |
| Cache poisoning across schema changes | Schema-hash-keyed Relay store cache; old keys swept on boot | – |

What's **out of scope**:
- Server-side authentication (your responsibility — use `better-auth` or whatever).
- TLS / mixed content (your responsibility — serve from HTTPS).
- DoS on the API (your responsibility — rate-limit at the edge).

## CSP

Every generated `index.html` carries this Content Security Policy:

```
default-src 'self';
script-src 'self' 'nonce-<NONCE>';
style-src 'self' 'nonce-<NONCE>' 'unsafe-inline';
img-src 'self' data: blob: https:;
font-src 'self' data:;
connect-src 'self' ws: wss:;
worker-src 'self' blob:;
manifest-src 'self';
object-src 'none';
base-uri 'self';
frame-ancestors 'none';
form-action 'self';
```

The nonce is fresh per build (16 random bytes, base64). Stamped on every inline `<script>` and `<style>` Crucible emits, including the boot module script. **`'unsafe-inline'` is omitted from `script-src`** — any inline `<script>` injected via XSS won't carry the nonce and the browser will block execution.

`'unsafe-inline'` IS kept on `style-src` because Tailwind v4's runtime CSS injection doesn't carry the nonce. Per CSP3 spec, browsers ignore `'unsafe-inline'` when a nonce is also present, so this is defense-in-depth in practice.

`'unsafe-eval'` is intentionally absent. Electron warns when it's present and it's the most common XSS amplifier.

`object-src 'none'` blocks Flash, Java applets, and other plugin-based escape hatches that haven't been relevant in years but are still in default templates.

`frame-ancestors 'none'` blocks clickjacking — your app can't be loaded in an iframe.

`base-uri 'self'` prevents `<base href="https://evil.com/">` from rebasing relative URLs.

### Customizing CSP

The default `connect-src` is intentionally tight: same-origin (`'self'`) plus `ws:` / `wss:` for HMR and WebSocket APIs. It does NOT include wildcard `http:` / `https:` — a compromised dependency cannot exfiltrate data to an attacker-controlled origin under the default policy.

To allow your app to talk to additional origins (a third-party API, error reporter, analytics endpoint), pass `connectSrcAllowlist` to the plugin:

```ts
// vite.config.ts
import { crucible } from "react-crucible";

export default {
  plugins: [
    crucible({
      connectSrcAllowlist: [
        "https://api.example.com",
        "https://*.sentry.io",
      ],
    }),
  ],
};
```

Each entry is included verbatim — pass full schemes. Hostnames support CSP source-list wildcards (`*.example.com`).

For app-specific tightening beyond what `connectSrcAllowlist` covers, fork `buildCsp` in `codegen/index-html.ts`. For per-route policies, set them server-side at the edge (CloudFront / Cloudflare Workers / etc.) — `<meta http-equiv>` CSP only supports a single global policy.

A fully typed `csp` option on the Vite plugin (covering all directives) is a future iteration.

### Dev mode quirks

In dev, `<script type="module">` tags Vite injects (HMR client) carry no nonce — they're added by Vite, not Crucible. Modern Vite + nonce-based CSP have a known incompatibility here. Two options:

1. **Use `'strict-dynamic'`** in dev's `script-src`. With strict-dynamic, scripts loaded by other nonced scripts inherit trust. This works but has edge cases.
2. **Loosen dev CSP**. Most apps run dev locally so the CSP gain is theoretical. Production builds carry the strict policy.

Crucible currently emits the same CSP in dev and production. If HMR scripts get blocked, loosen `script-src` for dev only by feature-detecting `import.meta.env.DEV` in your own override.

## URL safety

Two distinct functions, two distinct concerns:

### `isSafeHref(to)` — for rendering `<a href="...">`

Accepts:
- Relative paths (`/`, `?`, `#`, `.`)
- Same-origin and cross-origin `http(s)`
- `mailto:` / `tel:`

Rejects:
- `javascript:` / `data:` / `vbscript:` / `file:`
- Custom protocol handlers (`intent:`, `steam:`, etc.)
- Empty / non-string

This is what `<Link>` uses to decide whether to render `href` at all. If `isSafeHref(to)` is false, the rendered `<a>` has no `href` — middle-click / cmd-click can't open it as a tab, right-click → "Open in new window" is disabled.

### `isRouterTarget(to)` — for routing decisions

Same-origin only:

Accepts:
- Relative paths (`/`, `?`, `#`, `.`)
- Same-origin `http(s)` (origin matches `window.location.origin`)

Rejects:
- Cross-origin `http(s)` (even when scheme-safe)
- `mailto:` / `tel:` (href-only, not navigable)
- Everything `isSafeHref` rejects

This is what `navigate()` and `prefetch()` use to decide whether to call `history.pushState` (which would throw on cross-origin) or fire a Relay query.

`assertRouterTarget(to)` throws if the target isn't routable — used to catch programmatic mistakes early.

### Why split

The split is about defense-in-depth without breaking UX:

- A poisoned link in user-rendered content (e.g., `client.contactUrl` set to `https://evil.com`) renders correctly in `href` so cmd-click works as expected.
- The click handler doesn't navigate via the router (would throw). It also doesn't prefetch (would waste network on the cross-origin path).
- The browser handles the click natively → either follows the link normally (user expected behavior) or navigates away from the SPA.

If we used a single check, we'd either accept cross-origin everywhere (and break prefetch) or reject cross-origin in href (and break cmd-click).

## Electron IPC

The renderer receives only what the preload exposes via `contextBridge`. There's no generic `ipcRenderer.invoke(channel, ...)` escape hatch.

Closed channel set, defined in `electron/shared.ts`:

```ts
export const CHANNELS = {
  openExternal: "crucible:openExternal",
  copyToClipboard: "crucible:copyToClipboard",
};
```

Each handler validates input. `openExternal` rejects anything that isn't `^https?:|^mailto:|^tel:`. So even if a stored XSS lands in the renderer, the most damaging IPC call it can make is opening an external URL in the user's browser — and only an `https`/`mailto`/`tel` one.

`window.open` from the renderer is gated by `setWindowOpenHandler` to allow only same-scheme + `about:blank`. Allowed popups inherit the same preload, so they're equally restricted.

`webPreferences`:
- `contextIsolation: true` — renderer JS context is isolated from preload's
- `nodeIntegration: false` — no `require()` in renderer
- `sandbox: true` — renderer process is sandboxed by Chromium

These three together are the modern Electron-renderer-hardening baseline.

## Service worker

The SW only caches:
- Same-origin GET requests
- Status 200, type `basic` responses
- Filenames that pass `shouldPrecache` (excludes sourcemaps + manifest)

Authentication tokens should never be in URLs. The SW caches asset URLs; if your auth used `?token=...` in URLs (don't), the token would land in the cache. Use cookies + `Authorization` headers; both bypass the SW's caching path because they're per-request, not per-URL.

Navigation requests (HTML) are network-first with an `/index.html` fallback. So:
- Online: user gets fresh HTML.
- Offline: user gets the cached app shell, which then loads chunks from the asset cache.

If your app has authenticated routes that should redirect on session expiry, the redirect is server-side — the SW doesn't intercept that.

## What you're responsible for

### Sanitize user-rendered HTML

If you render user-provided markdown / HTML into the React inner-HTML escape hatch, sanitize it. Crucible doesn't ship a sanitizer because it's a library-pick (DOMPurify is the standard). Even with strict CSP, an XSS that sets `<style>` or `<img onerror>` can break visual layout or exfiltrate data via `background-image: url(...)` callbacks.

### Validate all URL inputs at the form layer

Crucible defends URLs that go through `<Link>` and the router. URLs that go through `<a href={user.url}>` directly (not via `<Link>`) are NOT defended — Crucible can't intercept arbitrary JSX. Either:
- Use `<Crucible.Link>` everywhere a URL is rendered, OR
- Sanitize URL inputs at the form layer (validate against a known scheme allowlist before saving).

### Authenticate every request

Crucible doesn't enforce authentication. The Relay environment includes `credentials: "include"` so the browser sends cookies, but it doesn't validate that you got a valid session back. Auth is your server's job.

### CSRF

Crucible doesn't ship CSRF protection. The default same-origin GraphQL endpoint with `credentials: "include"` is vulnerable to CSRF if your server doesn't add a SameSite cookie attribute or a CSRF token. Modern frameworks (Better Auth, Lucia, etc.) handle this; if you roll your own, don't forget.

### Audit your dependencies

Crucible has a small dependency tree (peer-deps on react, react-dom, react-relay, relay-runtime, vite, graphql, react-error-boundary, @standard-schema/spec). Run `bun audit` or equivalent regularly. Crucible can't audit YOUR app's deps.

## Reviewing changes for security

When reviewing PRs that touch crucible's runtime:

1. **Did the change add an inline `<script>` or `<style>`?** It needs the nonce.
2. **Did the change add a fetch to a new origin?** It needs `connect-src` to allow it (or it'll be CSP-blocked).
3. **Did the change add a new Electron IPC channel?** Validate the input at the main-process handler.
4. **Did the change add a new `<a href>` rendered from data?** Use `<Link>` or call `isSafeHref` first.
5. **Did the change put a token in a URL?** Move it to a cookie or header.

For PRs in app code:

1. **Are there raw inner-HTML insertions?** Sanitize first.
2. **Are URLs from user input ever passed to `<a href>` directly?** Use `<Link>` or sanitize.
3. **Are there `target="_blank"` links?** Verify `rel="noopener noreferrer"` (Crucible's `<Link>` adds this automatically, but raw `<a>` doesn't).

## Reporting

This is an internal package; no public bug-bounty surface. Report issues to the team via Linear / Slack / wherever your sec-ops process documents.

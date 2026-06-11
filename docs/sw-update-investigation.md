# Service Worker update behavior — investigation

> **Status (2026-05-08):** ALL findings (P0 + P1 cluster + P2 cluster) shipped under task #29 as a unified framework feature — see `runtime/sw-update.ts`, the `<AppShell swUpdate>` strategy prop, the `useCrucibleUpdate` hook, and the `crucible:update-ready` window event. The historical content below is preserved for context; see "Resolution" sections inline for what landed.

**Date:** 2026-05-08
**Reviewer:** crucible-fixer
**Scope:** the entire SW pipeline in `crucible/` — codegen, plugin emit, runtime registration, cache strategy. This is a research pass, not an implementation. P0/P1 follow-ups have been filed as separate tasks.

---

## TL;DR

The current SW gets the **mechanics** mostly right (content-hashed cache key, network-first navigation, cache-first hashed assets, prior-cache purge on activate, `skipWaiting` + `clients.claim`) but is missing the **update-discovery feedback loop** between client and SW. The most consequential gap: **`navigator.serviceWorker.register(...)` is called with no `updateViaCache` option**, which means the browser is allowed to serve a stale cached `/sw.js` for up to 24 hours per spec — the new SW is never discovered until either the user reloads after the cache expires or the deployment serves `/sw.js` with the right `Cache-Control` header. There's also no programmatic update trigger (no `registration.update()` on focus/visibility), no controller-change reload bridge, no waiting-SW notification, and the `skipWaiting` happens unconditionally inside `install` rather than gated on a user gesture, which can swap the controller mid-session and break in-flight work that assumed a stable bundle.

For a long-lived dashboard a user keeps open across deploys, this means: most of the time it works; some of the time the user is silently stuck on stale code with no signal until they full-restart the tab.

---

## Current behavior

### 1. Plugin / codegen — `crucible/index.ts` and `crucible/sw.ts`

- **Version key:** `computeAssetVersion(entries)` — `sw.ts:86-94`. FNV-1a hash of `\`${filename}::${size}\`` for each emitted asset, sorted by filename. Equivalent to a content-stable hash of the asset *list* (not the asset bytes themselves, but Vite content-hashes filenames so a content change produces a new filename, which flows through). The hash is embedded into the SW source via `__VERSION__` template substitution and used as the `caches.open(...)` key (`crucible-<hash>`).
- **Schema hash:** computed independently at `index.ts:21-31` — also FNV-1a, over `schema.graphql`. Threaded into `import.meta.env.CRUCIBLE_SCHEMA_HASH` for the Relay localStorage cache key. **Not** part of the SW version. This means: a schema-only change (no asset change) does NOT bump the SW version, so the cached assets stay valid; the schema hash invalidates the Relay store cache instead. Correct separation of concerns.
- **Emit:** `index.ts:194-219` — `generateBundle` walks the bundle, filters via `shouldPrecache`, computes the version, writes `sw.js`. Asset URLs include the SPA shell `/index.html` for offline navigation fallback.
- **Excluded from precache:** `sw.js`, `*.map`, `manifest.webmanifest` (`sw.ts:107-112`). Sane.
- **Dev-mode SW:** `index.ts:265-273` — middleware serves a no-op SW (`install → skipWaiting; activate → clients.claim`) so dev registration doesn't 404. Correct.
- **`updateViaCache` option:** **NOT SET** on the registration call (`ui/app-shell.tsx:46`). See P0 below.
- **`Cache-Control` for `/sw.js`:** **NOT SET** by the plugin. The deployed cache header is whatever the host (Vercel / CloudFront / nginx default) applies to a non-hashed root-level asset — typically `public, max-age=31536000` or similar long-lived defaults that defeat SW updates entirely.

### 2. Runtime registration — `crucible/ui/app-shell.tsx:36-49`

```ts
useEffect(() => {
  if (isElectron()) return;
  const swUrl = import.meta.env.CRUCIBLE_SW_URL ?? null;
  if (!swUrl) return;
  if (typeof navigator === "undefined") return;
  if (!("serviceWorker" in navigator)) return;
  void navigator.serviceWorker.register(swUrl).catch((err) => {
    console.error("[crucible] service worker registration failed:", err);
  });
}, []);
```

That is the **entire** runtime SW integration. There is no:

- `registration.update()` polling (focus, visibility, periodic).
- `registration.addEventListener("updatefound", ...)` to watch for incoming SWs.
- `installing.addEventListener("statechange", ...)` to surface a "new version ready" signal to UI.
- `navigator.serviceWorker.addEventListener("controllerchange", ...)` reload bridge.
- Distinction between first-load (no controller) vs. subsequent (controller present, possibly waiting).
- User-gesture handoff for `skipWaiting` (the SW does it unconditionally — see #3).

### 3. SW behavior — `crucible/sw.ts` template

```js
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(ASSETS);
      await self.skipWaiting();           // ← unconditional
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith("crucible-") && k !== CACHE_NAME)
            .map((k) => caches.delete(k)),
      );
      await self.clients.claim();         // ← claims all open clients
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  // ... GET + same-origin only; navigate → network-first → /index.html;
  // others → cache-first → fetch + cache.put on miss.
});

self.addEventListener("message", (event) => {
  if (event.data === "crucible:skip-waiting") self.skipWaiting();
});
```

**Cache strategy:**

- **Precache** on install: every emitted asset (filtered through `shouldPrecache`) plus `/index.html`.
- **Navigation requests:** network-first, fall back to `/index.html` shell offline.
- **Same-origin GET asset requests:** cache-first, populate on miss with `cache.put(req, res.clone())` if `res.status === 200 && res.type === "basic"`.
- **Eviction:** none for the runtime cache — the cache grows unbounded for the life of one version, then is wholesale `caches.delete()`'d on activate of the next version.
- **Cross-origin / non-GET:** untouched, browser handles directly.

**Update path:**

- Install fires `skipWaiting()` unconditionally → the new SW skips the "waiting" phase.
- Activate fires `clients.claim()` → all open tabs immediately switch controllers.
- The `crucible:skip-waiting` message handler exists but is unused — nothing in the runtime sends that message.

### 4. Interaction with Relay localStorage cache

The Relay store cache key is `crucible.relay-cache.${SCHEMA_HASH}` (`runtime/environment.ts:30-31`). On boot, `sweepStaleCacheKeys()` wipes any prior-schema entries (`runtime/environment.ts:37-51`). This is **independent** of the SW version — a code change without a schema change keeps the Relay cache valid. A schema change without a code change (rare but possible — e.g. server-only schema change with no client codegen) drops the Relay cache but keeps the SW asset cache. Correct separation; no concern flagged.

---

## Gaps and risks (severity-ranked)

### P0 — `register(...)` is called without `updateViaCache: 'none'`

**File:** `ui/app-shell.tsx:46`.

**Current:** `navigator.serviceWorker.register(swUrl)`. No options object → `updateViaCache` defaults to `'imports'` per the [Service Worker spec, §3.2.21](https://www.w3.org/TR/service-workers/#dfn-update-via-cache). That means the top-level script (`/sw.js`) **does** consult the HTTP cache, with a forced max-age of 24h applied by the browser on top of the server's `Cache-Control`.

**Risk:** the deployed `/sw.js` is served with whatever `Cache-Control` the host applies to a root-level non-hashed asset. On Vercel that's typically `public, max-age=0, must-revalidate` for the bundle index but is **not guaranteed** for ad-hoc files emitted by Vite's bundle. If the deployed `Cache-Control` is anything ≥ 24h (or if a CDN edge caches it), the browser may serve a stale `sw.js` for up to 24 hours, during which the user is on stale code with no signal. Even with a perfect `Cache-Control: no-cache` from the host, the 24h spec ceiling applies.

**Suggested fix:** pass `{ updateViaCache: 'none' }` to `register()`. This bypasses HTTP cache for `/sw.js` entirely (the SW is always fetched from network when `update()` runs or the page reloads). Cost: one extra network request per page load when the SW is checked for updates — negligible.

**Also recommended:** the plugin should set `Cache-Control: no-cache` (or `no-store`) for `/sw.js` itself in the dev middleware (`index.ts:265-273`) and document the production header expectation. Hosts like Vercel and CloudFront need an explicit override or the asset falls into the default long-cache bucket.

**Complexity:** trivial — one option key in the register call, plus a one-line header in the dev middleware, plus a `docs/pwa.md` note for hosts.

---

### P1 — No client-side update polling (`registration.update()`)

**File:** `ui/app-shell.tsx:36-49`.

**Current:** the SW is registered on mount and never explicitly checked again. The browser does check on its own when a navigation occurs, but for a SPA there are NO HTTP navigations after the first one — `<Crucible.Link>` does soft navigation. So the only way an open tab discovers a new SW is (a) a hard reload, (b) a tab close/reopen, (c) the browser's opaque background heuristics. A user with a long-lived dashboard tab can stay on stale code indefinitely.

**Suggested fix:** call `registration.update()` on `document.visibilitychange` (when the tab becomes visible) and on `window.focus`. Throttle to once per N minutes (60s is generous; 5min is conservative). When the call resolves, if there's a new `installing` worker, the `updatefound` event fires.

**Complexity:** ~15 lines in `app-shell.tsx`. A minor consideration: don't spam `update()` on every visibility flip — debounce it.

---

### P1 — `skipWaiting()` is unconditional on install

**File:** `sw.ts:11-19`.

**Current:** the new SW calls `skipWaiting()` inside its `install` event, then `clients.claim()` in `activate`. This means **as soon as the new bundle deploys and any tab loads / re-checks**, the controller in every open tab swaps mid-session.

**Risk:** the user is in the middle of a workflow, the controller swaps, and the cache backing their in-flight chunks rotates from `crucible-<old>` to `crucible-<new>`. Most chunk requests succeed because (a) Vite content-hashes filenames so the old chunks are also in the new precache (or fetchable from network and cache-on-miss), but (b) any `import()` for a chunk that was removed in the new build (e.g., a deleted route) **fails** if the user happens to navigate there before reloading. Worse: between `skipWaiting()` and the next request, the running React tree may try to fetch a chunk by the OLD hash that is no longer in the precache, gets it from the network if still served, but a CDN purge could 404 it. The result is a runtime error mid-interaction.

**Industry pattern (Workbox's `messageSkipWaiting`, Next.js's PWA helpers, even Google's own SW examples):** install precaches, then SW goes to `waiting`. The page detects the waiting SW via `updatefound` + `statechange === "installed"`, surfaces a "Refresh to update" toast to the user, and only sends `postMessage("SKIP_WAITING")` (which is what our existing `crucible:skip-waiting` handler already accepts) when the user clicks. The message handler triggers `skipWaiting()`, the page listens for `controllerchange` and reloads.

**Suggested fix:** remove `await self.skipWaiting()` from `install`. Wire up the `updatefound`/`statechange`/`controllerchange` flow on the client side and emit a public event (e.g. `crucible:update-ready`) that consumer apps can listen for and surface in their own UI. Keep the `crucible:skip-waiting` message handler (it's already correct).

**Note:** for a data-heavy dashboard, "user must explicitly refresh" is the right default — silent code swaps mid-session are exactly the kind of thing that breaks half-filled forms, in-flight uploads, etc. A "soft auto-refresh after 5 minutes idle" could be a future option, but the default should be opt-in.

**Complexity:** medium. SW change is one line. Client-side requires the update-tracking machinery from P1-A above plus a pub/sub event. Maybe ~50 lines. Public-event surface needs documenting.

---

### P1 — No `controllerchange` reload bridge

**File:** `ui/app-shell.tsx`.

**Current:** there's nothing listening for `navigator.serviceWorker.controllerchange`. Once #P1-A and #P1-B above are addressed (i.e., we adopt the user-gesture-driven `skipWaiting` flow), we need a `controllerchange` listener that triggers `window.location.reload()` so the page picks up the new bundle once the user accepts the update.

**Risk:** without this, even a perfectly-orchestrated user-gesture flow leaves the page running on the old controller until the user reloads themselves. Surfacing a "Refresh to update" toast that requires a separate reload step is one click too many.

**Suggested fix:** add `navigator.serviceWorker.addEventListener("controllerchange", () => window.location.reload())` once at registration time. Guard against the first-load case where there's no prior controller (the initial activation is not a "change").

**Complexity:** trivial — guard plus a one-liner.

---

### P1 — No "new version available" event surface

**Current:** after fixing #P1-B (don't `skipWaiting` on install), apps need a way to render a "Refresh to update" toast. The runtime should emit a documented event.

**Risk:** without an event, every consumer app reinvents the same boilerplate.

**Suggested fix:** dispatch `window.dispatchEvent(new CustomEvent("crucible:update-ready", { detail: { activate: () => navigator.serviceWorker.controller?.postMessage("crucible:skip-waiting") } }))` when `updatefound → installing → installed → registration.waiting != null`. Consumers listen and render whatever UX they like. (The detail callback closes over the right registration so consumers don't have to look it up themselves.)

**Complexity:** small — ~10 lines in `app-shell.tsx`, plus a docs section.

---

### P2 — Dev-mode SW unconditionally `clients.claim`s every reload

**File:** `index.ts:265-273`.

**Current:** the dev middleware serves a SW that does `install → skipWaiting; activate → clients.claim`. Harmless 99% of the time, but a developer who switches between branches with different SW behavior may get bitten by a still-active dev SW intercepting requests on the new branch. Vite's HMR full-reload bypasses the SW for navigation, so this is mostly cosmetic.

**Suggested fix:** add an `unregister()` path the developer can hit (e.g., document the DevTools "Unregister" button), or simply make the dev SW also `unregister()` itself on activate. Latter is more aggressive but cleaner — a dev tab that boots the dev SW immediately tears it down.

**Complexity:** trivial. P2 because it's a developer-experience nit, not a production concern.

---

### P2 — Runtime cache-on-miss is unbounded

**File:** `sw.ts:52-63`.

**Current:** the cache-first asset handler does `cache.put(req, res.clone())` on every successful miss. There's no cap on entries; the cache grows for the life of one SW version. On version bump, the entire cache is dropped via `caches.delete()` — so the lifetime is bounded, but within one version a user who loads many pages can accumulate a lot of asset entries.

**Risk:** for a typical SPA this is fine — the bundle is ~1-5MB and immutable per version, so the cache asymptotes. But if the app loads dynamic non-hashed assets (user-uploaded images, generated reports), they accumulate without bound.

**Suggested fix:** consider gating `cache.put` to assets matching `/^assets\//` (Vite's hashed asset directory). Anything else, fetch but don't cache. Optional: add a simple LRU cap.

**Complexity:** trivial filter; LRU is more involved. P2 because the failure mode is "cache grows" which storage quotas eventually clean up; not a correctness issue.

---

### P2 — `error` from `navigator.serviceWorker.register` is `console.error`'d but otherwise dropped

**File:** `ui/app-shell.tsx:46-48`.

**Current:** `.catch((err) => { console.error(...) })`. No reporting hook, no retry, no fallback.

**Risk:** in production, a SW registration failure is silent to users and the team. The page still works (SW failure is non-fatal), but the user loses offline support and the team loses visibility.

**Suggested fix:** route the error through the same `onError` hook the router already exposes (`AppProps.onError`) so Sentry/Datadog see it. Or expose a `<AppShell onSwError>` callback specifically.

**Complexity:** small; design question is which hook to plumb it through.

---

### P2 — Tests cover serialization but none of the runtime behavior

**File:** `sw-and-pwa.test.ts`.

**Current coverage:** `computeAssetVersion` (4 tests), `generateSwSource` (3 tests), `shouldPrecache` (4 tests), `resolvePWA` (8 tests). All pure functions — input → output, no DOM, no SW lifecycle.

**What's NOT covered:**
- The `install` handler's `cache.addAll` semantics. Untested.
- The `activate` handler's prior-cache purge. Untested.
- The `fetch` handler's network-first navigation + cache-first asset routing. Untested.
- The `crucible:skip-waiting` message handler. Untested.
- The runtime registration call shape (i.e., that `updateViaCache: 'none'` is passed once we add it).

**Suggested fix:** add a test file using a mock `ServiceWorkerGlobalScope` (or evaluate the SW source string in a sandboxed `vm.createContext` with stubbed `caches`/`fetch`/`self.addEventListener`). This is enough to verify the lifecycle without needing a real SW environment.

**Complexity:** medium. The hardest part is the mock harness; the assertions are straightforward once the harness exists.

---

## What's clean

- **Schema-hash isolation from asset-version hash.** Two separate keys for two separate caches (Relay store vs. SW asset cache); they don't bleed.
- **Same-origin guard in fetch handler.** `url.origin !== self.location.origin → return` — cross-origin assets correctly pass through to the browser.
- **Method guard.** Non-GET requests pass through (the SW correctly avoids intercepting POST/PUT/etc., which would be a real footgun).
- **Excluded precache list.** `sw.js`, sourcemaps, manifest.webmanifest are correctly excluded.
- **Offline navigation fallback.** `/index.html` is always precached; navigations fall back to the SPA shell on network failure.
- **Dev no-op SW.** Right call — registers, doesn't fight Vite, doesn't 404.
- **Electron skip path.** `if (isElectron()) return` correctly avoids registering in the desktop wrapper.

---

## Recommended follow-ups (ranked, P0/P1 created as tasks)

1. **P0** — Pass `{ updateViaCache: 'none' }` to `register()` and document the production `Cache-Control` expectation for `/sw.js`. (Filed.)
2. **P1** — Add `registration.update()` on visibility/focus, with throttle. (Filed.)
3. **P1** — Remove unconditional `skipWaiting()` from install, wire up `updatefound`/`statechange`/`controllerchange`, dispatch `crucible:update-ready` with an `activate()` callback in detail. (Filed.)
4. **P1** — Add `controllerchange → window.location.reload()` bridge as part of #3. (Folded into the same task.)
5. **P2** — Cache-on-miss filter (assets/ only) + optional LRU. (Filed as P2 follow-up.)
6. **P2** — Plumb `register()` errors through a public callback (e.g., `<AppShell onSwError>`). (Filed.)
7. **P2** — Add SW lifecycle tests (install, activate, fetch routing, message handler). (Filed.)

Tests stay green at 266/266; this pass introduced no code changes.

# View Persistence

Crucible should make PWA and Electron apps feel like they resume natively after
refresh, relaunch, renderer reload, or service-worker update. The goal is not to
preserve the React heap. The goal is to reconstruct the same view from durable,
serializable state quickly enough that the user experiences a warm resume.

## Product Promise

Crucible restores views by combining:

- generated route metadata,
- the current URL and same-tab history entry key,
- Relay/app graph data,
- local-first data stores such as SQLite/OPFS,
- scroll and focus snapshots,
- opt-in form drafts,
- opt-in route view state,
- cached JS/query artifacts.

If the browser gives us BFCache, Crucible resumes the live document. If not,
Crucible recreates the last committed view from snapshots and then revalidates.

## Warm Resume Story

Crucible owns the route compiler, route runtime, Relay preloading, app graph,
AppShell, splash, and PWA/Electron boot path. That gives the framework enough
context to make refresh feel like native resume without pretending the old JS
process survived.

The story is:

1. The compiler knows every route, query, slot, intercept, and route ID.
2. On every committed navigation, the runtime writes a `ViewSnapshot`.
3. On reload/relaunch, Crucible validates the snapshot against build, schema,
   route manifest, URL, user scope, age, and route sensitivity.
4. If valid, the router restores that route state immediately.
5. Relay recreates query refs from generated route metadata.
6. Cached Relay/local-first data renders first.
7. The route revalidates in the background.
8. Splash is skipped or minimized only when restore is safe.
9. If anything is stale, invalid, corrupt, or sensitive, Crucible falls back to
   normal cold boot.

One-liner: Crucible cannot keep the old JS process alive, but it can make refresh
feel native by restoring the same route stack, data, scroll, focus, drafts, and
app state from compiler-backed snapshots, then revalidating.

## Hard Limits

A hard refresh creates a new JS realm. These cannot be persisted, even with OPFS:

- React fibers and component instances.
- Hook state, refs, closures, and event handlers.
- DOM nodes and live event listeners.
- `PreloadedQuery` retain handles.
- Suspense promises.
- Worker instances and live subscriptions.
- In-flight network requests.

OPFS gives durable bytes, not durable object identity. Therefore the framework
must persist explicit serializable state, not arbitrary running views.

## Architecture

Add a compiler-assisted `ViewSnapshot` layer above the router and below app code.

```ts
type ViewSnapshot = {
  version: number;
  buildId: string;
  schemaHash: string;
  routeManifestHash: string;
  userScope: string | null;
  entryKey: string;
  capturedAt: number;
  url: { pathname: string; search: string; hash: string };
  main: PersistedMatch | null;
  slots: Record<string, PersistedMatch | null>;
  underlay?: PersistedMatch | null;
  scroll: Record<string, { x: number; y: number }>;
  focus?: { id?: string; selector?: string; selectionStart?: number; selectionEnd?: number };
  forms?: Record<string, unknown>;
  viewState?: Record<string, unknown>;
};

type PersistedMatch = {
  routeId: string;
  path: string;
  params: Record<string, string>;
  kind: "page" | "default" | "intercept";
  slot?: string;
};
```

Use route IDs, not only URLs. This preserves native-feeling modal/intercept
state on same-tab refresh without changing cold deep-link behavior.

## Public API Direction

Route-level view persistence:

```ts
export const view = {
  persist: "entry",
  restore: ["stack", "slots", "scroll", "focus"],
  forms: "opt-in",
  maxAgeMs: 24 * 60 * 60 * 1000,
  sensitive: false,
  version: 1,
} satisfies Crucible.ViewConfig;
```

Optional directive for the common case:

```ts
"use view cache";
```

Serializable route-local state:

```tsx
const [draft, setDraft] = Crucible.useViewState(
  "compose-draft",
  () => ({ title: "", body: "" }),
  { version: 1, persist: "entry" },
);
```

Form drafts:

```tsx
<form data-crucible-draft="compose">
  <input name="title" />
  <textarea name="body" />
</form>
```

Nested scroll containers:

```tsx
<div data-crucible-scroll-id="inbox-list" />
```

Configuration naming should be app-level, not data-layer-specific. Crucible is a
Relay-native framework, so the config namespace is simply `persistence`:

```ts
export const persistence: CrucibleConfig["persistence"] = {
  store: "localStorage",
  scope: currentUserId,
  view: true,
};
```

## Storage Strategy

Use a layered store.

| Store | Use |
|---|---|
| `history.state` | Current entry key and tiny hints. |
| `sessionStorage` | First implementation for per-tab snapshots; sync read at boot. |
| IndexedDB | Durable async snapshots, indexes, migrations. |
| OPFS | SQLite/local-first domain data, outbox, large artifacts. |
| Cache Storage | App shell/assets and immutable blobs. |

Start with `sessionStorage` because warm boot needs synchronous availability.
Add IndexedDB once the boot/splash path supports async restoration. OPFS should
back local-first domain data, not every small router snapshot.

## Restore Rules

Use the snapshot only if all validation passes:

- build ID matches,
- route manifest hash matches,
- schema hash is compatible,
- current URL matches snapshot URL,
- persisted route IDs still exist,
- route is not `sensitive`,
- user/session scope matches,
- snapshot age is within `maxAgeMs`.

Failure falls back to normal cold route resolution.

Add a new internal nav source:

```ts
type NavSource = "init" | "soft" | "pop" | "restore";
```

`restore` must not arbitrarily activate intercept routes from the URL. It should
only restore intercept/modal state from a valid same-tab snapshot.

## Splash Behavior

Splash becomes conditional:

| Condition | Behavior |
|---|---|
| BFCache restore | No splash; live document resumes. |
| Valid warm snapshot and cached data likely available | Minimize/skip extended splash after first restored commit. |
| Local GraphQL boot must run | Keep splash until worker bootstrap completes or a threshold is exceeded. |
| Snapshot missing/stale/invalid | Normal splash. |
| Auth/session unknown | Keep splash or auth-specific shell. |
| Sensitive route | Normal boot; do not reveal persisted view state. |

## Compiler Responsibilities

Crucible codegen should:

- parse `export const view`, `export const cache`, and directives like
  `"use view cache"`,
- emit route persistence metadata,
- emit a route manifest hash,
- emit route IDs and query operation metadata,
- generate warm-restore boot hints,
- warn on unsafe form persistence,
- generate typed route builders,
- generate serializer/deserializer contracts for explicit view state,
- keep full query artifacts split from page chunks to avoid JS/data waterfalls,
- generate app graph resolvers so framework state is queryable through Relay.

Avoid arbitrary `useState` serialization in v1. Require explicit
`useViewState(...)` or form draft opt-in.

## Runtime Responsibilities

The runtime should:

- ensure every history entry has a stable Crucible entry key,
- capture committed route resolution after router commit acknowledgment,
- save snapshots on route commit, navigation start, debounced scroll/form
  changes, `pagehide`, `visibilitychange`, and update activation,
- restore snapshots before or during initial route resolution,
- recreate Relay query refs by running normal route preloading,
- restore scroll/focus before paint where possible,
- clear snapshots on logout/scope changes,
- suppress persistence on sensitive routes,
- treat corrupt/quota-failed snapshots as non-fatal,
- emit restore diagnostics for devtools.

## Advanced Web APIs To Track

Immediately useful:

- `pagehide` / `pageshow` for BFCache-aware checkpointing.
- `visibilitychange` for opportunistic saves.
- `PerformanceNavigationTiming` for reload/back-forward classification.
- IndexedDB for durable snapshots.
- Cache Storage for shell/assets/blob caches.
- `navigator.storage.persist()` and `estimate()` for quota/persistence UX.
- Web Locks for multi-tab write coordination.
- BroadcastChannel for cross-tab invalidation.
- Service Worker navigation preload for faster reloads.
- `structuredClone`, Transferables, and Compression Streams for snapshot safety
  and size control.

Experimental/watchlist:

- Navigation API for app-level navigation interception.
- View Transition API for restoration polish.
- Speculation Rules/prerender for likely next views.
- Storage Buckets for separating durable app data from disposable caches.
- Periodic Background Sync as an enhancement only.
- `scheduler.postTask` for non-blocking snapshot work.
- Launch Handler, protocol handlers, file handlers, and share targets for
  installed PWA relaunch intents.

Avoid as foundations:

- `beforeunload` as primary persistence trigger.
- `localStorage` for large snapshots.
- persisting React component trees or closures.
- requiring Background Sync for correctness.
- unversioned Cache Storage data.

## Implementation Phases

### Phase 1: Same-Tab Route Snapshot Restore

- Add history entry keys.
- Add `ViewSnapshot` and sessionStorage adapter.
- Persist committed main/slot matches by route ID.
- Add route manifest hash validation.
- Add internal `restore` source.
- Restore intercept dialogs only from matching same-tab snapshots.

### Phase 2: Scroll, Focus, And Drafts

- Persist window scroll and registered scroll containers.
- Restore focus for stable targets only.
- Add opt-in form drafts.
- Add `useViewState`.
- Add navigation/update dirty guards.

### Phase 3: Durable Async Stores

- Add IndexedDB view store.
- Add async Relay persistence option under `persistence`.
- Keep sync localStorage adapter for small apps.
- Keep local-first domain state in SQLite/OPFS.

### Phase 4: Compiler APIs

- Parse `view` / `cache` metadata.
- Generate diagnostics and typed helpers.
- Generate warm-restore boot hints.
- Add route state serializer contracts.

### Phase 5: Polish And Tooling

- Devtools restore inspector.
- `crucible doctor` checks for persistence, SW, manifest, quota, CSP.
- Reduced-motion-safe view transitions.
- Install/update banners integrated with dirty-state guards.

## Tests

Required coverage:

- snapshot validation and invalidation,
- same-tab restore of current route and slots,
- cold deep links do not restore intercepts,
- Relay query refs are recreated and disposed correctly,
- cached data renders immediately and revalidates,
- scroll/focus restore before paint where possible,
- sensitive routes suppress persistence,
- form drafts exclude sensitive controls,
- logout clears scoped persistence,
- corrupt/quota-failed snapshots do not block boot,
- BFCache still emits `crucible:resume`,
- SW update respects dirty-state guards,
- Electron renderer reload uses the same abstraction.

## Risks

- Overpromising heap persistence.
- Persisting sensitive form data.
- Restore crash loops.
- Multi-tab snapshot races.
- Large Relay/localStorage cache stalls.
- OPFS/IndexedDB quota and eviction.
- Route/schema/build mismatches.

Mitigations:

- explicit serializable APIs,
- sensitivity opt-out,
- route/user/build/schema/version keys,
- crash-loop fallback,
- same-tab entry keys,
- devtools restore decision logs.

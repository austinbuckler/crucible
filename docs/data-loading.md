# Data loading

Crucible doesn't do data fetching itself. It does **route-driven preloading** of Relay queries — meaning the page's queries fire in parallel with its code chunk, so the page doesn't suspend on data after the route splits. Components consume the preloaded queries via `usePreloadedQuery` from React Relay.

The pattern is borrowed from [Pastoria](http://pastoria.org) — same EntryPoint shape, same parallel-chunk-and-data preload, adapted for Vite + Relay. If you're new to Relay's `loadQuery` + `usePreloadedQuery` API, [the Relay docs](https://relay.dev/docs/api-reference/use-preloaded-query/) cover the primitives Crucible composes.

## The flow

```
nav to /orders/123
   ↓
matchRoute → match { route, params: { id: "123" } }
   ↓
match.route.entrypoint.getPreloadProps({ params, search })
   ↓ returns { queries: { orders: { parameters, variables } } }
   ↓
loadQuery(env, parameters, variables, { fetchPolicy: "store-and-network" })
   ↓
match.route.entrypoint.root.load()   ← starts loading the page chunk
   ↓
all in parallel
   ↓
React commit
   ↓
<PageRenderer> reads the chunk via JSResource (suspends if not ready)
   ↓
Page component receives { queries: { orders: PreloadedQuery<...> } }
   ↓
const data = usePreloadedQuery(graphql`...`, queries.orders)
   ↓
data renders (suspends if query still in-flight)
```

## What you write

```tsx
// src/app/orders/[id]/page.tsx
import * as Crucible from "crucible";
import { graphql, usePreloadedQuery } from "react-relay";
import type { OrderDetailQuery } from "./__generated__/OrderDetailQuery.graphql";

// 1. Declare the queries this page needs.
export type Queries = { order: OrderDetailQuery };

// 2. Optional metadata
export const metadata: Crucible.Metadata = { title: "Order" };

// 3. The component reads from `queries`, which crucible's runtime
//    populates with the loaded PreloadedQuery for each declared key.
export default function OrderDetailPage({
  queries,
  params,
}: Crucible.PageProps<"/orders/[id]">) {
  const data = usePreloadedQuery(
    graphql`
      query OrderDetailQuery($id: ID!) @preloadable {
        order(id: $id) { id, status, lines { sku, qty } }
      }
    `,
    queries.order,
  );
  return <pre>{JSON.stringify(data.order, null, 2)}</pre>;
}
```

The `@preloadable` directive on the query is required — relay-compiler emits a different artifact shape for preloadable queries that Crucible's codegen recognizes.

## What codegen does for you

For each `page.tsx`, codegen reads the `Queries` type and emits an entrypoint module like this:

```tsx
// .crucible/entrypoints/orders.[id].ts (generated)
import { JSResource, type EntryPoint } from "react-crucible/runtime/entrypoint.ts";
import query0 from "../../src/app/orders/[id]/__generated__/OrderDetailQuery.graphql.ts";
import type { OrderDetailQuery } from "../../src/app/orders/[id]/__generated__/OrderDetailQuery.graphql.ts";

type Queries = {
  order: { parameters: typeof query0; variables: OrderDetailQuery["variables"] };
};

const entrypoint: EntryPoint<Queries> = {
  root: JSResource("orders.[id]", () =>
    import("../../src/app/orders/[id]/page.tsx") as Promise<...>,
  ),
  getPreloadProps: ({ params }) => ({
    queries: {
      order: { parameters: query0, variables: { id: params.id } },
    },
  }),
};

export default entrypoint;
```

You don't write this. You don't read this. It's generated from your `Queries` type + the page's directory location + the operation's `variables` declaration in the GraphQL.

## Variable binding

Codegen automatically maps URL params to query variables when their names match:

| `Queries` declares | URL pattern | Variables passed |
|---|---|---|
| `OrderDetailQuery($id: ID!)` | `/orders/[id]` | `{ id: params.id }` |
| `ListQuery($limit: Int)` | `/items` | `{}` (no `limit` param) |
| `SearchQuery($q: String!, $limit: Int)` | `/search/[q]` | `{ q: params.q }` (no `limit` param) |

If your query needs a variable that isn't a URL param (e.g. a constant, or derived from search params), you can't get it through `getPreloadProps` automatically — the variable will be `undefined` at preload time. Either:

1. **Use `usePreloadedQuery` with `useLazyLoadQuery` for that field** — load the page's preloaded queries first, then fire a follow-up.
2. **Declare a sub-entrypoint** with its own `getPreloadProps`. (See "Sub-entrypoints" below.)

## The fetch policy

Every preload uses `fetchPolicy: "store-and-network"`. Behavior:

- **First visit:** no cached records → suspend on the network request.
- **Cached records exist (from a prior visit or warmup):** render immediately from cache; fire a network request in the background that updates the store. Components reactively re-render via Relay's subscriptions when fresh data lands.
- **No network:** render from cache if available, otherwise suspend (and the closest Suspense boundary's `loading.tsx` shows).

This is "stale-while-revalidate" semantics. The first paint is fast, the second paint is correct. For live feeds and similar near-realtime data, accept that some renders are stale-by-up-to-RTT.

To override per-page, accept the preloaded query and refetch as needed inside the component (see Relay's `useRefetchableFragment` and friends).

## The Relay store cache

Crucible persists Relay's `RecordSource` to `localStorage`, debounced ~500ms after writes. Cache key:

```
crucible.relay-cache.<schemaHash>
```

`schemaHash` is an FNV-1a hash of `schema.graphql` content, baked into the bundle at build time via `import.meta.env.CRUCIBLE_SCHEMA_HASH`. When the schema changes:

1. The hash changes → the cache key changes.
2. The new bundle reads from a fresh, empty cache → no records.
3. Old caches under prior hash keys are swept on boot (`sweepStaleCacheKeys`).

This means **a schema change orphans stale records instead of risking a returning user crashing on a removed/renamed field**. The cost is one full network round-trip per query on the first visit after a schema change.

You don't manage this manually. The plugin embeds the hash; the runtime reads it.

## Sub-entrypoints

A `page.tsx` can declare independent loadable units that don't block the page itself:

```tsx
// src/app/dashboard/page.tsx
import * as Crucible from "crucible";
import { graphql, usePreloadedQuery } from "react-relay";
import { Suspense } from "react";
import type { dashboardQuery } from "./__generated__/dashboardQuery.graphql";

export type Queries = { dashboard: dashboardQuery };

// EntryPoints declares the sub-entrypoints by name. Each value is a
// path to a sibling .tsx file that itself exports a default component
// + a `Queries` type.
export type EntryPoints = {
  sidebar: typeof import("./_sidebar.tsx");
  feed: typeof import("./_feed.tsx");
};

export default function Dashboard({
  queries,
  entryPoints,
}: Crucible.PageProps<"/dashboard">) {
  const data = usePreloadedQuery(
    graphql`query dashboardQuery @preloadable { viewer { name } }`,
    queries.dashboard,
  );
  return (
    <div>
      <h1>Hi, {data.viewer?.name}</h1>
      <Suspense fallback={<aside>Loading sidebar…</aside>}>
        <Crucible.EntryPointContainer entryPoint={entryPoints.sidebar} />
      </Suspense>
      <Suspense fallback={<section>Loading feed…</section>}>
        <Crucible.EntryPointContainer entryPoint={entryPoints.feed} />
      </Suspense>
    </div>
  );
}
```

```tsx
// src/app/dashboard/_sidebar.tsx
import { graphql, usePreloadedQuery } from "react-relay";
import * as Crucible from "crucible";
import type { sidebarQuery } from "./__generated__/sidebarQuery.graphql";

export type Queries = { sidebar: sidebarQuery };

export default function Sidebar({ queries }: Crucible.SubProps<Queries>) {
  const data = usePreloadedQuery(
    graphql`query sidebarQuery @preloadable { viewer { teams { name } } }`,
    queries.sidebar,
  );
  return <ul>{data.viewer?.teams.map((t) => <li key={t.name}>{t.name}</li>)}</ul>;
}
```

Behavior:
- All three queries (`dashboard`, `sidebar`, `feed`) fire **in parallel** when the route resolves.
- The `dashboard` query is required to render the page shell.
- Sub-entrypoints suspend independently inside their `<Suspense>` boundary — slow sidebar doesn't block fast feed.
- Sub-entrypoint code chunks split too: each `_sidebar.tsx` becomes its own bundle chunk.

This is useful when:
- A page has multiple data-heavy regions (sidebar, feed, ticker) that should appear independently.
- You want code-splitting at the sub-page level — sidebar code only loads when the dashboard is visited.

## Prefetch on hover/focus

`<Link>` warms the destination route's chunk + queries on hover, focus, or touchstart:

```tsx
import * as Crucible from "crucible";

<Crucible.Link to="/orders/123">View order</Crucible.Link>
```

Behavior:
- On `pointerEnter` / `focus` / `touchStart`, calls `prefetch(to)`.
- Resolves the matching route, fires `loadQuery(...)` for each, retains the query refs for `PREFETCH_TTL_MS` (30s by default).
- On click, the navigation finds the records already in the store (or the network requests already in-flight) and renders immediately.

Skipped automatically when:
- `prefetch={false}` is passed to `<Link>`
- `target="_blank"` (browser handles the click natively)
- Navigator reports `saveData: true` or `effectiveType: "slow-2g" | "2g"` (data-saver / poor connection)

## Idempotency

Multiple prefetches of the same URL are deduped:

```tsx
prefetch("/orders/123");  // fires
prefetch("/orders/123");  // no-op (already warm)
prefetch("/orders/123");  // no-op
```

## Transient retry (429 / 503)

The Relay network handler in `runtime/environment.ts` retries on **429 Too Many Requests** and **503 Service Unavailable** only — the two HTTP signals the server uses to mean "I'm overloaded, try me again shortly." Other statuses (4xx auth/validation failures, 5xx server bugs other than 503) are returned immediately; retrying just amplifies load.

**Schedule:** up to 3 retries with backoff `250ms / 500ms / 1000ms` and ±25% jitter. Jitter prevents many tabs hitting the same overloaded server from synchronizing their retry storms.

**Retry-After header:** when the response includes a numeric (seconds) `Retry-After`, the handler honors it instead of the schedule, capped at 5s. HTTP-date `Retry-After` values are ignored (rare in practice; the schedule kicks in).

**Network errors are NOT retried** at this layer — `fetch()` rejecting (offline, DNS failure, TLS error) propagates straight to the caller. Wire up your own offline-aware UX above the Relay error boundary if needed.

**Cancellation.** The handler bridges Relay's observable-unsubscribe pathway to an internal `AbortController`. When Relay drops a request — for example, a navigation supersedes the previous query, a `useQueryLoader` releases its retain, or a component using the request unmounts — the bridge fires `abort()` on the in-flight fetch AND interrupts any pending backoff sleep, so retries don't keep hammering the server for a result nobody will read. (Relay 20.1.1's `Network.create` does NOT pass an `AbortSignal` into the fetch closure; this is verified against the installed `relay-runtime` source. The bridge works by returning a `RelayObservable` whose cleanup function aborts our controller.) Net effect: cancelable, no manual plumbing required at call sites.

## Custom fetch

For requests that need request-scoped headers (idempotency keys, telemetry IDs, alternate auth schemes), supply a fetch function via the optional `src/app/crucible.config.ts` user-config module. Crucible's codegen detects the file and threads the exported `network.fetch` into `createEnvironment` automatically — you don't touch the bundle entry yourself.

```ts
// src/app/crucible.config.ts
import type { CrucibleConfig, FetchLike } from "crucible";

const idempotencyFetch: FetchLike = (url, init) => {
  // Only attach the header to GraphQL mutation POSTs. Queries pass
  // through unchanged.
  const looksLikeMutation =
    typeof init.body === "string" && /"query"\s*:\s*"\s*mutation\b/.test(init.body);
  if (!looksLikeMutation) return fetch(url, init);

  const headers = new Headers(init.headers);
  if (!headers.has("Idempotency-Key")) {
    headers.set("Idempotency-Key", crypto.randomUUID());
  }
  return fetch(url, { ...init, headers });
};

export const network: CrucibleConfig["network"] = {
  fetch: idempotencyFetch,
};
```

That's it — the codegen-emitted `.crucible/main.tsx` imports `network` from this file when it exists and passes `network.fetch` into `Crucible.createEnvironment({ fetch })`. No global `window.fetch` patch, no monkey-patching, no edits to the bundle entry.

**Composition.** Crucible's transient-retry layer (`fetchWithRetry`, the 429/503 schedule above) and the AbortSignal plumbing wrap your function — your wrapper is the innermost layer. Concretely, every retry attempt issues a fresh call into your fetch with the same `(url, init)`, and `init.signal` is the controller Crucible aborts on Relay-side unsubscribe (nav cancel, `useQueryLoader` release).

That layering matters in two ways:

1. **Headers reused across retries.** When you set `Idempotency-Key` in your wrapper, the retry layer re-issues the exact same `init` — server-side dedup observes a single key for all retries of one submission, which is the behavior you want for transient overload retries.
2. **Cancellation reaches you.** A Relay-side cancellation aborts `init.signal` — if you forward it (call `fetch(url, { ...init, ... })` rather than discarding `init`), retries through your wrapper interrupt cleanly instead of running to completion against a request nobody will read.

**Direct use without codegen.** If your app builds its own bootstrap (e.g. a non-codegen embedded runtime), call the factory directly:

```ts
import { createEnvironment, type FetchLike } from "crucible";
const customFetch: FetchLike = (url, init) => fetch(url, init);
const environment = createEnvironment({ fetch: customFetch });
```

The legacy positional form `createEnvironment(platform?)` is still supported — older codegen-emitted bundles call it that way and continue to work.

**Why a config file rather than a global patch.** Earlier Crucible-using apps installed wrappers as `window.fetch` overrides in a side-effect import. That worked but was architecturally smelly — every transitive consumer of `fetch` (analytics SDKs, file uploads, third-party widgets) silently flowed through the wrapper too, and tests that intercept `window.fetch` collided with the install order. The config file is scoped: only Relay's network handler sees the wrapped fetch, and apps that don't need a wrapper ship the original zero-config bundle.

## What you should NOT do

**Don't fire `loadQuery` from inside `useMemo` or render.** `loadQuery` is intentionally side-effectful — it mutates the Relay store. Calling it during render means a discarded render under concurrent scheduling leaks the query ref. Call it in event handlers (which Crucible does for navigation), in `useState` initializers, or in `useEffect`.

**Don't call `useLazyLoadQuery` for the page's primary data.** It works, but it forces a serial waterfall (chunk → render → query) instead of the parallel preload Crucible enables. Use the `Queries` type + `usePreloadedQuery` for primary data.

**Don't write to `localStorage` under the `crucible.relay-cache.*` prefix.** The runtime owns it.

## What you can do

**Refetch on demand.** Use Relay's `useRefetchableFragment` + `loadQuery` (in event handlers).

**Mutations.** Standard Relay — `useMutation`, `commitMutation`. The `RelayEnvironmentProvider` from `<App>` is in scope everywhere.

**Subscriptions.** Wire your own subscription handler into the Relay environment. The `createEnvironment()` from `runtime/environment.ts` accepts an extension point if you fork it; or build your own and pass it as `<App environment={myEnvironment} />`.

**Manual cache control.** `Relay.Environment.commitPayload`, `commitUpdate`, `getStore`. All standard Relay APIs.

**Disposing an environment.** `createEnvironment()` returns an `Environment` with a `dispose()` method. Call it ONLY when rotating environments — e.g. on logout/session-reset before constructing a fresh one. `dispose()` cancels any pending `localStorage` persistence write and locks out further writes from this environment's network handler, so the discarded environment can't race-write a stale `RecordSource` snapshot over the new one. The normal app lifetime never needs to dispose; the GC handles teardown.

## Persisted queries

Crucible reads a `persisted-queries.json` from the consuming app's root, generated by relay-compiler when configured with `persistConfig.localPath`. When a query has an `id` but no inline `text`, Crucible looks up the text in this map at request time and sends the inline text to the GraphQL server.

This is **client-side persisted-query expansion**, not APQ. The server doesn't need a persisted-query registry. To switch to true APQ (id-only requests, server-side resolution), modify the `Network.create` callback in `runtime/environment.ts` — it's about a 5-line change but requires server cooperation.

## Common patterns

### List + detail (master-detail)

```
src/app/items/page.tsx           ← list query, /items
src/app/items/[id]/page.tsx      ← detail query, /items/123
```

Click a list item → `<Link to="/items/123">` warms detail on hover → click navigates → detail renders from warm cache.

### Tabs that share a parent query

```tsx
// src/app/orders/[id]/layout.tsx
export type Queries = { order: orderShellQuery };
// renders the order's shared header, then {children}
```

```tsx
// src/app/orders/[id]/page.tsx (or .../activity/page.tsx etc.)
export type Queries = { details: orderDetailsQuery };
// renders the active tab's content
```

Both queries fire when the route resolves. Tabs that share a parent layout can read fragments off the parent's query via Relay fragments.

### Optimistic UI

Plain Relay — `useMutation({ optimisticUpdater })`. Crucible doesn't intervene.

### Polling

Plain Relay — `useEffect(() => { const id = setInterval(() => refetch(...), 5000); return () => clearInterval(id); }, [...]);`. Crucible doesn't intervene.

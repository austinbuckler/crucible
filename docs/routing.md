# Routing

Crucible's routing is a near-clone of Next.js's `app/` directory conventions, with deliberate omissions (no server components) and a few small additions (intercept routes apply uniformly; default routes match as URL prefixes). Read this top-to-bottom once and you have the whole model.

## The shape of `src/app/`

```
src/app/
├── layout.tsx            ← root layout (wraps everything)
├── page.tsx              ← matches "/"
├── splash.tsx            ← rendered to static HTML, inlined into index.html
├── manifest.ts           ← PWA manifest
├── globals.css           ← imported by main.tsx (where Tailwind goes)
│
├── orders/               ← /orders
│   ├── layout.tsx        ← wraps /orders/*
│   ├── page.tsx          ← matches "/orders"
│   ├── loading.tsx       ← Suspense fallback for this frame
│   ├── error.tsx         ← ErrorBoundary fallback for this frame
│   ├── not-found.tsx     ← NotFoundBoundary fallback
│   └── [id]/             ← dynamic param: params.id
│       └── page.tsx      ← matches "/orders/123"
│
├── (marketing)/          ← group: organizational, NOT in URL
│   ├── about/            ← /about (no /marketing/ prefix)
│   │   └── page.tsx
│   └── pricing/
│       └── page.tsx
│
├── @dialog/               ← parallel slot: layout receives `dialog` prop
│   ├── default.tsx       ← rendered when no dialog page matches
│   └── (.)create/        ← intercept route — fires only on soft nav
│       └── page.tsx
│
└── docs/
    └── [...path]/        ← catch-all: params.path = "a/b/c"
        └── page.tsx
```

## File roles

| File name | What it does |
|---|---|
| `page.tsx` | An exact-URL match. Renders the page component for that URL. Required for the route to be reachable. |
| `default.tsx` | A URL-prefix fallback. Renders when no `page.tsx` matches AND the slot has no preserved state to keep showing. |
| `layout.tsx` | Wraps every descendant page/sub-layout. Receives `children` plus any named slot props (see "Parallel slots" below). |
| `loading.tsx` | Suspense fallback for this frame. Renders while the page chunk or its queries are in-flight. |
| `error.tsx` | ErrorBoundary fallback for this frame. Receives `{ error, resetErrorBoundary }` from `react-error-boundary`. |
| `not-found.tsx` | NotFoundBoundary fallback. Renders when a descendant calls `Crucible.notFound()`. |
| `splash.tsx` | (Root only.) Rendered to static HTML at codegen time and inlined into `index.html` so it paints before any JS bundle parses. |
| `manifest.ts` | (Root only.) PWA manifest. Default export is a `Manifest` object or function returning one. |

## Directory conventions

| Pattern | Effect on URL | Effect on params |
|---|---|---|
| `orders/` | `/orders` | – |
| `[id]/` | `/[id]` (matches anything) | `params.id` is the URL-decoded segment |
| `[...path]/` | `/[...path]` (catch-all) | `params.path` is the remaining URL joined with `/` |
| `(group)/` | nothing — invisible to the URL | – |
| `@dialog/` | nothing — sub-tree contributes to the parent layout's `dialog` slot prop. (`@<name>/` works for any name; the directory name becomes the prop name.) | – |
| `(.)foo/` | `/foo` | – (intercept route; see below) |

These compose. `app/(marketing)/[locale]/page.tsx` matches `/{locale}` (no `marketing/`); `params.locale` carries the segment.

## Routing primitives in detail

### Pages

A `page.tsx` looks like this:

```tsx
import * as Crucible from "crucible";
import { graphql, usePreloadedQuery } from "react-relay";
import type { ordersQuery } from "./__generated__/ordersQuery.graphql";

export const query = graphql`
  query ordersQuery($id: ID!) @preloadable {
    order(id: $id) { id, status }
  }
`;

export const metadata: Crucible.Metadata = { title: "Orders" };

export default function OrdersPage({
  data,
  params,
  search,
}: {
  data: import("react-relay").PreloadedQuery<ordersQuery>;
  params: { id: string };
  search: URLSearchParams;
}) {
  const result = usePreloadedQuery(query, data);
  return <p>{result.order?.status}</p>;
}
```

Required exports:
- `export default function ...` — the React component. Receives `{ data, params, search }`.

Optional exports:
- `query` — a single Relay `graphql` operation with `@preloadable`. Codegen preloads it in parallel with the page chunk.
- `metadata: Crucible.Metadata` — merged into `<DocumentHead>`. See [metadata.md](./metadata.md).
- `searchParams` — Standard Schema validator. When present, `search` is the validator's output instead of `URLSearchParams`.

### Layouts

`layout.tsx` files wrap all pages beneath them:

```tsx
import type { ReactNode } from "react";
import * as Crucible from "crucible";

export const metadata: Crucible.Metadata = { themeColor: "#000" };

export default function OrdersLayout({
  children,
  dialog,                             // ← parallel slot @dialog/
}: {
  children: ReactNode;
  dialog: ReactNode;
}) {
  return (
    <>
      <nav>…</nav>
      {children}
      {dialog /* renders nothing if no @dialog route matched */}
    </>
  );
}
```

Layouts can declare their own `metadata`. Resolution is outermost-to-innermost; the page's `metadata` wins last.

### Loading / error / not-found

These three files contribute to the per-frame boundary stack:

```tsx
// orders/loading.tsx
export default function Loading() {
  return <div className="spinner" />;
}

// orders/error.tsx
import type { FallbackProps } from "react-error-boundary";
export default function Error({ error, resetErrorBoundary }: FallbackProps) {
  return (
    <div>
      <p>Something broke: {String(error)}</p>
      <button onClick={resetErrorBoundary}>Try again</button>
    </div>
  );
}

// orders/not-found.tsx
export default function NotFound() {
  return <p>Order not found.</p>;
}
```

The boundaries wrap the children at THIS frame's level. An error in `/orders/[id]/page.tsx` triggers `/orders/error.tsx` (its nearest ancestor with an `error.tsx`), or the parent's, walking up.

To trigger the not-found boundary deliberately:

```tsx
import { notFound } from "crucible";

if (!data.order) notFound(); // throws; nearest NotFoundBoundary catches
```

## Parallel slots (`@name/`)

Slots let a layout host multiple independent route trees that resolve in parallel, each with its own URL match. The canonical use case is an interceptable dialog:

```
src/app/
├── @dialog/
│   ├── default.tsx
│   └── (.)compose/
│       └── page.tsx
├── layout.tsx          ← receives `dialog` prop
└── compose/
    └── page.tsx        ← matches /compose on hard nav
```

The root layout receives the slot:

```tsx
export default function Root({
  children,
  dialog,
}: {
  children: ReactNode;
  dialog: ReactNode;
}) {
  return (
    <>
      {children}
      {dialog}
    </>
  );
}
```

The slot prop name comes from the directory name — `@dialog/` produces a `dialog` prop, `@notifications/` produces a `notifications` prop. There's nothing dialog-specific in the runtime; "dialog" is just the most common use case.

Resolution per slot, on every navigation:

1. **Intercept match** (only on soft nav — `<Link>` click or `navigate()`)
2. **Regular page match** in the slot's directory
3. **Last preserved match** (only on soft nav, when neither of the above hits — Next-style "dialog still open if you nav-without-closing")
4. **Default match** (`@dialog/default.tsx` — prefix-matches like a regular `default.tsx`)
5. `null` (nothing to render in this slot)

## Default routes (`default.tsx`)

`default.tsx` matches as a **URL prefix**. It renders when no `page.tsx` matches and:
- We're on a hard navigation (refresh, popstate, deep link), so there's no preserved last-match to keep showing, OR
- This is the children/main slot at a URL without a page match.

Defaults sort deepest-first, so the closest ancestor wins:

```
src/app/
├── default.tsx                   ← matches /, /, /foo, /bar/baz
└── orders/
    └── default.tsx               ← matches /orders, /orders/123, anything under /orders/*
```

A request for `/orders/something-not-a-page` renders `orders/default.tsx`. A request for `/dashboard/whatever` falls through to root `default.tsx`.

Dynamic params still bind on defaults:

```
src/app/
└── orgs/
    └── [id]/
        └── default.tsx          ← matches /orgs/abc, /orgs/abc/teams/x, etc.
                                   params.id = "abc" in either case
```

## Intercept routes (`(.)`, `(..)`, `(...)`)

Intercept routes only match during **soft navigation** — clicking a `<Link>`, calling `navigate()`. Hard navigation (refresh, popstate, deep link) skips them so the non-intercepting equivalent handles the URL.

Use case: open a dialog when navigating to a URL from a list view, but link directly to the full page if the user lands on the URL by refresh or paste.

```
src/app/
├── @dialog/
│   └── (.)photos/[id]/
│       └── page.tsx           ← dialog version
└── photos/
    └── [id]/
        └── page.tsx           ← full-page version
```

| User action | Match |
|---|---|
| Clicks `<Link to="/photos/42">` from `/feed` | `(.)photos/[id]` (dialog) |
| Refreshes on `/photos/42` | `photos/[id]` (full page) |
| Pastes `/photos/42` into address bar | `photos/[id]` (full page) |
| Clicks browser back from the dialog | Pop closes dialog, restores previous main route |

### A note on intercept "kinds"

Next.js distinguishes `(.)`, `(..)`, `(...)` to indicate where the intercepted route lives relative to the matching URL. **Crucible does not differentiate these kinds** — every truthy intercept fires on soft nav, period. The notation is preserved by codegen for file-system convention; the runtime treats all kinds identically.

Practical impact: if you mix `(.)foo` and `(..)foo` for the same URL, the first one in route order wins. Avoid mixing.

## Groups (`(name)/`)

A directory whose name is wrapped in `(...)` is **organizational, not part of the URL**. Use them to split the source tree without affecting routes:

```
src/app/
├── (marketing)/
│   ├── layout.tsx           ← applies to /about, /pricing, /contact
│   ├── about/page.tsx       ← /about
│   ├── pricing/page.tsx     ← /pricing
│   └── contact/page.tsx     ← /contact
└── (app)/
    ├── layout.tsx           ← applies to /dashboard, /orders, etc.
    ├── dashboard/page.tsx   ← /dashboard
    └── orders/page.tsx      ← /orders
```

Common usage: a different layout for marketing pages vs. the authenticated app.

## Type-safe URL params

Filesystem params are passed to the page as `params`:

```tsx
function OrdersPage({ params }: { params: { id: string } }) {
  // params is typed as { id: string }
  return null;
}
```

You can't pass an unknown URL string to `<Link>`'s `to` prop without TypeScript noticing — but `<Link>` accepts arbitrary strings to make `<Link to={\`/orders/${id}\`}>` work. Strict typing of `to` is a future iteration.

## Search params validation (Standard Schema)

Export `searchParams` to validate URL query parameters at the page boundary:

```tsx
import { z } from "zod";

export const searchParams = z.object({
  q: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(20),
});

export default function ListPage({
  search,
}: { search: { q?: string; limit: number } }) {
  // search is typed as { q?: string; limit: number }
  return <p>limit={search.limit}</p>;
}
```

Crucible runs the validator on every navigation. If it rejects, Crucible:
1. Identifies the offending top-level keys.
2. Drops them from the input.
3. Re-validates the filtered input.
4. Returns the result, OR `{}` if even the filtered input fails.

This means stray params (analytics tracking, manual URL edits, deprecated keys) silently drop without breaking the page.

Any [Standard Schema](https://standardschema.dev/) library works: Zod, Valibot, ArkType, etc.

## Soft nav vs hard nav

| Action | Source |
|---|---|
| `<Link>` click | `"soft"` |
| `navigate("/path")` programmatic | `"soft"` |
| Browser back/forward (`popstate`) | `"pop"` |
| Initial page load | `"init"` |
| Refresh (F5) | `"init"` |
| Deep link (paste URL) | `"init"` |

This is what gates intercept routes (soft only) and scroll/focus restoration semantics (init bypasses both).

## Next-style state preservation

Soft navigations preserve "last match" for the main outlet and each slot. Concretely:

- You navigate from `/feed` → click `<Link to="/orders/123">` → main = `orders/[id]`.
- Within the same session, you navigate to `/no-such-route`. Since there's no `page.tsx` match and no `default.tsx`, the previous `/orders/123` STAYS rendered.
- This is intentional — it's how modals preserve their underneath state.

On hard navigation, this preservation is dropped — the page resolves fresh from the URL.

## When you need an escape hatch

For navigation:

```tsx
import { useNavigate } from "crucible";

const navigate = useNavigate();
navigate("/orders/new");        // soft nav, history.pushState
```

For prefetching:

```tsx
import { usePrefetch } from "crucible";

const prefetch = usePrefetch();
prefetch("/orders/new");        // warm the chunk + queries, idempotent
```

For URL inspection:

```tsx
import { useLocation, useParams, useSearchParams } from "crucible";

const location = useLocation();         // { pathname, search, hash }
const params = useParams<{id: string}>();   // typed by you when you call it
const sp = useSearchParams();           // raw URLSearchParams
```

For programmatic 404:

```tsx
import { notFound } from "crucible";

if (!data) notFound();          // throws; nearest NotFoundBoundary catches
```

## What's not implemented

- **Server components.** Hard limit. Crucible is SPA-only by design.
- **Streaming SSR.** Same.
- **Static export.** No prerendering. Hash-routed deployment is out of scope; Vercel-shaped same-origin deploys are the supported target.
- **Per-page SSG / ISR.** Same.
- **Locale-aware routing primitives.** Implement via custom `matcher` strategy if needed.

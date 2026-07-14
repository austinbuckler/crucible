import type { ComponentType, ReactNode } from "react";
import type { FallbackProps } from "react-error-boundary";
import type { PreloadedQuery } from "react-relay";
import type {
  EntryPoint,
  JSResource,
  QueryParameter,
} from "../entrypoint.ts";
import type { Metadata } from "../metadata.tsx";

// One segment of a route path, as discovered by codegen at build time.
export type RouteSegment =
  | { kind: "literal"; value: string }
  | { kind: "param"; name: string }
  | { kind: "catchall"; name: string };

// Layout module shape — what a `layout.tsx` file is expected to export.
// Accepts `children` plus any number of named slot props. User-authored
// layouts can narrow this — e.g. `{ children; dialog? }` — and the runtime
// spreads `slotProps` so destructuring works either way.
export type LayoutModule = {
  default: ComponentType<{ children: ReactNode } & Record<string, ReactNode>>;
  metadata?: Metadata;
};

// One frame ≈ one directory level on the way to a page. The router wraps
// the children with whatever boundaries this frame declares (each
// optional). Layouts are lazy (JSResource) because they share their first
// paint with the page chunk. Boundary fallbacks (loading/error/notFound)
// are EAGER — they must render synchronously when their boundary fires,
// and a Suspense fallback can't itself suspend.
export type Frame = {
  layout?: JSResource<LayoutModule>;
  loading?: ComponentType;
  error?: ComponentType<FallbackProps>;
  notFound?: ComponentType;
  // Names of `@<slot>` directories at this frame's directory level. The
  // layout receives each slot as a named prop alongside `children`.
  slots?: ReadonlyArray<string>;
  // Number of URL segments consumed up to and including this frame's
  // directory. The root layout has depth 0; `/orders/layout.tsx` has
  // depth 1; `/orders/[id]/layout.tsx` has depth 2. Codegen emits this
  // so `useSelectedLayoutSegment` can read the segment at the calling
  // layout's URL position. Optional for back-compat — absent values are
  // treated as depth 0.
  urlDepth?: number;
};

// A discovered route. Codegen produces a `RouteRecord[]` from `src/app/`
// at build time; the router consumes it at runtime.
export type RouteRecord = {
  path: string;
  segments: ReadonlyArray<RouteSegment>;
  frames: ReadonlyArray<Frame>;
  entrypoint: EntryPoint<Record<string, QueryParameter>>;
  // When set, this route is a slot-only route. The router matches it
  // against the URL alongside the main route; the matched slot route
  // renders into the parent layout's slot prop.
  slot?: string;
  // When truthy, this route only matches during soft navigation. Hard
  // navigation (refresh, popstate, deep link) skips intercept routes so
  // the non-intercepting equivalent handles the URL.
  //
  // The Next.js intercept-kind notation (`.`, `..`, `...`) is preserved
  // by codegen for file-system convention, but the router treats every
  // truthy value identically — fire on soft nav. Distinguishing
  // "from same level" vs "from one level up" requires tracking the
  // intercept's source-directory depth, which the current scan doesn't
  // emit. Practical impact: if you mix `(.)foo` and `(..)foo` for the
  // same URL, the first one in route order wins. Avoid mixing.
  intercept?: string | true;
  // "default" routes correspond to a `default.tsx` file. They're prefix
  // fallbacks: when no `page` route in the same slot (or in the main
  // tree) matches the URL and we can't preserve a previous match
  // (cold load / hard nav), the deepest default whose `path` is an
  // ancestor of the URL renders. Omitted means "page" (exact-URL match).
  kind?: "default";
};

// Parsed URL the router operates on. We carry the parsed pieces so
// downstream code doesn't re-parse for every read.
export type Location = {
  pathname: string;
  search: URLSearchParams;
  hash: string;
};

// What a successful URL match yields: the route + its bound params.
export type Match = {
  route: RouteRecord;
  params: Record<string, string>;
};

// How we arrived at the current location. Used to gate intercepts (only
// fire on soft nav) and scroll/focus behavior (skip on init).
export type NavSource = "init" | "soft" | "pop";

// A loaded entrypoint: route + preloaded queries.
export type LoadedEntrypoint = {
  route: RouteRecord;
  preloaded: Record<string, PreloadedQuery<never>>;
};

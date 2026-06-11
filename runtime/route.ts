// Runtime + types for the omakase page contract.
//
//   export const Route = Crucible.Route("/clients/[id]", {
//     query: clientPageQuery,
//     search: { tab: ["orders", "docs"] as const },
//     title: ({ data }) => data.client?.name ?? "Client",
//     Entrypoint: { Sidebar, Feed },
//   });
//
//   export default Route.page(({ data, params, search }) => { ... });
//
// At runtime, `Crucible.Route(...)` is a thin builder that holds the
// config and exposes the `Entrypoint` namespace + `page` wrapper. The
// codegen at build time recognizes the call site, reads the URL
// pattern + config, and emits the routing manifest accordingly.
//
// The codegen does the load-bearing work; this runtime is the seam
// the user writes against. Types here pin the shape so consumers get
// autocomplete and inference from the URL pattern.

import type { ComponentType, ReactElement } from "react";
import type { OperationType } from "relay-runtime";
import type { PreloadedQuery } from "react-relay";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Metadata } from "./metadata.tsx";

// ── Search-config grammar ───────────────────────────────────────────────
//
// Search specs are Standard Schema validators — the protocol every
// modern TS schema lib speaks (Zod, Valibot, ArkType, Effect Schema):
//
//   import { Schema } from "effect";
//   search: Schema.Struct({
//     tab: Schema.optional(Schema.Literal("orders", "docs")),
//   })
//
// Pages without a `search` config receive `URLSearchParams` directly.

export type SearchSpec = StandardSchemaV1;

export type InferSearch<S> = S extends StandardSchemaV1<unknown, infer Out>
  ? Out
  : URLSearchParams;

// ── URL-pattern → params type ───────────────────────────────────────────
//
// "/clients/[id]"           → { id: string }
// "/orders/[id]/edit"       → { id: string }
// "/posts/[...slug]"        → { slug: string }
// "/" or "/orders"          → {}

export type InferParams<Pattern extends string> =
  Pattern extends `${string}[...${infer Name}]${infer Rest}`
    ? { [K in Name | keyof InferParams<Rest>]: string }
    : Pattern extends `${string}[${infer Name}]${infer Rest}`
      ? { [K in Name | keyof InferParams<Rest>]: string }
      : Record<string, never>;

// ── Route config ────────────────────────────────────────────────────────

export type RouteConfig<
  TQuery extends OperationType,
  TSearch extends SearchSpec | undefined,
  TEntrypoint extends Record<string, ComponentType<never>> | undefined,
> = {
  // The Relay operation type whose preloaded ref is passed as `data` to
  // the page. `query: typeof someQueryType` — phantom carrier; codegen
  // resolves the actual ConcreteRequest from the type identifier and
  // generates the entrypoint accordingly.
  query?: TQuery;
  // Search-param spec (Standard Schema validator).
  search?: TSearch;
  // Static page title for the document head. For dynamic titles that
  // depend on the page's resolved data, call `Crucible.useDocumentTitle`
  // from inside the page body — it composes naturally with React's
  // data flow and doesn't require head-layer Relay-store gymnastics.
  title?: string;
  // Static document metadata (description, OG, twitter, etc.). Use the
  // typed setters from `Crucible.useMetadata()` for data-derived values.
  meta?: Metadata;
  // Sub-entrypoints. Capitalized keys so JSX consumes them naturally:
  //   Entrypoint: { Sidebar, Feed }    →    <Route.Entrypoint.Sidebar />
  Entrypoint?: TEntrypoint;
  // Override seam for getPreloadProps. Default is name-matching: a
  // query variable `id` is wired to URL param `id`. Use `preload` when
  // the names diverge (e.g. variable `productId` ↔ URL param `product`).
  preload?: (arg: {
    params: Record<string, string>;
    search: InferSearch<TSearch>;
  }) => { variables?: TQuery["variables"] };
};

// ── Route object — what `Crucible.Route(...)` returns ───────────────────

export type RoutePageProps<
  TQuery extends OperationType,
  TParams,
  TSearch,
> = {
  data: PreloadedQuery<TQuery>;
  params: TParams;
  search: TSearch;
};

export type RouteObject<
  Pattern extends string,
  TQuery extends OperationType,
  TSearch extends SearchSpec | undefined,
  TEntrypoint extends Record<string, ComponentType<never>> | undefined,
> = {
  // Wrap a function component into the page's default export. The
  // wrapper is identity at runtime; its job is to thread the typed
  // props shape through the page module's default export so the
  // codegen knows what props to feed it.
  page: (
    fn: (
      props: RoutePageProps<TQuery, InferParams<Pattern>, InferSearch<TSearch>>,
    ) => ReactElement | null,
  ) => ComponentType<
    RoutePageProps<TQuery, InferParams<Pattern>, InferSearch<TSearch>>
  >;
  // Sub-entrypoint namespace. JSX-friendly:
  //   <Route.Entrypoint.Sidebar client={client} />
  // The runtime here is just the same object the user passed in
  // `config.Entrypoint`. Codegen wires the parallel-load semantics
  // separately by recognizing this property at parse time.
  Entrypoint: TEntrypoint extends undefined
    ? Record<string, never>
    : NonNullable<TEntrypoint>;
  // The original config object, exposed at runtime so the router can
  // read `title` for `<DocumentHead>` and `search` for searchParams
  // validation without re-parsing the page module's source.
  config: RouteConfig<TQuery, TSearch, TEntrypoint>;
};

// ── Factories ───────────────────────────────────────────────────────────

/**
 * Define a route. The codegen reads this call site at build time
 * (URL pattern, query type, search spec, entrypoint map) and emits
 * the routing manifest. At runtime, returns a thin object that wraps
 * the page component and exposes the entrypoint namespace.
 *
 * For pages with dynamic titles or metadata (callbacks that read
 * `data`), bind the page's query as the first generic so the
 * callbacks receive a typed `data.response`:
 *
 *   Crucible.Route<page_TeamMemberQuery>("/team/[memberId]", {
 *     title: ({ data }) => data.node?.userName ?? "Member",
 *   })
 *
 * Pages with static titles can omit the generic — `babel-plugin-relay`
 * pins the response type at the `usePreloadedQuery` call site, so the
 * page body stays correctly typed either way.
 */
export function Route<
  TQuery extends OperationType = OperationType,
  Pattern extends string = string,
  TSearch extends SearchSpec | undefined = undefined,
  TEntrypoint extends
    | Record<string, ComponentType<never>>
    | undefined = undefined,
>(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  pattern: Pattern,
  config: RouteConfig<TQuery, TSearch, TEntrypoint>,
): RouteObject<Pattern, TQuery, TSearch, TEntrypoint> {
  return {
    // Page wrapper is identity at runtime. The wrapper's value is
    // type-level: it constrains the function's argument to the
    // route's typed props shape.
    page: (fn) => fn as never,
    Entrypoint: (config.Entrypoint ?? {}) as never,
    config,
  };
}

/**
 * Mark a file as a sub-entrypoint. The codegen recognizes files
 * whose default export is `Crucible.Entrypoint(...)` and wires them
 * for parallel preloading alongside their parent route's queries.
 *
 * Runtime no-op: returns the component unchanged. The semantic is
 * carried by the wrapper's identity so the codegen can detect it
 * statically (via the call expression) without runtime introspection.
 */
export function Entrypoint<TProps>(
  component: ComponentType<TProps>,
): ComponentType<TProps> {
  return component;
}

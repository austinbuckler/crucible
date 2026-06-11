import type { ComponentType } from "react";
import type { JSResource, QueryParameter, SubModule } from "../entrypoint.ts";
import {
  DocumentHead,
  PageMetadataOverrideProvider,
  type Metadata,
} from "../metadata.tsx";
import type { RouteObject } from "../route.ts";
import { readResource } from "./load.ts";
import { validateSearchParams } from "./search-params.ts";
import type { LoadedEntrypoint, LoadedSubEntrypoint } from "./types.ts";

// Renders the leaf page component for a loaded entrypoint. Handles:
//   - readResource(entrypoint.root): synchronously reads or suspends.
//   - metadata layering: outer layouts → inner layouts → page (last wins).
//   - searchParams validation via Standard Schema (Route.config.search).
//
// Page modules export `const Route = Crucible.Route(pattern, config)`
// (omakase contract): the runtime reads `Route.config.title` for the
// document head and `Route.config.search` for searchParams validation.
// The page receives the unwrapped `data` (the single @preloadable
// PreloadedQuery from `loaded.preloaded.data`) plus `params`, `search`,
// and the resolved sub-entrypoints map.
export function PageRenderer({
  loaded,
  params,
  rawSearch,
}: {
  loaded: LoadedEntrypoint;
  params: Record<string, string>;
  rawSearch: URLSearchParams;
}) {
  const pageModule = readResource(loaded.route.entrypoint.root);
  const Page = pageModule.default as ComponentType<Record<string, unknown>>;
  const route = (
    pageModule as { Route?: RouteObject<string, never, never, never> }
  ).Route;

  // Outer layouts → inner layouts → page (last wins). `Route.config`
  // carries static title + meta for the page layer; pages that need
  // data-derived titles call `Crucible.useDocumentTitle` from the
  // body so the title flows naturally through React's normal render.
  const pageMetadata: Metadata | undefined =
    route?.config?.title || route?.config?.meta
      ? {
          ...(route.config.meta ?? {}),
          ...(route.config.title ? { title: route.config.title } : {}),
        }
      : undefined;
  const metadataLayers: ReadonlyArray<Metadata | undefined> = [
    ...loaded.route.frames.map(
      (f) => f.layout?.getModuleIfRequired()?.metadata,
    ),
    pageMetadata,
  ];

  const searchSpec = route?.config?.search;
  const search = searchSpec
    ? validateSearchParams(searchSpec, rawSearch)
    : rawSearch;

  // Single primary query is keyed `data` by codegen; pages without a
  // `@preloadable` operation get `undefined`, which their typed signature
  // wouldn't have asked for.
  const data = loaded.preloaded["data"];

  // Mount an override provider so the page body can publish a
  // `Metadata` patch via `useDocumentTitle` / `useMetadata`. The
  // provider's render-prop pattern means PageRenderer re-renders
  // DocumentHead when the page calls a setter, threading the override
  // onto the existing layer stack as the topmost layer.
  return (
    <PageMetadataOverrideProvider>
      {(override) => (
        <>
          <DocumentHead layers={[...metadataLayers, override]} />
          <Page
            data={data}
            params={params}
            search={search}
            entryPoints={loaded.entryPoints}
          />
        </>
      )}
    </PageMetadataOverrideProvider>
  );
}


// Renders a sub-entrypoint with its preloaded queries. Pages access this
// via `entryPoints.<name>` and wrap it in `<Suspense>` to control the
// fallback while the sub's chunk + queries are in-flight.
export function EntryPointContainer({
  entryPoint,
}: {
  entryPoint: LoadedSubEntrypoint;
}) {
  const mod = readResource(
    entryPoint.ep.root as JSResource<SubModule<Record<string, QueryParameter>>>,
  );
  const Component = mod.default as ComponentType<Record<string, unknown>>;
  return (
    <Component
      queries={entryPoint.preloaded}
      entryPoints={entryPoint.entryPoints}
    />
  );
}

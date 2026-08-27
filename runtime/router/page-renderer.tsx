import type { ComponentType } from "react";
import {
  DocumentHead,
  PageMetadataOverrideProvider,
  type Metadata,
} from "../metadata.tsx";
import type { SearchSpec } from "../route.ts";
import { readResource } from "./load.ts";
import { validateSearchParams } from "./search-params.ts";
import type { LoadedEntrypoint } from "./types.ts";

// Renders the leaf page component for a loaded entrypoint. Handles:
//   - readResource(entrypoint.root): synchronously reads or suspends.
//   - metadata layering: outer layouts → inner layouts → page (last wins).
//   - searchParams validation via Standard Schema (`export const searchParams`).
//
// Page modules use direct exports: `metadata`, `searchParams`, and `query`.
// The page receives the unwrapped `data` (the single
// @preloadable PreloadedQuery from `loaded.preloaded.data`) plus `params`,
// and `search`.
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

  // Outer layouts → inner layouts → page (last wins). Pages that need
  // data-derived titles call `Crucible.useDocumentTitle` from the body so the
  // title flows naturally through React's normal render.
  const metadataLayers: ReadonlyArray<Metadata | undefined> = [
    ...loaded.route.frames.map(
      (f) => f.layout?.getModuleIfRequired()?.metadata,
    ),
    (pageModule as { metadata?: Metadata }).metadata,
  ];

  const searchSpec = (pageModule as { searchParams?: SearchSpec }).searchParams;
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
          />
        </>
      )}
    </PageMetadataOverrideProvider>
  );
}

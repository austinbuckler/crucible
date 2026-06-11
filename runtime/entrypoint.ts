import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  ConcreteRequest,
  OperationType,
  PreloadableConcreteRequest,
  Variables,
} from "relay-runtime";
import type { Metadata } from "./metadata.tsx";

// JSResource caches the entire module record (not just its default export) so
// callers can also read sibling exports — e.g. `metadata` from a page or
// layout. Use `readResource(resource).default` to get the component.
export type JSResource<T extends object> = {
  readonly moduleId: string;
  load: () => Promise<T>;
  getModuleIfRequired: () => T | null;
};

export function JSResource<T extends object>(
  moduleId: string,
  loader: () => Promise<T>,
): JSResource<T> {
  let cached: T | null = null;
  let pending: Promise<T> | null = null;
  return {
    moduleId,
    getModuleIfRequired: () => cached,
    load: () => {
      if (cached) return Promise.resolve(cached);
      if (pending) return pending;
      // Capture the promise locally so the rejection path can clear
      // `pending` only if it still points at this attempt — otherwise a
      // retry kicked off concurrently could clobber a pending success.
      const attempt = loader().then(
        (mod) => {
          cached = mod;
          if (pending === attempt) pending = null;
          return mod;
        },
        (err) => {
          // CRITICAL: clear `pending` on rejection so the next call to
          // load() retries the dynamic import instead of returning the
          // same rejected promise forever. Without this, the error
          // boundary's "Try again" button (resetErrorBoundary →
          // remount → readResource → load()) is broken — every retry
          // returns the cached rejection immediately.
          if (pending === attempt) pending = null;
          throw err;
        },
      );
      pending = attempt;
      return attempt;
    },
  };
}

export type PreloadParams = {
  params: Record<string, string>;
  search: URLSearchParams;
};

export type QueryParameter = {
  parameters: ConcreteRequest | PreloadableConcreteRequest<OperationType>;
  variables: Variables;
};

import type { ComponentType } from "react";

export type PageModule<
  TQueries extends Record<string, QueryParameter>,
  TParams = Record<string, string>,
  TSearch = URLSearchParams,
  TEntryPoints = Record<string, unknown>,
> = {
  default: ComponentType<{
    queries: TQueries;
    params: TParams;
    search: TSearch;
    entryPoints: TEntryPoints;
  }>;
  metadata?: Metadata;
  // When present, must be a Standard Schema-compliant validator. Crucible
  // calls its `~standard.validate` against URLSearchParams entries on every
  // navigation and types `PageProps['search']` as the schema's output.
  searchParams?: StandardSchemaV1;
};

// Sub-entrypoint module shape — a non-page tsx file that declares its own
// Queries. Receives only `queries` + (optionally) nested `entryPoints` —
// no params / search (those are page-scoped).
export type SubModule<
  TQueries extends Record<string, QueryParameter>,
  TEntryPoints = Record<string, unknown>,
> = {
  default: ComponentType<{
    queries: TQueries;
    entryPoints: TEntryPoints;
  }>;
  metadata?: Metadata;
};

export type EntryPoint<TQueries extends Record<string, QueryParameter>> = {
  root: JSResource<PageModule<TQueries>>;
  getPreloadProps: (preload: PreloadParams) => { queries: TQueries };
  // Sub-entrypoints declared by the page's `EntryPoints` type. Each is a
  // standalone EntryPoint definition. The router loads them in parallel
  // with the page's queries; pages render them via `<EntryPointContainer>`.
  entryPoints?: Record<string, SubEntryPoint<Record<string, QueryParameter>>>;
};

// A non-page entrypoint. Same preload mechanics as a page entrypoint, but
// the loaded module shape is `SubModule` (no params/search).
export type SubEntryPoint<TQueries extends Record<string, QueryParameter>> = {
  root: JSResource<SubModule<TQueries>>;
  getPreloadProps: (preload: PreloadParams) => { queries: TQueries };
  entryPoints?: Record<string, SubEntryPoint<Record<string, QueryParameter>>>;
};

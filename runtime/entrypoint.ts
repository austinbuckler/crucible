import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { PreloadedQuery } from "react-relay";
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

type PageData<TQueries extends Record<string, QueryParameter>> =
  TQueries extends {
    data: {
      parameters:
        | ConcreteRequest
        | PreloadableConcreteRequest<infer TOperation extends OperationType>;
    };
  }
    ? PreloadedQuery<TOperation>
    : undefined;

import type { ComponentType } from "react";

export type PageModule<
  TQueries extends Record<string, QueryParameter>,
  TParams = Record<string, string>,
  TSearch = URLSearchParams,
> = {
  default: ComponentType<{
    data: PageData<TQueries>;
    params: TParams;
    search: TSearch;
  }>;
  metadata?: Metadata;
  // When present, must be a Standard Schema-compliant validator. Crucible
  // calls its `~standard.validate` against URLSearchParams entries on every
  // navigation. Page props receive the schema's output as `search`.
  searchParams?: StandardSchemaV1;
};

export type EntryPoint<TQueries extends Record<string, QueryParameter>> = {
  root: JSResource<PageModule<TQueries>>;
  getPreloadProps: (preload: PreloadParams) => { queries: TQueries };
};

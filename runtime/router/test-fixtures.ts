// Typed fixture helpers shared by router tests. Uses the framework's
// real `EntryPoint` / `LayoutModule` types so we don't need `as any`
// casts inside individual test files.

import type { ComponentType } from "react";
import {
  JSResource,
  type EntryPoint,
  type PageModule,
  type QueryParameter,
} from "../entrypoint.ts";
import type { LayoutModule, RouteRecord, RouteSegment } from "./types.ts";

type AnyQueries = Record<string, QueryParameter>;

/** Empty default-exporting page module — satisfies PageModule's structural shape. */
function emptyPageModule(): PageModule<AnyQueries> {
  return { default: () => null };
}

function emptyLayoutModule(): LayoutModule {
  return { default: () => null };
}

/**
 * JSResource factory for a page module + load-counter ref. The counter
 * lets tests assert that `load()` fires the expected number of times
 * without monkey-patching prototypes.
 */
export function fakePageResource(moduleId = "page-mod") {
  const counter = { value: 0 };
  const r = JSResource(moduleId, () => {
    counter.value++;
    return Promise.resolve(emptyPageModule());
  });
  return Object.assign(r, { _loadCount: counter });
}

export function fakeLayoutResource(moduleId = "layout-mod") {
  const counter = { value: 0 };
  const r = JSResource(moduleId, () => {
    counter.value++;
    return Promise.resolve(emptyLayoutModule());
  });
  return Object.assign(r, { _loadCount: counter });
}

/** Standard "no queries" entrypoint for routing tests. */
export function fakeEntrypoint(moduleId = "page-mod"): EntryPoint<AnyQueries> {
  return {
    root: fakePageResource(moduleId),
    getPreloadProps: () => ({ queries: {} }),
  };
}

/**
 * Full RouteRecord factory. Path is derived from segments for readability.
 * Override anything via `extras`.
 */
export function makeRoute(
  segments: ReadonlyArray<RouteSegment>,
  extras: Partial<RouteRecord> = {},
): RouteRecord {
  return {
    path: "/" + segments.map(segmentToPath).join("/"),
    segments,
    frames: [],
    entrypoint: fakeEntrypoint(),
    ...extras,
  };
}

function segmentToPath(s: RouteSegment): string {
  if (s.kind === "literal") return s.value;
  if (s.kind === "param") return `[${s.name}]`;
  return `[...${s.name}]`;
}

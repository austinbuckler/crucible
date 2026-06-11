import { existsSync, readdirSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

export type RouteSegment =
  | { kind: "literal"; value: string }
  | { kind: "param"; name: string }
  | { kind: "catchall"; name: string };

export type FrameLevel = {
  layout?: string;
  loading?: string;
  error?: string;
  notFound?: string;
  // Slot names whose `@<name>` directory is a child of this frame's
  // directory. The parent layout receives each one as a named prop alongside
  // `children`.
  slots?: ReadonlyArray<string>;
  // Number of URL segments consumed up to and including this frame's
  // directory. `app/layout.tsx` has depth 0; `app/orders/layout.tsx`
  // has depth 1; `app/orders/[id]/layout.tsx` has depth 2. The runtime
  // hook `useSelectedLayoutSegment` reads this to resolve "the segment
  // below the calling layout's URL position".
  urlDepth: number;
};

export type InterceptKind = "." | ".." | "...";

export type DiscoveredRoute = {
  urlPath: string;
  id: string;
  segments: ReadonlyArray<RouteSegment>;
  // For "page" routes, this is `page.tsx`; for "default" routes, `default.tsx`.
  pageFile: string;
  frames: ReadonlyArray<FrameLevel>;
  // When set, this is a parallel-slot route. The router matches it against
  // the URL alongside the main route and renders it into the parent layout's
  // matching slot prop.
  slot?: string;
  // When set, this route only matches during soft navigation (Link click,
  // navigate() call). On hard navigation (refresh, popstate, deep link) it
  // is filtered out so the non-intercepting equivalent route handles the
  // URL. Used for "dialog over current view" UX.
  intercept?: InterceptKind;
  // "page" — exact-URL match (page.tsx).
  // "default" — prefix fallback (default.tsx). Renders when no page matches
  // and either we're on a hard nav or the slot has no last-rendered page to
  // preserve. The default's `urlPath`/`segments` describe the directory it
  // sits in; the router treats it as covering all URLs under that prefix.
  kind: "page" | "default";
};

const DIR_PARAM = /^\[([^.\]]+)\]$/;
const DIR_CATCHALL = /^\[\.\.\.([^\]]+)\]$/;
const DIR_GROUP = /^\(([^)]+)\)$/;
const DIR_SLOT = /^@(.+)$/;
const DIR_INTERCEPT = /^\((\.{1,3})\)(.+)$/;

type SegmentClassification = {
  segment: RouteSegment | null;
  intercept?: InterceptKind;
};

function classifySegment(name: string): SegmentClassification {
  const ic = DIR_INTERCEPT.exec(name);
  if (ic) {
    const inner = classifySegment(ic[2]!);
    return { ...inner, intercept: ic[1] as InterceptKind };
  }
  const catchall = DIR_CATCHALL.exec(name);
  if (catchall) return { segment: { kind: "catchall", name: catchall[1]! } };
  const param = DIR_PARAM.exec(name);
  if (param) return { segment: { kind: "param", name: param[1]! } };
  if (DIR_GROUP.test(name)) return { segment: null };
  return { segment: { kind: "literal", value: name } };
}

function urlSegment(seg: RouteSegment): string {
  switch (seg.kind) {
    case "literal":
      return seg.value;
    case "param":
      return `[${seg.name}]`;
    case "catchall":
      return `[...${seg.name}]`;
  }
}

function routeIdFromSegments(
  segments: ReadonlyArray<RouteSegment>,
  slot: string | undefined,
  intercept: InterceptKind | undefined,
  kind: "page" | "default",
): string {
  const base =
    segments.length === 0
      ? "index"
      : segments
          .map((s) =>
            s.kind === "literal"
              ? s.value
              : s.kind === "param"
                ? `[${s.name}]`
                : `[...${s.name}]`,
          )
          .join(".");
  let id = slot ? `@${slot}.${base}` : base;
  if (intercept) id = `intercept_${intercept.length}.${id}`;
  if (kind === "default") id = `default.${id}`;
  return id;
}

function readFrame(
  absDir: string,
  slotsHere: ReadonlyArray<string>,
  urlDepth: number,
): FrameLevel {
  const frame: FrameLevel = { urlDepth };
  const layout = join(absDir, "layout.tsx");
  if (existsSync(layout)) frame.layout = layout;
  const loading = join(absDir, "loading.tsx");
  if (existsSync(loading)) frame.loading = loading;
  const error = join(absDir, "error.tsx");
  if (existsSync(error)) frame.error = error;
  const notFound = join(absDir, "not-found.tsx");
  if (existsSync(notFound)) frame.notFound = notFound;
  if (slotsHere.length > 0) frame.slots = slotsHere;
  return frame;
}

function frameIsEmpty(frame: FrameLevel): boolean {
  return (
    !frame.layout &&
    !frame.loading &&
    !frame.error &&
    !frame.notFound &&
    (!frame.slots || frame.slots.length === 0)
  );
}

export function scanRoutes(appDir: string): ReadonlyArray<DiscoveredRoute> {
  const routes: DiscoveredRoute[] = [];

  function walk(
    absDir: string,
    segments: ReadonlyArray<RouteSegment>,
    frames: ReadonlyArray<FrameLevel>,
    slot: string | undefined,
    intercept: InterceptKind | undefined,
  ) {
    const entries = readdirSync(absDir);
    // Slots that live INSIDE this directory — only relevant when we're
    // walking the main tree. Slot subtrees don't introduce nested slots in
    // v1.
    const slotsHere: string[] = [];
    if (!slot) {
      for (const entry of entries) {
        if (!entry.startsWith("@")) continue;
        if (!statSync(join(absDir, entry)).isDirectory()) continue;
        const m = DIR_SLOT.exec(entry);
        if (m) slotsHere.push(m[1]!);
      }
    }
    const localFrame = readFrame(absDir, slotsHere, segments.length);
    const framesAtThisLevel = frameIsEmpty(localFrame)
      ? frames
      : [...frames, localFrame];

    const urlPath = "/" + segments.map(urlSegment).join("/");
    const normalizedUrl = urlPath === "/" ? "/" : urlPath.replace(/\/+$/, "");

    const pageHere = join(absDir, "page.tsx");
    if (existsSync(pageHere)) {
      routes.push({
        urlPath: normalizedUrl,
        id: routeIdFromSegments(segments, slot, intercept, "page"),
        segments,
        pageFile: pageHere,
        frames: framesAtThisLevel,
        slot,
        intercept,
        kind: "page",
      });
    }

    // `default.tsx` is the fallback rendered when no `page.tsx` matches the
    // URL and either the slot has no last-rendered page (cold load / hard
    // nav) or this is the children/main slot at a URL with no page match.
    // Defaults are URL-prefix routes — they cover their directory's URL and
    // every sub-URL underneath. Intercepts don't apply to defaults.
    const defaultHere = join(absDir, "default.tsx");
    if (existsSync(defaultHere)) {
      routes.push({
        urlPath: normalizedUrl,
        id: routeIdFromSegments(segments, slot, undefined, "default"),
        segments,
        pageFile: defaultHere,
        frames: framesAtThisLevel,
        slot,
        kind: "default",
      });
    }

    for (const entry of entries) {
      const full = join(absDir, entry);
      if (!statSync(full).isDirectory()) continue;
      if (entry.startsWith("_")) continue;

      const slotMatch = DIR_SLOT.exec(entry);
      if (slotMatch) {
        // Slot subtree: routes inside contribute to the named slot. Frames
        // reset — the slot has its own render tree, independent of outer
        // layouts. Segments are PRESERVED so a slot's URL space mirrors its
        // parent's: `app/dashboard/@team/settings/page.tsx` matches
        // `/dashboard/settings`, not `/settings`. The intercept tag also
        // propagates so a slot beneath a `(.)foo` ancestor still produces
        // an intercept route (otherwise an intercept-slot route would match
        // on hard nav and pop a dialog on refresh).
        if (slot) {
          // v1: nested slots aren't supported. Skip silently.
          continue;
        }
        walk(full, segments, [], slotMatch[1]!, intercept);
        continue;
      }
      const cls = classifySegment(entry);
      const nextSegments = cls.segment ? [...segments, cls.segment] : segments;
      // Intercept tag bubbles down: if any directory on the path was a
      // (.) / (..) / (...) intercept, the resulting route is an intercept.
      const nextIntercept = cls.intercept ?? intercept;
      walk(full, nextSegments, framesAtThisLevel, slot, nextIntercept);
    }
  }

  walk(appDir, [], [], undefined, undefined);
  return routes;
}

/**
 * A `route.ts` file colocated with `page.tsx` files under `src/app/`,
 * Next.js-style. Each file becomes an HTTP route mounted at its
 * directory's URL path (`src/app/api/health/route.ts` → `/api/health`).
 *
 * Convention: the file's default export is a Hono app. Named exports
 * (`GET`, `POST`, etc.) aren't supported in v1 — the user can wrap
 * those into a Hono app themselves. Keeps the generated mount logic
 * one-liner small.
 */
export type ServerRoute = {
  /**
   * URL path with Hono-style `:name` placeholders for dynamic
   * segments (e.g. `/api/orders/:id`). This is what gets passed to
   * `app.route(...)` in the generated mount file. Catchalls produce
   * `:name{.+}` so Hono matches the rest of the path.
   */
  urlPath: string;
  /** Absolute filesystem path to the `route.ts` file. */
  file: string;
};

function honoSegment(seg: RouteSegment): string {
  switch (seg.kind) {
    case "literal":
      return seg.value;
    case "param":
      return `:${seg.name}`;
    case "catchall":
      return `:${seg.name}{.+}`;
  }
}

/**
 * Walk `src/app/` and discover every `route.ts` file. Slot directories
 * (`@dialog`, etc.), intercept directories (`(.)foo`), and underscore-
 * prefixed dirs (`_helpers`) are skipped — those are SPA-router
 * concepts, not server routes.
 */
export function scanServerRoutes(
  appDir: string,
): ReadonlyArray<ServerRoute> {
  const routes: ServerRoute[] = [];

  function walk(absDir: string, segments: ReadonlyArray<RouteSegment>) {
    const entries = readdirSync(absDir);

    const routeFile = join(absDir, "route.ts");
    if (existsSync(routeFile)) {
      const urlPath =
        segments.length === 0 ? "/" : "/" + segments.map(honoSegment).join("/");
      routes.push({ urlPath, file: routeFile });
    }

    for (const entry of entries) {
      const full = join(absDir, entry);
      if (!statSync(full).isDirectory()) continue;
      if (entry.startsWith("_")) continue;
      // Slots and intercepts are client-side parallel-route concepts;
      // the server tree mirrors the URL space cleanly.
      if (entry.startsWith("@")) continue;
      if (DIR_INTERCEPT.test(entry)) continue;
      const cls = classifySegment(entry);
      const nextSegments = cls.segment ? [...segments, cls.segment] : segments;
      walk(full, nextSegments);
    }
  }

  walk(appDir, []);
  return routes;
}

export function toPosix(p: string): string {
  return p.split(sep).join(posix.sep);
}

export function relPosix(from: string, to: string): string {
  const r = relative(from, to);
  const posixified = toPosix(r);
  return posixified.startsWith(".") ? posixified : `./${posixified}`;
}

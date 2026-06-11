import type { Environment } from "../environment.ts";
import type { Buckets } from "./buckets.ts";
import {
  disposeLoadedEntrypoint,
  loadEntrypoint,
} from "./load.ts";
import { matchDefault, matchRoute } from "./match.ts";
import type {
  LoadedEntrypoint,
  Location,
  Match,
  NavSource,
} from "./types.ts";

// Resolution: matches + loaded entrypoints, computed at navigation time.
//
// Computing matches AND firing `loadQuery` happens here, in event-handler
// (or useState-initializer) context — NOT inside `useMemo` during render.
// That guarantee is what keeps Relay's PreloadedQuery refs from being
// orphaned by discarded concurrent renders or StrictMode double-invocations.
export type Resolution = {
  // The committed match for the main outlet — null while the URL has no
  // match and no default.
  main: Match | null;
  // Per-slot match map. A null value means "this slot has no content for
  // this URL" — render `null` into the layout's slot prop.
  slotMatches: ReadonlyMap<string, Match | null>;
  // Loaded entrypoints (page module + queries) keyed the same way.
  mainLoaded: LoadedEntrypoint | null;
  slotLoaded: ReadonlyMap<string, LoadedEntrypoint>;
  // Last `page` matches we'd commit on top — exposed so the App can
  // update its preservation refs after this resolution becomes visible.
  mainCommit?: Match;
  slotPageCommits: ReadonlyMap<string, Match>;
};

export const EMPTY_RESOLUTION: Resolution = {
  main: null,
  slotMatches: new Map(),
  mainLoaded: null,
  slotLoaded: new Map(),
  slotPageCommits: new Map(),
};

// Release every PreloadedQuery handle held by a resolution. Used when a
// navigation supersedes a prior in-flight one (rapid clicks): the prior
// resolution will never commit, so its queries must be disposed or they
// orphan retain handles on the Relay store + leave aborted fetches as
// pending until GC. The ref-counted dispose path also unsubscribes the
// network observable, which fires `controller.abort()` in the network
// handler — cancelling any in-flight transient retry sleeps too.
export function disposeResolution(res: Resolution): void {
  if (res.mainLoaded) disposeLoadedEntrypoint(res.mainLoaded);
  for (const loaded of res.slotLoaded.values()) {
    disposeLoadedEntrypoint(loaded);
  }
}

export type PrevState = {
  lastMain: Match | null;
  lastSlots: ReadonlyMap<string, Match>;
};

// Compute the resolution for a location, then fire all loads. The
// orchestration of "match → preserve → fall back to default → load" is
// the router's most subtle logic; isolate it here so it's testable
// without React.
export function resolveAndLoad(
  buckets: Buckets,
  location: Location,
  navSource: NavSource,
  env: Environment["relay"],
  prev: PrevState,
): Resolution {
  const isSoftNav = navSource === "soft";

  // Pre-match the regular (non-intercepted) main route. Used both for the
  // same-page-nav guard below and the main-resolution branch further down.
  const regularMainMatch = matchRoute(buckets.mainRoutes, location.pathname);

  // Same-page navigation: the user is already on the route this nav
  // would land on, just with different search params or hash. Intercepts
  // must NOT fire in this case — the intercept is "open dialog over a
  // different page", and there's no different page here.
  //
  // Mirrors Next.js's behavior: an intercept route activates when the
  // *destination's resolved page route* differs from the route the user
  // is currently on. A search-param-only update on the same page leaves
  // the matched route record unchanged, so the intercept is suppressed.
  const samePageNav =
    regularMainMatch != null &&
    prev.lastMain != null &&
    regularMainMatch.route === prev.lastMain.route;

  // --- Slot intercepts: only fire on soft nav across different pages. ---
  const slotIntercepts = new Map<string, Match | null>();
  if (isSoftNav && !samePageNav) {
    for (const [slotName, ictRoutes] of buckets.slotIntercepts) {
      slotIntercepts.set(slotName, matchRoute(ictRoutes, location.pathname));
    }
  }
  const interceptHit = [...slotIntercepts.values()].some(
    (m): m is Match => m != null,
  );

  // --- Resolve every declared slot. --------------------------------------
  // Order: intercept (soft only) → regular page → soft-nav last → default → null.
  const slotMatches = new Map<string, Match | null>();
  const slotPageCommits = new Map<string, Match>();
  for (const slotName of buckets.allSlots) {
    const intercept = slotIntercepts.get(slotName);
    if (intercept) {
      slotMatches.set(slotName, intercept);
      continue;
    }
    const regulars = buckets.slotRegulars.get(slotName);
    const pageMatch = regulars
      ? matchRoute(regulars, location.pathname)
      : null;
    if (pageMatch) {
      slotMatches.set(slotName, pageMatch);
      slotPageCommits.set(slotName, pageMatch);
      continue;
    }
    if (isSoftNav) {
      const last = prev.lastSlots.get(slotName);
      if (last) {
        slotMatches.set(slotName, last);
        continue;
      }
    }
    const defaults = buckets.slotDefaults.get(slotName);
    const defaultMatch = defaults
      ? matchDefault(defaults, location.pathname)
      : null;
    slotMatches.set(slotName, defaultMatch);
  }

  // --- Resolve main. Intercepts freeze the previous main beneath the dialog. ---
  let main: Match | null;
  let mainCommit: Match | undefined;
  if (interceptHit && prev.lastMain) {
    main = prev.lastMain;
    mainCommit = undefined;
  } else {
    if (regularMainMatch) {
      main = regularMainMatch;
      mainCommit = regularMainMatch;
    } else if (isSoftNav && prev.lastMain) {
      main = prev.lastMain;
      mainCommit = undefined;
    } else {
      main = matchDefault(buckets.mainDefaults, location.pathname);
      mainCommit = undefined;
    }
  }

  // --- Load entrypoints (the side-effectful step). -----------------------
  const mainLoaded = main ? loadEntrypoint(env, main, location) : null;
  const slotLoaded = new Map<string, LoadedEntrypoint>();
  for (const [slotName, m] of slotMatches) {
    if (m) slotLoaded.set(slotName, loadEntrypoint(env, m, location));
  }

  return {
    main,
    slotMatches,
    mainLoaded,
    slotLoaded,
    mainCommit,
    slotPageCommits,
  };
}

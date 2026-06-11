import { useEffect, useLayoutEffect } from "react";
import type { FocusBehavior } from "./focus.ts";
import type { ScrollBehavior } from "./scroll.ts";
import type { Location, NavSource } from "./types.ts";

// Scroll restoration runs in a layout effect — synchronous after DOM
// commit, BEFORE paint — so the user never sees the wrong scroll
// position even for a frame.
export function useScrollRestoration(
  location: Location,
  navSource: NavSource,
  enabled: boolean,
  scrollBehavior: ScrollBehavior,
): void {
  useLayoutEffect(() => {
    if (!enabled) return;
    scrollBehavior.apply(location, navSource);
  }, [location, navSource, enabled, scrollBehavior]);
}

// Focus management runs after paint. We skip on init: the browser/user
// has already managed focus on first paint, and moving it would steal
// focus from anything they were already interacting with (deep links,
// password manager autofill).
export function useFocusManagement(
  pathname: string,
  navSource: NavSource,
  enabled: boolean,
  focusBehavior: FocusBehavior,
): void {
  useEffect(() => {
    if (!enabled) return;
    if (navSource === "init") return;
    focusBehavior.apply();
    // Only the pathname is the trigger here — searchParams/hash changes
    // don't represent a "new page" for focus purposes.
  }, [pathname, navSource, enabled, focusBehavior]);
}

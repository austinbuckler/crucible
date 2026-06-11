import { useEffect } from "react";

type ApplyNav = (next: URL, source: "soft" | "pop", historyOp: () => void) => void;

// `popstate` fires on back/forward button + history.{forward,back,go}().
// `pageshow` with `event.persisted === true` fires on bfcache restoration
// (iOS Safari swipe-back, Chrome/Firefox back-from-cache) — popstate does
// NOT fire in that case, so the router needs a separate handler. Without
// it, swipe-back renders the snapshot's data indefinitely.
// Reference: Next.js `app-router.js:142–165` follows the same pattern.
export function useBrowserNavListeners(applyNav: ApplyNav): void {
  useEffect(() => {
    const onPop = () => {
      // Don't push — popstate already moved history. Don't save the
      // outgoing scroll either: the entry we're leaving was already
      // updated by the scroll-restoration effect, and `replaceState`
      // here would clobber the entry we're landing ON.
      applyNav(new URL(window.location.href), "pop", () => {});
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      // Re-resolve so any stale Relay queries refetch (store-and-network)
      // and the router state syncs to whatever URL the browser landed on.
      applyNav(new URL(window.location.href), "pop", () => {});
      // Surface a separate `crucible:resume` signal for non-Relay
      // observers. iOS Safari silences `ResizeObserver`,
      // `IntersectionObserver`, and `window resize` events DURING the
      // app-snapshot pass it uses to capture the multitasker thumbnail
      // (Source/WebCore/page/Quirks.cpp:
      // shouldSilenceResizeObservers, shouldDeferIntersectionObservers
      // DuringResize, shouldSilenceWindowResizeEventsDuringApplication
      // Snapshotting). Any layout that happened during the snapshot
      // window never delivered to user code; on bfcache restoration,
      // the observer doesn't re-fire unless size CHANGES again, so
      // virtualized lists and chart canvases come back stale-sized.
      // Consumers that own canvas-driven UI (charts, virtualized
      // tables) should listen for `crucible:resume` and force a layout
      // recompute.
      window.dispatchEvent(new Event("crucible:resume"));
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [applyNav]);
}

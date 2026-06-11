import type { Location, NavSource } from "./types.ts";

// History state shape for scroll restoration. We piggy-back on
// `history.state` so positions travel with the entry (back/forward both
// see the right value) without needing per-pathname sessionStorage keys.
export const SCROLL_KEY = "_crucibleScrollY";

export function saveCurrentScroll(): void {
  if (typeof window === "undefined") return;
  const prev = window.history.state ?? {};
  window.history.replaceState({ ...prev, [SCROLL_KEY]: window.scrollY }, "");
}

export function readScrollFromState(): number | null {
  if (typeof window === "undefined") return null;
  const v = window.history.state?.[SCROLL_KEY];
  return typeof v === "number" ? v : null;
}

// Strategy contract: scroll behavior is one composable unit so apps can
// replace it wholesale (smooth scrolling library, animated scroll, etc.)
// without forking the framework.
export type ScrollBehavior = {
  // Save the current scroll position before navigation so back-nav can
  // restore it.
  save: () => void;
  // Apply the right scroll for the new location given how we got here.
  apply: (location: Location, source: NavSource) => void;
};

// Default behavior:
//   - hash present → scroll to that element. If absent (deferred under
//     Suspense), retry once on requestAnimationFrame.
//   - pop → restore from history.state.
//   - push → top.
//   - init → leave alone (browser already managed scroll for the deep
//     link / refresh).
export const defaultScrollBehavior: ScrollBehavior = {
  save: saveCurrentScroll,
  apply(location, source) {
    if (typeof window === "undefined") return;

    const { hash } = location;
    if (hash && hash.length > 1) {
      const id = decodeURIComponent(hash.slice(1));
      const tryScroll = (): boolean => {
        const el = document.getElementById(id);
        if (el) {
          el.scrollIntoView({ block: "start" });
          return true;
        }
        return false;
      };
      if (tryScroll()) return;
      // Retry on the next frame to cover Suspense-deferred content.
      requestAnimationFrame(() => {
        tryScroll();
      });
      return;
    }

    if (source === "pop") {
      const y = readScrollFromState();
      if (y !== null) {
        window.scrollTo(0, y);
        return;
      }
    }

    if (source !== "init") {
      window.scrollTo(0, 0);
    }
  },
};

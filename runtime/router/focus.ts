// Focus management on navigation. Screen readers and keyboard users
// expect focus to move to the new page content after navigation. Without
// this, focus stays on the link that was just clicked, which is
// confusing and a WCAG 2.4.3 (Focus Order) violation in practice.
//
// Resolution order:
//   1. `[data-crucible-focus-target]` — explicit opt-in for app authors
//      who want post-nav focus to land on a specific node.
//   2. `<main>` — semantic landmark, most apps wrap their page content
//      in one already.
//   3. The body. We force `tabindex="-1"` on whatever target we end up
//      using so `.focus()` actually moves focus (focusable-by-default
//      is a small allowlist that excludes <main> and <body>).
export function findFocusTarget(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const explicit = document.querySelector<HTMLElement>(
    "[data-crucible-focus-target]",
  );
  if (explicit) return explicit;
  const main = document.querySelector<HTMLElement>("main");
  if (main) return main;
  return document.body;
}

// Strategy contract: focus behavior is replaceable per-app. Default
// applies focus to the resolved target with `preventScroll: true` so
// scroll-restoration isn't clobbered.
export type FocusBehavior = {
  apply: () => void;
};

export const defaultFocusBehavior: FocusBehavior = {
  apply() {
    const target = findFocusTarget();
    if (!target) return;
    if (target.getAttribute("tabindex") === null) {
      target.setAttribute("tabindex", "-1");
    }
    target.focus({ preventScroll: true });
    // We don't restore tabindex — leaving "-1" makes subsequent
    // programmatic focus calls work without re-toggling. It doesn't
    // affect tab order (negative tabindex is "focusable but not
    // sequentially").
  },
};

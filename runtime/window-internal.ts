import type { ReactNode } from "react";

// Internal helpers shared by `<Crucible.Window>` and `Crucible.openAppWindow`.
// Lives in a `.ts` file (not `.tsx`) so it has no React-component exports —
// keeps `vite-plugin-react`'s Fast Refresh "consistent exports" rule
// satisfied for both surfaces.

export type WindowOptions = {
  title?: string;
  width?: number;
  height?: number;
  features?: string;
  onClose?: () => void;
};

// Open an `about:blank` popup with the given options. Returns null if
// the browser blocked it (popup blocker, sandbox, etc.).
export function openPopup(opts: WindowOptions): Window | null {
  const features =
    opts.features ??
    [`width=${opts.width ?? 1024}`, `height=${opts.height ?? 700}`].join(",");
  const popup = window.open("about:blank", "_blank", features);
  if (!popup) return null;
  if (opts.title) popup.document.title = opts.title;
  return popup;
}

// Mirror parent stylesheets into the popup. We watch ONLY for STYLE / LINK
// node add/remove in document.head — not characterData or attribute
// mutations. React 19 + DocumentHead update <meta content="…"> attributes
// on every navigation, and earlier versions of this code re-synced all
// stylesheets on each of those mutations, which thrashed the popup's CSS
// on every nav. The narrow childList watch covers HMR (Vite swaps style
// nodes) and route-driven CSS changes (React mounts/unmounts <style>) and
// nothing else.
export function observeStyleChanges(target: Document): MutationObserver | null {
  if (typeof MutationObserver === "undefined") return null;
  const sync = () => {
    if (!target.head) return;
    for (const node of target.head.querySelectorAll(
      "[data-crucible-style-clone]",
    )) {
      node.remove();
    }
    let css = "";
    for (const node of document.head.querySelectorAll<
      HTMLStyleElement | HTMLLinkElement
    >("style, link[rel='stylesheet']")) {
      if (node.tagName === "STYLE") {
        css += (node as HTMLStyleElement).textContent ?? "";
        css += "\n";
      } else {
        const link = target.createElement("link");
        link.rel = "stylesheet";
        const href = (node as HTMLLinkElement).getAttribute("href");
        if (href) link.setAttribute("href", href);
        link.setAttribute("data-crucible-style-clone", "");
        target.head.appendChild(link);
      }
    }
    if (css) {
      const styleEl = target.createElement("style");
      styleEl.setAttribute("data-crucible-style-clone", "");
      styleEl.textContent = css;
      target.head.appendChild(styleEl);
    }
  };
  if (target.readyState === "loading") {
    target.addEventListener("DOMContentLoaded", sync, { once: true });
  } else {
    sync();
  }
  const isStyleNode = (n: Node): boolean =>
    n.nodeType === 1 &&
    ((n as Element).tagName === "STYLE" ||
      ((n as Element).tagName === "LINK" &&
        (n as HTMLLinkElement).rel === "stylesheet"));

  const observer = new MutationObserver((records) => {
    for (const r of records) {
      // Only react to STYLE/LINK additions or removals. Skip everything
      // else — text mutations on <title>, <meta content> updates from
      // DocumentHead, etc. would otherwise force a full resync per nav.
      for (const n of r.addedNodes) {
        if (isStyleNode(n)) return sync();
      }
      for (const n of r.removedNodes) {
        if (isStyleNode(n)) return sync();
      }
    }
  });
  observer.observe(document.head, {
    childList: true,
    subtree: false,
  });
  return observer;
}

// =============================================================================
// Imperative-window registry. Module-level state subscribed by <WindowsHost>.
// =============================================================================

export type RegistryEntry = {
  id: number;
  children: ReactNode;
  popup: Window;
  onClose?: () => void;
};

let nextId = 1;
let entries: ReadonlyArray<RegistryEntry> = [];
const subscribers = new Set<() => void>();

function notify(): void {
  for (const s of subscribers) s();
}

export const windowRegistry = {
  add(entry: Omit<RegistryEntry, "id">): number {
    const id = nextId++;
    entries = [...entries, { id, ...entry }];
    notify();
    return id;
  },
  remove(id: number): void {
    const entry = entries.find((e) => e.id === id);
    entries = entries.filter((e) => e.id !== id);
    entry?.onClose?.();
    notify();
  },
  snapshot(): ReadonlyArray<RegistryEntry> {
    return entries;
  },
  subscribe(cb: () => void): () => void {
    subscribers.add(cb);
    return () => subscribers.delete(cb);
  },
};

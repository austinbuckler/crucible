import type { CrucibleRuntime } from "../platform.ts";
import { isSafeHref } from "../url-safety.ts";

// Web implementation of `window.crucible`. The generated main.tsx calls
// `installWebRuntime()` at boot, which assigns this onto `window.crucible`
// only if no runtime has already claimed it — Electron's preload runs
// first and populates the same namespace with IPC-backed methods, so the
// check is a no-op there.
export function createWebRuntime(): CrucibleRuntime {
  return {
    runtime: {
      type: "web",
      capabilities: ["CLIPBOARD", "EXTERNAL_LINKS", "NOTIFICATIONS"],
    },
    openExternal: async (url) => {
      if (!isSafeHref(url)) return false;
      const opened = window.open(url, "_blank", "noopener,noreferrer");
      return opened != null;
    },
    copyToClipboard: async (text) => {
      if (!navigator.clipboard) return false;
      await navigator.clipboard.writeText(text);
      return true;
    },
  };
}

export function installWebRuntime(): CrucibleRuntime {
  if (typeof window === "undefined") {
    throw new Error("[crucible] installWebRuntime called outside the browser");
  }
  if (window.crucible) return window.crucible;
  const runtime = createWebRuntime();
  window.crucible = runtime;
  return runtime;
}

import type { ReactNode } from "react";
import { isElectron } from "./platform.ts";
import {
  observeStyleChanges,
  openPopup,
  windowRegistry,
  type WindowOptions,
} from "./window-internal.ts";

// Imperative companion to `<Crucible.Window>`. Same mechanism — `window.open`
// + portal — but the children are captured at call time and don't re-render
// when the calling component's state changes. Use `<Crucible.Window>` for
// reactive popups; use this for one-shot snapshots.
//
// In its own .ts file so vite-plugin-react's Fast Refresh consistent-
// exports rule isn't tripped by mixing components + non-components.

export type AppWindowHandle = {
  close: () => void;
};

export function openAppWindow(
  children: ReactNode,
  opts: WindowOptions = {},
): AppWindowHandle {
  if (!isElectron()) {
    if (typeof console !== "undefined") {
      console.warn(
        "[crucible] openAppWindow is a no-op outside Electron — multi-window only applies in Electron.",
      );
    }
    return { close: () => {} };
  }
  const popup = openPopup(opts);
  if (!popup) {
    opts.onClose?.();
    return { close: () => {} };
  }
  const observer = observeStyleChanges(popup.document);
  const id = windowRegistry.add({ children, popup, onClose: opts.onClose });
  popup.addEventListener("beforeunload", () => {
    observer?.disconnect();
    windowRegistry.remove(id);
  });
  return {
    close: () => {
      observer?.disconnect();
      try {
        popup.close();
      } catch {
        // already closed
      }
      windowRegistry.remove(id);
    },
  };
}

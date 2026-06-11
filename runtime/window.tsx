import {
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { isElectron } from "./platform.ts";
import {
  observeStyleChanges,
  openPopup,
  windowRegistry,
  type WindowOptions,
} from "./window-internal.ts";

export type { WindowOptions } from "./window-internal.ts";

// Multi-window via React portals. Always shares the parent React tree —
// children inherit Relay env, platform runtime, viewer context, theme,
// useState above, etc. No need to re-set-up providers per window.
//
// Two surfaces over the same mechanism:
//   - <Crucible.Window>     — declarative, reactive (re-renders with parent)
//   - Crucible.openAppWindow — imperative, snapshot at call time
//                             (defined in `./open-window.ts`)
//
// Behavior by platform:
//   - Web: pass-through. Children render inline in the parent's tree
//     (web has no separate-window concept; multi-window is Electron-only).
//   - Electron: opens a popup via `window.open('about:blank')`. The main
//     process's `setWindowOpenHandler` allows it and applies the same
//     preload (so `window.crucible` is populated in the popup too).
//     Children portal into `popup.document.body`. Stylesheets are mirrored
//     from the parent and stay in sync via MutationObserver.

export type WindowProps = WindowOptions & {
  children: ReactNode;
  // Default `true`. Most usage is conditional rendering of the Window
  // element itself; the prop exists for cases where keeping the element
  // mounted but toggling visibility is more natural.
  isOpen?: boolean;
  // Receives the popup's Window object once opened — useful for
  // imperative things like `popup.focus()` or moving across screens.
  windowRef?: (win: Window | null) => void;
};

export function Window({
  children,
  isOpen = true,
  windowRef,
  ...opts
}: WindowProps) {
  if (!isElectron()) {
    // Web: pass-through. Children render inline in the parent's tree.
    return isOpen ? <>{children}</> : null;
  }
  if (!isOpen) return null;
  return (
    <ElectronPortal opts={opts} windowRef={windowRef}>
      {children}
    </ElectronPortal>
  );
}

function ElectronPortal({
  children,
  opts,
  windowRef,
}: {
  children: ReactNode;
  opts: WindowOptions;
  windowRef?: (win: Window | null) => void;
}) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const popupRef = useRef<Window | null>(null);

  // Hold opts.onClose / windowRef / opts (for `openPopup` reads at mount
  // time) in refs so the open-once effect calls the LATEST closure rather
  // than whatever was passed on the mount render. The effect intentionally
  // runs once (`[]` dep), but the callbacks it invokes — `onClose`,
  // `windowRef` — should always reflect the parent's current props.
  const onCloseRef = useRef(opts.onClose);
  const windowRefRef = useRef(windowRef);
  const optsRef = useRef(opts);
  useEffect(() => {
    onCloseRef.current = opts.onClose;
    windowRefRef.current = windowRef;
    optsRef.current = opts;
  });

  useEffect(() => {
    const popup = openPopup(optsRef.current);
    if (!popup) {
      onCloseRef.current?.();
      return;
    }
    popupRef.current = popup;
    windowRefRef.current?.(popup);

    const observer = observeStyleChanges(popup.document);

    const onBeforeUnload = () => {
      windowRefRef.current?.(null);
      onCloseRef.current?.();
    };
    popup.addEventListener("beforeunload", onBeforeUnload);

    setTarget(popup.document.body);

    return () => {
      popup.removeEventListener("beforeunload", onBeforeUnload);
      observer?.disconnect();
      try {
        popup.close();
      } catch {
        // already closed
      }
      popupRef.current = null;
      windowRefRef.current?.(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!target) return null;
  return createPortal(children, target);
}

// Internal — rendered once by `<Crucible.App>` so portals from
// `openAppWindow` join the same React tree (and inherit context). App
// code never needs to render this directly.
export function WindowsHost() {
  const entries = useSyncExternalStore(
    windowRegistry.subscribe,
    windowRegistry.snapshot,
    windowRegistry.snapshot,
  );
  return (
    <>
      {entries.map((entry) =>
        createPortal(entry.children, entry.popup.document.body, String(entry.id)),
      )}
    </>
  );
}

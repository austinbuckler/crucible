import { useEffect, type ReactNode } from "react";
import {
  MetadataDefaultsProvider,
  type MetadataDefaults,
} from "../runtime/metadata.tsx";
import { isElectron } from "../runtime/platform.ts";
import {
  initSwUpdate,
  type SwUpdateReadyEvent,
} from "../runtime/sw-update.ts";

export type AppleStatusBarStyle = "default" | "black" | "black-translucent";

// Hex literal nudge: iOS Safari can't parse `oklch()` / CSS variables for
// theme-color or manifest backgrounds, so values are restricted to hex.
export type HexColor = `#${string}`;

// Strategy prop for the SW update lifecycle. The bug-fix surface
// (`updateViaCache: 'none'`, polling, deferred skipWaiting,
// controllerchange reload, /assets/ cache filter, dev SW self-unregister,
// `crucible:update-ready` event dispatch) is a framework default and NOT
// configurable — the only knobs exposed are auto-activate-on-idle timing
// and observability hooks.
export type SwUpdateBehavior = {
  /**
   * Milliseconds of user inactivity before Crucible auto-applies a
   * waiting SW. Default: 300_000 (5 minutes).
   *
   * Set to `Infinity` to disable idle auto-activate entirely. The
   * `crucible:update-ready` window event and `onUpdateReady` callback
   * still fire — your app must call `event.activate()` itself (e.g.
   * from a "Refresh to update" toast button).
   *
   * @example
   *   <AppShell swUpdate={{ idleThresholdMs: 60_000 }} />  // aggressive
   *   <AppShell swUpdate={{ idleThresholdMs: Infinity }} />  // disable
   */
  idleThresholdMs?: number;
  /**
   * Called when a new SW has installed and is ready to activate. Always
   * fires alongside the `crucible:update-ready` window event — never
   * gated. Calling `event.activate()` is idempotent, so listening on
   * both surfaces is safe.
   */
  onUpdateReady?: (event: SwUpdateReadyEvent) => void;
  /**
   * Called when `navigator.serviceWorker.register()` rejects. Wire to
   * Sentry/Datadog. Defaults to `console.error`.
   */
  onSwError?: (err: unknown) => void;
};

// AppShell is now lean. Critical CSS, viewport meta, color-scheme,
// installed-PWA meta tags, splash markup, and safe-area CSS variables all
// live in the codegen-emitted index.html. The component:
//
//   1. Provides hardcoded `MetadataDefaults` via context. The root layout's
//      `metadata` export merges over these (and per-route metadata over
//      that) to drive `<DocumentHead>` at runtime.
//   2. Registers the service worker (URL injected by the Crucible Vite
//      plugin via `import.meta.env.CRUCIBLE_SW_URL`) and manages the
//      SW update lifecycle via `initSwUpdate`.
//
// That's it. Customization happens through metadata + the `swUpdate`
// strategy prop, not through ad-hoc props.
const HARDCODED_DEFAULTS: MetadataDefaults = {
  themeColor: "#ffffff",
  backgroundColor: "#ffffff",
  statusBarStyle: "black-translucent",
  // The plugin emits this constant via `define`. Set when a manifest is
  // configured (file-based or option-based); null otherwise. Root layout
  // metadata can still override to a specific value or `false`.
  manifest: import.meta.env.CRUCIBLE_MANIFEST_URL ?? false,
  defaultTitle: "",
};

export function AppShell({ children, swUpdate }: AppShellProps) {
  useEffect(() => {
    // Skip SW registration in Electron — the renderer loads its bundle
    // off-disk via the custom `crucible://` protocol; there's nothing for
    // an SW to cache that Electron's own networking doesn't already.
    if (isElectron()) return;
    const swUrl = import.meta.env.CRUCIBLE_SW_URL ?? null;
    if (!swUrl) return;
    return initSwUpdate({
      swUrl,
      idleThresholdMs: swUpdate?.idleThresholdMs,
      onUpdateReady: swUpdate?.onUpdateReady,
      onSwError: swUpdate?.onSwError,
    });
    // The swUpdate object identity is allowed to vary; if a consumer
    // swaps the strategy at runtime, we re-init so the new config takes
    // effect. StrictMode double-invoke is safe — the teardown released
    // all listeners before the second init.
  }, [swUpdate]);

  return (
    <MetadataDefaultsProvider value={HARDCODED_DEFAULTS}>
      {children}
    </MetadataDefaultsProvider>
  );
}

// Kept as a public export — DocumentHead's manifest link uses this when no
// explicit value is set in metadata. The plugin emits the URL via
// `import.meta.env.CRUCIBLE_MANIFEST_URL`; AppShell pipes it through if
// future code wants a hook.
export type AppShellProps = {
  children: ReactNode;
  /**
   * SW update lifecycle behavior. Omit for defaults (5-minute idle
   * auto-activate, window-event-only signaling). Pass overrides to
   * customize idle threshold or wire observability hooks.
   *
   * The bug-fix mechanics (`updateViaCache: 'none'`, registration
   * polling, deferred skipWaiting, controllerchange reload, /assets/
   * cache filter) are framework defaults and not configurable.
   */
  swUpdate?: SwUpdateBehavior;
};

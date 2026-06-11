import { createContext, use } from "react";

export type RuntimeType = "web" | "electron" | "ios" | "android";

export type PlatformCapability =
  | "CLIPBOARD"
  | "FILE_PICKER"
  | "NOTIFICATIONS"
  | "WINDOW_CONTROLS"
  | "EXTERNAL_LINKS";

// What `window.crucible` looks like at runtime. Same shape regardless of
// platform — the Electron preload, future iOS/Android bridges, and the
// web bootstrap all populate this object before React mounts. App code
// reads it via `Crucible.usePlatform()`; framework code can sniff
// `runtime.type` to branch behavior (e.g. skip SW registration in
// Electron).
export type CrucibleRuntime = {
  runtime: {
    type: RuntimeType;
    capabilities: ReadonlyArray<PlatformCapability>;
  };
  // Leave the app. Cross-platform meaning is consistent.
  //   - Web: `window.open(url, "_blank", "noopener,noreferrer")`.
  //   - Electron: `shell.openExternal(url)` (hands off to the OS).
  // Returns true on success, false on rejection (unsafe URL, popup
  // blocked, etc.).
  openExternal: (url: string) => Promise<boolean>;
  copyToClipboard: (text: string) => Promise<boolean>;
};

// Backwards-compatible alias — the existing PlatformRuntime type is the
// same thing as the global `window.crucible` namespace.
export type PlatformRuntime = CrucibleRuntime;

declare global {
  interface Window {
    crucible?: CrucibleRuntime;
  }
}

const PlatformContext = createContext<CrucibleRuntime | null>(null);

export const PlatformProvider = PlatformContext.Provider;

export function usePlatform(): CrucibleRuntime {
  const platform = use(PlatformContext);
  if (!platform) {
    throw new Error(
      "usePlatform called outside of <Crucible.App>. The runtime is mounted at window.crucible at boot.",
    );
  }
  return platform;
}

// Returns `true` when running inside Electron's renderer (preload populated
// `window.crucible.runtime.type = 'electron'`). Useful for branching
// platform-only UI (e.g. native window controls) without breaking the
// "uniform interface" contract — both runtimes still expose the same
// methods.
export function isElectron(): boolean {
  return getRuntimeType() === "electron";
}

export function getRuntimeType(): RuntimeType | null {
  if (typeof window === "undefined") return null;
  return window.crucible?.runtime?.type ?? null;
}

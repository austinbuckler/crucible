import type { CrucibleRuntime, PlatformCapability } from "../platform.ts";

// Capability set for the Electron renderer. Platform-specific UI (e.g.
// custom titlebar) can branch on this list at runtime if it wants to,
// without breaking the uniform `CrucibleRuntime` interface app code uses.
export const ELECTRON_CAPABILITIES: ReadonlyArray<PlatformCapability> = [
  "CLIPBOARD",
  "EXTERNAL_LINKS",
  "NOTIFICATIONS",
  "FILE_PICKER",
  "WINDOW_CONTROLS",
];

// Bound IPC method implementations supplied by the preload (which has the
// real `ipcRenderer.invoke` bound to specific channel names). The factory
// just wires those into the `CrucibleRuntime` shape — no generic `invoke`
// escape hatch crosses into the renderer.
export type ElectronMethods = {
  openExternal: (url: string) => Promise<boolean>;
  copyToClipboard: (text: string) => Promise<boolean>;
};

export function createElectronRuntime(
  methods: ElectronMethods,
): CrucibleRuntime {
  return {
    runtime: {
      type: "electron",
      capabilities: ELECTRON_CAPABILITIES,
    },
    openExternal: methods.openExternal,
    copyToClipboard: methods.copyToClipboard,
  };
}

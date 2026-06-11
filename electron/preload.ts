// Crucible's Electron preload helper. The user's preload entry is one
// import + one call; everything below — channel names, contextBridge
// wiring, the runtime shape — lives here so it stays in lockstep with
// the framework's `CrucibleRuntime` type.
//
// Security: the renderer receives ONLY the bound methods declared on
// `CrucibleRuntime`. It does not have access to a generic
// `ipcRenderer.invoke(channel, …)`, so it can't reach IPC channels that
// the main process didn't intend to expose.

import { contextBridge, ipcRenderer } from "electron";
import { createElectronRuntime } from "../runtime/platforms/electron.ts";
import { CHANNELS } from "./shared.ts";

export function setupCruciblePreload(): void {
  const runtime = createElectronRuntime({
    openExternal: (url) =>
      ipcRenderer.invoke(CHANNELS.openExternal, url) as Promise<boolean>,
    copyToClipboard: (text) =>
      ipcRenderer.invoke(CHANNELS.copyToClipboard, text) as Promise<boolean>,
  });
  contextBridge.exposeInMainWorld("crucible", runtime);
}

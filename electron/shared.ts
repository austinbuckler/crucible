// IPC channel names shared between Crucible's Electron preload + main.
// Both sides import from here so there are no stringly-typed channel
// mismatches. The renderer can only call these channels because the
// preload exposes them as bound functions, never `ipcRenderer.invoke`
// directly.
export const CHANNELS = {
  openExternal: "crucible:openExternal",
  copyToClipboard: "crucible:copyToClipboard",
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];

export const DEFAULT_PROTOCOL_SCHEME = "crucible";

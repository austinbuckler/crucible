// Crucible's Electron main-process helper. Wraps the boilerplate the
// app's `desktop/main.ts` would otherwise repeat: protocol scheme
// registration, IPC handlers (closed set, mapped to CHANNELS), bundle
// directory resolution (with hot-update overlay support), and
// BrowserWindow construction.
//
// Usage in a host app:
//
//   const platform = setupCruciblePlatform({
//     bundleDir: join(__dirname, "../bundle"),
//     userDataBundleDir: join(app.getPath("userData"), "bundles", "current"),
//     preloadPath: join(__dirname, "preload.js"),
//   })
//
//   platform.registerProtocolSchemes()  // before app.whenReady()
//   app.whenReady().then(() => platform.openMainWindow())

import {
  BrowserWindow,
  clipboard,
  ipcMain,
  net,
  protocol,
  shell,
} from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CHANNELS, DEFAULT_PROTOCOL_SCHEME } from "./shared.ts";

export type SetupOptions = {
  // Path to the bundle directory shipped with the binary. The renderer
  // loads `<bundleDir>/index.html` plus the rest of the Vite output.
  bundleDir: string;
  // Optional overlay: when this directory exists and contains an
  // `index.html`, it wins over `bundleDir`. Use it for hot-updated
  // bundles (e.g. `userData/bundles/current/`).
  userDataBundleDir?: string;
  // Path to the compiled preload script (the file that called
  // `setupCruciblePreload()`). Required.
  preloadPath: string;
  // Defaults applied to the main window. The host can also call
  // `openMainWindow()` with overrides per call.
  window?: WindowOptions;
  // Custom protocol scheme. Default `"crucible"`. The renderer loads
  // `<scheme>://app/`.
  protocolScheme?: string;
  // Dev-mode override. When set, the renderer loads this URL directly
  // (Vite dev server with HMR) instead of going through the custom
  // protocol + on-disk bundle. Default reads `CRUCIBLE_DEV_URL` from the
  // environment so `desktop:dev` can wire it up via the script.
  devUrl?: string;
};

export type WindowOptions = {
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  backgroundColor?: string;
};

export type CruciblePlatform = {
  registerProtocolSchemes: () => void;
  resolveBundleDir: () => string;
  openMainWindow: (
    overrides?: WindowOptions & {
      // When set, the window loads this URL instead of the default
      // (`devUrl` or `<scheme>://app/`). Apps use it to thread
      // boot-time hints to the renderer — e.g. `?auth=pending` so
      // the splash can show a "Signing in…" message while the host
      // completes an OAuth flow in the system browser. The hint
      // travels in the URL because the splash inline script runs
      // before any IPC bridge is available.
      urlOverride?: string;
    },
  ) => Promise<BrowserWindow>;
  // Resolve the URL the renderer would otherwise load. Useful for
  // computing a one-off override URL (e.g. appending a query).
  defaultUrl: () => string;
};

export function setupCruciblePlatform(opts: SetupOptions): CruciblePlatform {
  const scheme = opts.protocolScheme ?? DEFAULT_PROTOCOL_SCHEME;
  const defaultWindow: Required<WindowOptions> = {
    width: opts.window?.width ?? 1280,
    height: opts.window?.height ?? 800,
    minWidth: opts.window?.minWidth ?? 720,
    minHeight: opts.window?.minHeight ?? 480,
    backgroundColor: opts.window?.backgroundColor ?? "#ffffff",
  };
  // Dev-URL override: when set, skip the custom protocol path and load
  // the URL directly. Lets `desktop:dev` wire up Vite's HMR — the
  // preload still runs, so window.crucible is populated correctly.
  const devUrl = opts.devUrl ?? process.env.CRUCIBLE_DEV_URL;

  let initialized = false;

  const resolveBundleDir = (): string => {
    if (
      opts.userDataBundleDir &&
      existsSync(join(opts.userDataBundleDir, "index.html"))
    ) {
      return opts.userDataBundleDir;
    }
    return opts.bundleDir;
  };

  const registerProtocolHandler = (): void => {
    const dir = resolveBundleDir();
    protocol.handle(scheme, async (req) => {
      const url = new URL(req.url);
      const rel = url.pathname === "/" ? "/index.html" : url.pathname;
      const filePath = join(dir, rel);
      return net.fetch(`file://${filePath}`);
    });
  };

  const registerIpc = (): void => {
    // openExternal: leave the app. shell.openExternal hands the URL to
    // the OS — browser, mail client, etc. Same semantic as web's
    // `window.open(url, "_blank")` from the user's POV.
    ipcMain.handle(CHANNELS.openExternal, async (_e, url: string) => {
      if (typeof url !== "string") return false;
      const trimmed = url.trim();
      if (!/^https?:|^mailto:|^tel:/i.test(trimmed)) return false;
      try {
        await shell.openExternal(trimmed);
        return true;
      } catch {
        return false;
      }
    });
    ipcMain.handle(CHANNELS.copyToClipboard, (_e, text: string) => {
      if (typeof text !== "string") return false;
      clipboard.writeText(text);
      return true;
    });
  };

  // window.open() from the renderer is what `<Crucible.Window>` uses for
  // its portal target. We allow `about:blank` (the portal pattern) and
  // any same-origin URL inside our scheme; everything else is denied so
  // a stray `target="_blank"` link doesn't open an unconfigured window.
  // Same preload + same isolation, so `window.crucible` populates the
  // popup too.
  const configureWindowOpen = (win: BrowserWindow): void => {
    win.webContents.setWindowOpenHandler(({ url }) => {
      const target = url.trim();
      const isAboutBlank = target === "about:blank";
      const isSameScheme = target.startsWith(`${scheme}://`);
      const isDevSameOrigin =
        !!devUrl && (target === devUrl || target.startsWith(devUrl));
      if (!isAboutBlank && !isSameScheme && !isDevSameOrigin) {
        return { action: "deny" };
      }
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          backgroundColor: "#ffffff",
          webPreferences: {
            preload: opts.preloadPath,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        },
      };
    });
  };

  return {
    registerProtocolSchemes() {
      // Custom protocol unused in dev-URL mode (Vite serves over HTTP).
      if (devUrl) return;
      protocol.registerSchemesAsPrivileged([
        {
          scheme,
          privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            stream: true,
          },
        },
      ]);
    },
    resolveBundleDir,
    defaultUrl: () => devUrl ?? `${scheme}://app/`,
    async openMainWindow(overrides) {
      if (!initialized) {
        if (!devUrl) registerProtocolHandler();
        registerIpc();
        initialized = true;
      }
      // The window-config overrides (width, etc.) shouldn't include
      // the auth hint — strip it before spreading.
      const { urlOverride, ...windowConfig } = overrides ?? {};
      const win = new BrowserWindow({
        ...defaultWindow,
        ...windowConfig,
        show: false,
        titleBarStyle:
          process.platform === "darwin" ? "hiddenInset" : "default",
        webPreferences: {
          preload: opts.preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      configureWindowOpen(win);
      win.once("ready-to-show", () => win.show());
      await win.loadURL(urlOverride ?? devUrl ?? `${scheme}://app/`);
      return win;
    },
  };
}

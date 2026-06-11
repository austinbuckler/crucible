import { runCodegenAsync } from "./codegen/run.ts";
import type { ThemeStorage } from "./codegen/index-html.ts";

// Run from the consumer app's directory. Crucible is a workspace package
// now; the script is invoked via `bun .../crucible/cli.ts` from the app's
// package.json, with cwd set to the app root. Don't resolve relative to
// the script's own location — that would point at packages/.
const appRoot = process.cwd();

// Parse `--theme-storage <storageKey>:<class|data-theme>` from argv. Used
// by consumers whose runtime ThemeProvider persists with a non-default
// storage key or attribute convention (e.g. shadcn's `vite-ui-theme:class`).
// Without this flag the boot script defaults to `theme:class` (next-themes'
// storage key + Tailwind/shadcn's `.dark` convention). Only consulted
// when the root layout's metadata declares a dual-form `backgroundColor:
// { light, dark }`.
function parseThemeStorageArg(): ThemeStorage | undefined {
  const idx = process.argv.indexOf("--theme-storage");
  if (idx === -1) return undefined;
  const raw = process.argv[idx + 1];
  if (!raw) {
    throw new Error(
      "[crucible] --theme-storage requires a value, e.g. 'theme:class' or 'vite-ui-theme:class'.",
    );
  }
  const parts = raw.split(":");
  if (parts.length !== 2) {
    throw new Error(
      `[crucible] --theme-storage expects '<storageKey>:<class|data-theme>'; got ${JSON.stringify(raw)}.`,
    );
  }
  const [storageKey, attribute] = parts;
  if (attribute !== "class" && attribute !== "data-theme") {
    throw new Error(
      `[crucible] --theme-storage attribute must be 'class' or 'data-theme'; got ${JSON.stringify(attribute)}.`,
    );
  }
  return { storageKey: storageKey!, attribute };
}

const themeStorage = parseThemeStorageArg();

const result = await runCodegenAsync({ appRoot, themeStorage });
console.log(`[crucible] generated artifacts for ${result.routeCount} route(s).`);

import { existsSync, readFileSync, writeFileSync } from "node:fs";

// Codegen runs on every dev-server boot AND any time the user re-runs
// `bun run codegen`. Vite watches `.crucible/` (the project root), so an
// unconditional `writeFileSync` updates mtime even when content is
// identical — and Vite then invalidates the module, forcing a full
// reload (catastrophic for `main.tsx`, which is the entry and has no
// HMR boundary). Skip writes when the on-disk content already matches
// the rendered output to keep HMR quiet.
//
// `readFileSync` failures (perms / partial write) are rare and benign
// here — rewriting is the recovery, so we fall through.
export function writeIfChanged(file: string, content: string): void {
  if (existsSync(file)) {
    try {
      if (readFileSync(file, "utf8") === content) return;
    } catch {
      /* fall through */
    }
  }
  writeFileSync(file, content, "utf8");
}

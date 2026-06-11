import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Runs before relay-compiler. Seeds persisted-queries.json so the compiler
// doesn't bail on a missing file (it refuses to start when persistConfig
// points to a path that doesn't exist).
//
// Resolves against process.cwd() — crucible is a workspace package; this
// script is invoked from the consumer app's directory.
const appRoot = process.cwd();
const persisted = resolve(appRoot, "persisted-queries.json");
if (!existsSync(persisted)) {
  writeFileSync(persisted, "{}\n", "utf8");
  console.log("[crucible] seeded persisted-queries.json");
}

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { transformAsync } from "@babel/core";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { crucible } from "../../index.ts";

const appRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(appRoot, "../..");
const appNodeModules = resolve(appRoot, "node_modules");

function relayTransform(): Plugin {
  return {
    name: "relay-transform",
    enforce: "pre",
    async transform(code, id) {
      if (!/\.[jt]sx$/.test(id) || !code.includes("graphql`")) return null;
      const result = await transformAsync(code, {
        filename: id,
        babelrc: false,
        configFile: false,
        parserOpts: {
          plugins: ["typescript", "jsx"],
        },
        plugins: ["relay"],
      });
      return result?.code
        ? {
            code: result.code,
          }
        : null;
    },
  };
}

export default defineConfig({
  root: resolve(appRoot, ".crucible"),
  plugins: [
    relayTransform(),
    react({
      include: /\.[jt]sx$/,
    }),
    crucible({
      appRoot,
      crucibleSpecifier: "react-crucible",
    }),
  ],
  resolve: {
    alias: [
      {
        find: "crucible",
        replacement: resolve(repoRoot, "crucible.ts"),
      },
      {
        find: /^react\/(.*)$/,
        replacement: `${appNodeModules}/react/$1`,
      },
      {
        find: "react",
        replacement: resolve(appNodeModules, "react"),
      },
      {
        find: /^react-dom\/(.*)$/,
        replacement: `${appNodeModules}/react-dom/$1`,
      },
      {
        find: "react-dom",
        replacement: resolve(appNodeModules, "react-dom"),
      },
      {
        find: "react-relay",
        replacement: resolve(appNodeModules, "react-relay"),
      },
      {
        find: "relay-runtime",
        replacement: resolve(appNodeModules, "relay-runtime"),
      },
      {
        find: /^graphql\/(.*)$/,
        replacement: `${appNodeModules}/graphql/$1`,
      },
      {
        find: "graphql",
        replacement: resolve(appNodeModules, "graphql"),
      },
      {
        find: /^react-crucible\/(.*)$/,
        replacement: `${repoRoot}/$1`,
      },
      {
        find: "react-crucible",
        replacement: resolve(repoRoot, "index.ts"),
      },
    ],
    dedupe: ["graphql", "react", "react-dom", "react-relay", "relay-runtime"],
  },
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    fs: {
      allow: [appRoot, repoRoot],
    },
  },
  optimizeDeps: {
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
});

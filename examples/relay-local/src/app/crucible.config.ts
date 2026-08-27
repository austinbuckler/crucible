import type { CrucibleConfig } from "crucible";

export const localGraphQL: CrucibleConfig["localGraphQL"] = {
  worker: () =>
    new Worker(new URL("../local/graphql-worker.ts", import.meta.url), {
      type: "module",
    }),
};

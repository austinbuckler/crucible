import { plugin } from "bun";
import { readFileSync } from "node:fs";
import {
  isRelayGeneratedArtifact,
  stripRelayResolverTypeAssertions,
} from "./relay-artifacts.ts";

plugin({
  name: "crucible-relay-artifacts",
  setup(build) {
    build.onLoad({ filter: /\.graphql\.ts$/ }, ({ path }) => {
      if (!isRelayGeneratedArtifact(path)) return;
      return {
        contents: stripRelayResolverTypeAssertions(readFileSync(path, "utf8")),
        loader: "ts",
      };
    });
  },
});

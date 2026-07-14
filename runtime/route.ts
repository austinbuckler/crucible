import type { StandardSchemaV1 } from "@standard-schema/spec";

// Shared route/search types for the direct-export page contract.
// Pages export `searchParams` as any Standard Schema-compliant validator;
// PageRenderer validates URLSearchParams through this shape at runtime.
export type SearchSpec = StandardSchemaV1;

export type InferSearch<S> = S extends StandardSchemaV1<unknown, infer Out>
  ? Out
  : URLSearchParams;

// URL-pattern → params type helper kept for public typing utilities.
// "/clients/[id]"     → { id: string }
// "/posts/[...slug]"  → { slug: string }
// "/"                 → Record<string, never>
export type InferParams<Pattern extends string> =
  Pattern extends `${string}[...${infer Name}]${infer Rest}`
    ? { [K in Name | keyof InferParams<Rest>]: string }
    : Pattern extends `${string}[${infer Name}]${infer Rest}`
      ? { [K in Name | keyof InferParams<Rest>]: string }
      : Record<string, never>;

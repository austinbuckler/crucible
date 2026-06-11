import type { StandardSchemaV1 } from "@standard-schema/spec";

type Schema = StandardSchemaV1;
type SchemaResult =
  | { ok: true; value: unknown }
  | { ok: false; issues: ReadonlyArray<{ path?: ReadonlyArray<unknown> }> };

function tryValidate(schema: Schema, input: unknown): SchemaResult {
  let r;
  try {
    r = schema["~standard"].validate(input);
  } catch (err) {
    console.warn("[crucible] searchParams validator threw:", err);
    return { ok: false, issues: [] };
  }
  if (r instanceof Promise) {
    console.warn(
      "[crucible] Async Standard Schema validators aren't supported for searchParams yet. Provide a sync schema.",
    );
    return { ok: false, issues: [] };
  }
  if (r.issues) return { ok: false, issues: r.issues };
  return { ok: true, value: r.value };
}

function offendingTopLevelKeys(
  issues: ReadonlyArray<{ path?: ReadonlyArray<unknown> }>,
): Set<string> {
  const out = new Set<string>();
  for (const issue of issues) {
    if (!issue.path || issue.path.length === 0) continue;
    const root = issue.path[0];
    if (typeof root === "string") {
      out.add(root);
    } else if (typeof root === "object" && root !== null && "key" in root) {
      const key = (root as { key: unknown }).key;
      if (typeof key === "string") out.add(key);
    }
  }
  return out;
}

// Best-effort search params validation. If the schema rejects, identify
// the offending top-level keys, drop them from the input, and re-validate
// so the *valid* fields still flow through. This means stray or malformed
// params (tracking pixels, manual URL edits, deprecated keys) never break
// user-land — they're silently dropped while everything else keeps
// working.
export function validateSearchParams(
  schema: Schema,
  raw: URLSearchParams,
): unknown {
  const input = Object.fromEntries(raw.entries());
  const first = tryValidate(schema, input);
  if (first.ok) return first.value;

  const bad = offendingTopLevelKeys(first.issues);
  if (bad.size === 0) {
    if (import.meta.env.DEV) {
      console.warn(
        "[crucible] Invalid search params (whole-input failure, no top-level paths). Falling back to empty:",
        first.issues,
      );
    }
    return {};
  }

  if (import.meta.env.DEV) {
    console.warn(
      `[crucible] Invalid search param(s) — dropping ${[...bad]
        .map((k) => `'${k}'`)
        .join(", ")} and continuing:`,
      first.issues,
    );
  }

  const filtered = Object.fromEntries(
    Object.entries(input).filter(([k]) => !bad.has(k)),
  );
  const second = tryValidate(schema, filtered);
  if (second.ok) return second.value;
  if (import.meta.env.DEV) {
    console.warn(
      "[crucible] Search params still invalid after dropping bad keys. Falling back to empty:",
      second.issues,
    );
  }
  return {};
}

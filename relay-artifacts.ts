export function isRelayGeneratedArtifact(id: string): boolean {
  return /\/__generated__\/.*\.graphql\.ts(?:\?.*)?$/.test(
    id.split(/[\\/]+/).join("/"),
  );
}

export function stripRelayResolverTypeAssertions(code: string): string {
  return code
    .replace(
      /^[ \t]*\([A-Za-z_$][\w$]* satisfies \([\s\S]*?^[ \t]*\) => [\s\S]*?\);\n/gm,
      "",
    )
    .replace(/^[ \t]*\([A-Za-z_$][\w$]* satisfies .*?\);\n/gm, "");
}

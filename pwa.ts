import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HexColor } from "./ui/app-shell.tsx";

export type PWAIcon = {
  src: string;
  sizes: string;
  type?: string;
  purpose?: "any" | "maskable" | "monochrome";
};

export type PWAConfig = {
  name: string;
  shortName?: string;
  description?: string;
  themeColor: HexColor;
  backgroundColor: HexColor;
  display?: "standalone" | "fullscreen" | "minimal-ui" | "browser";
  startUrl?: string;
  scope?: string;
  orientation?: "portrait" | "landscape" | "any";
  categories?: ReadonlyArray<string>;
  icons: ReadonlyArray<PWAIcon>;
  appleTouchIcon?: string;
};

export type LinkTag = {
  tag: "link";
  attrs: Record<string, string>;
};

export type ResolvedPWA = {
  manifestPath: string;
  manifestJson: string;
  htmlInjections: ReadonlyArray<LinkTag>;
  appleTouchIcon: string | undefined;
};

export function resolvePWA(config: PWAConfig): ResolvedPWA {
  const manifest = {
    name: config.name,
    short_name: config.shortName ?? config.name,
    description: config.description,
    start_url: config.startUrl ?? "/",
    scope: config.scope ?? "/",
    display: config.display ?? "standalone",
    orientation: config.orientation,
    background_color: config.backgroundColor,
    theme_color: config.themeColor,
    categories: config.categories,
    icons: config.icons.map((i) => ({
      src: i.src,
      sizes: i.sizes,
      type: i.type ?? guessIconType(i.src),
      purpose: i.purpose,
    })),
  };

  const appleTouchIcon =
    config.appleTouchIcon ?? findAppleTouchIcon(config.icons);

  const injections: LinkTag[] = [
    { tag: "link", attrs: { rel: "manifest", href: "/manifest.webmanifest" } },
  ];
  if (appleTouchIcon) {
    injections.push({
      tag: "link",
      attrs: { rel: "apple-touch-icon", href: appleTouchIcon },
    });
  }
  for (const icon of config.icons) {
    if (icon.purpose && icon.purpose !== "any") continue;
    injections.push({
      tag: "link",
      attrs: {
        rel: "icon",
        type: icon.type ?? guessIconType(icon.src),
        sizes: icon.sizes,
        href: icon.src,
      },
    });
  }

  return {
    manifestPath: "/manifest.webmanifest",
    manifestJson: JSON.stringify(manifest, null, 2) + "\n",
    htmlInjections: injections,
    appleTouchIcon,
  };
}

function findAppleTouchIcon(icons: ReadonlyArray<PWAIcon>): string | undefined {
  const exact = icons.find((i) => i.sizes === "180x180");
  if (exact) return exact.src;
  const big = icons.find((i) => sideLength(i.sizes) >= 180);
  return big?.src;
}

function sideLength(sizes: string): number {
  const m = /^(\d+)x(\d+)$/.exec(sizes);
  if (!m) return 0;
  return Math.min(Number(m[1]), Number(m[2]));
}

function guessIconType(src: string): string {
  const ext = src.toLowerCase().split(".").pop();
  switch (ext) {
    case "png":
      return "image/png";
    case "svg":
      return "image/svg+xml";
    case "webp":
      return "image/webp";
    case "ico":
      return "image/x-icon";
    default:
      return "image/png";
  }
}

export function writeManifestFile(
  appRoot: string,
  resolved: ResolvedPWA,
): void {
  const file = join(appRoot, "public", "manifest.webmanifest");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, resolved.manifestJson, "utf8");
}

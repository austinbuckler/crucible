import {
  createContext,
  use,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import type { AppleStatusBarStyle, HexColor } from "../ui/app-shell.tsx";

// `template` slots descendant titles via `%s`; `default` is what fills the
// slot when no descendant set its own title. Both fields are required —
// authoring a template without a fallback ends up rendering an empty slot
// when a leaf forgets to declare a title.
export type TitleTemplate = {
  template: `${string}%s${string}`;
  default: string;
};

// Open Graph metadata. The DOM uses `<meta property="og:foo">` (note:
// `property`, not `name`). Image is a single string for now — multi-image
// OG is rarely needed and the type can grow later.
export type OpenGraph = {
  title?: string;
  description?: string;
  image?: string;
  type?: string; // "website" | "article" | "profile" | …
  url?: string;
  siteName?: string;
  locale?: string;
};

// Twitter Card metadata. Uses `<meta name="twitter:foo">`.
export type Twitter = {
  card?: "summary" | "summary_large_image" | "app" | "player";
  site?: string; // @handle
  creator?: string; // @handle
  title?: string;
  description?: string;
  image?: string;
};

// Robots directive. Pass a string for full control ("index, follow,
// max-snippet:-1") or a boolean shortcut. `false` → "noindex, nofollow".
export type Robots = string | boolean;

// Background color. Accept either a single hex (used in both light and
// dark mode — typical for apps that don't ship a dark theme) or an
// explicit per-mode pair. The codegen splash, the PWA manifest, and any
// runtime consumers can pick the right value for the active mode.
export type BackgroundColor = HexColor | { light: HexColor; dark: HexColor };

// Resolve a `BackgroundColor` to a single hex. Single-value forms
// passthrough; pair forms collapse to `light` (the canonical "default"
// mode — dark mode is opt-in and not all surfaces can pick at runtime,
// e.g. the PWA manifest's static `background_color` field).
export function resolveBackgroundColor(value: BackgroundColor): HexColor {
  return typeof value === "string" ? value : value.light;
}

// What pages and layouts may export. All fields are optional; the runtime
// merges layouts (outer → inner) over AppShell defaults, then the page wins
// last.
//
// `title` is either an absolute string (used as-is and slots into any
// ancestor template) or a TitleTemplate (this layer becomes the active
// template; descendant string titles fill its `%s` slot, and `default` is
// what renders when no descendant declares a title).
export type Metadata = {
  title?: string | TitleTemplate;
  description?: string;
  themeColor?: HexColor;
  backgroundColor?: BackgroundColor;
  statusBarStyle?: AppleStatusBarStyle;
  appleTitle?: string;
  manifest?: string | false;
  appleTouchIcon?: string;
  // Open Graph (`<meta property="og:foo">`) — for link previews on
  // Facebook, LinkedIn, Slack, Discord, iMessage, etc.
  openGraph?: OpenGraph;
  // Twitter Card (`<meta name="twitter:foo">`) — for X / Twitter previews.
  twitter?: Twitter;
  // robots directive. `true` → "index, follow"; `false` → "noindex,
  // nofollow"; string → used verbatim.
  robots?: Robots;
  // Additional <meta name="X" content="Y"> tags. Use sparingly — prefer
  // typed fields above when one exists.
  other?: ReadonlyArray<{ name: string; content: string }>;
};

// Defaults set by <AppShell> and threaded down via context. The router pulls
// these out, merges per-route Metadata over them, and renders <DocumentHead>.
export type MetadataDefaults = {
  themeColor: HexColor;
  backgroundColor: BackgroundColor;
  statusBarStyle: AppleStatusBarStyle;
  appleTitle?: string;
  manifest: string | false;
  appleTouchIcon?: string;
  // Title used when no route declares one. May be an absolute string or a
  // template; templates are inherited by descendant routes.
  defaultTitle: string | TitleTemplate;
};

const DefaultsContext = createContext<MetadataDefaults | null>(null);

export const MetadataDefaultsProvider = DefaultsContext.Provider;

export function useMetadataDefaults(): MetadataDefaults {
  const v = use(DefaultsContext);
  if (!v) {
    throw new Error(
      "DocumentHead is rendered outside of <Crucible.AppShell>. Wrap your <Crucible.App> in <Crucible.AppShell>.",
    );
  }
  return v;
}

// Per-route override slot. PageRenderer mounts a provider so the page
// body (or any descendant) can publish a `Metadata` patch that wins
// over `Route.config.title` + `Route.config.meta`. This is how
// render-as-you-fetch dynamic titles flow: the page calls
// `useDocumentTitle(data.foo)` after `usePreloadedQuery` resolves;
// PageRenderer's DocumentHead re-renders and merges the override on
// top of the static layers.
type PageMetadataSetter = Dispatch<SetStateAction<Metadata | undefined>>;

const PageMetadataContext = createContext<PageMetadataSetter | null>(null);

export function PageMetadataOverrideProvider({
  children,
}: {
  children: (override: Metadata | undefined) => ReactNode;
}): ReactNode {
  const [override, setOverride] = useState<Metadata | undefined>(undefined);
  return (
    <PageMetadataContext.Provider value={setOverride}>
      {children(override)}
    </PageMetadataContext.Provider>
  );
}

/**
 * Set the document title from the page body. Pair with
 * `usePreloadedQuery` to resolve titles from the page's data:
 *
 *   const data = usePreloadedQuery(graphql`...`, queryRef);
 *   Crucible.useDocumentTitle(data.client?.name ?? "Client");
 *
 * Static titles belong in `Route.config.title` — that path renders
 * the title via the head layer without an extra commit.
 */
export function useDocumentTitle(title: string): void {
  const set = use(PageMetadataContext);
  useEffect(() => {
    if (!set) return;
    set((prev) => ({ ...(prev ?? {}), title }));
    return () => {
      set((prev) => {
        if (!prev) return prev;
        const { title: _omit, ...rest } = prev;
        return Object.keys(rest).length > 0 ? rest : undefined;
      });
    };
  }, [set, title]);
}

/**
 * Patch document metadata from the page body. Like `useDocumentTitle`
 * but for richer fields (description, OG, twitter, etc.). Static
 * fields belong in `Route.config.meta`.
 */
export function useMetadata(meta: Metadata): void {
  const set = use(PageMetadataContext);
  // Stringify-shallow the patch so the effect re-fires only when its
  // visible content changes — page bodies rebuild the literal each
  // render but most of the time its values are stable.
  const sig = useMemo(() => JSON.stringify(meta), [meta]);
  useEffect(() => {
    if (!set) return;
    set((prev) => ({ ...(prev ?? {}), ...meta }));
    return () => {
      set((prev) => {
        if (!prev) return prev;
        const next = { ...prev };
        for (const k of Object.keys(meta) as Array<keyof Metadata>) {
          delete next[k];
        }
        return Object.keys(next).length > 0 ? next : undefined;
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set, sig]);
}

type Resolved = {
  title: string;
  description?: string;
  themeColor: HexColor;
  backgroundColor: BackgroundColor;
  statusBarStyle: AppleStatusBarStyle;
  appleTitle?: string;
  manifest: string | false;
  appleTouchIcon?: string;
  openGraph: OpenGraph;
  twitter: Twitter;
  robots?: string;
  other: ReadonlyArray<{ name: string; content: string }>;
};

const EMPTY_OG: OpenGraph = {};
const EMPTY_TW: Twitter = {};
const EMPTY_OTHER: ReadonlyArray<{ name: string; content: string }> = [];

function resolveRobots(value: Robots | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value === true) return "index, follow";
  if (value === false) return "noindex, nofollow";
  return value;
}

export function mergeMetadata(
  defaults: MetadataDefaults,
  layers: ReadonlyArray<Metadata | undefined>,
): Resolved {
  // Title resolution: walk layers (defaults outermost). The latest string
  // becomes the slot text, the latest TitleTemplate becomes the active
  // template. At the end, apply template if set; otherwise return the slot
  // text (or its template's `default` when only a template was ever set).
  let titleText: string | undefined;
  let template: TitleTemplate | undefined;
  const visit = (t: string | TitleTemplate | undefined) => {
    if (t === undefined) return;
    if (typeof t === "string") titleText = t;
    else template = t;
  };
  visit(defaults.defaultTitle);
  for (const layer of layers) visit(layer?.title);

  let description: string | undefined;
  let themeColor: HexColor = defaults.themeColor;
  let backgroundColor: BackgroundColor = defaults.backgroundColor;
  let statusBarStyle: AppleStatusBarStyle = defaults.statusBarStyle;
  let appleTitle = defaults.appleTitle;
  let manifest: string | false = defaults.manifest;
  let appleTouchIcon = defaults.appleTouchIcon;
  let openGraph: OpenGraph = EMPTY_OG;
  let twitter: Twitter = EMPTY_TW;
  let robots: string | undefined;

  let mergedOther: { name: string; content: string }[] | null = null;

  for (const layer of layers) {
    if (!layer) continue;
    if (layer.description !== undefined) description = layer.description;
    if (layer.themeColor !== undefined) themeColor = layer.themeColor;
    if (layer.backgroundColor !== undefined)
      backgroundColor = layer.backgroundColor;
    if (layer.statusBarStyle !== undefined)
      statusBarStyle = layer.statusBarStyle;
    if (layer.appleTitle !== undefined) appleTitle = layer.appleTitle;
    if (layer.manifest !== undefined) manifest = layer.manifest;
    if (layer.appleTouchIcon !== undefined)
      appleTouchIcon = layer.appleTouchIcon;
    if (layer.openGraph) openGraph = { ...openGraph, ...layer.openGraph };
    if (layer.twitter) twitter = { ...twitter, ...layer.twitter };
    const r = resolveRobots(layer.robots);
    if (r !== undefined) robots = r;
    if (layer.other && layer.other.length > 0) {
      mergedOther = mergedOther ?? [];
      for (const entry of layer.other) mergedOther.push(entry);
    }
  }

  const title = template
    ? template.template.replace("%s", titleText ?? template.default)
    : (titleText ?? "");

  return {
    title,
    description,
    themeColor,
    backgroundColor,
    statusBarStyle,
    appleTitle,
    manifest,
    appleTouchIcon,
    openGraph,
    twitter,
    robots,
    other: mergedOther ?? EMPTY_OTHER,
  };
}

// Updates document-level metadata for the active route. We mutate existing
// tags imperatively instead of rendering React elements — the static
// `index.html` already declares the canonical set with sensible defaults,
// and React 19's metadata hoisting doesn't dedupe `<meta>` tags by `name`
// (two with the same name but different `content` would both end up in
// <head>). Imperative mutation keeps a single tag per name across route
// changes; the static defaults cover the pre-mount frame.
export function DocumentHead({
  layers,
}: {
  layers: ReadonlyArray<Metadata | undefined>;
}): ReactNode {
  const defaults = useMetadataDefaults();
  // `mergeMetadata` allocates fresh object refs for `openGraph`/`twitter`/
  // `other` on every call, so memoizing on the merged result directly would
  // never be stable. Memoize on the actual inputs (`defaults` + `layers`)
  // instead, then derive the signature from that memoized result.
  const m = useMemo(
    () => mergeMetadata(defaults, layers),
    [defaults, layers],
  );

  const signature = useMemo(
    () =>
      JSON.stringify([
        m.title,
        m.description,
        m.themeColor,
        m.statusBarStyle,
        m.appleTitle,
        m.manifest,
        m.appleTouchIcon,
        m.openGraph,
        m.twitter,
        m.robots,
        m.other,
      ]),
    [m],
  );

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title = m.title;
    setMeta("description", m.description);
    setMeta("theme-color", m.themeColor);
    setMeta("apple-mobile-web-app-status-bar-style", m.statusBarStyle);
    setMeta("apple-mobile-web-app-title", m.appleTitle);
    setMeta("robots", m.robots);
    setLink("manifest", m.manifest === false ? null : m.manifest);
    setLink("apple-touch-icon", m.appleTouchIcon);

    setOgProperty("og:title", m.openGraph.title);
    setOgProperty("og:description", m.openGraph.description);
    setOgProperty("og:image", m.openGraph.image);
    setOgProperty("og:type", m.openGraph.type);
    setOgProperty("og:url", m.openGraph.url);
    setOgProperty("og:site_name", m.openGraph.siteName);
    setOgProperty("og:locale", m.openGraph.locale);

    setMeta("twitter:card", m.twitter.card);
    setMeta("twitter:site", m.twitter.site);
    setMeta("twitter:creator", m.twitter.creator);
    setMeta("twitter:title", m.twitter.title);
    setMeta("twitter:description", m.twitter.description);
    setMeta("twitter:image", m.twitter.image);

    for (const entry of m.other) setMeta(entry.name, entry.content);
    // signature is the deep-equality dependency; m is reconstructed each
    // render but its underlying values only change when the signature does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return null;
}

function setMeta(name: string, content: string | undefined): void {
  const existing = document.head.querySelector<HTMLMetaElement>(
    `meta[name="${cssEscape(name)}"]`,
  );
  if (content === undefined) {
    // Mirror `setLink`: navigating from a route that set this tag to one
    // that omits it must remove the tag, otherwise stale metadata leaks
    // across routes (e.g. a previous `robots: "noindex"` survives onto a
    // public page).
    existing?.remove();
    return;
  }
  if (!existing) {
    const el = document.createElement("meta");
    el.setAttribute("name", name);
    el.setAttribute("content", content);
    document.head.appendChild(el);
    return;
  }
  if (existing.getAttribute("content") !== content) {
    existing.setAttribute("content", content);
  }
}

// Open Graph uses `property=`, not `name=`. Different selector, same idea.
function setOgProperty(property: string, content: string | undefined): void {
  const existing = document.head.querySelector<HTMLMetaElement>(
    `meta[property="${cssEscape(property)}"]`,
  );
  if (content === undefined) {
    existing?.remove();
    return;
  }
  if (!existing) {
    const el = document.createElement("meta");
    el.setAttribute("property", property);
    el.setAttribute("content", content);
    document.head.appendChild(el);
    return;
  }
  if (existing.getAttribute("content") !== content) {
    existing.setAttribute("content", content);
  }
}

function setLink(rel: string, href: string | null | undefined): void {
  const existing = document.head.querySelector<HTMLLinkElement>(
    `link[rel="${cssEscape(rel)}"]`,
  );
  if (href == null) {
    existing?.remove();
    return;
  }
  if (existing) {
    if (existing.getAttribute("href") !== href) {
      existing.setAttribute("href", href);
    }
    return;
  }
  const el = document.createElement("link");
  el.setAttribute("rel", rel);
  el.setAttribute("href", href);
  document.head.appendChild(el);
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  // Fallback for older runtimes — escape quotes/backslashes used inside the
  // `[name="…"]` attribute selector.
  return value.replace(/(["\\])/g, "\\$1");
}

/// <reference lib="dom" />
import { test, expect, describe, beforeEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import {
  DocumentHead,
  MetadataDefaultsProvider,
  type Metadata,
  type MetadataDefaults,
} from "./metadata.tsx";

const DEFAULTS: MetadataDefaults = {
  themeColor: "#000000",
  backgroundColor: "#ffffff",
  statusBarStyle: "default",
  manifest: "/manifest.webmanifest",
  defaultTitle: "App",
};

function clearHead() {
  while (document.head.firstChild) {
    document.head.removeChild(document.head.firstChild);
  }
  document.title = "";
}

beforeEach(() => {
  cleanup();
  clearHead();
});

function renderHead(defaults: MetadataDefaults, layers: ReadonlyArray<Metadata | undefined>) {
  return render(
    <MetadataDefaultsProvider value={defaults}>
      <DocumentHead layers={layers} />
    </MetadataDefaultsProvider>,
  );
}

describe("DocumentHead — effect re-fire", () => {
  test("effect runs on first render and writes title + meta", () => {
    renderHead(DEFAULTS, [{ title: "Home", description: "hello" }]);
    expect(document.title).toBe("Home");
    const desc = document.head.querySelector('meta[name="description"]');
    expect(desc?.getAttribute("content")).toBe("hello");
  });

  test("effect does NOT re-fire when defaults and layers references are unchanged", () => {
    const layers: ReadonlyArray<Metadata> = [
      { title: "Home", description: "hello" },
    ];
    const { rerender } = render(
      <MetadataDefaultsProvider value={DEFAULTS}>
        <DocumentHead layers={layers} />
      </MetadataDefaultsProvider>,
    );
    expect(document.title).toBe("Home");

    // Mutate document.title from outside the component. If the effect
    // re-fires on a no-op rerender, it will reset the title back to
    // "Home". A correctly memoized signature keeps our manual change.
    document.title = "MANUALLY-CHANGED";

    rerender(
      <MetadataDefaultsProvider value={DEFAULTS}>
        <DocumentHead layers={layers} />
      </MetadataDefaultsProvider>,
    );

    expect(document.title).toBe("MANUALLY-CHANGED");
  });

  test("effect re-fires when layers contents change (even if outer array is new)", () => {
    const { rerender } = renderHead(DEFAULTS, [{ title: "First" }]);
    expect(document.title).toBe("First");

    rerender(
      <MetadataDefaultsProvider value={DEFAULTS}>
        <DocumentHead layers={[{ title: "Second" }]} />
      </MetadataDefaultsProvider>,
    );

    expect(document.title).toBe("Second");
  });

  test("removes meta[name] when a subsequent layer omits the field", () => {
    const { rerender } = renderHead(DEFAULTS, [{ robots: false }]);
    expect(
      document.head
        .querySelector('meta[name="robots"]')
        ?.getAttribute("content"),
    ).toBe("noindex, nofollow");

    rerender(
      <MetadataDefaultsProvider value={DEFAULTS}>
        <DocumentHead layers={[{}]} />
      </MetadataDefaultsProvider>,
    );
    expect(document.head.querySelector('meta[name="robots"]')).toBeNull();
  });

  test("removes meta[property] (Open Graph) when a subsequent layer omits the field", () => {
    const { rerender } = renderHead(DEFAULTS, [
      { openGraph: { title: "Old", description: "Old desc" } },
    ]);
    expect(
      document.head
        .querySelector('meta[property="og:title"]')
        ?.getAttribute("content"),
    ).toBe("Old");

    rerender(
      <MetadataDefaultsProvider value={DEFAULTS}>
        <DocumentHead layers={[{}]} />
      </MetadataDefaultsProvider>,
    );
    expect(document.head.querySelector('meta[property="og:title"]')).toBeNull();
    expect(
      document.head.querySelector('meta[property="og:description"]'),
    ).toBeNull();
  });

  test("removes Twitter meta when a subsequent layer omits the field", () => {
    const { rerender } = renderHead(DEFAULTS, [
      { twitter: { card: "summary", title: "Old" } },
    ]);
    expect(
      document.head
        .querySelector('meta[name="twitter:card"]')
        ?.getAttribute("content"),
    ).toBe("summary");

    rerender(
      <MetadataDefaultsProvider value={DEFAULTS}>
        <DocumentHead layers={[{}]} />
      </MetadataDefaultsProvider>,
    );
    expect(document.head.querySelector('meta[name="twitter:card"]')).toBeNull();
    expect(document.head.querySelector('meta[name="twitter:title"]')).toBeNull();
  });

  test("removing one field does not disturb others on the same render", () => {
    const { rerender } = renderHead(DEFAULTS, [
      { robots: false, description: "kept" },
    ]);
    expect(
      document.head
        .querySelector('meta[name="robots"]')
        ?.getAttribute("content"),
    ).toBe("noindex, nofollow");

    rerender(
      <MetadataDefaultsProvider value={DEFAULTS}>
        <DocumentHead layers={[{ description: "kept" }]} />
      </MetadataDefaultsProvider>,
    );
    expect(document.head.querySelector('meta[name="robots"]')).toBeNull();
    expect(
      document.head
        .querySelector('meta[name="description"]')
        ?.getAttribute("content"),
    ).toBe("kept");
  });

  test("effect does not re-fire when only an unrelated parent re-render occurs", () => {
    const layers: ReadonlyArray<Metadata> = [{ title: "Stable" }];

    function Wrapper({ tick }: { tick: number }) {
      // `tick` forces parent re-renders without changing DocumentHead's props.
      void tick;
      return (
        <MetadataDefaultsProvider value={DEFAULTS}>
          <DocumentHead layers={layers} />
        </MetadataDefaultsProvider>
      );
    }

    const { rerender } = render(<Wrapper tick={0} />);
    expect(document.title).toBe("Stable");

    document.title = "OUTSIDE";
    rerender(<Wrapper tick={1} />);
    rerender(<Wrapper tick={2} />);
    rerender(<Wrapper tick={3} />);

    expect(document.title).toBe("OUTSIDE");
  });
});

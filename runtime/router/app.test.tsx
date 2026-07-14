/// <reference lib="dom" />
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { StrictMode, useLayoutEffect } from "react";
import {
  Environment as RelayEnvironment,
  Network,
  RecordSource,
  Store,
} from "relay-runtime";
import type { PageModule, QueryParameter } from "../entrypoint.ts";
import type { Environment } from "../environment.ts";
import {
  MetadataDefaultsProvider,
  type MetadataDefaults,
} from "../metadata.tsx";
import { App } from "./app.tsx";
import { useNavigate } from "./context.ts";
import type { RouteRecord } from "./types.ts";

afterEach(() => {
  cleanup();
  resetTestUrl("/");
});

const TEST_DEFAULTS: MetadataDefaults = {
  themeColor: "#ffffff",
  backgroundColor: "#ffffff",
  statusBarStyle: "default",
  manifest: false,
  defaultTitle: "",
};

describe("App boot ownership", () => {
  test("StrictMode replay does not resolve/load the initial route twice", () => {
    resetTestUrl("/");
    const environment = makeTestEnvironment();
    let loadCalls = 0;
    let preloadCalls = 0;
    const pageModule: PageModule<Record<string, QueryParameter>> = {
      default: () => <div>HOME</div>,
    };
    const route: RouteRecord = {
      path: "/",
      segments: [],
      frames: [],
      entrypoint: {
        root: {
          moduleId: "test-page",
          getModuleIfRequired: () => pageModule,
          load: () => {
            loadCalls++;
            return Promise.resolve(pageModule);
          },
        },
        getPreloadProps: () => {
          preloadCalls++;
          return { queries: {} };
        },
      },
    };

    try {
      render(
        <StrictMode>
          <MetadataDefaultsProvider value={TEST_DEFAULTS}>
            <App
              routes={[route]}
              environment={environment}
              matcher={(routes) => ({ route: routes[0]!, params: {} })}
              viewTransitions={false}
            />
          </MetadataDefaultsProvider>
        </StrictMode>,
      );

      expect(preloadCalls).toBe(1);
      expect(loadCalls).toBe(1);
    } finally {
      environment.dispose();
    }
  });

  test("bootFallback navigation wins over the stale initial boot resolve", async () => {
    resetTestUrl("/");
    const environment = makeTestEnvironment();
    let homePreloads = 0;
    let targetPreloads = 0;
    const home = makeRoute("/", () => <div>HOME</div>, () => {
      homePreloads++;
    });
    const target = makeRoute("/target", () => <div>TARGET</div>, () => {
      targetPreloads++;
    });

    function Redirector() {
      const navigate = useNavigate();
      useLayoutEffect(() => {
        navigate("/target");
      }, [navigate]);
      return <div>BOOT</div>;
    }

    try {
      render(
        <MetadataDefaultsProvider value={TEST_DEFAULTS}>
          <App
            routes={[home, target]}
            environment={environment}
            matcher={(routes, pathname) => {
              const route = routes.find((r) => r.path === pathname);
              return route ? { route, params: {} } : null;
            }}
            viewTransitions={false}
            bootFallback={<Redirector />}
          />
        </MetadataDefaultsProvider>,
      );

      await waitFor(() => {
        expect(document.body.textContent).toContain("TARGET");
      });
      expect(window.location.pathname).toBe("/target");
      expect(document.body.textContent).not.toContain("HOME");
      expect(homePreloads).toBe(0);
      expect(targetPreloads).toBe(1);
    } finally {
      environment.dispose();
    }
  });

  test("onResolve runs after scroll restoration", async () => {
    resetTestUrl("/");
    const environment = makeTestEnvironment();
    let scrollApplied = false;
    let onResolveSawScroll = false;
    const route = makeRoute("/", () => <div>HOME</div>);

    try {
      render(
        <MetadataDefaultsProvider value={TEST_DEFAULTS}>
          <App
            routes={[route]}
            environment={environment}
            matcher={(routes) => ({ route: routes[0]!, params: {} })}
            scrollBehavior={{
              save: () => {},
              apply: () => {
                scrollApplied = true;
              },
            }}
            viewTransitions={false}
            onResolve={() => {
              onResolveSawScroll = scrollApplied;
            }}
          />
        </MetadataDefaultsProvider>,
      );

      await waitFor(() => {
        expect(onResolveSawScroll).toBe(true);
      });
    } finally {
      environment.dispose();
    }
  });

  test("StrictMode replay does not double-fire onResolve", async () => {
    resetTestUrl("/");
    const environment = makeTestEnvironment();
    let resolveCalls = 0;
    const route = makeRoute("/", () => <div>HOME</div>);

    try {
      render(
        <StrictMode>
          <MetadataDefaultsProvider value={TEST_DEFAULTS}>
            <App
              routes={[route]}
              environment={environment}
              matcher={(routes) => ({ route: routes[0]!, params: {} })}
              viewTransitions={false}
              onResolve={() => {
                resolveCalls++;
              }}
            />
          </MetadataDefaultsProvider>
        </StrictMode>,
      );

      await waitFor(() => {
        expect(resolveCalls).toBe(1);
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(resolveCalls).toBe(1);
    } finally {
      environment.dispose();
    }
  });

  test("latest same-tick navigation wins", async () => {
    resetTestUrl("/");
    const environment = makeTestEnvironment();
    let didNavigate = false;

    function Home() {
      const navigate = useNavigate();
      useLayoutEffect(() => {
        if (didNavigate) return;
        didNavigate = true;
        navigate("/b");
        navigate("/c");
      }, [navigate]);
      return <div>HOME</div>;
    }

    try {
      render(
        <MetadataDefaultsProvider value={TEST_DEFAULTS}>
          <App
            routes={[
              makeRoute("/", Home),
              makeRoute("/b", () => <div>B</div>),
              makeRoute("/c", () => <div>C</div>),
            ]}
            environment={environment}
            matcher={(routes, pathname) => {
              const route = routes.find((r) => r.path === pathname);
              return route ? { route, params: {} } : null;
            }}
          />
        </MetadataDefaultsProvider>,
      );

      await waitFor(() => {
        expect(document.body.textContent).toContain("C");
      });
      expect(window.location.pathname).toBe("/c");
      expect(document.body.textContent).not.toContain("B");
    } finally {
      environment.dispose();
    }
  });
});

function resetTestUrl(pathname: string): void {
  (window as unknown as { happyDOM: { setURL: (url: string) => void } })
    .happyDOM.setURL(new URL(pathname, "https://app.test/").href);
}

function makeRoute(
  path: string,
  Page: PageModule<Record<string, QueryParameter>>["default"],
  onPreload?: () => void,
): RouteRecord {
  const pageModule: PageModule<Record<string, QueryParameter>> = {
    default: Page,
  };
  return {
    path,
    segments: [],
    frames: [],
    entrypoint: {
      root: {
        moduleId: `test-page:${path}`,
        getModuleIfRequired: () => pageModule,
        load: () => Promise.resolve(pageModule),
      },
      getPreloadProps: () => {
        onPreload?.();
        return { queries: {} };
      },
    },
  };
}

function makeTestEnvironment(): Environment {
  return {
    relay: new RelayEnvironment({
      network: Network.create(() => Promise.resolve({ data: {} })),
      store: new Store(new RecordSource()),
    }),
    platform: {
      runtime: { type: "web", capabilities: [] },
      openExternal: () => Promise.resolve(true),
      copyToClipboard: () => Promise.resolve(true),
    },
    dispose: () => {},
  };
}

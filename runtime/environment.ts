import {
  Environment as RelayEnvironment,
  Network,
  Observable as RelayObservable,
  RecordSource,
  Store,
  type GraphQLResponse,
  type MissingFieldHandler,
  type SubscribeFunction,
} from "relay-runtime";
import type { PlatformRuntime } from "./platform.ts";
import { installWebRuntime } from "./platforms/web.ts";
// Resolved by the Crucible Vite plugin to <appRoot>/persisted-queries.json
// (the file relay-compiler writes). The plugin reads it from the consuming
// app's directory, NOT crucible's own — so this works correctly across
// every consumer regardless of where crucible is installed (workspace,
// node_modules, hoisted, etc.).
import persistedQueries from "virtual:crucible/persisted-queries";

const queryById = persistedQueries as Record<string, string>;

// GraphQL endpoint. Web builds: relative path resolves same-origin
// (SPA + API on one origin). Desktop builds: prefixed with the
// build-time `CRUCIBLE_API_BASE_URL` so the SPA loaded from
// `app://app` reaches the prod API. Empty base = relative = today's
// web behavior; consumers who customize the network handler (see
// `crucible.config.ts`'s `network.fetch`) can also rewrite per-call.
const API_BASE_URL: string = import.meta.env.CRUCIBLE_API_BASE_URL ?? "";
const GRAPHQL_ENDPOINT = `${API_BASE_URL}/api/graphql`;

// Cache key includes the schema hash (injected at build time by the
// Crucible Vite plugin). When the schema changes, the key changes — old
// records are orphaned and swept on next boot rather than reapplied to
// queries that may have new field shapes. Falls back to a default when
// the env var isn't defined (e.g. running tests outside Vite).
const SCHEMA_HASH = import.meta.env.CRUCIBLE_SCHEMA_HASH ?? "noschema";
const STORAGE_PREFIX = "crucible.relay-cache.";
const STORAGE_KEY = `${STORAGE_PREFIX}${SCHEMA_HASH}`;
const PERSIST_DEBOUNCE_MS = 500;

// Sweep any cache keys belonging to a prior schema. Runs once at module
// load — no per-request cost. Idempotent because we only remove keys with
// the prefix that don't match the current hash.
function sweepStaleCacheKeys(): void {
  if (typeof localStorage === "undefined") return;
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (k.startsWith(STORAGE_PREFIX) && k !== STORAGE_KEY) stale.push(k);
    }
    for (const k of stale) localStorage.removeItem(k);
  } catch {
    // private mode / quota issues — ignore
  }
}
sweepStaleCacheKeys();

function hydrateRecordSource(): RecordSource {
  if (typeof localStorage === "undefined") return new RecordSource();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new RecordSource();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return new RecordSource();
    return new RecordSource(parsed);
  } catch {
    return new RecordSource();
  }
}

type Persister = {
  schedule: () => void;
  dispose: () => void;
};

// Exported for unit tests; not part of the package's public API.
export function makePersister(source: RecordSource): Persister {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  return {
    schedule: () => {
      if (disposed || timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (disposed) return;
        if (typeof localStorage === "undefined") return;
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(source.toJSON()));
        } catch {
          try {
            localStorage.removeItem(STORAGE_KEY);
          } catch {
            // private mode / quota issues — give up
          }
        }
      }, PERSIST_DEBOUNCE_MS);
    },
    dispose: () => {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

// Retry policy: only the transient overload signals (429 Too Many Requests,
// 503 Service Unavailable). Other 4xx are permanent (auth, validation,
// missing fields) and retrying just amplifies load. 5xx other than 503
// are server bugs that won't fix themselves in 1s either. Network errors
// (fetch reject) are NOT retried here — Relay surfaces those to the caller
// to handle (offline indicator, etc.).
//
// Schedule: 3 retries with exponential backoff 250ms / 500ms / 1000ms,
// each with ±25% jitter to avoid synchronized retry storms across many
// tabs hitting the same overloaded server.
export const RETRY_STATUSES: ReadonlySet<number> = new Set([429, 503]);
export const RETRY_BACKOFF_MS: ReadonlyArray<number> = [250, 500, 1000];

export type FetchLike = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export type SubscribeLike = (
  input: string,
  init: RequestInit,
) => RelayObservable<GraphQLResponse>;

// `DOMException` with name "AbortError" — the spec-compliant rejection for
// an aborted fetch. Mirroring the platform here means downstream callers
// can do `err.name === "AbortError"` regardless of whether the abort came
// from the fetch itself or from our inter-retry sleep.
function makeAbortError(): Error {
  // `DOMException` is widely available in browsers and Node ≥17. Fall
  // back to a plain Error with the same `name` for any runtime that
  // hasn't shipped it yet.
  if (typeof DOMException !== "undefined") {
    return new DOMException("Aborted", "AbortError");
  }
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

// Sleep that races a timer against an AbortSignal. Resolves on timer
// fire, rejects with an AbortError when the signal aborts mid-sleep.
// Cleans up the listener and timer in either path.
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(makeAbortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(makeAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Exported for tests. Production callers should not invoke this directly —
// it's the inner loop of the Relay network handler.
//
// Honors `init.signal` end-to-end:
//   - If the signal is already aborted on entry, throws AbortError without
//     issuing any fetch.
//   - Each fetch attempt receives the caller's `init` (and thus `signal`),
//     so an in-flight abort propagates through the platform fetch.
//   - The inter-retry backoff is interruptible: aborting during the sleep
//     cancels the timer and throws AbortError instead of running the next
//     fetch.
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: {
    fetchImpl?: FetchLike;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    rng?: () => number;
  } = {},
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const sleep = opts.sleep ?? abortableSleep;
  const rng = opts.rng ?? Math.random;
  const signal = init.signal ?? undefined;

  // Pre-aborted: skip the network entirely. Mirrors `fetch()`'s own
  // behavior so callers see the same rejection shape regardless of
  // whether they aborted before or after the first byte went out.
  if (signal?.aborted) throw makeAbortError();

  // Total attempts = 1 initial + RETRY_BACKOFF_MS.length retries.
  let res = await fetchImpl(url, init);
  for (let attempt = 0; attempt < RETRY_BACKOFF_MS.length; attempt++) {
    if (!RETRY_STATUSES.has(res.status)) return res;
    const base = RETRY_BACKOFF_MS[attempt] ?? 1000;
    // Honor `Retry-After` (seconds form) when the server provides one;
    // cap at 5s so a hostile/buggy server can't lock the tab up. The
    // HTTP-date form is rare and we conservatively ignore it.
    const retryAfterHeader = res.headers.get("retry-after");
    const retryAfterMs =
      retryAfterHeader && /^\d+$/.test(retryAfterHeader.trim())
        ? Math.min(Number(retryAfterHeader.trim()) * 1000, 5_000)
        : null;
    // ±25% jitter: delay = base * (0.75 + rng() * 0.5).
    const jittered = Math.floor(base * (0.75 + rng() * 0.5));
    const delay = retryAfterMs ?? jittered;
    // `abortableSleep` rejects with AbortError if the signal fires
    // mid-sleep — propagates straight up; no further retries.
    await sleep(delay, signal);
    res = await fetchImpl(url, init);
  }
  return res;
}

// `node(id: $id)` is the canonical Relay refetch entry point: every type
// that implements `Node` is reachable by global id, and detail pages
// almost always fetch via `node(id: $id) { ... on Order { ... } }`. When
// a list page has already populated `Order:abc123` in the store, a
// detail navigation can satisfy the field locally — the global id is
// the DataID. Without this handler, Relay treats `node(id: $id)` as
// missing and fires a network request to refetch what's already there.
//
// The handler is conservative: it only fires when the field is named
// `node` AND the `id` argument is a string — anything else falls
// through to the default missing-field behavior.
//
// Exported for unit tests; not part of the package's public API.
export const NODE_MISSING_FIELD_HANDLER: MissingFieldHandler = {
  kind: "linked",
  handle(field, record, args, store) {
    if (
      field.name === "node" &&
      typeof args.id === "string" &&
      record?.getDataID() === store.getRoot().getDataID()
    ) {
      return args.id;
    }
    return undefined;
  },
};

function createRelayEnvironment(
  userFetch: FetchLike | undefined,
  userSubscribe: SubscribeLike | undefined,
  persistStore = true,
): { relay: RelayEnvironment; dispose: () => void } {
  const source = persistStore ? hydrateRecordSource() : new RecordSource();
  const store = new Store(source);
  const persister = persistStore
    ? makePersister(source)
    : { schedule: () => {}, dispose: () => {} } satisfies Persister;

  const buildGraphQLBody = (
    operation: { name: string; text?: string | null; id?: string | null },
    variables: Record<string, unknown> | null | undefined,
  ) => {
    // Resolve the operation's full text. relay-compiler emits one of:
    //   - `operation.text` (eagerEsModules + non-persisted dev)
    //   - `operation.id` only, with the text in `persisted-queries.json`
    // We always send the inline text — the server doesn't run a
    // persisted-query registry yet, so APQ-style id-only requests
    // would fail to execute. Once yoga gains `usePersistedOperations`
    // wired to the same registry, we can switch to id-only here.
    const text =
      operation.text ??
      (operation.id ? queryById[operation.id] : undefined);
    if (!text) {
      throw new Error(
        `[crucible] No operation text or persisted query for ${operation.name} (id=${String(
          operation.id,
        )}). Re-run \`bun run codegen\`.`,
      );
    }
    return {
      operationName: operation.name,
      query: text,
      variables: variables ?? {},
    };
  };

  const network = Network.create((operation, variables) => {
    const body = buildGraphQLBody(operation, variables as Record<string, unknown> | null | undefined);

    // Return a RelayObservable so Relay's `unsubscribe` (fired when a
    // navigation supersedes a request, or when a component using
    // `useQueryLoader` releases its retain) propagates into our internal
    // AbortController. Verified against the installed
    // `relay-runtime@20.1.1` source (`lib/network/RelayObservable.js`):
    //   - `Network.create(fetchFn)` calls `convertFetch`, which calls
    //     `RelayObservable.from(fetchFn(...))`. When `fetchFn` returns a
    //     RelayObservable directly, `from` short-circuits and reuses it.
    //   - `RelayObservable.create(source)` accepts a cleanup fn (or
    //     Subscription) returned by `source(sink)`; the cleanup runs on
    //     subscriber unsubscribe.
    // Without this bridge, a superseded request would still run to
    // completion (and its retries would still hammer the server)
    // because `fromPromise` does NOT abort the underlying promise on
    // unsubscribe.
    return RelayObservable.create<GraphQLResponse>((sink) => {
      const controller = new AbortController();
      (async () => {
        try {
          // Layer order: `fetchWithRetry` (transient 429/503 retry +
          // abort plumbing, from #8 / #18) wraps the user-provided
          // fetch (from #46). The retry layer issues each attempt
          // through `userFetch`, so a consumer's wrapper (e.g. an
          // Idempotency-Key injector) sees every retry as a real call
          // and reuses the same `(url, init)` — server-side dedup
          // works because the headers it set are still in `init`.
          // When no user fetch is configured, retry falls back to
          // platform `fetch`, preserving prior behavior exactly.
          const res = await fetchWithRetry(
            GRAPHQL_ENDPOINT,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              // Send the better-auth session cookie. Same-origin
              // (Vite proxy in dev, same host in prod) — no
              // third-party-cookie surprises.
              credentials: "include",
              body: JSON.stringify(body),
              signal: controller.signal,
            },
            { fetchImpl: userFetch },
          );
          if (!res.ok) {
            sink.error(
              new Error(
                `[crucible] GraphQL request failed: HTTP ${res.status} ${res.statusText}`,
              ),
            );
            return;
          }
          const json = (await res.json()) as GraphQLResponse;
          // Schedule a persist after Relay normalizes this response
          // into the store. The debounce + microtask gap gives the
          // commit time to land.
          queueMicrotask(persister.schedule);
          sink.next(json);
          sink.complete();
        } catch (err) {
          // AbortError when we're already torn down — Relay has
          // unsubscribed; nothing to deliver, no need to surface.
          if (controller.signal.aborted) return;
          sink.error(err instanceof Error ? err : new Error(String(err)));
        }
      })();
      return () => {
        // Unsubscribe path: Relay no longer cares about this result.
        // Aborting cancels the in-flight fetch AND interrupts any
        // pending backoff sleep so we don't fire retries against a
        // request the consumer threw away.
        controller.abort();
      };
    });
  }, userSubscribe
    ? ((operation, variables) => {
        const body = buildGraphQLBody(
          operation,
          variables as Record<string, unknown> | null | undefined,
        );
        return RelayObservable.create<GraphQLResponse>((sink) => {
          const subscription = userSubscribe(GRAPHQL_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify(body),
          }).subscribe({
            next: (payload) => {
              queueMicrotask(persister.schedule);
              sink.next(payload);
            },
            error: (error: Error) => sink.error(error),
            complete: () => sink.complete(),
          });
          return () => subscription.unsubscribe();
        });
      }) satisfies SubscribeFunction
    : undefined);

  return {
    relay: new RelayEnvironment({
      network,
      store,
      missingFieldHandlers: [NODE_MISSING_FIELD_HANDLER],
    }),
    dispose: persister.dispose,
  };
}

export type Environment = {
  relay: RelayEnvironment;
  platform: PlatformRuntime;
  // Cancels any pending persistence timer and disables further writes from
  // this environment's network handler. Only call when rotating
  // environments (e.g., logout/session-reset); the normal app lifetime
  // doesn't need to dispose.
  dispose: () => void;
};

export type CreateEnvironmentOptions = {
  /**
   * Pluggable platform runtime. Defaults to the web runtime
   * (`installWebRuntime`). Electron's preload script populates
   * `window.crucible` before the bundle loads; on web it's installed
   * at first call.
   */
  platform?: PlatformRuntime;
  /**
   * Custom fetch implementation used by Relay's network handler. When
   * omitted, the handler calls platform `fetch` directly. The supplied
   * function is invoked per attempt (initial + retries) with the same
   * `(url, init)` shape as `fetch`. Use this to inject request-scoped
   * headers (e.g. `Idempotency-Key`), telemetry, or auth-scheme
   * adapters without monkey-patching `globalThis.fetch`.
   *
   * Composition: Crucible's transient-retry layer (`fetchWithRetry`,
   * #8) and AbortSignal plumbing (#18) wrap your function — your
   * wrapper sees retries as separate calls but reuses the same `init`
   * across them, so server-side dedup keyed off your headers behaves
   * the way you'd expect.
   *
   * @example
   *   const idempotencyFetch: FetchLike = (url, init) => {
   *     const headers = new Headers(init.headers);
   *     if (!headers.has("Idempotency-Key")) {
   *       headers.set("Idempotency-Key", crypto.randomUUID());
   *     }
   *     return fetch(url, { ...init, headers });
   *   };
   *   createEnvironment({ fetch: idempotencyFetch });
   */
  fetch?: FetchLike;
  subscribe?: SubscribeLike;
  /**
   * Persist Relay's normalized RecordSource to localStorage. Defaults to true
   * for remote GraphQL apps. Local-first apps with a durable SQLite store
   * should set this to false so SQLite is the only persistent cache.
   */
  persistStore?: boolean;
};

// Two call shapes:
//   - `createEnvironment(platform?)` — legacy positional form, kept so
//     the codegen-emitted main.tsx pre-#46 keeps working byte-for-byte.
//   - `createEnvironment({ platform?, fetch?, subscribe? })` — options bag for
//     the network seam and any future env-level config.
export function createEnvironment(platform?: PlatformRuntime): Environment;
export function createEnvironment(options: CreateEnvironmentOptions): Environment;
export function createEnvironment(
  arg?: PlatformRuntime | CreateEnvironmentOptions,
): Environment {
  // Disambiguate by shape. A `PlatformRuntime` carries an
  // `openExternal` method (declared in platform.ts); the options bag
  // does not. Anything else (undefined, plain object) is treated as
  // options.
  const isPlatform =
    arg !== undefined &&
    typeof arg === "object" &&
    "openExternal" in arg;
  const options: CreateEnvironmentOptions = isPlatform
    ? { platform: arg as PlatformRuntime }
    : ((arg as CreateEnvironmentOptions | undefined) ?? {});

  // Ordering: when running in Electron, the preload script has already
  // assigned `window.crucible` with IPC-backed methods before the bundle
  // loaded. `installWebRuntime` is a no-op in that case (it bails when
  // `window.crucible` is already populated). On web, this is the first
  // assignment.
  const resolved = options.platform ?? installWebRuntime();
  const { relay, dispose } = createRelayEnvironment(
    options.fetch,
    options.subscribe,
    options.persistStore ?? true,
  );
  return { relay, platform: resolved, dispose };
}

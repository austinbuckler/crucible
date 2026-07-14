import {
  execute,
  parse,
  specifiedRules,
  subscribe,
  validate,
  type ExecutionResult,
  type GraphQLSchema,
} from "graphql";
import { Observable as RelayObservable, type GraphQLResponse } from "relay-runtime";
import type { FetchLike, SubscribeLike } from "./environment.ts";

type MaybePromise<T> = T | Promise<T>;

type LocalGraphQLRequest = {
  operationName?: string | null;
  query?: string;
  variables?: Record<string, unknown> | null;
};

export type LocalGraphQLContextFactoryArgs = {
  input: string;
  init: RequestInit;
  request: LocalGraphQLRequest;
};

export type LocalGraphQLFetchOptions<TContext = unknown> = {
  /**
   * GraphQL schema exposed to Relay. In the local-first path this should be
   * the Pothos schema whose resolvers read/write the client SQLite database.
   */
  schema: GraphQLSchema;
  /**
   * Per-request GraphQL context. Use this to pass a Drizzle client, sync
   * engine handle, user/session state, or tracing hooks into Pothos resolvers.
   */
  context?: TContext | ((args: LocalGraphQLContextFactoryArgs) => MaybePromise<TContext>);
  rootValue?: unknown;
  /**
   * Validate operations before execution. Defaults to true; tests or trusted
   * generated-operation runtimes can disable it to remove parse-time overhead.
   */
  validate?: boolean;
  /**
   * Optional one-time startup hook. In worker mode, this is the right place
   * to open SQLite, apply migrations, seed local data, and warm any sync
   * metadata before React mounts.
   */
  bootstrap?: () => MaybePromise<void>;
};

export type LocalGraphQLWorkerOptions = {
  /**
   * Worker that owns the local GraphQL executor. Keep Pothos, Drizzle, and
   * SQLite in this worker so Relay's main-thread fetch path only does RPC.
   */
  worker: Worker | (() => Worker);
};

export type LocalGraphQLOptions<TContext = unknown> =
  | LocalGraphQLFetchOptions<TContext>
  | LocalGraphQLWorkerOptions;

type WorkerRequestInit = {
  method?: string;
  headers?: Array<[string, string]>;
  body?: string;
};

type WorkerRequestMessage = {
  type: "crucible:local-graphql:request";
  id: number;
  input: string;
  init: WorkerRequestInit;
};

type WorkerInitMessage = {
  type: "crucible:local-graphql:init";
  id: number;
};

type WorkerCancelMessage = {
  type: "crucible:local-graphql:cancel";
  id: number;
};

type WorkerSubscribeMessage = {
  type: "crucible:local-graphql:subscribe";
  id: number;
  input: string;
  init: WorkerRequestInit;
};

type WorkerResponseMessage = {
  type: "crucible:local-graphql:response";
  id: number;
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: string;
};

type WorkerErrorMessage = {
  type: "crucible:local-graphql:error";
  id: number;
  error: {
    name?: string;
    message: string;
  };
};

type WorkerSubscriptionNextMessage = {
  type: "crucible:local-graphql:subscription:next";
  id: number;
  body: string;
};

type WorkerSubscriptionCompleteMessage = {
  type: "crucible:local-graphql:subscription:complete";
  id: number;
};

type WorkerInboundMessage =
  | WorkerResponseMessage
  | WorkerErrorMessage
  | WorkerSubscriptionNextMessage
  | WorkerSubscriptionCompleteMessage;
type WorkerOutboundMessage =
  | WorkerRequestMessage
  | WorkerInitMessage
  | WorkerCancelMessage
  | WorkerSubscribeMessage;

const workerCache = new WeakMap<LocalGraphQLWorkerOptions, Worker>();
const bootstrapCache = new WeakMap<LocalGraphQLFetchOptions, Promise<void>>();

function runLocalGraphQLBootstrap(options: LocalGraphQLFetchOptions): Promise<void> {
  let promise = bootstrapCache.get(options);
  if (!promise) {
    promise = Promise.resolve(options.bootstrap?.());
    bootstrapCache.set(options, promise);
  }
  return promise;
}

function getLocalGraphQLWorker(options: LocalGraphQLWorkerOptions): Worker {
  const cached = workerCache.get(options);
  if (cached) return cached;
  const worker = typeof options.worker === "function" ? options.worker() : options.worker;
  workerCache.set(options, worker);
  return worker;
}

type LocalGraphQLWorkerScope = EventTarget & {
  addEventListener: (
    type: "message",
    listener: (event: MessageEvent<WorkerOutboundMessage>) => void,
  ) => void;
  postMessage: (message: WorkerInboundMessage) => void;
};

function isWorkerOptions<TContext>(
  options: LocalGraphQLOptions<TContext>,
): options is LocalGraphQLWorkerOptions {
  return "worker" in options;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}

async function requestBodyToString(body: BodyInit | null | undefined): Promise<string> {
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(body);
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return body.text();
  }
  return "";
}

function isVariables(value: unknown): value is Record<string, unknown> | null | undefined {
  return value == null || (typeof value === "object" && !Array.isArray(value));
}

function parseLocalGraphQLRequest(raw: string): LocalGraphQLRequest | Error {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return new Error("GraphQL request body must be a JSON object.");
    }
    const request = parsed as Record<string, unknown>;
    if (typeof request.query !== "string" || request.query.length === 0) {
      return new Error("GraphQL request body must include a string `query`.");
    }
    if (!isVariables(request.variables)) {
      return new Error("GraphQL request `variables` must be an object when provided.");
    }
    if (
      request.operationName != null &&
      typeof request.operationName !== "string"
    ) {
      return new Error("GraphQL request `operationName` must be a string when provided.");
    }
    return {
      operationName: request.operationName ?? null,
      query: request.query,
      variables: request.variables,
    };
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return (
    value != null &&
    typeof value === "object" &&
    Symbol.asyncIterator in value &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  );
}

/**
 * Creates a Relay-compatible `fetch` implementation backed by either a local
 * GraphQL schema or a Worker that serves one. Relay still posts normal
 * GraphQL; the local schema decides whether reads hit SQLite, mutations
 * enqueue sync work, or resolvers delegate to a remote Worker/API.
 */
export function createLocalGraphQLFetch<TContext = unknown>(
  options: LocalGraphQLOptions<TContext>,
): FetchLike {
  if (isWorkerOptions(options)) return createLocalGraphQLWorkerFetch(options);

  const shouldValidate = options.validate ?? true;
  return async (input, init) => {
    throwIfAborted(init.signal);
    const method = init.method?.toUpperCase() ?? "GET";
    if (method !== "POST") {
      return jsonResponse(
        { errors: [{ message: "Local GraphQL only accepts POST requests." }] },
        { status: 405, statusText: "Method Not Allowed" },
      );
    }

    const rawBody = await requestBodyToString(init.body);
    throwIfAborted(init.signal);
    const request = parseLocalGraphQLRequest(rawBody);
    if (request instanceof Error) {
      return jsonResponse({ errors: [{ message: request.message }] }, { status: 400 });
    }

    try {
      await runLocalGraphQLBootstrap(options);
      throwIfAborted(init.signal);
      const document = parse(request.query ?? "");
      if (shouldValidate) {
        const validationErrors = validate(options.schema, document, specifiedRules);
        if (validationErrors.length > 0) {
          return jsonResponse({ errors: validationErrors });
        }
      }

      const contextValue =
        typeof options.context === "function"
          ? await (options.context as (args: LocalGraphQLContextFactoryArgs) => MaybePromise<TContext>)({
              input,
              init,
              request,
            })
          : options.context;
      throwIfAborted(init.signal);

      const result = (await execute({
        schema: options.schema,
        document,
        rootValue: options.rootValue,
        contextValue,
        variableValues: request.variables ?? undefined,
        operationName: request.operationName ?? undefined,
      })) as ExecutionResult;

      return jsonResponse(result);
    } catch (err) {
      if (init.signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
        throw err instanceof Error ? err : makeAbortError();
      }
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse({ errors: [{ message }] });
    }
  };
}

/**
 * Creates a Relay-compatible subscription implementation backed by GraphQL.js
 * `subscribe()`. In worker mode the async iterator stays in the worker and
 * each `ExecutionResult` is streamed to Relay over postMessage.
 */
export function createLocalGraphQLSubscribe<TContext = unknown>(
  options: LocalGraphQLOptions<TContext>,
): SubscribeLike {
  if (isWorkerOptions(options)) return createLocalGraphQLWorkerSubscribe(options);

  const shouldValidate = options.validate ?? true;
  return (input, init) =>
    RelayObservable.create<GraphQLResponse>((sink) => {
      let active = true;
      let iterator: AsyncIterator<ExecutionResult> | null = null;

      void (async () => {
        try {
          const method = init.method?.toUpperCase() ?? "GET";
          if (method !== "POST") {
            sink.error(new Error("Local GraphQL subscriptions only accept POST requests."));
            return;
          }

          const rawBody = await requestBodyToString(init.body);
          const request = parseLocalGraphQLRequest(rawBody);
          if (request instanceof Error) {
            sink.error(request);
            return;
          }

          await runLocalGraphQLBootstrap(options);
          if (!active) return;

          const document = parse(request.query ?? "");
          if (shouldValidate) {
            const validationErrors = validate(options.schema, document, specifiedRules);
            if (validationErrors.length > 0) {
              sink.next({ errors: validationErrors } as unknown as GraphQLResponse);
              sink.complete();
              return;
            }
          }

          const contextValue =
            typeof options.context === "function"
              ? await (options.context as (args: LocalGraphQLContextFactoryArgs) => MaybePromise<TContext>)({
                  input,
                  init,
                  request,
                })
              : options.context;
          if (!active) return;

          const result = await subscribe({
            schema: options.schema,
            document,
            rootValue: options.rootValue,
            contextValue,
            variableValues: request.variables ?? undefined,
            operationName: request.operationName ?? undefined,
          });

          if (!isAsyncIterable<ExecutionResult>(result)) {
            if (!active) return;
            sink.next(result as GraphQLResponse);
            sink.complete();
            return;
          }

          iterator = result[Symbol.asyncIterator]();
          if (!active) {
            await iterator.return?.();
            return;
          }
          while (active) {
            const next = await iterator.next();
            if (next.done) break;
            sink.next(next.value as GraphQLResponse);
          }
          if (active) sink.complete();
        } catch (err) {
          if (!active) return;
          sink.error(err instanceof Error ? err : new Error(String(err)));
        }
      })();

      return () => {
        active = false;
        void iterator?.return?.();
      };
    });
}

function makeAbortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("Aborted", "AbortError");
  }
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

function headersToEntries(headers: RequestInit["headers"]): Array<[string, string]> {
  return Array.from(new Headers(headers).entries());
}

function normalizeWorkerError(error: WorkerErrorMessage["error"]): Error {
  const err = new Error(error.message);
  if (error.name) err.name = error.name;
  return err;
}

function throwIfAborted(signal: AbortSignal | null | undefined): void {
  if (signal?.aborted) throw makeAbortError();
}

export function createLocalGraphQLWorkerFetch(
  options: LocalGraphQLWorkerOptions,
): FetchLike {
  let worker: Worker | null = null;
  let nextId = 1;
  const pending = new Map<
    number,
    {
      resolve: (response: Response) => void;
      reject: (error: Error) => void;
    }
  >();

  const getWorker = () => {
    if (!worker) {
      worker = getLocalGraphQLWorker(options);
      worker.addEventListener("message", (event: MessageEvent<WorkerInboundMessage>) => {
        const message = event.data;
        if (
          !message ||
          (message.type !== "crucible:local-graphql:response" &&
            message.type !== "crucible:local-graphql:error")
        ) {
          return;
        }

        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);

        if (message.type === "crucible:local-graphql:error") {
          entry.reject(normalizeWorkerError(message.error));
          return;
        }

        entry.resolve(
          new Response(message.body, {
            status: message.status,
            statusText: message.statusText,
            headers: message.headers,
          }),
        );
      });
      const rejectPending = (error: Error) => {
        for (const entry of pending.values()) entry.reject(error);
        pending.clear();
      };
      worker.addEventListener("error", (event) => {
        rejectPending(new Error(event.message || "Local GraphQL worker failed."));
      });
      worker.addEventListener("messageerror", () => {
        rejectPending(new Error("Local GraphQL worker sent an unreadable message."));
      });
    }
    return worker;
  };

  return async (input, init) => {
    const id = nextId++;
    const activeWorker = getWorker();
    if (init.signal?.aborted) throw makeAbortError();

    const body = await requestBodyToString(init.body);
    let onAbort: (() => void) | null = null;
    return new Promise<Response>((resolve, reject) => {
      onAbort = () => {
        pending.delete(id);
        activeWorker.postMessage({
          type: "crucible:local-graphql:cancel",
          id,
        } satisfies WorkerOutboundMessage);
        reject(makeAbortError());
      };

      pending.set(id, { resolve, reject });
      init.signal?.addEventListener("abort", onAbort, { once: true });

      activeWorker.postMessage({
        type: "crucible:local-graphql:request",
        id,
        input,
        init: {
          method: init.method,
          headers: headersToEntries(init.headers),
          body,
        },
      } satisfies WorkerOutboundMessage);
    }).finally(() => {
      if (onAbort) init.signal?.removeEventListener("abort", onAbort);
    });
  };
}

export function createLocalGraphQLWorkerSubscribe(
  options: LocalGraphQLWorkerOptions,
): SubscribeLike {
  let worker: Worker | null = null;
  let nextId = -1;
  const pending = new Map<
    number,
    {
      next: (response: GraphQLResponse) => void;
      complete: () => void;
      error: (error: Error) => void;
      finish: () => void;
    }
  >();

  const getWorker = () => {
    if (!worker) {
      worker = getLocalGraphQLWorker(options);
      worker.addEventListener("message", (event: MessageEvent<WorkerInboundMessage>) => {
        const message = event.data;
        if (
          !message ||
          (message.type !== "crucible:local-graphql:subscription:next" &&
            message.type !== "crucible:local-graphql:subscription:complete" &&
            message.type !== "crucible:local-graphql:error")
        ) {
          return;
        }

        const entry = pending.get(message.id);
        if (!entry) return;

        if (message.type === "crucible:local-graphql:error") {
          pending.delete(message.id);
          entry.finish();
          entry.error(normalizeWorkerError(message.error));
          return;
        }

        if (message.type === "crucible:local-graphql:subscription:complete") {
          pending.delete(message.id);
          entry.finish();
          entry.complete();
          return;
        }

        try {
          entry.next(JSON.parse(message.body) as GraphQLResponse);
        } catch (err) {
          pending.delete(message.id);
          entry.finish();
          entry.error(err instanceof Error ? err : new Error(String(err)));
        }
      });
      const errorPending = (error: Error) => {
        for (const entry of pending.values()) {
          entry.finish();
          entry.error(error);
        }
        pending.clear();
      };
      worker.addEventListener("error", (event) => {
        errorPending(new Error(event.message || "Local GraphQL worker failed."));
      });
      worker.addEventListener("messageerror", () => {
        errorPending(new Error("Local GraphQL worker sent an unreadable message."));
      });
    }
    return worker;
  };

  return (input, init) =>
    RelayObservable.create<GraphQLResponse>((sink) => {
      const id = nextId--;
      const activeWorker = getWorker();
      let disposed = false;
      let finished = false;

      void (async () => {
        try {
          if (init.signal?.aborted) throw makeAbortError();
          const body = await requestBodyToString(init.body);
          if (disposed) return;

          pending.set(id, {
            next: (response) => sink.next(response),
            complete: () => sink.complete(),
            error: (error) => sink.error(error),
            finish: () => {
              finished = true;
            },
          });

          activeWorker.postMessage({
            type: "crucible:local-graphql:subscribe",
            id,
            input,
            init: {
              method: init.method,
              headers: headersToEntries(init.headers),
              body,
            },
          } satisfies WorkerOutboundMessage);
        } catch (err) {
          sink.error(err instanceof Error ? err : new Error(String(err)));
        }
      })();

      return () => {
        disposed = true;
        pending.delete(id);
        if (finished) return;
        activeWorker.postMessage({
          type: "crucible:local-graphql:cancel",
          id,
        } satisfies WorkerOutboundMessage);
      };
    });
}

export function prepareLocalGraphQL<TContext = unknown>(
  options: LocalGraphQLOptions<TContext>,
): Promise<void> {
  if (!isWorkerOptions(options)) {
    return runLocalGraphQLBootstrap(options);
  }

  const worker = getLocalGraphQLWorker(options);
  const id = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);

  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      worker.removeEventListener("messageerror", onMessageError);
    };
    const onMessage = (event: MessageEvent<WorkerInboundMessage>) => {
      const message = event.data;
      if (!message || message.id !== id) return;
      cleanup();

      if (message.type === "crucible:local-graphql:error") {
        reject(normalizeWorkerError(message.error));
        return;
      }

      resolve();
    };
    const onError = (event: ErrorEvent) => {
      cleanup();
      reject(new Error(event.message || "Local GraphQL worker failed to start."));
    };
    const onMessageError = () => {
      cleanup();
      reject(new Error("Local GraphQL worker sent an unreadable startup message."));
    };

    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.addEventListener("messageerror", onMessageError);
    worker.postMessage({
      type: "crucible:local-graphql:init",
      id,
    } satisfies WorkerOutboundMessage);
  });
}

export function serveLocalGraphQLWorker<TContext = unknown>(
  options: LocalGraphQLFetchOptions<TContext>,
): void {
  const localFetch = createLocalGraphQLFetch(options);
  const localSubscribe = createLocalGraphQLSubscribe(options);
  const cancelled = new Set<number>();
  const subscriptions = new Map<number, { unsubscribe: () => void }>();
  const requestControllers = new Map<number, AbortController>();
  const scope = globalThis as unknown as LocalGraphQLWorkerScope;

  scope.addEventListener(
    "message",
    (event: MessageEvent<WorkerOutboundMessage>) => {
      const message = event.data;
      if (!message) return;

      if (message.type === "crucible:local-graphql:cancel") {
        cancelled.add(message.id);
        requestControllers.get(message.id)?.abort();
        requestControllers.delete(message.id);
        subscriptions.get(message.id)?.unsubscribe();
        subscriptions.delete(message.id);
        return;
      }

      if (message.type === "crucible:local-graphql:init") {
        void (async () => {
          try {
            await runLocalGraphQLBootstrap(options);
            scope.postMessage({
              type: "crucible:local-graphql:response",
              id: message.id,
              status: 204,
              statusText: "No Content",
              headers: [],
              body: "",
            } satisfies WorkerInboundMessage);
          } catch (err) {
            scope.postMessage({
              type: "crucible:local-graphql:error",
              id: message.id,
              error: {
                name: err instanceof Error ? err.name : undefined,
                message: err instanceof Error ? err.message : String(err),
              },
            } satisfies WorkerInboundMessage);
          }
        })();
        return;
      }

      if (message.type === "crucible:local-graphql:subscribe") {
        void (async () => {
          try {
            await runLocalGraphQLBootstrap(options);
            if (cancelled.has(message.id)) {
              cancelled.delete(message.id);
              return;
            }

            const subscription = localSubscribe(message.input, {
              method: message.init.method,
              headers: message.init.headers,
              body: message.init.body,
            }).subscribe({
              next: (payload) => {
                if (cancelled.has(message.id)) return;
                scope.postMessage({
                  type: "crucible:local-graphql:subscription:next",
                  id: message.id,
                  body: JSON.stringify(payload),
                } satisfies WorkerInboundMessage);
              },
              error: (err: Error) => {
                subscriptions.delete(message.id);
                if (cancelled.has(message.id)) {
                  cancelled.delete(message.id);
                  return;
                }
                scope.postMessage({
                  type: "crucible:local-graphql:error",
                  id: message.id,
                  error: {
                    name: err instanceof Error ? err.name : undefined,
                    message: err instanceof Error ? err.message : String(err),
                  },
                } satisfies WorkerInboundMessage);
              },
              complete: () => {
                subscriptions.delete(message.id);
                if (cancelled.has(message.id)) {
                  cancelled.delete(message.id);
                  return;
                }
                scope.postMessage({
                  type: "crucible:local-graphql:subscription:complete",
                  id: message.id,
                } satisfies WorkerInboundMessage);
              },
            });
            subscriptions.set(message.id, subscription);
          } catch (err) {
            if (cancelled.has(message.id)) {
              cancelled.delete(message.id);
              return;
            }
            scope.postMessage({
              type: "crucible:local-graphql:error",
              id: message.id,
              error: {
                name: err instanceof Error ? err.name : undefined,
                message: err instanceof Error ? err.message : String(err),
              },
            } satisfies WorkerInboundMessage);
          }
        })();
        return;
      }

      if (message.type !== "crucible:local-graphql:request") return;

      const controller = new AbortController();
      requestControllers.set(message.id, controller);

      void (async () => {
        try {
          await runLocalGraphQLBootstrap(options);
          if (cancelled.has(message.id)) {
            cancelled.delete(message.id);
            return;
          }
          const response = await localFetch(message.input, {
            method: message.init.method,
            headers: message.init.headers,
            body: message.init.body,
            signal: controller.signal,
          });
          const body = await response.text();
          if (cancelled.has(message.id)) {
            cancelled.delete(message.id);
            return;
          }
          scope.postMessage({
            type: "crucible:local-graphql:response",
            id: message.id,
            status: response.status,
            statusText: response.statusText,
            headers: Array.from(response.headers.entries()),
            body,
          } satisfies WorkerInboundMessage);
        } catch (err) {
          if (controller.signal.aborted) return;
          if (cancelled.has(message.id)) {
            cancelled.delete(message.id);
            return;
          }
          scope.postMessage({
            type: "crucible:local-graphql:error",
            id: message.id,
            error: {
              name: err instanceof Error ? err.name : undefined,
              message: err instanceof Error ? err.message : String(err),
            },
          } satisfies WorkerInboundMessage);
        } finally {
          requestControllers.delete(message.id);
        }
      })();
    },
  );
}

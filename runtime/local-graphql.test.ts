/// <reference lib="dom" />
import { describe, expect, test } from "bun:test";
import { buildSchema, GraphQLInt, GraphQLObjectType, GraphQLSchema } from "graphql";
import {
  createLocalGraphQLFetch,
  createLocalGraphQLSubscribe,
  prepareLocalGraphQL,
} from "./local-graphql.ts";

async function readJson(res: Response): Promise<unknown> {
  return res.json();
}

describe("createLocalGraphQLFetch", () => {
  test("executes Relay-style GraphQL POSTs against a local schema", async () => {
    const schema = buildSchema(`
      type Query {
        hello(name: String!): String!
      }
    `);
    const localFetch = createLocalGraphQLFetch({
      schema,
      rootValue: {
        hello: ({ name }: { name: string }) => `hello ${name}`,
      },
    });

    const res = await localFetch("/api/graphql", {
      method: "POST",
      body: JSON.stringify({
        operationName: "HelloQuery",
        query: "query HelloQuery($name: String!) { hello(name: $name) }",
        variables: { name: "relay" },
      }),
    });

    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ data: { hello: "hello relay" } });
  });

  test("passes a per-request context into resolvers", async () => {
    const schema = buildSchema(`
      type Query {
        dbName: String!
      }
    `);
    const localFetch = createLocalGraphQLFetch<{ dbName: string }>({
      schema,
      context: ({ request }) => ({
        dbName: `sqlite:${request.operationName}`,
      }),
      rootValue: {
        dbName: (_args: never, context: { dbName: string }) => context.dbName,
      },
    });

    const res = await localFetch("/api/graphql", {
      method: "POST",
      body: JSON.stringify({
        operationName: "LocalQuery",
        query: "query LocalQuery { dbName }",
      }),
    });

    expect(await readJson(res)).toEqual({ data: { dbName: "sqlite:LocalQuery" } });
  });

  test("returns GraphQL validation errors without executing", async () => {
    const schema = buildSchema("type Query { ok: Boolean! }");
    let executed = false;
    const localFetch = createLocalGraphQLFetch({
      schema,
      rootValue: {
        ok: () => {
          executed = true;
          return true;
        },
      },
    });

    const res = await localFetch("/api/graphql", {
      method: "POST",
      body: JSON.stringify({ query: "query BadQuery { missing }" }),
    });
    const json = (await readJson(res)) as { errors?: Array<{ message: string }> };

    expect(res.status).toBe(200);
    expect(executed).toBe(false);
    expect(json.errors?.[0]?.message).toContain("Cannot query field");
  });

  test("rejects malformed Relay POST bodies", async () => {
    const schema = buildSchema("type Query { ok: Boolean! }");
    const localFetch = createLocalGraphQLFetch({ schema });

    const res = await localFetch("/api/graphql", {
      method: "POST",
      body: JSON.stringify({ variables: [] }),
    });

    expect(res.status).toBe(400);
    expect(await readJson(res)).toEqual({
      errors: [{ message: "GraphQL request body must include a string `query`." }],
    });
  });

  test("only accepts POST requests", async () => {
    const schema = buildSchema("type Query { ok: Boolean! }");
    const localFetch = createLocalGraphQLFetch({ schema });

    const res = await localFetch("/api/graphql", { method: "GET" });

    expect(res.status).toBe(405);
    expect(await readJson(res)).toEqual({
      errors: [{ message: "Local GraphQL only accepts POST requests." }],
    });
  });
});

describe("createLocalGraphQLSubscribe", () => {
  test("executes GraphQL subscription operations and streams payloads", async () => {
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "Query",
        fields: {
          ok: { type: GraphQLInt, resolve: () => 1 },
        },
      }),
      subscription: new GraphQLObjectType({
        name: "Subscription",
        fields: {
          count: {
            type: GraphQLInt,
            subscribe: async function* () {
              yield { count: 1 };
              yield { count: 2 };
            },
            resolve: (event: { count: number }) => event.count,
          },
        },
      }),
    });
    const localSubscribe = createLocalGraphQLSubscribe({ schema });
    const payloads: unknown[] = [];

    await new Promise<void>((resolve, reject) => {
      localSubscribe("/api/graphql", {
        method: "POST",
        body: JSON.stringify({
          operationName: "CounterSubscription",
          query: "subscription CounterSubscription { count }",
        }),
      }).subscribe({
        next: (payload) => payloads.push(payload),
        error: reject,
        complete: resolve,
      });
    });

    expect(payloads).toEqual([{ data: { count: 1 } }, { data: { count: 2 } }]);
  });

  test("shares one bootstrap across prepare, fetch, and subscribe", async () => {
    let bootstrapCount = 0;
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "Query",
        fields: {
          ok: { type: GraphQLInt, resolve: () => 1 },
        },
      }),
      subscription: new GraphQLObjectType({
        name: "Subscription",
        fields: {
          count: {
            type: GraphQLInt,
            subscribe: async function* () {
              yield { count: 1 };
            },
            resolve: (event: { count: number }) => event.count,
          },
        },
      }),
    });
    const options = {
      schema,
      bootstrap: () => {
        bootstrapCount++;
      },
    };

    await prepareLocalGraphQL(options);
    await createLocalGraphQLFetch(options)("/api/graphql", {
      method: "POST",
      body: JSON.stringify({ query: "query OkQuery { ok }" }),
    });
    await new Promise<void>((resolve, reject) => {
      createLocalGraphQLSubscribe(options)("/api/graphql", {
        method: "POST",
        body: JSON.stringify({ query: "subscription CountSubscription { count }" }),
      }).subscribe({
        error: reject,
        complete: resolve,
      });
    });

    expect(bootstrapCount).toBe(1);
  });

  test("returns a subscription source that resolves after unsubscribe", async () => {
    let releaseSubscribe!: () => void;
    let markSubscribeStarted!: () => void;
    const subscribeStarted = new Promise<void>((resolve) => {
      markSubscribeStarted = resolve;
    });
    let sourceReturned = false;
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "Query",
        fields: {
          ok: { type: GraphQLInt, resolve: () => 1 },
        },
      }),
      subscription: new GraphQLObjectType({
        name: "Subscription",
        fields: {
          count: {
            type: GraphQLInt,
            subscribe: async () => {
              await new Promise<void>((resolve) => {
                releaseSubscribe = resolve;
                markSubscribeStarted();
              });
              return {
                [Symbol.asyncIterator]() {
                  return {
                    next: () => new Promise<IteratorResult<{ count: number }>>(() => {}),
                    return: async () => {
                      sourceReturned = true;
                      return { done: true, value: undefined };
                    },
                  };
                },
              };
            },
            resolve: (event: { count: number }) => event.count,
          },
        },
      }),
    });

    const subscription = createLocalGraphQLSubscribe({ schema })("/api/graphql", {
      method: "POST",
      body: JSON.stringify({ query: "subscription CountSubscription { count }" }),
    }).subscribe({});

    await subscribeStarted;
    subscription.unsubscribe();
    releaseSubscribe();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sourceReturned).toBe(true);
  });
});

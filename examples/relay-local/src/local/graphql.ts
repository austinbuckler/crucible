import SchemaBuilder from "@pothos/core";
import DrizzlePlugin from "@pothos/plugin-drizzle";
import RelayPlugin from "@pothos/plugin-relay";
import { eq } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import type { LocalDb } from "./db.ts";
import { dbRelations, todos } from "./schema.ts";

type TodoRow = {
  id: string;
  title: string;
  completed: boolean;
  updatedAt: string;
};

type TodoEventKind = "TODO_CREATED" | "TODO_TOGGLED";

type TodoEventPayload = {
  eventId: string;
  kind: TodoEventKind;
  message: string;
  emittedAt: string;
  sourceTab: string;
  todo: TodoRow;
};

export type LocalContext = {
  db: LocalDb;
};

const builder = new SchemaBuilder<{
  Context: LocalContext;
  DrizzleRelations: typeof dbRelations;
}>({
  plugins: [RelayPlugin, DrizzlePlugin],
  relay: {},
  drizzle: {
    client: (ctx) => ctx.db,
    getTableConfig,
    relations: dbRelations,
  },
});

const sourceTab = crypto.randomUUID();
const todoEventListeners = new Set<(event: TodoEventPayload) => void>();
const todoEventChannel =
  typeof BroadcastChannel === "undefined"
    ? null
    : new BroadcastChannel("crucible-relay-local:todo-events");

function isTodoEventPayload(value: unknown): value is TodoEventPayload {
  return (
    value != null &&
    typeof value === "object" &&
    typeof (value as TodoEventPayload).eventId === "string" &&
    typeof (value as TodoEventPayload).kind === "string" &&
    typeof (value as TodoEventPayload).message === "string" &&
    typeof (value as TodoEventPayload).emittedAt === "string" &&
    typeof (value as TodoEventPayload).sourceTab === "string" &&
    valueHasTodo((value as TodoEventPayload).todo)
  );
}

function valueHasTodo(value: unknown): value is TodoRow {
  return (
    value != null &&
    typeof value === "object" &&
    typeof (value as TodoRow).id === "string" &&
    typeof (value as TodoRow).title === "string" &&
    typeof (value as TodoRow).completed === "boolean" &&
    typeof (value as TodoRow).updatedAt === "string"
  );
}

function notifyTodoEvent(event: TodoEventPayload): void {
  for (const listener of todoEventListeners) listener(event);
}

todoEventChannel?.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (isTodoEventPayload(event.data)) notifyTodoEvent(event.data);
});

function publishTodoEvent(kind: TodoEventKind, todo: TodoRow): void {
  const event: TodoEventPayload = {
    eventId: crypto.randomUUID(),
    kind,
    message:
      kind === "TODO_CREATED"
        ? `Created local todo "${todo.title}"`
        : `${todo.completed ? "Completed" : "Reopened"} local todo "${todo.title}"`,
    emittedAt: new Date().toISOString(),
    sourceTab,
    todo,
  };
  notifyTodoEvent(event);
  todoEventChannel?.postMessage(event);
}

async function* subscribeTodoEvents(): AsyncGenerator<TodoEventPayload> {
  const queue: TodoEventPayload[] = [];
  let wake: (() => void) | null = null;
  const listener = (event: TodoEventPayload) => {
    queue.push(event);
    wake?.();
    wake = null;
  };

  todoEventListeners.add(listener);
  try {
    while (true) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      const event = queue.shift();
      if (event) yield event;
    }
  } finally {
    todoEventListeners.delete(listener);
  }
}

const Todo = builder.drizzleNode("todos", {
  name: "Todo",
  id: {
    column: (table) => table.id,
  },
  fields: (t) => ({
    databaseId: t.exposeString("id"),
    title: t.exposeString("title"),
    completed: t.exposeBoolean("completed"),
    updatedAt: t.exposeString("updatedAt"),
  }),
});

const TodoEvent = builder.objectRef<TodoEventPayload>("TodoEvent").implement({
  fields: (t) => ({
    eventId: t.exposeString("eventId"),
    kind: t.exposeString("kind"),
    message: t.exposeString("message"),
    emittedAt: t.exposeString("emittedAt"),
    sourceTab: t.exposeString("sourceTab"),
    todo: t.field({
      type: Todo,
      resolve: (event) => event.todo as never,
    }),
  }),
});

builder.queryType({
  fields: (t) => ({
    todos: t.drizzleConnection({
      type: Todo,
      resolve: async (query, _root, _args, ctx) =>
        (await ctx.db.query.todos.findMany(
          query({
            orderBy: {
              id: "asc",
            },
          }),
        )) as never,
    }),
  }),
});

builder.mutationType({
  fields: (t) => ({
    createTodo: t.field({
      type: Todo,
      args: {
        title: t.arg.string({ required: true }),
      },
      resolve: async (_root, args, ctx) => {
        const id = `todo_${crypto.randomUUID()}`;
        const [todo] = await ctx.db
          .insert(todos)
          .values({
            id,
            title: args.title.trim(),
            completed: false,
            updatedAt: new Date().toISOString(),
          })
          .returning();
        if (!todo) throw new Error("Failed to create todo");
        publishTodoEvent("TODO_CREATED", todo);
        return todo;
      },
    }),
    toggleTodo: t.field({
      type: Todo,
      args: {
        databaseId: t.arg.string({ required: true }),
      },
      resolve: async (_root, args, ctx) => {
        const existing = await ctx.db.query.todos.findFirst({
          where: {
            id: args.databaseId,
          },
        });
        if (!existing) throw new Error(`Todo not found: ${args.databaseId}`);

        const [todo] = await ctx.db
          .update(todos)
          .set({
            completed: !existing.completed,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(todos.id, args.databaseId))
          .returning();
        if (!todo) throw new Error("Failed to update todo");
        publishTodoEvent("TODO_TOGGLED", todo);
        return todo;
      },
    }),
  }),
});

builder.subscriptionType({
  fields: (t) => ({
    todoEvent: t.field({
      type: TodoEvent,
      subscribe: () => subscribeTodoEvents(),
      resolve: (event) => event,
    }),
  }),
});

export const schema = builder.toSchema();

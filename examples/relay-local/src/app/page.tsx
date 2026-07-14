import { useEffect, useState, type FormEvent } from "react";
import * as Crucible from "crucible";
import { graphql, useMutation, usePreloadedQuery } from "react-relay";
import type { page_CreateTodoMutation } from "./__generated__/page_CreateTodoMutation.graphql.ts";
import type { page_ToggleTodoMutation } from "./__generated__/page_ToggleTodoMutation.graphql.ts";
import type { page_TodosQuery } from "./__generated__/page_TodosQuery.graphql.ts";
import { SubscriptionProof } from "./subscription-proof.tsx";

type Todo = NonNullable<page_TodosQuery["response"]["todos"]["edges"][number]["node"]>;

const formatBytes = (value: number | null): string => {
  if (value == null) return "unknown";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
};

const formatPercent = (value: number | null): string => {
  if (value == null) return "unknown";
  return `${(value * 100).toFixed(1)}%`;
};

export const metadata = { title: "Relay Local" };

export const query = graphql`
  query page_TodosQuery @preloadable {
    app {
      storage {
        persisted
        usage
        quota
        usageRatio
      }
      sync {
        online
        status
        pendingMutations
      }
    }
    todos(first: 50) {
      edges {
        node {
          id
          databaseId
          title
          completed
          updatedAt
        }
      }
    }
  }
`;

const createTodoMutation = graphql`
  mutation page_CreateTodoMutation($title: String!) {
    createTodo(title: $title) {
      id
      databaseId
      title
      completed
      updatedAt
    }
  }
`;

const toggleTodoMutation = graphql`
  mutation page_ToggleTodoMutation($databaseId: String!) {
    toggleTodo(databaseId: $databaseId) {
      id
      databaseId
      title
      completed
      updatedAt
    }
  }
`;

export default function Page({ data }: { data: import("react-relay").PreloadedQuery<page_TodosQuery> }) {
  const result = usePreloadedQuery<page_TodosQuery>(query, data);
  const [todos, setTodos] = useState(() =>
    result.todos.edges
      .map((edge) => edge.node)
      .filter((todo): todo is Todo => todo != null),
  );
  const [title, setTitle] = useState("");
  const [lastWrite, setLastWrite] = useState<string | null>(null);
  const storage = result.app?.storage ?? null;
  const sync = result.app?.sync ?? null;
  const refreshStorage = Crucible.useStorageRefresh();
  const requestPersistence = Crucible.usePersistenceRequest();
  const [commitCreate, isCreating] = useMutation<page_CreateTodoMutation>(createTodoMutation);
  const [commitToggle, isToggling] = useMutation<page_ToggleTodoMutation>(toggleTodoMutation);

  const upsertTodo = (changed: Todo) => {
    setTodos((current) => {
      const existing = current.some((todo) => todo.databaseId === changed.databaseId);
      if (existing) {
        return current.map((todo) =>
          todo.databaseId === changed.databaseId ? changed : todo,
        );
      }
      return [changed, ...current];
    });
  };

  useEffect(() => {
    void refreshStorage();
  }, [refreshStorage]);

  const addTodo = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle || isCreating) return;

    commitCreate({
      variables: { title: trimmedTitle },
      onCompleted: (response) => {
        upsertTodo(response.createTodo);
        setTitle("");
        setLastWrite(`Created "${response.createTodo.title}" in local SQLite.`);
        void refreshStorage();
      },
    });
  };

  const toggle = (todo: Todo) => {
    if (isToggling) return;
    commitToggle({
      variables: { databaseId: todo.databaseId },
      optimisticResponse: {
        toggleTodo: {
          ...todo,
          completed: !todo.completed,
          updatedAt: new Date().toISOString(),
        },
      },
      onCompleted: (response) => {
        upsertTodo(response.toggleTodo);
        setLastWrite(
          `${response.toggleTodo.completed ? "Completed" : "Reopened"} "${response.toggleTodo.title}" in local SQLite.`,
        );
        void refreshStorage();
      },
    });
  };

  const askForPersistentStorage = async () => {
    await requestPersistence();
  };

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#101216",
        color: "#f7f3ea",
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
        padding: "48px min(8vw, 96px)",
      }}
    >
      <p style={{ color: "#a8ffcb", letterSpacing: "0.18em", textTransform: "uppercase" }}>
        Relay {"->"} local GraphQL {"->"} Drizzle {"->"} SQLite OPFS
      </p>
      <h1 style={{ fontSize: "clamp(44px, 8vw, 92px)", lineHeight: 0.9, margin: "24px 0" }}>
        Edit local data, reload, and watch it stick.
      </h1>
      <p style={{ color: "rgba(247,243,234,0.72)", fontSize: 18, lineHeight: 1.6, maxWidth: 760 }}>
        Every button below commits a normal Relay mutation. The network handler posts GraphQL to a
        worker, Pothos resolves it, Drizzle writes SQLite, and the database lives at
        <code> /crucible-relay-local.sqlite3</code> in OPFS when the browser supports it. The page
        also renders a separate component with a live <code>subscription todoEvent</code> running
        through Relay.
      </p>

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 360px), 1fr))",
          gap: 24,
          marginTop: 40,
        }}
      >
        <div>
          <form onSubmit={addTodo} style={{ display: "flex", gap: 12, marginBottom: 16 }}>
            <input
              value={title}
              onChange={(event) => setTitle(event.currentTarget.value)}
              placeholder="Add a local SQLite todo"
              style={{
                minWidth: 0,
                flex: 1,
                border: "1px solid rgba(255,255,255,0.18)",
                borderRadius: 14,
                background: "rgba(255,255,255,0.08)",
                color: "#f7f3ea",
                font: "inherit",
                padding: "14px 16px",
              }}
            />
            <button
              disabled={isCreating || title.trim().length === 0}
              style={{
                border: 0,
                borderRadius: 14,
                background: "#a8ffcb",
                color: "#101216",
                cursor: "pointer",
                font: "inherit",
                fontWeight: 800,
                padding: "0 18px",
              }}
            >
              {isCreating ? "Writing..." : "Write to SQLite"}
            </button>
          </form>

          <section style={{ display: "grid", gap: 12 }}>
            {todos.map((todo) => (
              <article
                key={todo.id}
                style={{
                  alignItems: "center",
                  border: "1px solid rgba(255,255,255,0.12)",
                  borderRadius: 18,
                  background: "rgba(255,255,255,0.06)",
                  display: "grid",
                  gap: 14,
                  gridTemplateColumns: "1fr auto",
                  padding: 20,
                }}
              >
                <div>
                  <strong
                    style={{
                      display: "block",
                      fontSize: 20,
                      textDecoration: todo.completed ? "line-through" : "none",
                    }}
                  >
                    {todo.title}
                  </strong>
                  <span style={{ color: todo.completed ? "#a8ffcb" : "#ffd08a" }}>
                    {todo.completed ? "completed" : "local draft"} - {todo.updatedAt}
                  </span>
                  <code style={{ display: "block", color: "rgba(247,243,234,0.5)", marginTop: 8 }}>
                    row id: {todo.databaseId}
                  </code>
                </div>
                <button
                  onClick={() => toggle(todo)}
                  style={{
                    border: "1px solid rgba(255,255,255,0.2)",
                    borderRadius: 999,
                    background: todo.completed ? "transparent" : "#ffd08a",
                    color: todo.completed ? "#f7f3ea" : "#101216",
                    cursor: "pointer",
                    font: "inherit",
                    fontWeight: 700,
                    padding: "10px 14px",
                  }}
                >
                  {todo.completed ? "Reopen" : "Complete"}
                </button>
              </article>
            ))}
          </section>
        </div>

        <aside
          style={{
            alignSelf: "start",
            border: "1px solid rgba(168,255,203,0.35)",
            borderRadius: 24,
            background: "rgba(168,255,203,0.08)",
            padding: 22,
          }}
        >
          <h2 style={{ marginTop: 0 }}>Persistence proof</h2>
          <p style={{ color: "rgba(247,243,234,0.72)", lineHeight: 1.5 }}>
            Create or toggle a todo, then hard reload. Relay store persistence is off for this app,
            so surviving rows are coming from SQLite/OPFS.
          </p>
          <dl style={{ display: "grid", gap: 10 }}>
            <div>
              <dt style={{ color: "rgba(247,243,234,0.58)" }}>Storage persisted</dt>
              <dd style={{ margin: 0 }}>{storage?.persisted == null ? "unknown" : String(storage.persisted)}</dd>
            </div>
            <div>
              <dt style={{ color: "rgba(247,243,234,0.58)" }}>Origin usage</dt>
              <dd style={{ margin: 0 }}>{formatBytes(storage?.usage ?? null)}</dd>
            </div>
            <div>
              <dt style={{ color: "rgba(247,243,234,0.58)" }}>Origin quota</dt>
              <dd style={{ margin: 0 }}>{formatBytes(storage?.quota ?? null)}</dd>
            </div>
            <div>
              <dt style={{ color: "rgba(247,243,234,0.58)" }}>Quota used</dt>
              <dd style={{ margin: 0 }}>{formatPercent(storage?.usageRatio ?? null)}</dd>
            </div>
            <div>
              <dt style={{ color: "rgba(247,243,234,0.58)" }}>Sync status</dt>
              <dd style={{ margin: 0 }}>
                {sync?.status ?? "unknown"} {sync?.online === false ? "(offline)" : ""}
                {sync?.pendingMutations ? ` - ${sync.pendingMutations} pending` : ""}
              </dd>
            </div>
          </dl>
          <button
            onClick={askForPersistentStorage}
            style={{
              border: "1px solid rgba(255,255,255,0.22)",
              borderRadius: 14,
              background: "rgba(255,255,255,0.08)",
              color: "#f7f3ea",
              cursor: "pointer",
              font: "inherit",
              marginTop: 16,
              padding: "12px 14px",
              width: "100%",
            }}
          >
            Request persistent storage
          </button>
          <button
            onClick={() => window.location.reload()}
            style={{
              border: 0,
              borderRadius: 14,
              background: "#f7f3ea",
              color: "#101216",
              cursor: "pointer",
              font: "inherit",
              fontWeight: 800,
              marginTop: 10,
              padding: "12px 14px",
              width: "100%",
            }}
          >
            Reload and read SQLite
          </button>
          {lastWrite ? <p style={{ color: "#a8ffcb" }}>{lastWrite}</p> : null}
          <SubscriptionProof />
        </aside>
      </section>
    </main>
  );
}

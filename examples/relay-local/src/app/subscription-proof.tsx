import { useMemo, useState, type ReactElement } from "react";
import { graphql, useSubscription } from "react-relay";
import type { subscriptionProof_TodoEventsSubscription } from "./__generated__/subscriptionProof_TodoEventsSubscription.graphql.ts";

type EventRow = {
  eventId: string;
  kind: string;
  message: string;
  emittedAt: string;
  sourceTab: string;
  todoTitle: string;
};

const todoEventsSubscription = graphql`
  subscription subscriptionProof_TodoEventsSubscription {
    todoEvent {
      eventId
      kind
      message
      emittedAt
      sourceTab
      todo {
        id
        title
      }
    }
  }
`;

export function SubscriptionProof(): ReactElement {
  const [status, setStatus] = useState("listening");
  const [events, setEvents] = useState<EventRow[]>([]);

  const subscriptionConfig = useMemo(
    () => ({
      subscription: todoEventsSubscription,
      variables: {},
      onNext: (payload: subscriptionProof_TodoEventsSubscription["response"] | null | undefined) => {
        const event = payload?.todoEvent;
        if (!event) return;
        setStatus(`received ${event.kind}`);
        setEvents((current) => [
          {
            eventId: event.eventId,
            kind: event.kind,
            message: event.message,
            emittedAt: event.emittedAt,
            sourceTab: event.sourceTab,
            todoTitle: event.todo.title,
          },
          ...current,
        ].slice(0, 5));
      },
      onError: (error: Error) => {
        setStatus(`error: ${error.message}`);
      },
      onCompleted: () => {
        setStatus("completed");
      },
    }),
    [],
  );

  useSubscription<subscriptionProof_TodoEventsSubscription>(subscriptionConfig);

  return (
    <div
      style={{
        borderTop: "1px solid rgba(255,255,255,0.16)",
        marginTop: 18,
        paddingTop: 18,
      }}
    >
      <h3 style={{ margin: "0 0 8px" }}>Subscription proof</h3>
      <p style={{ color: "rgba(247,243,234,0.72)", lineHeight: 1.5, marginTop: 0 }}>
        This component runs a real Relay subscription to <code>todoEvent</code>. The payload includes
        event metadata that is not part of the todo list query.
      </p>
      <dl style={{ display: "grid", gap: 10 }}>
        <div>
          <dt style={{ color: "rgba(247,243,234,0.58)" }}>Relay subscription</dt>
          <dd style={{ margin: 0 }}>{status}</dd>
        </div>
        <div>
          <dt style={{ color: "rgba(247,243,234,0.58)" }}>Events received</dt>
          <dd style={{ margin: 0, fontSize: 28, fontWeight: 900 }}>{events.length}</dd>
        </div>
      </dl>
      {events.length > 0 ? (
        <ol style={{ color: "rgba(247,243,234,0.78)", paddingLeft: 20 }}>
          {events.map((event) => (
            <li key={event.eventId}>
              <strong>{event.kind}</strong>: {event.message}
              <code style={{ display: "block", color: "rgba(247,243,234,0.52)", marginTop: 4 }}>
                event {event.eventId} from tab {event.sourceTab.slice(0, 8)} at {event.emittedAt}
              </code>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

import { Component, type ReactNode } from "react";

const NOT_FOUND_TAG: unique symbol = Symbol.for("crucible.NotFound");

class NotFoundError extends Error {
  // Discriminator that survives instanceof failures across module copies.
  readonly [NOT_FOUND_TAG] = true;
  constructor() {
    super("not_found");
    this.name = "NotFoundError";
  }
}

export function notFound(): never {
  throw new NotFoundError();
}

function isNotFoundError(value: unknown): value is NotFoundError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[NOT_FOUND_TAG] === true
  );
}

type Props = {
  fallback: ReactNode;
  children: ReactNode;
};

type State = {
  error: unknown;
};

// React error boundaries can't opt out of catching, so we catch every error,
// render the fallback only for NotFoundError, and re-throw anything else
// during render so the outer ErrorBoundary handles it.
export class NotFoundBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      if (isNotFoundError(this.state.error)) return this.props.fallback;
      throw this.state.error;
    }
    return this.props.children;
  }
}

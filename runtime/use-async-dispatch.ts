import { useCallback, useTransition } from "react";

type Dispatch = <T>(fn: () => Promise<T>) => Promise<T>;

// Thin wrapper over React 19's `useTransition` for dispatching async work
// (typically a `'use worker'` call). The transition stays pending for the
// full duration of the awaited promise — including any state updates inside
// the dispatched function — so a button bound to `dispatch` shows accurate
// busy state without manual flag wrangling.
//
// Returns `[dispatch, isPending]` matching the parameter order callers
// usually want at the use-site:
//
//   const [dispatch, isPending] = useAsyncDispatch()
//   <button
//     onClick={() => dispatch(exportCsv).then(setCsv)}
//     disabled={isPending}
//   />
export function useAsyncDispatch(): readonly [Dispatch, boolean] {
  const [isPending, startTransition] = useTransition();
  const dispatch = useCallback<Dispatch>((fn) => {
    return new Promise((resolve, reject) => {
      startTransition(async () => {
        try {
          resolve(await fn());
        } catch (err) {
          reject(err);
        }
      });
    });
  }, []);
  return [dispatch, isPending] as const;
}

export type AsyncRunObserverDispose = () => void;

export interface AsyncRunObserverOptions<T> {
  register: () => Promise<AsyncRunObserverDispose>;
  run: () => Promise<T>;
  onRegistrationError?: (error: unknown) => void;
}

/**
 * Starts observer registration, invokes the state-capturing run synchronously,
 * then waits for both while guaranteeing disposal of a late observer.
 */
export async function runWithAsyncObserver<T>(
  options: AsyncRunObserverOptions<T>,
): Promise<T> {
  const registration = (() => {
    try {
      return Promise.resolve(options.register()).catch((error) => {
        try {
          options.onRegistrationError?.(error);
        } catch {
          // Observer failure reporting must never replace the run outcome.
        }
        return null;
      });
    } catch (error) {
      try {
        options.onRegistrationError?.(error);
      } catch {
        // Observer failure reporting must never prevent the run from starting.
      }
      return Promise.resolve(null);
    }
  })();

  let run: Promise<T>;
  try {
    run = Promise.resolve(options.run());
    // Registration can be deferred; attach rejection handling immediately.
    void run.catch(() => undefined);
  } catch (error) {
    const dispose = await registration;
    dispose?.();
    throw error;
  }

  const dispose = await registration;
  try {
    return await run;
  } finally {
    dispose?.();
  }
}

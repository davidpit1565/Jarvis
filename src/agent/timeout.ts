export class AgentTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentTimeoutError";
  }
}

/** Races `promise` against a timer, rejecting with AgentTimeoutError if the timer wins. Never leaves a dangling timer. */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AgentTimeoutError(message)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        reject(error as Error);
      });
  });
}

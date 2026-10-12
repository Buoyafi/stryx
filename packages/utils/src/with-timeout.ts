/** Thrown when withTimeout's own budget is what ran out. */
export class TimeoutBudgetExceededError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutBudgetExceededError';
  }
}

/** Bounds a promise to `ms`, rejecting with a labeled error if it hasn't settled in time. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutBudgetExceededError(label, ms)), ms);
  });
  return Promise.race([promise, budget]).finally(() => clearTimeout(timer));
}

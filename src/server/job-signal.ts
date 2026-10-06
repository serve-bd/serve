import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage<AbortSignal>();

/**
 * Runs a job with its abort signal in reach of every command it starts, however deep (a restore
 * runs dozens, through helpers that know nothing of jobs). Commands stop when it aborts.
 */
export function withJobSignal<T>(signal: AbortSignal, fn: () => Promise<T>) {
  return store.run(signal, fn);
}

/** The running job's abort signal, if it runs under withJobSignal. */
export function jobSignal(): AbortSignal | undefined {
  return store.getStore();
}

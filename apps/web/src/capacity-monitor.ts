export interface RunCapacity {
  limit: number;
  inUse: number;
  available: number;
}

export type CapacityState =
  | { kind: "checking" }
  | { kind: "unavailable" }
  | { kind: "ready"; capacity: RunCapacity; checkedAt: number };

export function parseCapacity(value: unknown): RunCapacity {
  if (!value || typeof value !== "object") throw new Error("Invalid capacity response");
  const { limit, inUse, available } = value as RunCapacity;
  if (!Number.isInteger(limit) || limit < 1 || limit > 8 ||
      !Number.isInteger(inUse) || inUse < 0 || inUse > limit ||
      !Number.isInteger(available) || available !== limit - inUse) {
    throw new Error("Invalid capacity response");
  }
  return { limit, inUse, available };
}

interface Clock {
  now(): number;
  set(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clear(timer: ReturnType<typeof setTimeout>): void;
}

/** One outstanding request; failures/expiry remove old counts rather than imply zero. */
export function createCapacityMonitor(
  load: (signal: AbortSignal) => Promise<unknown>,
  publish: (state: CapacityState) => void,
  clock: Clock = {
    now: () => Date.now(),
    // Browser timer functions require the global receiver, not this clock.
    set: (callback, delay) => globalThis.setTimeout(callback, delay),
    clear: timer => globalThis.clearTimeout(timer),
  },
) {
  let stopped = false;
  let generation = 0;
  let request: Promise<void> | null = null;
  let controller: AbortController | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let checkedAt: number | null = null;
  const clear = (timer: ReturnType<typeof setTimeout> | undefined) => { if (timer !== undefined) clock.clear(timer); };

  const refresh = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (checkedAt !== null && clock.now() - checkedAt >= 8_000) publish({ kind: "unavailable" });
    if (request) return request;
    clear(pollTimer);
    const current = ++generation;
    const abort = new AbortController();
    controller = abort;
    const timeout = new Promise<never>((_, reject) => {
      timeoutTimer = clock.set(() => { abort.abort(); reject(new Error("Capacity request timed out")); }, 4_000);
    });
    request = Promise.race([Promise.resolve().then(() => load(abort.signal)), timeout])
      .then(value => {
        if (stopped || current !== generation) return;
        const capacity = parseCapacity(value);
        checkedAt = clock.now();
        publish({ kind: "ready", capacity, checkedAt });
        clear(expiryTimer);
        expiryTimer = clock.set(() => { if (!stopped) publish({ kind: "unavailable" }); }, 8_000);
      })
      .catch(() => {
        if (!stopped && current === generation) { checkedAt = null; publish({ kind: "unavailable" }); }
      })
      .finally(() => {
        clear(timeoutTimer);
        request = null;
        controller = null;
        if (!stopped) pollTimer = clock.set(() => { void refresh(); }, 2_000);
      });
    return request;
  };

  return {
    refresh,
    stop() {
      stopped = true;
      generation++;
      controller?.abort();
      clear(pollTimer); clear(expiryTimer); clear(timeoutTimer);
    },
  };
}

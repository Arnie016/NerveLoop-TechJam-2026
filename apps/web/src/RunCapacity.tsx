import type { CapacityState } from "./capacity-monitor";

export function RunCapacityIndicator({ state, refresh }: { state: CapacityState; refresh: () => void }) {
  const full = state.kind === "ready" && state.capacity.available === 0;
  return (
    <section className={"capacity-strip" + (full ? " capacity-full" : "")} aria-label="Run capacity">
      <div className="capacity-copy" role="status" aria-live="polite" aria-atomic="true">
        <span className="capacity-label">Run capacity</span>
        <strong>{state.kind === "ready"
          ? `${state.capacity.inUse} of ${state.capacity.limit} in use`
          : state.kind === "checking" ? "Checking capacity…" : "Capacity unavailable"}</strong>
        <span>{state.kind === "ready"
          ? full ? "Full. Keep your draft; retry after a Run finishes." : `${state.capacity.available} slot${state.capacity.available === 1 ? "" : "s"} available · Checked recently`
          : "The server checks capacity on every Send."}</span>
      </div>
      <button type="button" className="capacity-refresh" onClick={refresh} aria-label="Refresh Run capacity">Refresh</button>
    </section>
  );
}

// One active read-only request. Cancellation invalidates even transports ignoring AbortSignal.
export class DecisionSession {
  private generation = 0;
  private active: AbortController | null = null;
  cancel() { this.generation++; this.active?.abort(); this.active = null; }
  begin() {
    if (this.active) return null;
    const controller = new AbortController(); this.active = controller;
    const id = ++this.generation;
    return { id, signal: controller.signal, current: () => this.generation === id && !controller.signal.aborted,
      finish: () => { if (this.generation === id) this.active = null; } };
  }
}

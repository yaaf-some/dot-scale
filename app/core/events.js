// Tiny typed event emitter shared by store and scale.
// `on(type, fn, { signal })` auto-unsubscribes when the AbortSignal aborts, so views never leak listeners.
export class Emitter {
  #handlers = new Map();

  on(type, fn, { signal } = {}) {
    if (signal?.aborted) return () => {};
    let set = this.#handlers.get(type);
    if (!set) this.#handlers.set(type, (set = new Set()));
    set.add(fn);
    const off = () => set.delete(fn);
    signal?.addEventListener('abort', off, { once: true });
    return off;
  }

  emit(type, detail) {
    for (const fn of [...(this.#handlers.get(type) ?? [])]) {
      try { fn(detail); } catch (e) { console.error(`handler for "${type}" threw`, e); }
    }
  }
}

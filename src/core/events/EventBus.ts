import type { JarvisEventMap, JarvisEventName } from "@/types/events";

type Listener<T> = (payload: T) => void;

/**
 * Lightweight typed pub/sub bus. Intentionally synchronous and in-memory —
 * Phase 1 has a single process, so nothing more is needed yet.
 */
export class EventBus {
  private listeners: Map<JarvisEventName, Set<Listener<unknown>>> = new Map();

  on<E extends JarvisEventName>(event: E, listener: Listener<JarvisEventMap[E]>): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener as Listener<unknown>);
    this.listeners.set(event, set);
    return () => set.delete(listener as Listener<unknown>);
  }

  emit<E extends JarvisEventName>(event: E, payload: JarvisEventMap[E]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of set) {
      listener(payload);
    }
  }
}

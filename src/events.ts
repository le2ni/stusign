import type { Unsubscribe } from './types.js';

export class Emitter<T> {
  private readonly listeners = new Set<(event: T) => void>();
  constructor(private readonly onError: (error: unknown) => void = () => {}) {}
  on(listener: (event: T) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  emit(event: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.onError(error);
      }
    }
  }
  clear(): void {
    this.listeners.clear();
  }
}

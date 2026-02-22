/**
 * @fileoverview Global test setup — runs before every test file via bunfig.toml preload.
 * @module __tests__/setup
 *
 * Provides browser globals that are missing in Node/Bun (e.g. EventSource for SSE).
 */

/** Minimal EventSource-like type for test mock (browser EventSource is not in Node/Bun). */
type EventSourceConstructor = new (url: string) => {
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  close(): void;
  readyState: number;
  dispatchEvent(event: Event): boolean;
};

declare global {
  // eslint-disable-next-line no-var
  var EventSource: EventSourceConstructor | undefined;
}

if (typeof globalThis.EventSource === "undefined") {
  globalThis.EventSource = class EventSource {
    constructor(_url: string) {}
    addEventListener(_type: string, _listener: EventListenerOrEventListenerObject): void {}
    removeEventListener(_type: string, _listener: EventListenerOrEventListenerObject): void {}
    close(): void {}
    get readyState(): number {
      return 2; // CLOSED
    }
    dispatchEvent(_event: Event): boolean {
      return true;
    }
  } as EventSourceConstructor;
}

import type { MainEvent } from '../shared/types';

type Sink = (event: MainEvent) => void;
let sink: Sink = () => {};
/** Extra listeners besides the window (the phone link). */
const listeners = new Set<Sink>();

export function setSink(fn: Sink) {
  sink = fn;
}

export function listen(fn: Sink) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(event: MainEvent) {
  sink(event);
  for (const l of listeners) {
    try {
      l(event);
    } catch {
      /* a listener must not break the window */
    }
  }
}

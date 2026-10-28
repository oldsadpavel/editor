import type { MainEvent } from '../shared/types';

type Sink = (event: MainEvent) => void;
let sink: Sink = () => {};

export function setSink(fn: Sink) {
  sink = fn;
}

export function emit(event: MainEvent) {
  sink(event);
}

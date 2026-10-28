import type { MainEvent } from '../shared/types';

interface Bridge {
  invoke<T = any>(channel: string, ...args: unknown[]): Promise<T>;
  on(fn: (e: MainEvent) => void): () => void;
}

export const bridge: Bridge = (window as any).bridge;
export const call = <T = any>(channel: string, ...args: unknown[]) => bridge.invoke<T>(channel, ...args);

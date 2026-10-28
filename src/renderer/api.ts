import type { MainEvent } from '../shared/types';

interface Bridge {
  invoke<T = any>(channel: string, ...args: unknown[]): Promise<T>;
  on(fn: (e: MainEvent) => void): () => void;
  pathForFile(file: File): string;
}

export const bridge: Bridge = (window as any).bridge;
export const call = <T = any>(channel: string, ...args: unknown[]) => bridge.invoke<T>(channel, ...args);

/** URL that shows a local file in <img> (served by the main process `efile:` protocol). */
export const fileUrl = (path: string, version?: number) => `efile:///${encodeURIComponent(path)}${version ? `?v=${version}` : ''}`;

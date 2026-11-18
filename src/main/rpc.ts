/** Every IPC handler of the renderer, by channel — the same functions serve the phone link (remote-link.ts). */
export const handlers = new Map<string, (...args: any[]) => any>();

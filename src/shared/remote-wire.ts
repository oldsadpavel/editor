/**
 * Wire format of the phone link (MPI ↔ MPI Remote on Android) — shared by the editor (Node) and the app (browser).
 *
 * Every frame goes through Insider: POST /api/editor/remote/send {d} → the user's private channel on socket.mrkt.ru
 * (event «f», data {d}). `d` is one of:
 *   "j<json>"                — a message;
 *   "z<base64 deflate-raw>"  — a big message, compressed;
 *   "p<id>:<i>:<n>:<chunk>"  — part i of n of a frame too big for one request (the chunks joined give "j…"/"z…").
 */

/** Phone → PC. `from` is the phone's id (several phones may be signed in). */
export type PhoneMsg =
  | { k: 'hello'; from: string; name: string }
  | { k: 'bye'; from: string }
  | { k: 'rpc'; from: string; id: number; ch: string; args: unknown[] }
  | { k: 'sub'; from: string; ids: string[] };

/** PC → phone(s). Without `to` — for every phone. */
export type PcMsg =
  | { k: 'pc'; to?: string; name: string; version: string; at: number }
  | { k: 'ack'; to: string; id: number }
  | { k: 'res'; to: string; id: number; ok: boolean; value?: unknown; error?: string }
  | { k: 'ev'; list: unknown[] }
  | { k: 'off' };

export const CHUNK = 100_000;
const COMPRESS_FROM = 1500;

export interface Codec {
  deflate(text: string): Promise<string>;
  inflate(b64: string): Promise<string>;
}

export async function encode(msg: unknown, codec: Codec): Promise<string[]> {
  const json = JSON.stringify(msg);
  const body = json.length > COMPRESS_FROM ? 'z' + (await codec.deflate(json)) : 'j' + json;
  if (body.length <= CHUNK) return [body];
  const id = Math.random().toString(36).slice(2, 10);
  const n = Math.ceil(body.length / CHUNK);
  return Array.from({ length: n }, (_, i) => `p${id}:${i}:${n}:${body.slice(i * CHUNK, (i + 1) * CHUNK)}`);
}

/** Collects parts; returns the decoded message once a frame is complete, else undefined. */
export function decoder(codec: Codec) {
  const parts = new Map<string, { got: string[]; n: number; at: number }>();
  return async (d: string): Promise<unknown | undefined> => {
    if (d[0] === 'p') {
      const m = /^p([^:]+):(\d+):(\d+):/.exec(d);
      if (!m) return undefined;
      const [head, id, i, n] = m;
      const p = parts.get(id) ?? { got: [], n: Number(n), at: Date.now() };
      p.got[Number(i)] = d.slice(head.length);
      parts.set(id, p);
      for (const [k, v] of parts) if (Date.now() - v.at > 120_000) parts.delete(k);
      if (p.got.filter((x) => x !== undefined).length < p.n) return undefined;
      parts.delete(id);
      d = p.got.join('');
    }
    if (d[0] === 'j') return JSON.parse(d.slice(1));
    if (d[0] === 'z') return JSON.parse(await codec.inflate(d.slice(1)));
    return undefined;
  };
}

/** JSON has no undefined: arguments keep it as a marker (handlers tell «not given» from null). */
const UNDEF = { __u: 1 };
export const packArgs = (args: unknown[]) => args.map((a) => (a === undefined ? UNDEF : a));
export const unpackArgs = (args: unknown[]) => args.map((a) => (a && typeof a === 'object' && (a as any).__u === 1 && Object.keys(a).length === 1 ? undefined : a));

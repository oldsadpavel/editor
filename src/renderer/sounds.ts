import { call, fileUrl } from './api';
import { get } from './store';

/**
 * «Answer ready» sounds. Built-in ones are synthesized here (no files, nothing to download); system ones are the
 * OS's own notification sounds (C:\Windows\Media, /System/Library/Sounds). Sound ids: 'none', 'synth:<name>',
 * 'file:<path>'.
 */
export interface SoundOption {
  id: string;
  name: string;
}

type Note = { f: number; at: number; dur: number; type?: OscillatorType; gain?: number; to?: number };

const SYNTH: Record<string, { name: string; notes: Note[] }> = {
  chime: { name: 'Колокольчик', notes: [{ f: 1318, at: 0, dur: 1.4, gain: 0.5 }, { f: 2637, at: 0, dur: 0.8, gain: 0.15 }, { f: 1976, at: 0, dur: 1.1, gain: 0.12 }] },
  dingdong: { name: 'Динь-дон', notes: [{ f: 784, at: 0, dur: 0.7 }, { f: 622, at: 0.28, dur: 1.0 }] },
  drop: { name: 'Капля', notes: [{ f: 1400, to: 420, at: 0, dur: 0.22, gain: 0.7 }] },
  bubble: { name: 'Пузырь', notes: [{ f: 380, to: 900, at: 0, dur: 0.12, gain: 0.6 }, { f: 520, to: 1200, at: 0.13, dur: 0.12, gain: 0.5 }] },
  marimba: { name: 'Маримба', notes: [{ f: 523, at: 0, dur: 0.35, gain: 0.7 }, { f: 784, at: 0.12, dur: 0.35, gain: 0.7 }, { f: 1047, at: 0.24, dur: 0.6, gain: 0.7 }] },
  coin: { name: 'Монетка', notes: [{ f: 988, at: 0, dur: 0.09, type: 'square', gain: 0.18 }, { f: 1319, at: 0.09, dur: 0.45, type: 'square', gain: 0.18 }] },
  fanfare: { name: 'Готово!', notes: [523, 659, 784, 1047].map((f, i) => ({ f, at: i * 0.11, dur: i === 3 ? 0.7 : 0.18, type: 'triangle' as const, gain: 0.45 })) },
  soft: { name: 'Мягкий', notes: [{ f: 440, at: 0, dur: 1.2, gain: 0.35 }, { f: 660, at: 0, dur: 1.2, gain: 0.18 }] },
  knock: { name: 'Тук-тук', notes: [{ f: 180, to: 90, at: 0, dur: 0.08, gain: 0.9 }, { f: 180, to: 90, at: 0.16, dur: 0.08, gain: 0.9 }] },
};

export const DEFAULT_SOUND = 'synth:chime';

export const builtinSounds = (): SoundOption[] => Object.entries(SYNTH).map(([k, v]) => ({ id: `synth:${k}`, name: v.name }));

let systemCache: SoundOption[] | null = null;
export async function systemSounds(): Promise<SoundOption[]> {
  if (!systemCache) systemCache = await call<SoundOption[]>('sounds:system').catch(() => []);
  return systemCache;
}

let ctx: AudioContext | null = null;
function synth(name: string, volume: number) {
  const s = SYNTH[name] ?? SYNTH.chime;
  ctx ??= new AudioContext();
  const t0 = ctx.currentTime + 0.02;
  const master = ctx.createGain();
  master.gain.value = volume;
  master.connect(ctx.destination);
  for (const n of s.notes) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = n.type ?? 'sine';
    o.frequency.setValueAtTime(n.f, t0 + n.at);
    if (n.to) o.frequency.exponentialRampToValueAtTime(n.to, t0 + n.at + n.dur);
    // quick attack, exponential fade: a struck, bell-like envelope
    g.gain.setValueAtTime(0.0001, t0 + n.at);
    g.gain.exponentialRampToValueAtTime(n.gain ?? 0.5, t0 + n.at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.dur);
    o.connect(g).connect(master);
    o.start(t0 + n.at);
    o.stop(t0 + n.at + n.dur + 0.05);
  }
}

/** Plays a sound id at a volume 0…1 ('none' — nothing). A system file that's gone falls back to the bell. */
export function playSound(id: string, volume: number) {
  if (!id || id === 'none' || volume <= 0) return;
  if (id.startsWith('file:')) {
    const a = new Audio(fileUrl(id.slice(5)));
    a.volume = Math.min(1, volume);
    a.play().catch(() => synth('chime', volume));
    return;
  }
  synth(id.replace(/^synth:/, ''), volume);
}

/** The sound a chat plays when its answer is ready: its own choice, or the default one. */
export function soundFor(sessionId: string) {
  const app = get().app;
  return app?.chatSounds?.[sessionId] ?? app?.sound?.default ?? DEFAULT_SOUND;
}

export const soundVolume = () => get().app?.sound?.volume ?? 0.6;

export function playDone(sessionId: string) {
  playSound(soundFor(sessionId), soundVolume());
}

import { useEffect, useId, useRef } from 'react';

/**
 * «Око» — the loader: a creature's eye in a dark metal rim (design: branding/eye-loader.html).
 * run — looks around and blinks (horizontal or vertical lids at random, sometimes twice); wait — stares at you with a
 * wide pupil and a pulsing halo; stop — shut, lashes down, breathing; error — red cast, a trembling slit.
 * amber — Claude, emerald — a model through OpenRouter.
 */
export type EyeState = 'run' | 'wait' | 'stop' | 'error';
const COLORS = { amber: ['#ffd29a', '#e08a3c', '#7a3510'], emerald: ['#d8ff8a', '#5fbf3a', '#1d5a17'] } as const;

export function Eye({ size = 20, state = 'run', variant = 'amber', className = '', title }: { size?: number; state?: EyeState; variant?: keyof typeof COLORS; className?: string; title?: string }) {
  const id = useId().replace(/:/g, '');
  const ref = useRef<HTMLSpanElement>(null);
  const [c1, c2, c3] = COLORS[variant];

  // random blinks; a sleeping eye doesn't blink, a waiting one less often
  useEffect(() => {
    const el = ref.current;
    if (!el || state === 'stop') return;
    let timer: number | undefined;
    let alive = true;
    const blink = (then: (k: string) => void, kind?: string) => {
      const k = kind ?? (Math.random() < 0.5 ? 'h' : 'v');
      el.classList.remove('blink-h', 'blink-v');
      void el.offsetWidth;
      el.classList.add('blink-' + k);
      timer = window.setTimeout(() => {
        el.classList.remove('blink-h', 'blink-v');
        if (alive) then(k);
      }, k === 'v' ? 440 : 380);
    };
    const later = () => {
      if (!alive) return;
      const wait = (state === 'wait' ? 4000 : 2000) + Math.random() * 4000;
      timer = window.setTimeout(() => blink((k) => (Math.random() < 0.2 ? (timer = window.setTimeout(() => blink(later, k), 120)) : later())), wait);
    };
    later();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [state]);

  // its own phase of looking around, so several eyes don't move in step
  const delay = useRef(`-${(Math.random() * 7).toFixed(2)}s`).current;
  return (
    <span ref={ref} className={`eye eye-${state} ${className}`} style={{ width: size, height: size }} title={title} aria-hidden={!title}>
      <svg viewBox="0 0 100 100">
        <defs>
          <radialGradient id={`rim${id}`} cx="35%" cy="30%" r="80%">
            <stop offset="0" stopColor="#9aa1ab" />
            <stop offset=".45" stopColor="#4a4f57" />
            <stop offset="1" stopColor="#1c1e22" />
          </radialGradient>
          <radialGradient id={`iris${id}`} cx="45%" cy="42%" r="62%">
            <stop offset="0" stopColor={c1} />
            <stop offset=".55" stopColor={c2} />
            <stop offset="1" stopColor={c3} />
          </radialGradient>
          <radialGradient id={`shade${id}`} cx="50%" cy="50%" r="50%">
            <stop offset=".7" stopColor="#000" stopOpacity="0" />
            <stop offset="1" stopColor="#000" stopOpacity=".55" />
          </radialGradient>
          <clipPath id={`ball${id}`}>
            <circle cx="50" cy="50" r="36" />
          </clipPath>
          <mask id={`lids${id}`} maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
            <rect x="0" y="0" width="100" height="100" fill="#fff" />
            <path className="opening open-h" d="M -6 52 Q 50 -14 106 52 Q 50 118 -6 52 Z" fill="#000" />
            <path className="opening open-v" d="M 50 -6 Q -14 50 50 106 Q 114 50 50 -6 Z" fill="#000" />
          </mask>
        </defs>
        <circle cx="50" cy="50" r="48" fill={`url(#rim${id})`} />
        <circle cx="50" cy="50" r="40" fill="#111214" />
        <g clipPath={`url(#ball${id})`}>
          <circle className="glow" cx="50" cy="50" r="36" fill={`url(#iris${id})`} />
          <g stroke={c3} strokeOpacity=".35" strokeWidth="1.2">
            <line x1="50" y1="16" x2="50" y2="30" />
            <line x1="50" y1="70" x2="50" y2="84" />
            <line x1="16" y1="50" x2="28" y2="50" />
            <line x1="72" y1="50" x2="84" y2="50" />
            <line x1="26" y1="26" x2="34" y2="34" />
            <line x1="66" y1="66" x2="74" y2="74" />
            <line x1="74" y1="26" x2="66" y2="34" />
            <line x1="26" y1="74" x2="34" y2="66" />
          </g>
          <g className="look" style={{ animationDelay: delay }}>
            <ellipse className="pupil" style={{ animationDelay: delay }} cx="50" cy="50" rx="4.2" ry="27" fill="#07080a" />
            <ellipse className="pupil" style={{ animationDelay: delay }} cx="50" cy="50" rx="7" ry="29" fill="none" stroke={c3} strokeOpacity=".5" strokeWidth="1.5" />
          </g>
          <circle cx="50" cy="50" r="36" fill={`url(#shade${id})`} />
          <circle className="err-tint" cx="50" cy="50" r="36" fill="#e02626" />
          <g mask={`url(#lids${id})`}>
            <rect className="lid-h" x="0" y="0" width="100" height="100" fill="#2a2c31" />
            <rect className="lid-v" x="0" y="0" width="100" height="100" fill={c3} fillOpacity=".9" />
          </g>
          <path className="seam" d="M 16 50 Q 50 64 84 50" fill="none" stroke="#5b616b" strokeWidth="2.2" strokeLinecap="round" />
          <g className="seam" stroke="#5b616b" strokeWidth="1.6" strokeLinecap="round">
            <line x1="30" y1="56" x2="28" y2="62" />
            <line x1="42" y1="59" x2="41" y2="65" />
            <line x1="58" y1="59" x2="59" y2="65" />
            <line x1="70" y1="56" x2="72" y2="62" />
          </g>
          <path className="opening open-h edge" d="M -6 52 Q 50 -14 106 52 Q 50 118 -6 52 Z" fill="none" stroke="#0d0e10" strokeWidth="2.5" />
          <path className="opening open-v edge" d="M 50 -6 Q -14 50 50 106 Q 114 50 50 -6 Z" fill="none" stroke="#0d0e10" strokeWidth="2.5" />
        </g>
        <ellipse cx="38" cy="32" rx="8" ry="5" fill="#fff" fillOpacity=".55" transform="rotate(-30 38 32)" />
        <circle cx="61" cy="66" r="2" fill="#fff" fillOpacity=".35" />
      </svg>
    </span>
  );
}

import { useEffect, useRef, useState } from 'react';
import { saveApp, useStore } from '../store';
import { DEFAULT_SOUND, builtinSounds, playSound, systemSounds, type SoundOption } from '../sounds';

const nameOf = (id: string, list: SoundOption[]) => (id === 'none' ? 'Без звука' : list.find((s) => s.id === id)?.name ?? id.replace(/^.*[\\/:]/, ''));

function SoundSelect({ value, onChange, withDefault }: { value: string; onChange: (v: string) => void; withDefault?: string }) {
  const [system, setSystem] = useState<SoundOption[]>([]);
  useEffect(() => void systemSounds().then(setSystem), []);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {withDefault !== undefined && <option value="">По умолчанию ({withDefault})</option>}
      <option value="none">🔕 Без звука</option>
      <optgroup label="Встроенные">
        {builtinSounds().map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </optgroup>
      {system.length > 0 && (
        <optgroup label="Системные">
          {system.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

/**
 * 🔔 in the chat toolbar: the sound this chat plays when its answer is ready (or the default one), the default for
 * all chats, the volume, and a test button. Picking a sound plays it right away.
 */
export function SoundButton({ sessionId }: { sessionId: string }) {
  const own = useStore((s) => s.app?.chatSounds?.[sessionId]);
  const def = useStore((s) => s.app?.sound?.default ?? DEFAULT_SOUND);
  const volume = useStore((s) => s.app?.sound?.volume ?? 0.6);
  const sound = useStore((s) => s.app?.sound);
  const chatSounds = useStore((s) => s.app?.chatSounds);
  const notifications = useStore((s) => s.app?.notifications !== false);
  const [open, setOpen] = useState(false);
  const [system, setSystem] = useState<SoundOption[]>([]);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => void systemSounds().then(setSystem), []);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const all = [...builtinSounds(), ...system];
  const effective = own ?? def;
  const muted = effective === 'none' || volume <= 0;
  const setOwn = (v: string) => {
    const next = { ...(chatSounds ?? {}) };
    if (v) next[sessionId] = v;
    else delete next[sessionId];
    void saveApp({ chatSounds: next });
    playSound(v || def, volume);
  };
  return (
    <span className="sound-wrap" ref={box}>
      <button
        className={`btn small ${own ? 'sound-own' : ''}`}
        title={`Звук, когда ответ готов: ${nameOf(effective, all)}${own ? ' (свой у этого чата)' : ' (по умолчанию)'}`}
        onClick={() => setOpen(!open)}
      >
        {muted ? '🔕' : '🔔'}
      </button>
      {open && (
        <div className="sound-pop">
          <label>
            Этот чат
            <SoundSelect value={own ?? ''} onChange={setOwn} withDefault={nameOf(def, all)} />
          </label>
          <label>
            По умолчанию для всех чатов
            <SoundSelect
              value={def}
              onChange={(v) => {
                void saveApp({ sound: { ...sound, default: v } });
                playSound(v, volume);
              }}
            />
          </label>
          <label>
            Громкость: {Math.round(volume * 100)}%
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(volume * 100)}
              onChange={(e) => void saveApp({ sound: { ...sound, volume: Number(e.target.value) / 100 } })}
              onMouseUp={() => playSound(effective, volume)}
            />
          </label>
          <label className="sound-check" title="Всплывающее уведомление Windows, когда ответ готов, а окно MPI свёрнуто или в фоне. У чата «без звука» его не будет">
            <input type="checkbox" checked={notifications} onChange={(e) => void saveApp({ notifications: e.target.checked })} />
            Уведомления Windows, когда ответ готов
          </label>
          <div className="sound-row">
            <button className="btn small" onClick={() => playSound(effective === 'none' ? def : effective, volume || 0.6)}>
              ▶ Проверить
            </button>
            <span className="muted small">Звучит, когда Claude закончил ответ в этом чате</span>
          </div>
        </div>
      )}
    </span>
  );
}

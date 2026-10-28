import type { FavoriteAnswer, Turn } from '../shared/types';
import { get, openChat, saveApp, set, toast } from './store';

/** A turn is matched by question time and text: its id differs between a live run and a transcript reload. */
const same = (f: FavoriteAnswer, sessionId: string, turn: Pick<Turn, 'startedAt' | 'prompt'>) =>
  f.sessionId === sessionId && Math.abs(f.startedAt - turn.startedAt) < 2000 && f.prompt === turn.prompt;

export const isFavorite = (list: FavoriteAnswer[] | undefined, sessionId: string, turn: Turn) => !!list?.some((f) => same(f, sessionId, turn));

const answerText = (turn: Turn) =>
  turn.items
    .filter((i) => i.kind === 'text')
    .map((i) => (i as { text: string }).text)
    .join('\n\n')
    .slice(0, 50_000);

export function toggleFavorite(sessionId: string, turn: Turn) {
  const app = get().app!;
  const list = app.favoriteAnswers ?? [];
  const existing = list.find((f) => same(f, sessionId, turn));
  if (existing) return removeFavorite(existing.id);
  const chat = get().chats[sessionId];
  const fav: FavoriteAnswer = {
    id: `${sessionId}:${turn.startedAt}`,
    sessionId,
    cwd: chat?.cwd ?? '',
    chatTitle: chat?.title ?? '',
    startedAt: turn.startedAt,
    prompt: turn.prompt,
    answer: answerText(turn),
    savedAt: Date.now(),
  };
  void saveApp({ favoriteAnswers: [...list, fav] });
  toast('Ответ сохранён в избранное — вкладка «★ Избранное» внизу чата');
}

export function removeFavorite(id: string) {
  void saveApp({ favoriteAnswers: (get().app!.favoriteAnswers ?? []).filter((f) => f.id !== id) });
}

/** Opens the chat of a saved answer and scrolls to that answer. */
export async function openFavorite(f: FavoriteAnswer) {
  await openChat(f.sessionId, f.cwd);
  const chat = get().chats[f.sessionId];
  const turn = chat?.turns.find((t) => same(f, f.sessionId, t));
  if (!turn) return toast('Этот ответ больше не найден в истории чата — его текст сохранён в избранном');
  set({ focusTurn: { sessionId: f.sessionId, turnId: turn.id, nonce: Date.now() } });
}

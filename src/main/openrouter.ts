import { safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './store';

/**
 * OpenRouter (openrouter.ai) as the model provider of a Claude Code chat: Claude Code with all its tools, the model
 * answered through OpenRouter's Anthropic-compatible API (ANTHROPIC_BASE_URL=https://openrouter.ai/api, the key as
 * ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY empty — openrouter.ai/docs/guides/guides/claude-code-integration).
 * A chat's model «or:<openrouter id>» means OpenRouter. The key is kept encrypted (safeStorage) in openrouter.bin.
 */

export const OR_PREFIX = 'or:';
export const isOr = (m?: string) => !!m && m.startsWith(OR_PREFIX);
export const orId = (m: string) => m.slice(OR_PREFIX.length);
const BASE = 'https://openrouter.ai/api';

const keyFile = () => path.join(dataDir(), 'openrouter.bin');

export function getKey(): string | null {
  try {
    const raw = fs.readFileSync(keyFile());
    return raw[0] === 0x7b ? JSON.parse(raw.toString('utf8')).key : JSON.parse(safeStorage.decryptString(raw)).key;
  } catch {
    return null;
  }
}

export function setKey(key: string | null) {
  if (!key) return void fs.rmSync(keyFile(), { force: true });
  const text = JSON.stringify({ key: key.trim() });
  fs.writeFileSync(keyFile(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text) : Buffer.from(text));
}

/** What the settings window shows: is there a key, and its owner's limits (never the key itself). */
export async function status(): Promise<{ hasKey: boolean; label?: string; usage?: number; limit?: number | null; error?: string }> {
  const key = getKey();
  if (!key) return { hasKey: false };
  try {
    const r = await fetch(`${BASE}/v1/key`, { headers: { Authorization: `Bearer ${key}` } });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) return { hasKey: true, error: j?.error?.message ?? `HTTP ${r.status}` };
    return { hasKey: true, label: j.data?.label, usage: j.data?.usage, limit: j.data?.limit ?? null };
  } catch (e: any) {
    return { hasKey: true, error: e?.message ?? String(e) };
  }
}

/** Models OpenRouter offers for Claude Code (its Anthropic-compatible list). */
export async function models(): Promise<{ id: string; name: string; context?: number; vision?: boolean; tools?: boolean; price?: string }[]> {
  const key = getKey();
  const r = await fetch(`${BASE}/v1/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
  if (!r.ok) throw new Error(`OpenRouter: HTTP ${r.status}`);
  const j: any = await r.json();
  return (j.data ?? []).map((m: any) => {
    const p = Number(m.pricing?.prompt), c = Number(m.pricing?.completion);
    return {
      id: m.id,
      name: m.display_name ?? m.name ?? m.id,
      context: m.max_input_tokens ?? m.context_length,
      // pictures in the chat (screenshots, Chrome) need image input; Claude Code itself needs tool calls
      vision: Array.isArray(m.architecture?.input_modalities) ? m.architecture.input_modalities.includes('image') : undefined,
      tools: Array.isArray(m.supported_parameters) ? m.supported_parameters.includes('tools') : undefined,
      price: isFinite(p) && isFinite(c) ? `$${(p * 1e6).toFixed(2)} / $${(c * 1e6).toFixed(2)}` : undefined,
    };
  });
}

/** Environment of a Claude Code process answering through OpenRouter with this model. */
export function env(model: string): Record<string, string> {
  const key = getKey();
  if (!key) throw new Error('Нет ключа OpenRouter: выберите в списке моделей «⚙ OpenRouter…» и вставьте ключ');
  const id = orId(model);
  return {
    ANTHROPIC_BASE_URL: BASE,
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_API_KEY: '',
    // every tier (and subagents, background summaries) on the chosen model
    ANTHROPIC_DEFAULT_OPUS_MODEL: id,
    ANTHROPIC_DEFAULT_SONNET_MODEL: id,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: id,
    ANTHROPIC_DEFAULT_FABLE_MODEL: id,
    CLAUDE_CODE_SUBAGENT_MODEL: id,
  };
}

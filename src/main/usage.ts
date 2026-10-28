import os from 'node:os';
import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { UsageInfo, UsageWindow } from '../shared/types';
import { emit } from './bus';
import { claudeExecutable } from './claude';

const POLL_MS = 60_000;

let meter: Query | null = null;
let current: UsageInfo | null = null;
let timer: NodeJS.Timeout | null = null;

/** Never yields: keeps the meter process alive without ever sending a prompt (no tokens are spent). */
async function* silence(): AsyncGenerator<SDKUserMessage> {
  await new Promise(() => {});
}

function windowOf(w: { utilization: number | null; resets_at: string | null } | null | undefined): UsageWindow | undefined {
  if (!w || w.utilization === null) return undefined;
  return { percent: w.utilization, resetsAt: w.resets_at ? Date.parse(w.resets_at) : undefined };
}

function publish(next: UsageInfo) {
  current = next;
  emit({ type: 'usage', usage: next });
}

/**
 * Plan limits (5-hour session window and weekly window) from the same endpoint as `/usage`.
 * A dedicated idle Claude Code process answers the control request; it never receives a prompt.
 * The SDK marks this API experimental, so any failure just hides the meters.
 */
async function refresh() {
  try {
    meter ??= query({
      prompt: silence(),
      options: { cwd: os.homedir(), pathToClaudeCodeExecutable: claudeExecutable(), persistSession: false, settingSources: [] } as any,
    });
    const fn = (meter as any).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof fn !== 'function') return publish({ available: false, checkedAt: Date.now(), error: 'SDK не отдаёт лимиты' });
    const r = await fn.call(meter, { skipBehaviors: true });
    const rl = r?.rate_limits;
    publish({
      available: !!r?.rate_limits_available && !!rl,
      plan: r?.subscription_type ?? undefined,
      session: windowOf(rl?.five_hour),
      week: windowOf(rl?.seven_day),
      models: [
        ...(rl?.seven_day_opus ? [{ name: 'Opus', ...windowOf(rl.seven_day_opus)! }] : []),
        ...(rl?.seven_day_sonnet ? [{ name: 'Sonnet', ...windowOf(rl.seven_day_sonnet)! }] : []),
        ...((rl?.model_scoped ?? []) as any[]).filter((m) => m.utilization !== null).map((m) => ({ name: m.display_name, ...windowOf(m)! })),
      ].filter((m) => m.percent !== undefined),
      extra: rl?.extra_usage?.is_enabled ? { percent: rl.extra_usage.utilization ?? undefined, used: rl.extra_usage.used_credits ?? undefined, limit: rl.extra_usage.monthly_limit ?? undefined, currency: rl.extra_usage.currency ?? undefined } : undefined,
      checkedAt: Date.now(),
    });
  } catch (e: any) {
    meter?.interrupt().catch(() => {});
    meter = null;
    publish({ ...(current ?? { available: false }), checkedAt: Date.now(), error: e?.message ?? String(e) });
  }
}

/** Live chats report limit changes as they happen (rate_limit_event); applied without waiting for the next poll. */
export function onRateLimitEvent(info: { rateLimitType?: string; utilization?: number; resetsAt?: number }) {
  if (!current || info.utilization === undefined) return;
  const percent = info.utilization <= 1 ? info.utilization * 100 : info.utilization;
  const w: UsageWindow = { percent, resetsAt: info.resetsAt ? info.resetsAt * 1000 : undefined };
  if (info.rateLimitType === 'five_hour') publish({ ...current, session: w, checkedAt: Date.now() });
  else if (info.rateLimitType === 'seven_day') publish({ ...current, week: w, checkedAt: Date.now() });
}

export function lastUsage() {
  return current;
}

export function startUsage() {
  void refresh();
  timer = setInterval(() => void refresh(), POLL_MS);
}

export function refreshUsage() {
  return refresh().then(() => current);
}

export function stopUsage() {
  if (timer) clearInterval(timer);
  meter?.interrupt().catch(() => {});
}

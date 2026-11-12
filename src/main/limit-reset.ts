/**
 * «You've hit your 5-hour limit · resets 6:30pm (Asia/Tbilisi)» → when that is. Formats seen: «resets 6:30pm»,
 * «resets 7pm», «resets 18:30», «resets Nov 15, 6pm», «resets Nov 15 at 6:30pm», with or without the time zone.
 */
const LIMIT_RE = /(?:hit|reached)\s+(?:your|the)\b[^\n]{0,60}?limit[^\n]*?resets?\s+(?:at\s+)?([^\n()]+?)\s*(?:\(([A-Za-z_]+\/[A-Za-z_/+-]+|UTC)\))?\s*(?:$|\n|[.·])/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Milliseconds to add to UTC wall time to get the zone's wall time at moment t. */
function offsetOf(t: number, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      .formatToParts(t)
      .map((x) => [x.type, x.value]),
  );
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(t / 1000) * 1000;
}

/** The moment of a wall-clock time in a zone. */
function zoned(y: number, mo: number, d: number, h: number, mi: number, tz?: string): number {
  if (!tz) return new Date(y, mo, d, h, mi).getTime();
  const guess = Date.UTC(y, mo, d, h, mi);
  const t = guess - offsetOf(guess, tz);
  return guess - offsetOf(t, tz); // second pass: right across a DST change
}

/** The reset moment named in a limit message (the first one after `from`), or undefined when it isn't one. */
export function limitResetAt(text: string, from = Date.now()): number | undefined {
  const m = text.match(LIMIT_RE);
  if (!m) return undefined;
  const when = m[1].trim().toLowerCase();
  let tz: string | undefined = m[2];
  try {
    if (tz) new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    tz = undefined;
  }
  const tm = when.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*$/);
  if (!tm) return undefined;
  let h = Number(tm[1]);
  const mi = Number(tm[2] ?? 0);
  if (tm[3] === 'pm' && h < 12) h += 12;
  if (tm[3] === 'am' && h === 12) h = 0;
  if (h > 23 || mi > 59) return undefined;
  // today (or the named day) in that zone
  const now = tz ? new Date(from + offsetOf(from, tz)) : new Date(from);
  const get = (k: 'FullYear' | 'Month' | 'Date') => (tz ? (now as any)[`getUTC${k}`]() : (now as any)[`get${k}`]());
  let y = get('FullYear');
  let mo = get('Month');
  let d = get('Date');
  const md = when.match(/([a-z]{3})[a-z]*\.?\s+(\d{1,2})/);
  if (md && MONTHS.includes(md[1])) {
    mo = MONTHS.indexOf(md[1]);
    d = Number(md[2]);
    let t = zoned(y, mo, d, h, mi, tz);
    if (t < from - 180 * 86_400_000) t = zoned(++y, mo, d, h, mi, tz);
    return t;
  }
  let t = zoned(y, mo, d, h, mi, tz);
  if (t <= from) t = zoned(y, mo, d + 1, h, mi, tz);
  return t;
}

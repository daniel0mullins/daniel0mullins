// Local-time date helpers.
//
// Everything here works on Date components (year, month, day, hour, minute)
// rather than by adding multiples of 86 400 000 ms, so "tomorrow at 09:00"
// stays 09:00 across daylight-saving transitions.

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** 'YYYY-MM-DD' -> Date at local midnight, or null when malformed/impossible. */
export function parseLocalDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const date = new Date(y, mo - 1, d);
  // new Date(2026, 1, 31) silently rolls to March; reject that.
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date;
}

/** 'HH:MM' (24h) -> { h, m } or null. */
export function parseClock(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return { h, m: mi };
}

export function isClock(hhmm) {
  return parseClock(hhmm) !== null;
}

/** Any instant within a local day + 'HH:MM' -> instant at that clock time on that day. */
export function atClock(dayMs, hhmm) {
  const c = parseClock(hhmm);
  if (!c) throw new Error(`Invalid clock time: ${hhmm}`);
  const d = new Date(dayMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), c.h, c.m, 0, 0).getTime();
}

export function startOfDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function addDays(ms, n) {
  const d = new Date(ms);
  return new Date(
    d.getFullYear(), d.getMonth(), d.getDate() + n,
    d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()
  ).getTime();
}

export function addMinutes(ms, n) {
  return ms + n * MINUTE;
}

/**
 * Local midnight at the start of the next week.
 * weekStartsOn uses JS Date.getDay() numbering: 0 = Sunday, 1 = Monday.
 * Always strictly after `ms`, even when `ms` is already on the start day.
 */
export function startOfNextWeek(ms, weekStartsOn = 1) {
  const d = new Date(ms);
  let delta = (weekStartsOn - d.getDay() + 7) % 7;
  if (delta === 0) delta = 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta).getTime();
}

/** Local midnight on the first day of the next month. */
export function startOfNextMonth(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** ms -> 'YYYY-MM-DD' in local time (for <input type="date">). */
export function toDateInput(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** ms -> 'HH:MM' in local time (for <input type="time">). */
export function toClockInput(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function formatTime(ms, locale) {
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
}

/** 'Today', 'Tomorrow', 'Yesterday', or a short weekday + date. */
export function formatDay(ms, now, locale) {
  const dayDiff = Math.round((startOfDay(ms) - startOfDay(now)) / DAY);
  if (dayDiff === 0) return 'Today';
  if (dayDiff === 1) return 'Tomorrow';
  if (dayDiff === -1) return 'Yesterday';
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' })
  }).format(new Date(ms));
}

export function formatWhen(ms, now, locale) {
  return `${formatDay(ms, now, locale)} ${formatTime(ms, locale)}`;
}

/** Minutes -> '5 min', '1 h', '1 h 30 min', '2 d', '2 d 3 h'. */
export function formatDuration(minutes) {
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return `${total} min`;
  const days = Math.floor(total / (60 * 24));
  const hours = Math.floor((total % (60 * 24)) / 60);
  const mins = total % 60;
  const parts = [];
  if (days) parts.push(`${days} d`);
  if (hours) parts.push(`${hours} h`);
  if (mins && !days) parts.push(`${mins} min`);
  return parts.join(' ');
}

/** Relative wording: 'in 5 min', '2 h ago', 'now'. */
export function formatRelative(ms, now) {
  const diff = ms - now;
  const abs = Math.abs(diff);
  if (abs < MINUTE) return 'now';
  const text = formatDuration(abs / MINUTE);
  return diff > 0 ? `in ${text}` : `${text} ago`;
}

/** Signed lateness in a compact form: '+2 h', '-15 min', 'on time'. */
export function formatLateness(ms) {
  const abs = Math.abs(ms);
  if (abs < MINUTE) return 'on time';
  const text = formatDuration(abs / MINUTE);
  return ms > 0 ? `${text} late` : `${text} early`;
}

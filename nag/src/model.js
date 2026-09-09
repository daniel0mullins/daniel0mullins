// Data model: tasks, anchors, spoons, settings.
//
// A task is a plain object so it survives JSON round-trips through
// localStorage untouched. All mutation happens through machine.js.

import { parseLocalDate, parseClock, atClock, isClock } from './time.js';

export const PERIODS = [
  { key: 'morning', label: 'Morning', defaultTime: '09:00' },
  { key: 'midday', label: 'Midday', defaultTime: '12:00' },
  { key: 'afternoon', label: 'Afternoon', defaultTime: '15:00' },
  { key: 'evening', label: 'Evening', defaultTime: '18:30' },
  { key: 'night', label: 'Night', defaultTime: '21:00' },
];

export const PERIOD_KEYS = PERIODS.map((p) => p.key);

export const CATEGORIES = [
  'chores', 'admin', 'health', 'work', 'errands', 'social', 'self-care', 'money', 'other',
];

export const MIN_SPOONS = 1;
export const MAX_SPOONS = 5;
export const DEFAULT_SPOONS = 2;
export const MAX_TITLE_LENGTH = 200;

export const STATES = ['scheduled', 'alerting', 'snoozed', 'deferred', 'done'];

export const DEFAULT_SETTINGS = Object.freeze({
  periods: Object.freeze(Object.fromEntries(PERIODS.map((p) => [p.key, p.defaultTime]))),
  dayStart: '09:00', // when "rest of today / week / month" deferrals come back
  weekStartsOn: 1, // 0 = Sunday, 1 = Monday
  sound: true,
  vibrate: true,
  nagEverySeconds: 30, // re-pulse an unanswered alert this often
});

export class ValidationError extends Error {
  constructor(errors) {
    super(Object.values(errors).join(' '));
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

/**
 * Merge a partial settings object over `base` (the defaults unless given),
 * keeping the base value wherever the incoming one is missing or invalid.
 */
export function normalizeSettings(partial, base = DEFAULT_SETTINGS) {
  const src = partial && typeof partial === 'object' ? partial : {};
  const root = base && typeof base === 'object' ? base : DEFAULT_SETTINGS;
  const basePeriods = root.periods && typeof root.periods === 'object' ? root.periods : DEFAULT_SETTINGS.periods;
  const srcPeriods = src.periods && typeof src.periods === 'object' ? src.periods : {};
  const periods = {};
  for (const key of PERIOD_KEYS) {
    periods[key] = isClock(srcPeriods[key]) ? srcPeriods[key]
      : isClock(basePeriods[key]) ? basePeriods[key]
        : DEFAULT_SETTINGS.periods[key];
  }
  const pick = (key, valid) => (valid(src[key]) ? src[key] : valid(root[key]) ? root[key] : DEFAULT_SETTINGS[key]);
  const isBool = (v) => typeof v === 'boolean';
  const isWeekStart = (v) => v !== null && v !== undefined && v !== '' && [0, 1, 6].includes(Number(v));
  const isNagInterval = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 5;
  return {
    periods,
    dayStart: pick('dayStart', isClock),
    weekStartsOn: Number(pick('weekStartsOn', isWeekStart)),
    sound: pick('sound', isBool),
    vibrate: pick('vibrate', isBool),
    nagEverySeconds: Number(pick('nagEverySeconds', isNagInterval)),
  };
}

export function isValidSpoons(n) {
  return Number.isInteger(n) && n >= MIN_SPOONS && n <= MAX_SPOONS;
}

export function clampSpoons(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return DEFAULT_SPOONS;
  return Math.min(MAX_SPOONS, Math.max(MIN_SPOONS, Math.round(v)));
}

/** Validate an anchor {date, kind, time|period}. Returns { errors, anchor }. */
export function validateAnchor(raw) {
  const errors = {};
  const src = raw && typeof raw === 'object' ? raw : {};
  const date = String(src.date || '').trim();
  if (!parseLocalDate(date)) errors.date = 'Pick a date.';
  const kind = src.kind === 'fuzzy' ? 'fuzzy' : src.kind === 'exact' ? 'exact' : null;
  if (!kind) errors.kind = 'Pick an exact time or a part of the day.';
  const anchor = { date, kind };
  if (kind === 'exact') {
    const time = String(src.time || '').trim();
    if (!parseClock(time)) errors.time = 'Pick a time.';
    anchor.time = time;
  } else if (kind === 'fuzzy') {
    const period = String(src.period || '').trim();
    if (!PERIOD_KEYS.includes(period)) errors.period = 'Pick a part of the day.';
    anchor.period = period;
  }
  return { errors, anchor };
}

/** Compute the instant a valid anchor refers to. */
export function computeDueAt(anchor, settings) {
  const s = normalizeSettings(settings);
  const day = parseLocalDate(anchor.date);
  if (!day) throw new ValidationError({ date: 'Pick a date.' });
  if (anchor.kind === 'exact') {
    if (!parseClock(anchor.time)) throw new ValidationError({ time: 'Pick a time.' });
    return atClock(day.getTime(), anchor.time);
  }
  if (anchor.kind === 'fuzzy') {
    if (!PERIOD_KEYS.includes(anchor.period)) throw new ValidationError({ period: 'Pick a part of the day.' });
    return atClock(day.getTime(), s.periods[anchor.period]);
  }
  throw new ValidationError({ kind: 'Pick an exact time or a part of the day.' });
}

export function periodLabel(key) {
  const p = PERIODS.find((x) => x.key === key);
  return p ? p.label : key;
}

/** Human label for an anchor: '5:00 PM' or 'Morning'. */
export function anchorLabel(anchor, locale) {
  if (!anchor) return '';
  if (anchor.kind === 'fuzzy') return periodLabel(anchor.period);
  const c = parseClock(anchor.time);
  if (!c) return anchor.time || '';
  const d = new Date(2000, 0, 1, c.h, c.m);
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(d);
}

/** Validate raw form input. Returns { errors, value } where value is normalized. */
export function validateTaskInput(input) {
  const src = input && typeof input === 'object' ? input : {};
  const errors = {};
  const title = String(src.title || '').trim().replace(/\s+/g, ' ');
  if (!title) errors.title = 'Give it a name.';
  else if (title.length > MAX_TITLE_LENGTH) errors.title = `Keep the name under ${MAX_TITLE_LENGTH} characters.`;

  let category = String(src.category || '').trim().replace(/\s+/g, ' ').toLowerCase();
  if (!category) category = 'other';
  if (category.length > 40) errors.category = 'Keep the type under 40 characters.';

  let spoons = DEFAULT_SPOONS;
  if (src.spoons !== undefined && src.spoons !== null && String(src.spoons).trim() !== '') {
    const n = Number(src.spoons);
    if (!isValidSpoons(n)) errors.spoons = `Spoons must be a whole number from ${MIN_SPOONS} to ${MAX_SPOONS}.`;
    else spoons = n;
  }

  const { errors: anchorErrors, anchor } = validateAnchor(src.anchor);
  Object.assign(errors, anchorErrors);

  return { errors, value: { title, category, spoons, anchor } };
}

export function generateId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Build a brand-new task from validated-or-raw input.
 * Throws ValidationError on bad input.
 */
export function createTask(input, { now, settings, id } = {}) {
  const at = Number.isFinite(now) ? now : Date.now();
  const { errors, value } = validateTaskInput(input);
  if (Object.keys(errors).length) throw new ValidationError(errors);
  const dueAt = computeDueAt(value.anchor, settings);
  return {
    id: id || generateId(),
    title: value.title,
    category: value.category,
    spoons: value.spoons,
    anchor: value.anchor,
    dueAt,
    createdAt: at,
    state: 'scheduled',
    level: 0,
    nextFireAt: dueAt,
    alertedAt: null,
    completedAt: null,
    snoozeCount: 0,
    deferCount: 0,
    alertCount: 0,
    maxLevel: 0,
    lastSnoozeMinutes: null,
    events: [{ type: 'created', at }],
  };
}

/**
 * Apply edited fields to an existing (not done) task.
 * Friction counters are history and are kept. If the anchor moved, the task
 * goes back to waiting on the new anchor; an in-progress alert is cancelled.
 */
export function updateTaskFields(task, input, { now, settings } = {}) {
  const at = Number.isFinite(now) ? now : Date.now();
  if (task.state === 'done') throw new ValidationError({ state: 'Completed tasks cannot be edited.' });
  const { errors, value } = validateTaskInput(input);
  if (Object.keys(errors).length) throw new ValidationError(errors);
  const dueAt = computeDueAt(value.anchor, settings);
  const anchorMoved = dueAt !== task.dueAt;
  const next = {
    ...task,
    title: value.title,
    category: value.category,
    spoons: value.spoons,
    anchor: value.anchor,
    dueAt,
    events: [...task.events, { type: 'edited', at, anchorMoved }],
  };
  if (anchorMoved) {
    next.state = 'scheduled';
    next.nextFireAt = dueAt;
    next.alertedAt = null;
  }
  return next;
}

/** Snoozes count once, out-of-spoons deferrals count double. */
export const FRICTION_WEIGHTS = Object.freeze({ snooze: 1, deferral: 2 });

export function taskFriction(task) {
  return (task.snoozeCount || 0) * FRICTION_WEIGHTS.snooze + (task.deferCount || 0) * FRICTION_WEIGHTS.deferral;
}

export function spoonsLabel(n) {
  return `${n} spoon${n === 1 ? '' : 's'}`;
}

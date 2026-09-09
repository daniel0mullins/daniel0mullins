// The snooze engine.
//
// Snooze windows scale with spoon size (bigger task, longer initial snooze)
// and shrink with every snooze (cascading urgency). Two rules make the
// cascade strict:
//
//   1. Each escalation level halves the menu and drops the generous options,
//      so the menu at level L is strictly shorter than the menu at L-1.
//   2. No offered snooze may be as long as the one the user chose last time.
//
// Both bottom out at MIN_MINUTES, the terminal one-minute nag.

import { clampSpoons } from './model.js';
import { MINUTE, atClock, addDays, startOfDay, startOfNextWeek, startOfNextMonth, formatDuration } from './time.js';

/** Standard (middle) snooze in minutes at level 0, by spoon size. */
export const BASE_MINUTES = Object.freeze({ 1: 5, 2: 10, 3: 20, 4: 45, 5: 90 });

/** short / standard / long multipliers applied to the base. */
export const MULTIPLIERS = Object.freeze([0.5, 1, 2]);

/** Every escalation level multiplies durations by this. */
export const DECAY = 0.5;

export const MIN_MINUTES = 1;

/** 3 options at levels 0-1, 2 at levels 2-3, then a single option. */
export function optionCount(level) {
  return Math.max(1, 3 - Math.floor(Math.max(0, level) / 2));
}

/** Menu of snooze minutes for a spoon size at an escalation level. Ascending, unique. */
export function snoozeMinutes(spoons, level) {
  const base = BASE_MINUTES[clampSpoons(spoons)];
  const scale = Math.pow(DECAY, Math.max(0, level));
  const mins = MULTIPLIERS.slice(0, optionCount(level)).map((m) => Math.max(MIN_MINUTES, Math.round(base * m * scale)));
  return [...new Set(mins)].sort((a, b) => a - b);
}

/**
 * Snooze options actually offered for a task: the level menu, capped so every
 * option is strictly shorter than the user's previous snooze on this task.
 */
export function snoozeOptions(task) {
  let mins = snoozeMinutes(task.spoons, task.level || 0);
  const last = task.lastSnoozeMinutes;
  if (Number.isFinite(last) && last !== null) {
    const shorter = mins.filter((m) => m < last);
    mins = shorter.length ? shorter : [Math.max(MIN_MINUTES, Math.floor(last / 2))];
  }
  return mins.map((minutes) => ({ minutes, label: formatDuration(minutes) }));
}

export const DEFERRAL_KEYS = ['day', 'week', 'month'];

/**
 * "Out of spoons" deferrals. Each comes back at the user's day-start time:
 * tomorrow, the first day of next week, or the first day of next month.
 */
export function deferralOptions(now, settings) {
  const dayStart = settings.dayStart;
  const dayUntil = atClock(addDays(startOfDay(now), 1), dayStart);
  const weekUntil = atClock(startOfNextWeek(now, settings.weekStartsOn), dayStart);
  const monthUntil = atClock(startOfNextMonth(now), dayStart);
  return [
    { key: 'day', label: 'Rest of today', hint: 'Back tomorrow', until: dayUntil },
    { key: 'week', label: 'Rest of this week', hint: 'Back next week', until: weekUntil },
    { key: 'month', label: 'Until next month', hint: 'Back on the 1st', until: monthUntil },
  ];
}

export function deferralOption(key, now, settings) {
  const opt = deferralOptions(now, settings).find((o) => o.key === key);
  if (!opt) throw new Error(`Unknown deferral: ${key}`);
  return opt;
}

/** Visual/verbal urgency for an escalation level. */
export function urgency(level) {
  const n = Math.max(0, level | 0);
  if (n === 0) {
    return { tier: 'calm', level: n, heading: 'Is this complete?', sub: 'Its time anchor just arrived.' };
  }
  if (n === 1) {
    return { tier: 'firm', level: n, heading: 'Still not done?', sub: 'Snoozed once. The windows are shorter now.' };
  }
  if (n === 2) {
    return { tier: 'loud', level: n, heading: 'Third alert. Is it complete?', sub: 'Snoozed twice. It only gets shorter from here.' };
  }
  return {
    tier: 'hostile',
    level: n,
    heading: `Nag #${n + 1}. Do the thing.`,
    sub: `Snoozed ${n} times. This will not stop until you answer honestly.`,
  };
}

export const TIERS = ['calm', 'firm', 'loud', 'hostile'];

/** Milliseconds a snooze of `minutes` lasts from `now`. */
export function snoozeUntil(now, minutes) {
  return now + minutes * MINUTE;
}

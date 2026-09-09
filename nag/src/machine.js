// Task state machine.
//
//   scheduled ──fire──▶ alerting ──complete──▶ done
//       ▲                 │  │
//       │        snooze ──┘  └── defer (out of spoons)
//       │                 │            │
//       │                 ▼            ▼
//       │             snoozed       deferred
//       │                 │            │
//       └──────fire───────┴────fire────┘   (snoozed fires at level+1; deferred resets to level 0)
//
// `complete` is legal from every non-done state so a task can be finished
// early, before it ever alerts. Every transition returns a new task object.

import { snoozeOptions, deferralOption, snoozeUntil } from './snooze.js';

export class IllegalTransition extends Error {
  constructor(task, action) {
    super(`Cannot ${action} a task in state "${task.state}"`);
    this.name = 'IllegalTransition';
    this.state = task.state;
    this.action = action;
  }
}

export const WAITING_STATES = ['scheduled', 'snoozed', 'deferred'];

export function isWaiting(task) {
  return WAITING_STATES.includes(task.state);
}

export function isOpen(task) {
  return task.state !== 'done';
}

export function isDue(task, now) {
  return isWaiting(task) && Number.isFinite(task.nextFireAt) && task.nextFireAt <= now;
}

function withEvent(task, patch, event) {
  return { ...task, ...patch, events: [...(task.events || []), event] };
}

/** waiting -> alerting. The alert carries the task's current escalation level. */
export function fire(task, now) {
  if (!isWaiting(task)) throw new IllegalTransition(task, 'fire');
  return withEvent(task, {
    state: 'alerting',
    alertedAt: now,
    nextFireAt: null,
    alertCount: (task.alertCount || 0) + 1,
  }, { type: 'alerted', at: now, level: task.level || 0 });
}

/** any non-done -> done. */
export function complete(task, now) {
  if (task.state === 'done') throw new IllegalTransition(task, 'complete');
  return withEvent(task, {
    state: 'done',
    completedAt: now,
    nextFireAt: null,
    alertedAt: null,
  }, { type: 'completed', at: now, level: task.level || 0, late: now - task.dueAt });
}

/** alerting -> snoozed for one of the offered durations. Escalates the level. */
export function snooze(task, minutes, now) {
  if (task.state !== 'alerting') throw new IllegalTransition(task, 'snooze');
  const offered = snoozeOptions(task).map((o) => o.minutes);
  if (!offered.includes(minutes)) {
    throw new RangeError(`Snooze of ${minutes} min not offered; options are ${offered.join(', ')}`);
  }
  const level = (task.level || 0) + 1;
  const until = snoozeUntil(now, minutes);
  return withEvent(task, {
    state: 'snoozed',
    level,
    maxLevel: Math.max(task.maxLevel || 0, level),
    snoozeCount: (task.snoozeCount || 0) + 1,
    lastSnoozeMinutes: minutes,
    nextFireAt: until,
    alertedAt: null,
  }, { type: 'snoozed', at: now, level: task.level || 0, minutes, until });
}

/**
 * alerting -> deferred ("out of spoons"). The cascade resets: when the task
 * comes back it starts at level 0 with fresh snooze windows. The deferral is
 * still recorded (double-weighted) for friction analytics.
 */
export function defer(task, key, now, settings) {
  if (task.state !== 'alerting') throw new IllegalTransition(task, 'defer');
  const opt = deferralOption(key, now, settings);
  return withEvent(task, {
    state: 'deferred',
    level: 0,
    lastSnoozeMinutes: null,
    deferCount: (task.deferCount || 0) + 1,
    nextFireAt: opt.until,
    alertedAt: null,
  }, { type: 'deferred', at: now, level: task.level || 0, key, until: opt.until });
}

/** Dispatch helper: { type: 'fire'|'complete'|'snooze'|'defer', ... } */
export function reduce(task, action, ctx) {
  switch (action.type) {
    case 'fire': return fire(task, ctx.now);
    case 'complete': return complete(task, ctx.now);
    case 'snooze': return snooze(task, action.minutes, ctx.now);
    case 'defer': return defer(task, action.key, ctx.now, ctx.settings);
    default: throw new Error(`Unknown action: ${action.type}`);
  }
}

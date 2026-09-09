// Notification queue logic (pure functions over the task list).

import { isWaiting } from './machine.js';

/** Ids of waiting tasks whose fire time has arrived, earliest first. */
export function dueTaskIds(tasks, now) {
  return tasks
    .filter((t) => isWaiting(t) && Number.isFinite(t.nextFireAt) && t.nextFireAt <= now)
    .sort((a, b) => a.nextFireAt - b.nextFireAt)
    .map((t) => t.id);
}

/**
 * Alerting tasks in the order they should be shown: the most escalated first,
 * then the one that has been waiting longest, then the earliest anchor.
 */
export function alertQueue(tasks) {
  return tasks
    .filter((t) => t.state === 'alerting')
    .sort((a, b) =>
      (b.level - a.level) ||
      ((a.alertedAt || 0) - (b.alertedAt || 0)) ||
      (a.dueAt - b.dueAt) ||
      a.id.localeCompare(b.id));
}

/** Waiting tasks in the order they will fire. */
export function upcoming(tasks) {
  return tasks
    .filter((t) => isWaiting(t))
    .sort((a, b) => (a.nextFireAt - b.nextFireAt) || (a.dueAt - b.dueAt) || a.id.localeCompare(b.id));
}

/** Completed tasks, most recent first. */
export function completed(tasks) {
  return tasks
    .filter((t) => t.state === 'done')
    .sort((a, b) => (b.completedAt - a.completedAt) || a.id.localeCompare(b.id));
}

/** Earliest pending fire time, or null. */
export function nextFireTime(tasks) {
  let min = null;
  for (const t of tasks) {
    if (isWaiting(t) && Number.isFinite(t.nextFireAt) && (min === null || t.nextFireAt < min)) min = t.nextFireAt;
  }
  return min;
}

/**
 * What a native wrapper needs to schedule local notifications:
 * one entry per waiting task, sorted by time.
 */
export function nativeSchedule(tasks) {
  return upcoming(tasks).map((t) => ({ id: t.id, title: t.title, at: t.nextFireAt, level: t.level }));
}

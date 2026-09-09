process.env.TZ = 'America/New_York';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTask, DEFAULT_SETTINGS } from '../src/model.js';
import { fire, snooze, complete } from '../src/machine.js';
import { dueTaskIds, alertQueue, upcoming, completed, nextFireTime, nativeSchedule } from '../src/scheduler.js';
import { parseLocalDate, atClock, MINUTE } from '../src/time.js';

const day = parseLocalDate('2026-09-09').getTime();
const at = (hhmm) => atClock(day, hhmm);
const settings = DEFAULT_SETTINGS;

function mk(id, time, spoons = 2) {
  return createTask({ title: id, spoons, anchor: { date: '2026-09-09', kind: 'exact', time } }, { now: at('08:00'), settings, id });
}

test('dueTaskIds returns waiting tasks whose time has come, earliest first', () => {
  const tasks = [mk('c', '10:30'), mk('a', '10:00'), mk('b', '10:15'), mk('later', '12:00')];
  assert.deepEqual(dueTaskIds(tasks, at('09:59')), []);
  assert.deepEqual(dueTaskIds(tasks, at('10:00')), ['a']);
  assert.deepEqual(dueTaskIds(tasks, at('10:31')), ['a', 'b', 'c']);
  const alerting = tasks.map((t) => (t.id === 'a' ? fire(t, at('10:00')) : t));
  assert.deepEqual(dueTaskIds(alerting, at('10:31')), ['b', 'c'], 'already-alerting tasks are not re-fired');
});

test('alertQueue puts the most escalated alert first, then the longest waiting', () => {
  let a = fire(mk('a', '10:00'), at('10:00'));
  a = snooze(a, 5, at('10:00'));
  a = fire(a, a.nextFireAt); // level 1, alerted 10:05
  const b = fire(mk('b', '10:01'), at('10:01')); // level 0, alerted 10:01
  const c = fire(mk('c', '10:02'), at('10:02')); // level 0, alerted 10:02
  const d = mk('d', '11:00');
  assert.deepEqual(alertQueue([d, c, b, a]).map((t) => t.id), ['a', 'b', 'c']);
});

test('upcoming, completed, nextFireTime and nativeSchedule', () => {
  let a = fire(mk('a', '10:00'), at('10:00'));
  a = snooze(a, 20, at('10:00')); // fires 10:20
  const b = mk('b', '10:10');
  const c = complete(mk('c', '09:00'), at('09:05'));
  const d = complete(mk('d', '09:30'), at('09:40'));
  const tasks = [a, b, c, d];
  assert.deepEqual(upcoming(tasks).map((t) => t.id), ['b', 'a']);
  assert.deepEqual(completed(tasks).map((t) => t.id), ['d', 'c']);
  assert.equal(nextFireTime(tasks), at('10:10'));
  assert.equal(nextFireTime([c, d]), null);
  assert.deepEqual(nativeSchedule(tasks), [
    { id: 'b', title: 'b', at: at('10:10'), level: 0 },
    { id: 'a', title: 'a', at: at('10:20'), level: 1 },
  ]);
  assert.equal(a.nextFireAt - at('10:00'), 20 * MINUTE);
});

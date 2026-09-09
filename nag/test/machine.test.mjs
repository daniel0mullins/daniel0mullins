process.env.TZ = 'America/New_York';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTask, updateTaskFields, ValidationError, DEFAULT_SETTINGS, DEFAULT_SPOONS, taskFriction } from '../src/model.js';
import { fire, complete, snooze, defer, reduce, isDue, IllegalTransition } from '../src/machine.js';
import { snoozeOptions } from '../src/snooze.js';
import { parseLocalDate, atClock, MINUTE, toDateInput } from '../src/time.js';

const day = parseLocalDate('2026-09-09').getTime();
const settings = DEFAULT_SETTINGS;
const at = (hhmm) => atClock(day, hhmm);

function newTask(overrides = {}, now = at('09:00')) {
  return createTask({
    title: 'Call the insurance company',
    category: 'admin',
    spoons: 2,
    anchor: { date: '2026-09-09', kind: 'exact', time: '10:00' },
    ...overrides,
  }, { now, settings, id: 't1' });
}

test('full lifecycle: create -> alert -> snooze -> cascading alerts -> completion', () => {
  let t = newTask();
  assert.equal(t.state, 'scheduled');
  assert.equal(t.dueAt, at('10:00'));
  assert.equal(isDue(t, at('09:59')), false);
  assert.equal(isDue(t, at('10:00')), true);

  // Alert 1 (level 0)
  t = fire(t, at('10:00'));
  assert.equal(t.state, 'alerting');
  assert.equal(t.alertCount, 1);
  assert.equal(t.level, 0);
  let offered = snoozeOptions(t).map((o) => o.minutes);
  assert.deepEqual(offered, [5, 10, 20]);

  // Snooze 10 min
  t = snooze(t, 10, at('10:00'));
  assert.equal(t.state, 'snoozed');
  assert.equal(t.level, 1);
  assert.equal(t.snoozeCount, 1);
  assert.equal(t.nextFireAt, at('10:10'));
  assert.equal(isDue(t, at('10:09')), false);
  assert.equal(isDue(t, at('10:10')), true);

  // Alert 2 (level 1): strictly shorter than the 10 minutes chosen before
  t = fire(t, at('10:10'));
  assert.equal(t.level, 1);
  offered = snoozeOptions(t).map((o) => o.minutes);
  assert.deepEqual(offered, [3, 5]);
  assert.ok(Math.max(...offered) < 10);

  t = snooze(t, 5, at('10:10'));
  t = fire(t, t.nextFireAt);
  assert.equal(t.level, 2);
  offered = snoozeOptions(t).map((o) => o.minutes);
  assert.deepEqual(offered, [1, 3]);

  t = snooze(t, 3, at('10:15'));
  t = fire(t, t.nextFireAt);
  assert.equal(t.level, 3);
  offered = snoozeOptions(t).map((o) => o.minutes);
  assert.deepEqual(offered, [1]);

  t = snooze(t, 1, at('10:18'));
  t = fire(t, t.nextFireAt);
  assert.equal(t.level, 4);
  assert.deepEqual(snoozeOptions(t).map((o) => o.minutes), [1], 'terminal one-minute nag');

  t = complete(t, at('10:25'));
  assert.equal(t.state, 'done');
  assert.equal(t.completedAt, at('10:25'));
  assert.equal(t.snoozeCount, 4);
  assert.equal(t.maxLevel, 4);
  assert.equal(t.alertCount, 5);
  assert.equal(t.nextFireAt, null);
  assert.equal(taskFriction(t), 4);
  const types = t.events.map((e) => e.type);
  assert.deepEqual(types, ['created', 'alerted', 'snoozed', 'alerted', 'snoozed', 'alerted', 'snoozed', 'alerted', 'snoozed', 'alerted', 'completed']);
  assert.equal(t.events.at(-1).late, 25 * MINUTE);
});

test('snooze durations scale with spoon size', () => {
  const small = fire(newTask({ spoons: 1 }), at('10:00'));
  const big = fire(newTask({ spoons: 5 }), at('10:00'));
  const smallMax = Math.max(...snoozeOptions(small).map((o) => o.minutes));
  const bigMax = Math.max(...snoozeOptions(big).map((o) => o.minutes));
  assert.ok(bigMax > smallMax);
  assert.equal(smallMax, 10);
  assert.equal(bigMax, 180);
});

test('out of spoons defers to tomorrow and resets the cascade', () => {
  let t = fire(newTask(), at('10:00'));
  t = snooze(t, 5, at('10:00'));
  t = fire(t, t.nextFireAt);
  t = snooze(t, 3, at('10:05'));
  t = fire(t, t.nextFireAt);
  assert.equal(t.level, 2);
  t = defer(t, 'day', at('10:08'), settings);
  assert.equal(t.state, 'deferred');
  assert.equal(t.level, 0);
  assert.equal(t.deferCount, 1);
  assert.equal(t.snoozeCount, 2);
  assert.equal(t.lastSnoozeMinutes, null);
  assert.equal(toDateInput(t.nextFireAt), '2026-09-10');
  assert.equal(new Date(t.nextFireAt).getHours(), 9);
  assert.equal(taskFriction(t), 4, 'a deferral is weighted like two snoozes');

  t = fire(t, t.nextFireAt);
  assert.deepEqual(snoozeOptions(t).map((o) => o.minutes), [5, 10, 20], 'fresh windows after coming back');

  const week = defer(t, 'week', t.alertedAt, settings);
  assert.equal(toDateInput(week.nextFireAt), '2026-09-14');
  const month = defer(t, 'month', t.alertedAt, settings);
  assert.equal(toDateInput(month.nextFireAt), '2026-10-01');
  assert.throws(() => defer(t, 'year', t.alertedAt, settings), /Unknown deferral/);
});

test('tasks can be completed early, before any alert', () => {
  const t = complete(newTask(), at('09:30'));
  assert.equal(t.state, 'done');
  assert.equal(t.alertCount, 0);
  assert.equal(t.snoozeCount, 0);
  assert.equal(t.events.at(-1).late, -30 * MINUTE);
});

test('illegal transitions throw', () => {
  const t = newTask();
  assert.throws(() => snooze(t, 5, at('10:00')), IllegalTransition);
  assert.throws(() => defer(t, 'day', at('10:00'), settings), IllegalTransition);
  const alerting = fire(t, at('10:00'));
  assert.throws(() => fire(alerting, at('10:01')), IllegalTransition);
  assert.throws(() => snooze(alerting, 7, at('10:00')), RangeError, 'only offered durations are accepted');
  const done = complete(alerting, at('10:01'));
  assert.throws(() => complete(done, at('10:02')), IllegalTransition);
  assert.throws(() => fire(done, at('10:02')), IllegalTransition);
  assert.throws(() => reduce(t, { type: 'nope' }, { now: 0 }), /Unknown action/);
});

test('reduce dispatches actions', () => {
  let t = newTask();
  t = reduce(t, { type: 'fire' }, { now: at('10:00'), settings });
  t = reduce(t, { type: 'snooze', minutes: 5 }, { now: at('10:00'), settings });
  assert.equal(t.state, 'snoozed');
  t = reduce(t, { type: 'fire' }, { now: t.nextFireAt, settings });
  t = reduce(t, { type: 'defer', key: 'month' }, { now: at('10:05'), settings });
  assert.equal(t.state, 'deferred');
  t = reduce(t, { type: 'complete' }, { now: at('10:06'), settings });
  assert.equal(t.state, 'done');
});

test('fuzzy anchors resolve through the settings and spoons default to 2', () => {
  const t = createTask({
    title: 'Water plants',
    anchor: { date: '2026-09-09', kind: 'fuzzy', period: 'evening' },
  }, { now: at('08:00'), settings: { ...settings, periods: { ...settings.periods, evening: '19:15' } } });
  assert.equal(t.spoons, DEFAULT_SPOONS);
  assert.equal(t.category, 'other');
  assert.equal(new Date(t.dueAt).getHours(), 19);
  assert.equal(new Date(t.dueAt).getMinutes(), 15);
  assert.ok(t.id.length > 5);
});

test('validation rejects missing title, date, time, period and bad spoons', () => {
  const base = { title: 'x', anchor: { date: '2026-09-09', kind: 'exact', time: '10:00' } };
  assert.throws(() => createTask({ ...base, title: '   ' }, { settings }), (e) => e instanceof ValidationError && !!e.errors.title);
  assert.throws(() => createTask({ ...base, anchor: { kind: 'exact', time: '10:00' } }, { settings }), (e) => !!e.errors.date);
  assert.throws(() => createTask({ ...base, anchor: { date: '2026-09-09', kind: 'exact' } }, { settings }), (e) => !!e.errors.time);
  assert.throws(() => createTask({ ...base, anchor: { date: '2026-09-09', kind: 'fuzzy', period: 'dawn' } }, { settings }), (e) => !!e.errors.period);
  assert.throws(() => createTask({ ...base, anchor: { date: '2026-09-09' } }, { settings }), (e) => !!e.errors.kind);
  assert.throws(() => createTask({ ...base, spoons: 9 }, { settings }), (e) => !!e.errors.spoons);
  assert.throws(() => createTask({ ...base, spoons: 2.5 }, { settings }), (e) => !!e.errors.spoons);
  assert.equal(createTask({ ...base, spoons: '' }, { settings }).spoons, 2);
  assert.equal(createTask({ ...base, spoons: '4' }, { settings }).spoons, 4);
});

test('editing keeps friction history and re-anchors when the time moves', () => {
  let t = fire(newTask(), at('10:00'));
  t = snooze(t, 5, at('10:00'));
  t = fire(t, t.nextFireAt);
  const edited = updateTaskFields(t, {
    title: 'Call insurance (again)',
    category: 'admin',
    spoons: 4,
    anchor: { date: '2026-09-10', kind: 'exact', time: '11:00' },
  }, { now: at('10:06'), settings });
  assert.equal(edited.state, 'scheduled');
  assert.equal(edited.snoozeCount, 1);
  assert.equal(edited.spoons, 4);
  assert.equal(toDateInput(edited.nextFireAt), '2026-09-10');
  const sameAnchor = updateTaskFields(t, { title: 'Renamed', anchor: t.anchor }, { now: at('10:06'), settings });
  assert.equal(sameAnchor.state, 'alerting', 'no anchor change keeps the alert');
  assert.equal(sameAnchor.spoons, DEFAULT_SPOONS);
  assert.throws(() => updateTaskFields(complete(t, at('10:07')), { title: 'x', anchor: t.anchor }, { settings }), ValidationError);
});

process.env.TZ = 'America/New_York';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTask, DEFAULT_SETTINGS } from '../src/model.js';
import { fire, snooze, complete, defer } from '../src/machine.js';
import { snoozeOptions } from '../src/snooze.js';
import { analyze, classify, periodOfTask, THRESHOLDS, isInformative, median } from '../src/analytics.js';
import { parseLocalDate, atClock, MINUTE } from '../src/time.js';

const settings = DEFAULT_SETTINGS;
const day = parseLocalDate('2026-09-09').getTime();
const at = (hhmm) => atClock(day, hhmm);
let seq = 0;

/** Build a completed task with a given number of snoozes and deferrals. */
function done({ category, spoons = 2, snoozes = 0, deferrals = 0, time = '10:00', anchor }) {
  let t = createTask({ title: `${category} ${seq}`, category, spoons, anchor: anchor || { date: '2026-09-09', kind: 'exact', time } }, { now: at('08:00'), settings, id: `t${seq++}` });
  let now = t.dueAt;
  t = fire(t, now);
  for (let i = 0; i < snoozes; i++) {
    const opts = snoozeOptions(t);
    t = snooze(t, opts[0].minutes, now);
    now = t.nextFireAt;
    t = fire(t, now);
  }
  for (let i = 0; i < deferrals; i++) {
    t = defer(t, 'day', now, settings);
    now = t.nextFireAt;
    t = fire(t, now);
  }
  return complete(t, now + 2 * MINUTE);
}

test('classification thresholds', () => {
  assert.equal(classify(0), 'easy');
  assert.equal(classify(THRESHOLDS.easy - 0.01), 'easy');
  assert.equal(classify(THRESHOLDS.easy), 'sticky');
  assert.equal(classify(THRESHOLDS.hard), 'sticky');
  assert.equal(classify(THRESHOLDS.hard + 0.01), 'hard');
});

test('types are ranked by snooze volume and frequency', () => {
  const tasks = [
    done({ category: 'chores' }), done({ category: 'chores' }), done({ category: 'chores', snoozes: 0 }),
    done({ category: 'admin', snoozes: 4 }), done({ category: 'admin', snoozes: 4 }), done({ category: 'admin', snoozes: 4 }),
    done({ category: 'errands', snoozes: 1, deferrals: 1 }), done({ category: 'errands', snoozes: 1 }),
  ];
  const r = analyze(tasks, { now: at('12:00'), settings });

  assert.equal(r.totals.tasks, 8);
  assert.equal(r.totals.completed, 8);
  assert.equal(r.totals.snoozes, 14);
  assert.equal(r.totals.deferrals, 1);
  assert.equal(r.totals.friction, 16);
  assert.equal(r.totals.perTask, 2);
  assert.equal(r.totals.firstAlertRate, 3 / 8);

  const cats = Object.fromEntries(r.byCategory.map((g) => [g.key, g]));
  assert.equal(cats.chores.snoozes, 0);
  assert.equal(cats.chores.perTask, 0);
  assert.equal(cats.chores.snoozedShare, 0);
  assert.equal(cats.chores.classification, 'easy');
  assert.equal(cats.admin.snoozes, 12);
  assert.equal(cats.admin.perTask, 4);
  assert.equal(cats.admin.snoozedShare, 1);
  assert.equal(cats.admin.maxLevel, 4);
  assert.equal(cats.admin.classification, 'hard');
  assert.equal(cats.errands.snoozes, 2);
  assert.equal(cats.errands.deferrals, 1);
  assert.equal(cats.errands.friction, 4);
  assert.equal(cats.errands.perTask, 2);
  assert.equal(cats.errands.classification, 'sticky');

  assert.deepEqual(r.byCategory.map((g) => g.key), ['admin', 'errands', 'chores']);
  assert.equal(r.hardest[0].key, 'admin');
  assert.equal(r.easiest[0].key, 'chores');
  assert.ok(!r.hardest.some((g) => g.key === 'chores'), 'zero-friction types are never "hardest"');
  assert.ok(r.insights.some((s) => /Admin/.test(s)), r.insights.join('\n'));
});

test('a deferral weighs exactly two snoozes', () => {
  const tasks = [
    done({ category: 'x', snoozes: 2 }),
    done({ category: 'y', deferrals: 1 }),
    done({ category: 'z', snoozes: 1, deferrals: 1 }),
  ];
  const r = analyze(tasks, { now: at('12:00'), settings });
  const cats = Object.fromEntries(r.byCategory.map((g) => [g.key, g]));
  assert.equal(cats.x.perTask, cats.y.perTask);
  assert.ok(cats.z.perTask > cats.x.perTask);
  assert.equal(r.byCategory[0].key, 'z');
});

test('open tasks that have alerted count; untouched scheduled tasks do not', () => {
  let open = createTask({ title: 'open', category: 'work', anchor: { date: '2026-09-09', kind: 'exact', time: '10:00' } }, { now: at('08:00'), settings, id: 'open' });
  open = fire(open, at('10:00'));
  open = snooze(open, 5, at('10:00'));
  const untouched = createTask({ title: 'later', category: 'work', anchor: { date: '2026-09-09', kind: 'exact', time: '18:00' } }, { now: at('08:00'), settings, id: 'later' });
  assert.equal(isInformative(open), true);
  assert.equal(isInformative(untouched), false);
  const r = analyze([open, untouched], { now: at('10:06'), settings });
  assert.equal(r.totals.tasks, 2);
  assert.equal(r.totals.informative, 1);
  assert.equal(r.totals.completed, 0);
  assert.equal(r.byCategory[0].tasks, 1);
  assert.equal(r.byCategory[0].snoozes, 1);
  assert.equal(r.byCategory[0].completionRate, 0);
});

test('breakdowns by spoon size and part of day', () => {
  const tasks = [
    done({ category: 'a', spoons: 1, time: '07:00' }),
    done({ category: 'a', spoons: 5, snoozes: 3, time: '13:00' }),
    done({ category: 'a', spoons: 5, snoozes: 3, anchor: { date: '2026-09-09', kind: 'fuzzy', period: 'night' } }),
    done({ category: 'a', spoons: 3, snoozes: 1, time: '02:00' }),
  ];
  const r = analyze(tasks, { now: at('23:00'), settings });
  const spoons = Object.fromEntries(r.bySpoons.map((g) => [g.key, g]));
  assert.equal(r.bySpoons.length, 5);
  assert.equal(spoons[1].tasks, 1);
  assert.equal(spoons[1].snoozes, 0);
  assert.equal(spoons[5].tasks, 2);
  assert.equal(spoons[5].snoozes, 6);
  assert.equal(spoons[2].tasks, 0);
  const periods = Object.fromEntries(r.byPeriod.map((g) => [g.key, g]));
  assert.equal(periods.morning.tasks, 1);
  assert.equal(periods.midday.tasks, 1);
  assert.equal(periods.night.tasks, 2);
  assert.ok(r.insights.some((s) => /Big tasks/.test(s)), r.insights.join('\n'));
});

test('periodOfTask buckets exact times around the configured period times', () => {
  const mk = (time) => ({ dueAt: at(time), anchor: { kind: 'exact', time } });
  assert.equal(periodOfTask(mk('02:59'), settings), 'night');
  assert.equal(periodOfTask(mk('03:00'), settings), 'morning');
  assert.equal(periodOfTask(mk('10:29'), settings), 'morning');
  assert.equal(periodOfTask(mk('10:30'), settings), 'midday');
  assert.equal(periodOfTask(mk('13:29'), settings), 'midday');
  assert.equal(periodOfTask(mk('13:30'), settings), 'afternoon');
  assert.equal(periodOfTask(mk('16:44'), settings), 'afternoon');
  assert.equal(periodOfTask(mk('16:45'), settings), 'evening');
  assert.equal(periodOfTask(mk('19:44'), settings), 'evening');
  assert.equal(periodOfTask(mk('19:45'), settings), 'night');
  assert.equal(periodOfTask(mk('23:59'), settings), 'night');
  assert.equal(periodOfTask({ dueAt: at('23:59'), anchor: { kind: 'fuzzy', period: 'morning' } }, settings), 'morning');
});

test('empty and degenerate inputs', () => {
  const r = analyze([], { now: at('12:00'), settings });
  assert.equal(r.totals.tasks, 0);
  assert.equal(r.totals.perTask, 0);
  assert.equal(r.totals.firstAlertRate, null);
  assert.deepEqual(r.byCategory, []);
  assert.deepEqual(r.hardest, []);
  assert.deepEqual(r.easiest, []);
  assert.deepEqual(r.insights, []);
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  const one = analyze([done({ category: 'solo', snoozes: 2 })], { now: at('12:00'), settings });
  assert.equal(one.hardest.length, 1);
  assert.deepEqual(one.easiest, [], 'a single type is not ranked against itself');
});

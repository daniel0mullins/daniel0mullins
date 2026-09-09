process.env.TZ = 'America/New_York';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE_MINUTES, MIN_MINUTES, snoozeMinutes, snoozeOptions, deferralOptions, urgency, optionCount } from '../src/snooze.js';
import { DEFAULT_SETTINGS } from '../src/model.js';
import { parseLocalDate, atClock, toDateInput } from '../src/time.js';

test('initial snooze grows with spoon size', () => {
  let prev = 0;
  for (let s = 1; s <= 5; s++) {
    const [, standard] = snoozeMinutes(s, 0);
    assert.equal(standard, BASE_MINUTES[s]);
    assert.ok(standard > prev, `spoons ${s} standard ${standard} > ${prev}`);
    prev = standard;
  }
  assert.deepEqual(snoozeMinutes(1, 0), [3, 5, 10]);
  assert.deepEqual(snoozeMinutes(2, 0), [5, 10, 20]);
  assert.deepEqual(snoozeMinutes(5, 0), [45, 90, 180]);
});

test('every escalation level offers a strictly shorter menu until the 1-minute floor', () => {
  for (let s = 1; s <= 5; s++) {
    let prev = snoozeMinutes(s, 0);
    for (let level = 1; level <= 10; level++) {
      const cur = snoozeMinutes(s, level);
      assert.ok(cur.length >= 1);
      assert.ok(cur.length <= prev.length, `spoons ${s} level ${level}: menu should not grow`);
      const prevMax = prev[prev.length - 1];
      const curMax = cur[cur.length - 1];
      if (prevMax > MIN_MINUTES) {
        assert.ok(curMax < prevMax, `spoons ${s} level ${level}: ${curMax} should be < ${prevMax}`);
      } else {
        assert.deepEqual(cur, [MIN_MINUTES]);
      }
      assert.ok(cur[0] <= prev[0]);
      prev = cur;
    }
    assert.deepEqual(snoozeMinutes(s, 12), [MIN_MINUTES], 'terminal state is a one-minute nag');
  }
  assert.equal(optionCount(0), 3);
  assert.equal(optionCount(2), 2);
  assert.equal(optionCount(4), 1);
});

test('offered options are strictly shorter than the previous snooze on the task', () => {
  assert.deepEqual(snoozeOptions({ spoons: 2, level: 0, lastSnoozeMinutes: null }).map((o) => o.minutes), [5, 10, 20]);
  assert.deepEqual(snoozeOptions({ spoons: 2, level: 1, lastSnoozeMinutes: 10 }).map((o) => o.minutes), [3, 5]);
  assert.deepEqual(snoozeOptions({ spoons: 2, level: 1, lastSnoozeMinutes: 5 }).map((o) => o.minutes), [3]);
  assert.deepEqual(snoozeOptions({ spoons: 2, level: 1, lastSnoozeMinutes: 3 }).map((o) => o.minutes), [1]);
  assert.deepEqual(snoozeOptions({ spoons: 5, level: 3, lastSnoozeMinutes: 1 }).map((o) => o.minutes), [1]);
  assert.equal(snoozeOptions({ spoons: 3, level: 0 })[2].label, '40 min');
  assert.equal(snoozeOptions({ spoons: 5, level: 0 })[2].label, '3 h');
});

test('out-of-spoons deferrals land on the next day, week and month at day start', () => {
  const settings = { ...DEFAULT_SETTINGS, dayStart: '08:30', weekStartsOn: 1 };
  const now = atClock(parseLocalDate('2026-09-09').getTime(), '15:00'); // a Wednesday
  const opts = deferralOptions(now, settings);
  const by = Object.fromEntries(opts.map((o) => [o.key, o]));
  assert.equal(toDateInput(by.day.until), '2026-09-10');
  assert.equal(new Date(by.day.until).getHours(), 8);
  assert.equal(new Date(by.day.until).getMinutes(), 30);
  assert.equal(toDateInput(by.week.until), '2026-09-14');
  assert.equal(new Date(by.week.until).getDay(), 1);
  assert.equal(toDateInput(by.month.until), '2026-10-01');
  for (const o of opts) assert.ok(o.until > now);
});

test('deferrals keep their clock time across DST', () => {
  const settings = { ...DEFAULT_SETTINGS, dayStart: '09:00' };
  const now = atClock(parseLocalDate('2026-03-07').getTime(), '20:00'); // DST starts overnight
  const by = Object.fromEntries(deferralOptions(now, settings).map((o) => [o.key, o]));
  assert.equal(toDateInput(by.day.until), '2026-03-08');
  assert.equal(new Date(by.day.until).getHours(), 9);
  assert.equal(new Date(by.week.until).getHours(), 9);
});

test('urgency escalates through four tiers', () => {
  assert.equal(urgency(0).tier, 'calm');
  assert.equal(urgency(1).tier, 'firm');
  assert.equal(urgency(2).tier, 'loud');
  assert.equal(urgency(3).tier, 'hostile');
  assert.equal(urgency(7).tier, 'hostile');
  assert.match(urgency(7).heading, /#8/);
});

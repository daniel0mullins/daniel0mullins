process.env.TZ = 'America/New_York';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLocalDate, parseClock, atClock, startOfDay, addDays, startOfNextWeek, startOfNextMonth,
  toDateInput, toClockInput, formatDuration, formatRelative, formatLateness, formatDay, MINUTE, HOUR,
} from '../src/time.js';

test('parseLocalDate accepts real dates and rejects impossible ones', () => {
  const d = parseLocalDate('2026-09-09');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 8);
  assert.equal(d.getDate(), 9);
  assert.equal(parseLocalDate('2026-02-31'), null);
  assert.equal(parseLocalDate('2026-13-01'), null);
  assert.equal(parseLocalDate('09/09/2026'), null);
  assert.equal(parseLocalDate(''), null);
  assert.equal(parseLocalDate(undefined), null);
});

test('parseClock validates HH:MM', () => {
  assert.deepEqual(parseClock('09:05'), { h: 9, m: 5 });
  assert.deepEqual(parseClock('23:59'), { h: 23, m: 59 });
  assert.equal(parseClock('24:00'), null);
  assert.equal(parseClock('9:60'), null);
  assert.equal(parseClock('nine'), null);
});

test('atClock and startOfDay use local components', () => {
  const day = parseLocalDate('2026-09-09').getTime();
  const at = atClock(day + 5 * HOUR, '17:30');
  const d = new Date(at);
  assert.equal(d.getHours(), 17);
  assert.equal(d.getMinutes(), 30);
  assert.equal(d.getDate(), 9);
  assert.equal(startOfDay(at), day);
});

test('addDays keeps the wall-clock time across a DST change', () => {
  // US DST began 2026-03-08 at 02:00 in New York.
  const sat = atClock(parseLocalDate('2026-03-07').getTime(), '09:00');
  const mon = addDays(sat, 2);
  assert.equal(new Date(mon).getHours(), 9);
  assert.equal(new Date(mon).getDate(), 9);
  assert.notEqual(mon - sat, 2 * 24 * HOUR); // the elapsed time is 47 hours, not 48
});

test('startOfNextWeek is always strictly in the future', () => {
  const monday = atClock(parseLocalDate('2026-09-07').getTime(), '10:00'); // a Monday
  const next = startOfNextWeek(monday, 1);
  assert.equal(new Date(next).getDay(), 1);
  assert.equal(new Date(next).getDate(), 14);
  const sunday = atClock(parseLocalDate('2026-09-13').getTime(), '23:00');
  assert.equal(new Date(startOfNextWeek(sunday, 1)).getDate(), 14);
  assert.equal(new Date(startOfNextWeek(sunday, 0)).getDate(), 20);
});

test('startOfNextMonth handles year rollover and short months', () => {
  const jan31 = atClock(parseLocalDate('2026-01-31').getTime(), '12:00');
  assert.equal(toDateInput(startOfNextMonth(jan31)), '2026-02-01');
  const dec = atClock(parseLocalDate('2026-12-15').getTime(), '12:00');
  assert.equal(toDateInput(startOfNextMonth(dec)), '2027-01-01');
});

test('input formatters round-trip', () => {
  const at = atClock(parseLocalDate('2026-09-09').getTime(), '07:05');
  assert.equal(toDateInput(at), '2026-09-09');
  assert.equal(toClockInput(at), '07:05');
});

test('duration and relative formatting', () => {
  assert.equal(formatDuration(1), '1 min');
  assert.equal(formatDuration(45), '45 min');
  assert.equal(formatDuration(60), '1 h');
  assert.equal(formatDuration(90), '1 h 30 min');
  assert.equal(formatDuration(60 * 24), '1 d');
  assert.equal(formatDuration(60 * 24 * 2 + 180), '2 d 3 h');
  const now = 1_000_000_000_000;
  assert.equal(formatRelative(now + 30 * 1000, now), 'now');
  assert.equal(formatRelative(now + 5 * MINUTE, now), 'in 5 min');
  assert.equal(formatRelative(now - 2 * HOUR, now), '2 h ago');
  assert.equal(formatLateness(20 * 1000), 'on time');
  assert.equal(formatLateness(15 * MINUTE), '15 min late');
  assert.equal(formatLateness(-15 * MINUTE), '15 min early');
});

test('formatDay names today/tomorrow/yesterday', () => {
  const now = atClock(parseLocalDate('2026-09-09').getTime(), '12:00');
  assert.equal(formatDay(now + 2 * HOUR, now), 'Today');
  assert.equal(formatDay(addDays(now, 1), now), 'Tomorrow');
  assert.equal(formatDay(addDays(now, -1), now), 'Yesterday');
  assert.match(formatDay(addDays(now, 3), now, 'en-US'), /Sat/);
});

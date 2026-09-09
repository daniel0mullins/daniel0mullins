process.env.TZ = 'America/New_York';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppStore } from '../src/state.js';
import { createStorage, memoryBackend, deserialize, sanitizeTask, STORAGE_KEY } from '../src/persist.js';
import { buildDemo } from '../src/demo.js';
import { analyze } from '../src/analytics.js';
import { parseLocalDate, atClock, MINUTE, toDateInput } from '../src/time.js';

const day = parseLocalDate('2026-09-09').getTime();
const at = (hhmm) => atClock(day, hhmm);

function clockAt(start) {
  let t = start;
  return { now: () => t, set: (v) => { t = v; }, advance: (ms) => { t += ms; } };
}

test('the store runs the whole loop and persists every step', () => {
  const backend = memoryBackend();
  const storage = createStorage({ backend, persistent: false });
  const clock = clockAt(at('09:00'));
  const store = new AppStore({ storage, clock });
  const changes = [];
  store.subscribe((c) => changes.push(c.type));

  const task = store.addTask({ title: 'Pay the bill', category: 'money', spoons: 3, anchor: { date: '2026-09-09', kind: 'exact', time: '10:00' } });
  assert.equal(store.tasks.length, 1);
  assert.equal(store.nextFireTime(), at('10:00'));

  assert.deepEqual(store.tick(), []);
  clock.set(at('10:00'));
  assert.deepEqual(store.tick(), [task.id]);
  assert.equal(store.currentAlert().id, task.id);
  assert.equal(store.currentAlert().level, 0);

  store.snooze(task.id, 20);
  assert.equal(store.currentAlert(), null);
  assert.equal(store.getTask(task.id).nextFireAt, at('10:20'));

  clock.set(at('10:20'));
  store.tick();
  assert.equal(store.currentAlert().level, 1);
  store.defer(task.id, 'week');
  assert.equal(store.getTask(task.id).state, 'deferred');
  assert.equal(toDateInput(store.getTask(task.id).nextFireAt), '2026-09-14');

  clock.set(store.getTask(task.id).nextFireAt);
  store.tick();
  assert.equal(store.currentAlert().level, 0);
  store.complete(task.id);
  assert.equal(store.getTask(task.id).state, 'done');
  assert.deepEqual(changes, ['add', 'fire', 'snooze', 'fire', 'defer', 'fire', 'complete']);

  // A fresh store over the same backend sees the same history.
  const reloaded = new AppStore({ storage: createStorage({ backend, persistent: false }), clock });
  assert.equal(reloaded.tasks.length, 1);
  assert.equal(reloaded.getTask(task.id).state, 'done');
  assert.equal(reloaded.getTask(task.id).snoozeCount, 1);
  assert.equal(reloaded.getTask(task.id).deferCount, 1);
  const report = analyze(reloaded.tasks, { now: clock.now(), settings: reloaded.settings });
  assert.equal(report.byCategory[0].key, 'money');
  assert.equal(report.byCategory[0].friction, 3);
});

test('multiple due tasks fire together and queue by escalation', () => {
  const clock = clockAt(at('09:00'));
  const store = new AppStore({ clock });
  const a = store.addTask({ title: 'a', anchor: { date: '2026-09-09', kind: 'exact', time: '09:30' } });
  const b = store.addTask({ title: 'b', anchor: { date: '2026-09-09', kind: 'exact', time: '09:40' } });
  clock.set(at('09:30'));
  store.tick();
  store.snooze(a.id, 10); // back at 09:40
  clock.set(at('09:40'));
  assert.deepEqual(new Set(store.tick()), new Set([a.id, b.id]));
  assert.deepEqual(store.alertQueue().map((t) => t.id), [a.id, b.id]);
  store.complete(a.id);
  assert.equal(store.currentAlert().id, b.id);
});

test('settings changes re-anchor untouched fuzzy tasks only', () => {
  const clock = clockAt(at('08:00'));
  const store = new AppStore({ clock });
  const fuzzy = store.addTask({ title: 'fuzzy', anchor: { date: '2026-09-09', kind: 'fuzzy', period: 'evening' } });
  const exact = store.addTask({ title: 'exact', anchor: { date: '2026-09-09', kind: 'exact', time: '18:30' } });
  assert.equal(new Date(fuzzy.dueAt).getHours(), 18);
  store.setSettings({ periods: { evening: '20:00' }, dayStart: '07:30', sound: false });
  assert.equal(new Date(store.getTask(fuzzy.id).dueAt).getHours(), 20);
  assert.equal(store.getTask(fuzzy.id).nextFireAt, store.getTask(fuzzy.id).dueAt);
  assert.equal(new Date(store.getTask(exact.id).dueAt).getHours(), 18);
  assert.equal(store.settings.dayStart, '07:30');
  assert.equal(store.settings.sound, false);
  assert.equal(store.settings.periods.morning, '09:00', 'untouched periods keep their defaults');
  store.setSettings({ dayStart: 'bogus' });
  assert.equal(store.settings.dayStart, '07:30', 'invalid values are ignored');
});

test('update, delete, import and clear', () => {
  const clock = clockAt(at('08:00'));
  const backend = memoryBackend();
  const store = new AppStore({ storage: createStorage({ backend, persistent: false }), clock });
  const t = store.addTask({ title: 'Old', anchor: { date: '2026-09-09', kind: 'exact', time: '09:00' } });
  store.updateTask(t.id, { title: 'New', spoons: 4, anchor: { date: '2026-09-10', kind: 'fuzzy', period: 'morning' } });
  assert.equal(store.getTask(t.id).title, 'New');
  assert.equal(store.getTask(t.id).spoons, 4);
  assert.equal(toDateInput(store.getTask(t.id).dueAt), '2026-09-10');
  assert.throws(() => store.updateTask(t.id, { title: '', anchor: {} }));
  store.deleteTask(t.id);
  assert.equal(store.tasks.length, 0);
  store.deleteTask('missing');

  const demo = buildDemo({ now: at('12:00'), settings: store.settings, seed: 7 });
  store.importSnapshot({ tasks: demo.tasks, settings: { sound: false } });
  assert.equal(store.tasks.length, demo.tasks.length);
  assert.equal(store.settings.sound, false);
  assert.throws(() => store.importSnapshot('nope'), /Nag data/);
  assert.ok(JSON.parse(backend.getItem(STORAGE_KEY)).tasks.length > 10);

  store.clearAll();
  assert.equal(store.tasks.length, 0);
  assert.equal(backend.getItem(STORAGE_KEY), null);
  assert.equal(store.settings.sound, true);
});

test('demo data is deterministic and obeys the machine invariants', () => {
  const a = buildDemo({ now: at('12:00'), seed: 1 });
  const b = buildDemo({ now: at('12:00'), seed: 1 });
  assert.deepEqual(a, b);
  const doneTasks = a.tasks.filter((t) => t.state === 'done');
  assert.ok(doneTasks.length >= 20);
  assert.ok(a.tasks.filter((t) => t.state === 'scheduled').length === 4);
  for (const t of doneTasks) {
    assert.equal(t.alertCount, t.events.filter((e) => e.type === 'alerted').length);
    assert.equal(t.snoozeCount, t.events.filter((e) => e.type === 'snoozed').length);
    assert.equal(t.deferCount, t.events.filter((e) => e.type === 'deferred').length);
    assert.ok(t.completedAt >= t.dueAt);
  }
  const report = analyze(a.tasks, { now: at('12:00') });
  const cats = Object.fromEntries(report.byCategory.map((g) => [g.key, g]));
  assert.ok(cats.admin.perTask > cats.chores.perTask, 'admin is designed to be the hard type');
  assert.ok(report.insights.length >= 2);
});

test('corrupt or foreign storage never crashes the store', () => {
  const backend = memoryBackend();
  backend.setItem(STORAGE_KEY, '{not json');
  const store = new AppStore({ storage: createStorage({ backend, persistent: false }) });
  assert.deepEqual(store.tasks, []);

  const good = { id: 'ok', title: 'fine', state: 'scheduled', dueAt: at('10:00'), anchor: { date: '2026-09-09', kind: 'exact', time: '10:00' } };
  const snap = deserialize(JSON.stringify({ tasks: [
    good,
    { ...good, id: 'ok' }, // duplicate id
    { ...good, id: 'bad-state', state: 'limbo' },
    { ...good, id: 'bad-anchor', anchor: { date: 'yesterday' } },
    { ...good, id: '', title: 'no id' },
    'garbage',
    null,
    { ...good, id: 'weird-numbers', spoons: 'lots', snoozeCount: -3, level: 'x', nextFireAt: 'soon', events: 'none' },
  ], settings: { weekStartsOn: 9, periods: { morning: '25:00', night: '22:15' } } }));
  assert.deepEqual(snap.tasks.map((t) => t.id), ['ok', 'weird-numbers']);
  const weird = snap.tasks[1];
  assert.equal(weird.spoons, 2);
  assert.equal(weird.snoozeCount, 0);
  assert.equal(weird.level, 0);
  assert.equal(weird.nextFireAt, at('10:00'));
  assert.deepEqual(weird.events, []);
  assert.equal(snap.settings.weekStartsOn, 1);
  assert.equal(snap.settings.periods.morning, '09:00');
  assert.equal(snap.settings.periods.night, '22:15');
  assert.equal(sanitizeTask(undefined), null);
  assert.equal(deserialize(''), null);
  assert.equal(deserialize('42'), null);
});

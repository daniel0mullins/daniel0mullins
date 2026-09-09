// Deterministic demo history so the dashboard has something to show.
// Tasks are built with createTask and driven through the real state machine,
// so every record obeys the same invariants as live data.

import { createTask, normalizeSettings } from './model.js';
import { fire, complete, snooze, defer } from './machine.js';
import { snoozeOptions } from './snooze.js';
import { toDateInput, toClockInput, startOfDay, addDays, MINUTE, HOUR } from './time.js';

/** Small seeded PRNG (mulberry32) so demo data is stable across reloads. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PROFILES = [
  { category: 'chores', spoons: [1, 2], snoozes: [0, 1], defer: 0.0, titles: ['Take the bins out', 'Run the dishwasher', 'Water the plants', 'Fold laundry', 'Wipe the kitchen counter'] },
  { category: 'health', spoons: [1, 2], snoozes: [0, 1], defer: 0.05, titles: ['Take meds', 'Drink a full glass of water', 'Stretch for 5 minutes', 'Book dentist', 'Go for a walk'] },
  { category: 'work', spoons: [2, 3, 4], snoozes: [1, 2, 3], defer: 0.1, titles: ['Reply to the project thread', 'Write the status update', 'Review the pull request', 'Prep slides for standup', 'Update the timesheet'] },
  { category: 'errands', spoons: [2, 3], snoozes: [1, 2], defer: 0.1, titles: ['Post the parcel', 'Buy groceries', 'Pick up prescription', 'Return the library books'] },
  { category: 'admin', spoons: [3, 4, 5], snoozes: [3, 4, 5, 6], defer: 0.35, titles: ['Call the insurance company', 'Renew the car registration', 'Sort the paperwork pile', 'Chase the refund', 'File the expense claim'] },
  { category: 'money', spoons: [3, 4], snoozes: [2, 4, 5], defer: 0.3, titles: ['Pay the electricity bill', 'Check the bank statement', 'Cancel the unused subscription', 'Transfer to savings'] },
  { category: 'social', spoons: [2, 3], snoozes: [0, 2, 3], defer: 0.2, titles: ['Text Sam back', 'RSVP to the party', 'Call Mum', 'Reply to the group chat'] },
  { category: 'self-care', spoons: [1, 2, 3], snoozes: [1, 2, 3], defer: 0.25, titles: ['Shower', 'Eat an actual lunch', 'Go to bed by 11', 'Journal for 5 minutes'] },
];

const PERIOD_KEYS = ['morning', 'midday', 'afternoon', 'evening', 'night'];

function pick(random, arr) {
  return arr[Math.floor(random() * arr.length)];
}

/** Drive one task through alert -> snoozes -> (maybe defer) -> completion. */
function simulate(task, { snoozes, deferProb, random, settings }) {
  let t = task;
  let now = t.dueAt;
  t = fire(t, now);
  for (let i = 0; i < snoozes; i++) {
    now += Math.floor(random() * 4) * MINUTE; // dithers on the alert for a bit
    const options = snoozeOptions(t);
    const choice = options[Math.min(options.length - 1, Math.floor(random() * options.length))];
    t = snooze(t, choice.minutes, now);
    now = t.nextFireAt;
    t = fire(t, now);
  }
  if (random() < deferProb) {
    t = defer(t, random() < 0.7 ? 'day' : 'week', now, settings);
    now = t.nextFireAt;
    t = fire(t, now);
    if (random() < 0.5) {
      const options = snoozeOptions(t);
      t = snooze(t, options[options.length - 1].minutes, now);
      now = t.nextFireAt;
      t = fire(t, now);
    }
  }
  now += Math.floor(random() * 6) * MINUTE;
  return complete(t, now);
}

/**
 * Build a demo data set: ~3 weeks of completed history plus a few upcoming
 * tasks, one of which is due almost immediately so the alert loop can be seen.
 */
export function buildDemo({ now = Date.now(), settings, seed = 20260909 } = {}) {
  const s = normalizeSettings(settings);
  const random = rng(seed);
  const tasks = [];
  let n = 0;
  const today = startOfDay(now);

  for (let daysAgo = 21; daysAgo >= 1; daysAgo--) {
    const day = addDays(today, -daysAgo);
    const count = 1 + Math.floor(random() * 3);
    for (let i = 0; i < count; i++) {
      const profile = pick(random, PROFILES);
      const fuzzy = random() < 0.5;
      const period = pick(random, PERIOD_KEYS);
      const hour = 8 + Math.floor(random() * 13);
      const minute = pick(random, [0, 15, 30, 45]);
      const anchor = fuzzy
        ? { date: toDateInput(day), kind: 'fuzzy', period }
        : { date: toDateInput(day), kind: 'exact', time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
      const created = createTask({
        title: pick(random, profile.titles),
        category: profile.category,
        spoons: pick(random, profile.spoons),
        anchor,
      }, { now: day - 2 * HOUR, settings: s, id: `demo-${seed}-${n++}` });
      tasks.push(simulate(created, {
        snoozes: pick(random, profile.snoozes),
        deferProb: profile.defer,
        random,
        settings: s,
      }));
    }
  }

  // Upcoming tasks.
  const soon = now + 90 * 1000;
  const upcomingSpecs = [
    { title: 'Drink some water', category: 'health', spoons: 1, anchor: { date: toDateInput(soon), kind: 'exact', time: toClockInput(soon) } },
    { title: 'Reply to the landlord email', category: 'admin', spoons: 3, anchor: { date: toDateInput(now), kind: 'fuzzy', period: 'evening' } },
    { title: 'Put the washing on', category: 'chores', spoons: 2, anchor: { date: toDateInput(addDays(now, 1)), kind: 'fuzzy', period: 'morning' } },
    { title: 'Do the tax return', category: 'money', spoons: 5, anchor: { date: toDateInput(addDays(now, 3)), kind: 'fuzzy', period: 'afternoon' } },
  ];
  for (const spec of upcomingSpecs) {
    tasks.push(createTask(spec, { now, settings: s, id: `demo-${seed}-${n++}` }));
  }

  return { tasks };
}

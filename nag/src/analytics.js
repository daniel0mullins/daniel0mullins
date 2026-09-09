// Friction analytics.
//
// Difficulty is measured by the snoozes a task accumulates: their volume
// (total snoozes), their frequency (snoozes per task, share of tasks that
// needed any snooze), and out-of-spoons deferrals, which count double. Tasks
// that were never alerted and are not done carry no signal and are excluded
// from per-type friction, though they still count in the overview totals.

import { PERIODS, PERIOD_KEYS, MIN_SPOONS, MAX_SPOONS, normalizeSettings, taskFriction, FRICTION_WEIGHTS } from './model.js';
import { parseClock } from './time.js';

export { FRICTION_WEIGHTS };

/** Friction per task: below `easy` is easy, up to `hard` is sticky, above is hard. */
export const THRESHOLDS = Object.freeze({ easy: 1, hard: 3 });

export function classify(perTask) {
  if (perTask < THRESHOLDS.easy) return 'easy';
  if (perTask <= THRESHOLDS.hard) return 'sticky';
  return 'hard';
}

export const CLASS_LABELS = Object.freeze({ easy: 'Easy', sticky: 'Sticky', hard: 'Hard' });

/** A task carries friction signal once it has alerted at least once or is done. */
export function isInformative(task) {
  return task.state === 'done' || (task.alertCount || 0) > 0;
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Minutes since local midnight for an instant. */
function minuteOfDay(ms) {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

function clockMinutes(hhmm) {
  const c = parseClock(hhmm);
  return c.h * 60 + c.m;
}

/**
 * Which part of the day a task belongs to. Fuzzy anchors use their period;
 * exact anchors are bucketed by the nearest configured period time, with the
 * boundary between two periods at their midpoint (wrapping night -> morning).
 */
export function periodOfTask(task, settings) {
  if (task.anchor && task.anchor.kind === 'fuzzy' && PERIOD_KEYS.includes(task.anchor.period)) {
    return task.anchor.period;
  }
  const s = normalizeSettings(settings);
  const times = PERIOD_KEYS.map((key) => ({ key, min: clockMinutes(s.periods[key]) }))
    .sort((a, b) => a.min - b.min);
  const m = minuteOfDay(task.dueAt);
  // Boundary before the first period wraps around from the last one.
  const first = times[0];
  const last = times[times.length - 1];
  const wrapBoundary = ((last.min + first.min + 24 * 60) / 2) % (24 * 60);
  if (m < wrapBoundary && wrapBoundary <= first.min) return last.key;
  for (let i = 0; i < times.length; i++) {
    const next = times[i + 1];
    if (!next) return times[i].key;
    const boundary = (times[i].min + next.min) / 2;
    if (m < boundary) return times[i].key;
  }
  return last.key;
}

function newGroup(key, label) {
  return {
    key,
    label,
    tasks: 0,
    completed: 0,
    open: 0,
    snoozes: 0,
    deferrals: 0,
    alerts: 0,
    friction: 0,
    perTask: 0,
    snoozesPerTask: 0,
    snoozedTasks: 0,
    snoozedShare: 0,
    completionRate: 0,
    firstAlertDone: 0,
    alertedDone: 0,
    maxLevel: 0,
    medianLatenessMs: null,
    classification: 'easy',
    _lateness: [],
  };
}

function addToGroup(g, task) {
  g.tasks += 1;
  if (task.state === 'done') {
    g.completed += 1;
    g._lateness.push(task.completedAt - task.dueAt);
    if ((task.alertCount || 0) > 0) {
      g.alertedDone += 1;
      if (!(task.snoozeCount || 0) && !(task.deferCount || 0)) g.firstAlertDone += 1;
    }
  } else {
    g.open += 1;
  }
  g.snoozes += task.snoozeCount || 0;
  g.deferrals += task.deferCount || 0;
  g.alerts += task.alertCount || 0;
  g.friction += taskFriction(task);
  if ((task.snoozeCount || 0) + (task.deferCount || 0) > 0) g.snoozedTasks += 1;
  g.maxLevel = Math.max(g.maxLevel, task.maxLevel || 0);
}

function finalizeGroup(g) {
  g.perTask = g.tasks ? g.friction / g.tasks : 0;
  g.snoozesPerTask = g.tasks ? g.snoozes / g.tasks : 0;
  g.snoozedShare = g.tasks ? g.snoozedTasks / g.tasks : 0;
  g.completionRate = g.tasks ? g.completed / g.tasks : 0;
  g.firstAlertRate = g.alertedDone ? g.firstAlertDone / g.alertedDone : null;
  g.medianLatenessMs = median(g._lateness);
  g.classification = classify(g.perTask);
  delete g._lateness;
  return g;
}

function byFrictionDesc(a, b) {
  return (b.perTask - a.perTask) || (b.snoozes - a.snoozes) || (b.tasks - a.tasks) || a.key.localeCompare(b.key);
}

function byFrictionAsc(a, b) {
  return (a.perTask - b.perTask) || (a.snoozes - b.snoozes) || (b.tasks - a.tasks) || a.key.localeCompare(b.key);
}

function fmt(n, digits = 1) {
  return Number(n.toFixed(digits)).toString();
}

function buildInsights({ byCategory, bySpoons, byPeriod, totals }) {
  const insights = [];
  const informativeCats = byCategory.filter((g) => g.tasks > 0);
  if (informativeCats.length >= 2) {
    const hardest = informativeCats[0];
    const easiest = informativeCats[informativeCats.length - 1];
    if (hardest.perTask > 0 && hardest.key !== easiest.key) {
      const ratio = easiest.perTask > 0 ? hardest.perTask / easiest.perTask : null;
      insights.push(
        `${cap(hardest.label)} tasks pick up ${fmt(hardest.perTask)} friction each` +
        (ratio && ratio >= 1.5 ? `, ${fmt(ratio)}× your easiest type (${easiest.label}).` : `; ${easiest.label} tasks pick up ${fmt(easiest.perTask)}.`)
      );
    }
  }
  const small = bySpoons.filter((g) => g.key <= 2 && g.tasks > 0);
  const big = bySpoons.filter((g) => g.key >= 4 && g.tasks > 0);
  const avg = (groups) => {
    const tasks = groups.reduce((n, g) => n + g.tasks, 0);
    const friction = groups.reduce((n, g) => n + g.friction, 0);
    return tasks ? friction / tasks : null;
  };
  const smallAvg = avg(small);
  const bigAvg = avg(big);
  if (smallAvg !== null && bigAvg !== null && (smallAvg > 0 || bigAvg > 0)) {
    if (bigAvg >= smallAvg * 1.5 && bigAvg >= 1) {
      insights.push(`Big tasks (4–5 spoons) gather ${fmt(bigAvg)} friction each versus ${fmt(smallAvg)} for small ones. Splitting them into smaller anchors may help.`);
    } else if (smallAvg >= bigAvg * 1.5 && smallAvg >= 1) {
      insights.push(`Small tasks (1–2 spoons) gather more friction (${fmt(smallAvg)}) than big ones (${fmt(bigAvg)}). They may be boring rather than hard.`);
    }
  }
  const periodsWithSnoozes = byPeriod.filter((g) => g.snoozes > 0).sort((a, b) => b.snoozes - a.snoozes);
  if (periodsWithSnoozes.length && totals.snoozes > 0) {
    const top = periodsWithSnoozes[0];
    const share = top.snoozes / totals.snoozes;
    if (share >= 0.4 && periodsWithSnoozes.length > 1) {
      insights.push(`${Math.round(share * 100)}% of your snoozes land on ${top.label.toLowerCase()} tasks.`);
    }
  }
  if (totals.deferrals > 0) {
    const topDefer = [...informativeCats].sort((a, b) => (b.deferrals - a.deferrals) || a.key.localeCompare(b.key))[0];
    if (topDefer && topDefer.deferrals > 0) {
      insights.push(`Out of spoons pressed ${totals.deferrals}× so far, most often on ${topDefer.label} tasks (${topDefer.deferrals}×).`);
    }
  }
  if (totals.alertedDone > 0 && totals.firstAlertRate !== null) {
    insights.push(`${Math.round(totals.firstAlertRate * 100)}% of alerted tasks were finished on the first alert without snoozing.`);
  }
  return insights;
}

function cap(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * Analyze the task history. Returns overview totals, per-type breakdowns
 * (category, spoon size, part of day), easiest/hardest rankings and
 * plain-language insights.
 */
export function analyze(tasks, { now = Date.now(), settings } = {}) {
  const s = normalizeSettings(settings);
  const all = Array.isArray(tasks) ? tasks : [];
  const informative = all.filter(isInformative);

  const categories = new Map();
  const spoons = new Map();
  for (let n = MIN_SPOONS; n <= MAX_SPOONS; n++) spoons.set(n, newGroup(n, `${n} spoon${n === 1 ? '' : 's'}`));
  const periods = new Map(PERIODS.map((p) => [p.key, newGroup(p.key, p.label)]));

  for (const task of informative) {
    const catKey = task.category || 'other';
    if (!categories.has(catKey)) categories.set(catKey, newGroup(catKey, catKey));
    addToGroup(categories.get(catKey), task);
    addToGroup(spoons.get(task.spoons) || spoons.get(2), task);
    addToGroup(periods.get(periodOfTask(task, s)), task);
  }

  const byCategory = [...categories.values()].map(finalizeGroup).sort(byFrictionDesc);
  const bySpoons = [...spoons.values()].map(finalizeGroup);
  const byPeriod = [...periods.values()].map(finalizeGroup);

  const overall = finalizeGroup(all.reduce((g, t) => (addToGroup(g, t), g), newGroup('all', 'All tasks')));
  const informativeGroup = finalizeGroup(informative.reduce((g, t) => (addToGroup(g, t), g), newGroup('informative', 'Informative')));

  const totals = {
    tasks: all.length,
    informative: informative.length,
    completed: overall.completed,
    open: overall.open,
    completionRate: overall.completionRate,
    snoozes: overall.snoozes,
    deferrals: overall.deferrals,
    alerts: overall.alerts,
    friction: overall.friction,
    perTask: informativeGroup.perTask,
    snoozesPerTask: informativeGroup.snoozesPerTask,
    snoozedShare: informativeGroup.snoozedShare,
    alertedDone: overall.alertedDone,
    firstAlertDone: overall.firstAlertDone,
    firstAlertRate: overall.firstAlertRate,
    medianLatenessMs: overall.medianLatenessMs,
    maxLevel: overall.maxLevel,
  };

  const ranked = byCategory.filter((g) => g.tasks > 0);
  const hardest = [...ranked].sort(byFrictionDesc).filter((g) => g.perTask > 0).slice(0, 3);
  const easiest = ranked.length >= 2 ? [...ranked].sort(byFrictionAsc).slice(0, 3) : [];

  return {
    generatedAt: now,
    totals,
    byCategory,
    bySpoons,
    byPeriod,
    easiest,
    hardest,
    insights: buildInsights({ byCategory, bySpoons, byPeriod, totals }),
  };
}

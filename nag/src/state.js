// The app store: owns the task list and settings, applies state-machine
// transitions, runs the scheduler tick, persists after every change and
// notifies subscribers with a change record.

import { createTask, updateTaskFields, normalizeSettings, computeDueAt } from './model.js';
import { fire, complete, snooze, defer } from './machine.js';
import { dueTaskIds, alertQueue, upcoming, completed, nextFireTime, nativeSchedule } from './scheduler.js';
import { SCHEMA_VERSION, normalizeSnapshot } from './persist.js';

export class AppStore {
  constructor({ storage = null, clock = { now: () => Date.now() } } = {}) {
    this.storage = storage;
    this.clock = clock;
    this.listeners = new Set();
    const snap = storage ? storage.load() : null;
    this.tasks = snap ? snap.tasks : [];
    this.settings = normalizeSettings(snap ? snap.settings : null);
  }

  now() {
    return this.clock.now();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  snapshot() {
    return { version: SCHEMA_VERSION, tasks: this.tasks, settings: this.settings };
  }

  emit(change) {
    for (const fn of [...this.listeners]) fn(change, this);
  }

  commit(change) {
    if (this.storage) this.storage.save(this.snapshot());
    this.emit(change);
  }

  getTask(id) {
    return this.tasks.find((t) => t.id === id) || null;
  }

  requireTask(id) {
    const t = this.getTask(id);
    if (!t) throw new Error(`No task with id ${id}`);
    return t;
  }

  replaceTask(next) {
    this.tasks = this.tasks.map((t) => (t.id === next.id ? next : t));
    return next;
  }

  addTask(input) {
    const task = createTask(input, { now: this.now(), settings: this.settings });
    this.tasks = [...this.tasks, task];
    this.commit({ type: 'add', ids: [task.id] });
    return task;
  }

  updateTask(id, input) {
    const next = this.replaceTask(updateTaskFields(this.requireTask(id), input, { now: this.now(), settings: this.settings }));
    this.commit({ type: 'update', ids: [id] });
    return next;
  }

  deleteTask(id) {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.id !== id);
    if (this.tasks.length !== before) this.commit({ type: 'delete', ids: [id] });
  }

  complete(id) {
    const next = this.replaceTask(complete(this.requireTask(id), this.now()));
    this.commit({ type: 'complete', ids: [id] });
    return next;
  }

  snooze(id, minutes) {
    const next = this.replaceTask(snooze(this.requireTask(id), minutes, this.now()));
    this.commit({ type: 'snooze', ids: [id], minutes });
    return next;
  }

  defer(id, key) {
    const next = this.replaceTask(defer(this.requireTask(id), key, this.now(), this.settings));
    this.commit({ type: 'defer', ids: [id], key });
    return next;
  }

  /** Fire every task whose time has come. Returns the ids fired. */
  tick(now = this.now()) {
    const ids = dueTaskIds(this.tasks, now);
    if (!ids.length) return [];
    const set = new Set(ids);
    this.tasks = this.tasks.map((t) => (set.has(t.id) ? fire(t, now) : t));
    this.commit({ type: 'fire', ids });
    return ids;
  }

  alertQueue() {
    return alertQueue(this.tasks);
  }

  currentAlert() {
    return this.alertQueue()[0] || null;
  }

  upcoming() {
    return upcoming(this.tasks);
  }

  completed() {
    return completed(this.tasks);
  }

  nextFireTime() {
    return nextFireTime(this.tasks);
  }

  nativeSchedule() {
    return nativeSchedule(this.tasks);
  }

  /** Update settings; tasks still waiting on their original anchor pick up new period times. */
  setSettings(partial) {
    const merged = normalizeSettings(partial, this.settings);
    this.settings = merged;
    this.tasks = this.tasks.map((t) => {
      if (t.state !== 'scheduled' || t.anchor.kind !== 'fuzzy') return t;
      const dueAt = computeDueAt(t.anchor, merged);
      return dueAt === t.dueAt ? t : { ...t, dueAt, nextFireAt: dueAt };
    });
    this.commit({ type: 'settings' });
    return merged;
  }

  /** Replace everything with an imported snapshot (object or JSON-parsed value). */
  importSnapshot(parsed) {
    const snap = normalizeSnapshot(parsed);
    if (!snap) throw new Error('That file does not contain Nag data.');
    this.tasks = snap.tasks;
    this.settings = snap.settings;
    this.commit({ type: 'import' });
    return snap;
  }

  /** Forget everything, leaving storage as empty as a fresh install. */
  clearAll() {
    this.tasks = [];
    this.settings = normalizeSettings(null);
    if (this.storage) this.storage.clear();
    this.emit({ type: 'clear' });
  }
}

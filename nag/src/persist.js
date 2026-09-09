// Local persistence: localStorage when available, memory otherwise.
// Every loaded task is sanitized so a corrupted or hand-edited store can never
// crash the app; bad entries are dropped rather than repaired in surprising ways.

import { STATES, validateAnchor, isValidSpoons, DEFAULT_SPOONS, normalizeSettings } from './model.js';

export const STORAGE_KEY = 'nag.v1';
export const SCHEMA_VERSION = 1;

export function memoryBackend() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

/** localStorage if it exists and is writable (private mode can throw), else memory. */
export function detectBackend() {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) {
      const probe = '__nag_probe__';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return { backend: localStorage, persistent: true };
    }
  } catch (err) {
    // fall through to memory
  }
  return { backend: memoryBackend(), persistent: false };
}

function finite(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function finiteOrNull(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

/** Return a clean task or null when the record is unusable. */
export function sanitizeTask(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id : null;
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!id || !title) return null;
  if (!STATES.includes(raw.state)) return null;
  const { errors, anchor } = validateAnchor(raw.anchor);
  if (Object.keys(errors).length) return null;
  const dueAt = finiteOrNull(raw.dueAt);
  if (dueAt === null) return null;
  const createdAt = finite(raw.createdAt, dueAt);
  const spoons = isValidSpoons(Number(raw.spoons)) ? Number(raw.spoons) : DEFAULT_SPOONS;
  const category = typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim().toLowerCase() : 'other';
  const state = raw.state;

  let nextFireAt = finiteOrNull(raw.nextFireAt);
  if (state === 'scheduled' && nextFireAt === null) nextFireAt = dueAt;
  if ((state === 'snoozed' || state === 'deferred') && nextFireAt === null) nextFireAt = dueAt;
  if (state === 'alerting' || state === 'done') nextFireAt = null;

  const completedAt = state === 'done' ? finite(raw.completedAt, dueAt) : null;
  const lastSnooze = finiteOrNull(raw.lastSnoozeMinutes);

  return {
    id,
    title,
    category,
    spoons,
    anchor,
    dueAt,
    createdAt,
    state,
    level: Math.max(0, Math.floor(finite(raw.level))),
    nextFireAt,
    alertedAt: state === 'alerting' ? finite(raw.alertedAt, dueAt) : null,
    completedAt,
    snoozeCount: Math.max(0, Math.floor(finite(raw.snoozeCount))),
    deferCount: Math.max(0, Math.floor(finite(raw.deferCount))),
    alertCount: Math.max(0, Math.floor(finite(raw.alertCount))),
    maxLevel: Math.max(0, Math.floor(finite(raw.maxLevel))),
    lastSnoozeMinutes: lastSnooze !== null && lastSnooze >= 1 ? lastSnooze : null,
    events: Array.isArray(raw.events) ? raw.events.filter((e) => e && typeof e === 'object' && typeof e.type === 'string') : [],
  };
}

/** Parse stored JSON into a valid snapshot; returns null when nothing usable is there. */
export function deserialize(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return null;
  }
  return normalizeSnapshot(parsed);
}

/** Accept any object shaped roughly like a snapshot (or a bare task array). */
export function normalizeSnapshot(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const rawTasks = Array.isArray(parsed) ? parsed : Array.isArray(parsed.tasks) ? parsed.tasks : [];
  const seen = new Set();
  const tasks = [];
  for (const raw of rawTasks) {
    const t = sanitizeTask(raw);
    if (t && !seen.has(t.id)) {
      seen.add(t.id);
      tasks.push(t);
    }
  }
  return {
    version: SCHEMA_VERSION,
    tasks,
    settings: normalizeSettings(Array.isArray(parsed) ? null : parsed.settings),
  };
}

export function serialize(snapshot) {
  return JSON.stringify({
    version: SCHEMA_VERSION,
    savedAt: Date.now(),
    tasks: snapshot.tasks,
    settings: snapshot.settings,
  });
}

export function createStorage({ backend, persistent, key = STORAGE_KEY } = {}) {
  let resolved = backend ? { backend, persistent: persistent !== false } : detectBackend();
  return {
    key,
    persistent: resolved.persistent,
    load() {
      try {
        return deserialize(resolved.backend.getItem(key));
      } catch (err) {
        return null;
      }
    },
    save(snapshot) {
      try {
        resolved.backend.setItem(key, serialize(snapshot));
        return true;
      } catch (err) {
        return false;
      }
    },
    clear() {
      try {
        resolved.backend.removeItem(key);
      } catch (err) {
        // ignore
      }
    },
  };
}

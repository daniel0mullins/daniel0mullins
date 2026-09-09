// UI wiring. Everything stateful lives in the AppStore; this module renders
// it, routes clicks back into it, runs the one-second scheduler tick, and
// drives the alert dialog and the time-simulation controls.

import { AppStore } from './state.js';
import { createStorage } from './persist.js';
import {
  PERIODS, CATEGORIES, DEFAULT_SPOONS, MIN_SPOONS, MAX_SPOONS,
  anchorLabel, spoonsLabel, computeDueAt, ValidationError,
} from './model.js';
import { snoozeOptions, snoozeMinutes, deferralOptions, urgency, BASE_MINUTES } from './snooze.js';
import { analyze, CLASS_LABELS, THRESHOLDS, FRICTION_WEIGHTS } from './analytics.js';
import { buildDemo } from './demo.js';
import { createNotifier } from './notify.js';
import {
  formatWhen, formatTime, formatDay, formatRelative, formatDuration, formatLateness,
  toDateInput, toClockInput, MINUTE, SECOND,
} from './time.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SPOON_HINTS = {
  1: 'Tiny. Barely any energy.',
  2: 'Moderate. A normal task. This is the default.',
  3: 'Effortful. Needs a run-up.',
  4: 'Heavy. Plan the day around it.',
  5: 'Huge. The whole tank.',
};

const CLASS_ICONS = { easy: '✓', sticky: '◐', hard: '✕' };

// The app clock: real time plus a simulation offset (prototype control).
const clock = {
  offset: 0,
  now() {
    return Date.now() + this.offset;
  },
};

const storage = createStorage();
const store = new AppStore({ storage, clock });
const notifier = createNotifier(() => store.settings);

const ui = {
  view: 'tasks',
  form: { editingId: null, kind: 'exact', period: 'morning', spoons: DEFAULT_SPOONS },
  alert: { id: null, level: -1, shownAt: 0, lastNagAt: 0, oosOpen: false },
  lastRenderMinute: null,
};

let toastTimer = null;

// ---------------------------------------------------------------- helpers

function toast(message, ms = 4000) {
  const node = $('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, ms);
}

function spoonDots(n) {
  return `<span class="dots" aria-hidden="true">${'●'.repeat(n)}${'○'.repeat(MAX_SPOONS - n)}</span>`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function frictionSummary(t) {
  const parts = [t.snoozeCount ? plural(t.snoozeCount, 'snooze') : 'no snoozes'];
  if (t.deferCount) parts.push(`${t.deferCount}× out of spoons`);
  return parts.join(', ');
}

function pct(x) {
  return `${Math.round(x * 100)}%`;
}

function fmt1(x) {
  return Number(x.toFixed(1)).toString();
}

function statusText(t, now) {
  switch (t.state) {
    case 'scheduled':
      return t.nextFireAt <= now ? 'Due now' : `Due ${formatRelative(t.nextFireAt, now)}`;
    case 'alerting':
      return `Nagging now · ${urgency(t.level).tier}${t.snoozeCount ? ` · snoozed ${t.snoozeCount}×` : ''}`;
    case 'snoozed':
      return `Snoozed until ${formatTime(t.nextFireAt)} (${formatRelative(t.nextFireAt, now)}) · ${t.snoozeCount}× so far`;
    case 'deferred':
      return `Out of spoons · back ${formatWhen(t.nextFireAt, now)}`;
    case 'done':
      return `Done ${formatDay(t.completedAt, now)} ${formatTime(t.completedAt)} · ${frictionSummary(t)}`;
    default:
      return '';
  }
}

// ---------------------------------------------------------------- routing

const MAIN_VIEWS = ['tasks', 'dashboard', 'settings'];

function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  if (hash === 'new') {
    openForm(null);
    return;
  }
  if (hash.startsWith('edit/')) {
    const task = store.getTask(decodeURIComponent(hash.slice(5)));
    if (task && task.state !== 'done') {
      openForm(task);
      return;
    }
    location.replace('#tasks');
    return;
  }
  showView(MAIN_VIEWS.includes(hash) ? hash : 'tasks');
}

function showView(name) {
  ui.view = name;
  for (const section of document.querySelectorAll('.view')) section.hidden = section.dataset.view !== name;
  for (const tab of document.querySelectorAll('.tab')) {
    if (tab.dataset.view === name) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  window.scrollTo(0, 0);
  render();
}

// ---------------------------------------------------------------- rendering

function render() {
  const now = store.now();
  if (ui.view === 'tasks') renderTasks(now);
  else if (ui.view === 'dashboard') renderDashboard(now);
  else if (ui.view === 'settings') renderSettings();
  renderSimBanner(now);
  syncAlert(now);
  pushNativeSchedule();
  ui.lastRenderMinute = Math.floor(now / MINUTE);
}

function taskCard(t, now) {
  const u = t.state === 'alerting' ? urgency(t.level) : null;
  const open = t.state !== 'done';
  return `<li class="task state-${t.state}${u ? ` tier-${u.tier}` : ''}" data-id="${esc(t.id)}">
    <div class="task-body">
      <p class="task-title">${esc(t.title)}</p>
      <p class="task-meta">
        <span class="chip">${esc(t.category)}</span>
        <span class="spoons" role="img" aria-label="${esc(spoonsLabel(t.spoons))}">${spoonDots(t.spoons)}</span>
        <span class="anchor">${esc(formatDay(t.dueAt, now))} · ${esc(anchorLabel(t.anchor))}</span>
      </p>
      <p class="task-status">${esc(statusText(t, now))}</p>
    </div>
    <div class="task-actions">
      ${open ? `<button type="button" class="btn small done" data-action="complete" data-id="${esc(t.id)}">Done</button>` : ''}
      ${open ? `<a class="btn small ghost" href="#edit/${encodeURIComponent(t.id)}">Edit</a>` : ''}
      <button type="button" class="btn small ghost" data-action="delete" data-id="${esc(t.id)}" aria-label="Delete ${esc(t.title)}">Delete</button>
    </div>
  </li>`;
}

function renderTasks(now) {
  const alerting = store.alertQueue();
  const next = store.upcoming();
  const done = store.completed();
  const open = alerting.length + next.length;
  const dayName = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(now));
  $('today-sub').textContent = `${dayName} · ${open ? plural(open, 'open task') : 'nothing open'}`;

  $('group-now').hidden = alerting.length === 0;
  $('list-now').innerHTML = alerting.map((t) => taskCard(t, now)).join('');

  $('list-next').innerHTML = next.map((t) => taskCard(t, now)).join('');
  $('empty-next').hidden = next.length > 0 || alerting.length > 0;

  $('done-count').textContent = String(done.length);
  $('list-done').innerHTML = done.map((t) => taskCard(t, now)).join('');
  $('empty-done').hidden = done.length > 0;

  $('sim-next').disabled = store.nextFireTime() === null;
}

function renderSimBanner(now) {
  const banner = $('sim-banner');
  banner.hidden = clock.offset === 0;
  if (clock.offset !== 0) {
    $('sim-banner-text').textContent = `Simulated clock: ${formatDuration(clock.offset / MINUTE)} ahead · now ${formatWhen(now, Date.now())}`;
  }
}

// ---- dashboard

function tile(label, value, sub) {
  return `<div class="kpi"><p class="kpi-label">${esc(label)}</p><p class="kpi-value">${esc(value)}</p><p class="kpi-sub">${esc(sub)}</p></div>`;
}

function badge(cls) {
  return `<span class="badge badge-${cls}"><span aria-hidden="true">${CLASS_ICONS[cls]}</span>${CLASS_LABELS[cls]}</span>`;
}

function meter(value, max, cls) {
  const width = value <= 0 ? 0 : Math.max(2, Math.round((value / max) * 100));
  return `<div class="meter track-${cls}" role="img" aria-label="Friction ${fmt1(value)} per task"><div class="meter-fill meter-${cls}" style="width:${width}%"></div></div>`;
}

function rankItem(g, max) {
  const detail = [
    `${plural(g.snoozes, 'snooze')} across ${plural(g.tasks, 'task')}`,
    `${fmt1(g.perTask)} friction per task`,
    `${pct(g.snoozedShare)} needed a snooze`,
  ];
  if (g.deferrals) detail.push(`${g.deferrals}× out of spoons`);
  return `<li class="rank">
    <div class="rank-head"><span class="rank-name">${esc(g.label)}</span>${badge(g.classification)}</div>
    <p class="rank-detail">${esc(detail.join(' · '))}</p>
    ${meter(g.perTask, max, g.classification)}
  </li>`;
}

function groupTable(groups, firstHeader, max) {
  const head = `<thead><tr>
    <th scope="col">${esc(firstHeader)}</th>
    <th scope="col" class="num">Tasks</th>
    <th scope="col" class="num">Done</th>
    <th scope="col" class="num">Snoozes</th>
    <th scope="col" class="num">Per task</th>
    <th scope="col" class="num">Snoozed</th>
    <th scope="col" class="num">Out of spoons</th>
    <th scope="col" class="num">Peak level</th>
    <th scope="col">Friction</th>
    <th scope="col">Verdict</th>
  </tr></thead>`;
  const rows = groups.map((g) => {
    if (!g.tasks) {
      return `<tr class="zero"><td class="name">${esc(g.label)}</td><td class="num">0</td><td class="num">–</td><td class="num">–</td><td class="num">–</td><td class="num">–</td><td class="num">–</td><td class="num">–</td><td>–</td><td>–</td></tr>`;
    }
    return `<tr>
      <td class="name">${esc(g.label)}</td>
      <td class="num">${g.tasks}</td>
      <td class="num">${g.completed}</td>
      <td class="num">${g.snoozes}</td>
      <td class="num">${fmt1(g.snoozesPerTask)}</td>
      <td class="num">${pct(g.snoozedShare)}</td>
      <td class="num">${g.deferrals}</td>
      <td class="num">${g.maxLevel}</td>
      <td>${meter(g.perTask, max, g.classification)}<span>${fmt1(g.perTask)}</span></td>
      <td>${badge(g.classification)}</td>
    </tr>`;
  }).join('');
  return `${head}<tbody>${rows}</tbody>`;
}

function renderDashboard(now) {
  const report = analyze(store.tasks, { now, settings: store.settings });
  const hasData = report.totals.informative > 0;
  $('dash-empty').hidden = hasData;
  $('dash-content').hidden = !hasData;
  if (!hasData) return;

  const t = report.totals;
  $('kpis').innerHTML = [
    tile('Completed', String(t.completed), `of ${plural(t.tasks, 'task')}`),
    tile('Completion rate', pct(t.completionRate), 'all tasks so far'),
    tile('Snoozes', String(t.snoozes), `${fmt1(t.snoozesPerTask)} per task`),
    tile('Out of spoons', String(t.deferrals), 'panic button presses'),
    tile('Done on first alert', t.firstAlertRate === null ? '–' : pct(t.firstAlertRate), 'no snooze needed'),
    tile('Typical lateness', t.medianLatenessMs === null ? '–' : formatLateness(t.medianLatenessMs), 'median, completed tasks'),
  ].join('');

  const max = Math.max(1, ...report.byCategory.map((g) => g.perTask), ...report.bySpoons.map((g) => g.perTask), ...report.byPeriod.map((g) => g.perTask));
  $('hardest').innerHTML = report.hardest.length
    ? report.hardest.map((g) => rankItem(g, max)).join('')
    : '<li class="muted">Nothing has been snoozed yet.</li>';
  $('easiest').innerHTML = report.easiest.length
    ? report.easiest.map((g) => rankItem(g, max)).join('')
    : '<li class="muted">Needs at least two types to compare.</li>';
  $('insights').innerHTML = report.insights.length
    ? report.insights.map((s) => `<li>${esc(s)}</li>`).join('')
    : '<li class="muted">More history needed before patterns show.</li>';
  $('table-category').innerHTML = groupTable(report.byCategory, 'Type', max);
  $('table-spoons').innerHTML = groupTable(report.bySpoons, 'Spoons', max);
  $('table-period').innerHTML = groupTable(report.byPeriod, 'Part of day', max);
  $('dash-method').textContent = `Friction per task = (snoozes × ${FRICTION_WEIGHTS.snooze} + out-of-spoons × ${FRICTION_WEIGHTS.deferral}) ÷ tasks. Under ${THRESHOLDS.easy} is easy, up to ${THRESHOLDS.hard} is sticky, above ${THRESHOLDS.hard} is hard. Only tasks that have alerted at least once or been completed are counted.`;
}

// ---- settings

function renderSettings() {
  const s = store.settings;
  $('period-settings').innerHTML = PERIODS.map((p) => `<div class="setting">
      <label class="sublabel" for="s-period-${p.key}">${esc(p.label)}</label>
      <input class="input" type="time" id="s-period-${p.key}" data-period="${p.key}" value="${esc(s.periods[p.key])}">
    </div>`).join('');
  $('s-daystart').value = s.dayStart;
  $('s-weekstart').value = String(s.weekStartsOn);
  $('s-sound').checked = s.sound;
  $('s-vibrate').checked = s.vibrate;
  $('s-nag').value = String(s.nagEverySeconds);

  const perm = notifier.permission();
  $('notif-status').textContent = {
    granted: 'Enabled. Alerts also appear as system notifications while this tab is in the background.',
    denied: 'Blocked. Allow notifications for this site in the browser settings.',
    default: 'Not enabled yet.',
    unsupported: 'Not supported in this browser.',
  }[perm] || '';
  $('notif-enable').disabled = perm !== 'default';

  $('storage-status').textContent = storage.persistent
    ? `Saved in this browser's local storage. ${plural(store.tasks.length, 'task')} stored.`
    : 'This browser blocks local storage, so data lives in memory only and is lost on reload.';

  const levels = [0, 1, 2, 3];
  $('table-policy').innerHTML = `<thead><tr><th scope="col">Spoons</th><th scope="col">First alert</th>${levels.slice(1).map((l) => `<th scope="col">After ${l} snooze${l === 1 ? '' : 's'}</th>`).join('')}</tr></thead>
    <tbody>${Array.from({ length: MAX_SPOONS - MIN_SPOONS + 1 }, (_, i) => i + MIN_SPOONS).map((n) => `<tr>
      <td class="name">${n} ${spoonDots(n)}</td>
      ${levels.map((l) => `<td>${snoozeMinutes(n, l).map(formatDuration).join(' / ')}</td>`).join('')}
    </tr>`).join('')}</tbody>`;
}

function readSettingsForm() {
  const partial = {
    periods: {},
    dayStart: $('s-daystart').value,
    weekStartsOn: Number($('s-weekstart').value),
    sound: $('s-sound').checked,
    vibrate: $('s-vibrate').checked,
    nagEverySeconds: Number($('s-nag').value),
  };
  for (const p of PERIODS) partial.periods[p.key] = $(`s-period-${p.key}`).value;
  return partial;
}

// ---------------------------------------------------------------- the alert

function pulse() {
  const dialog = $('alert');
  dialog.classList.remove('pulse');
  // Force a reflow so the shake animation restarts.
  void dialog.offsetWidth;
  dialog.classList.add('pulse');
  setTimeout(() => dialog.classList.remove('pulse'), 700);
}

function renderAlert(task, now) {
  const u = urgency(task.level);
  const dialog = $('alert');
  dialog.className = `alert tier-${u.tier}`;
  $('alert-kicker').textContent = `Alert ${task.alertCount} · ${u.tier}`;
  $('alert-heading').textContent = u.heading;
  $('alert-task').textContent = task.title;
  const late = now - task.dueAt;
  $('alert-meta').textContent = [
    task.category,
    spoonsLabel(task.spoons),
    `anchored ${formatWhen(task.dueAt, now)}`,
    late >= MINUTE ? `${formatDuration(late / MINUTE)} past it` : 'right on time',
  ].join(' · ');
  $('alert-sub').textContent = u.sub;

  const options = snoozeOptions(task);
  $('snooze-row').innerHTML = options.map((o) => `<button type="button" class="btn snooze" data-alert="snooze" data-minutes="${o.minutes}" aria-label="Snooze ${esc(o.label)}">${esc(o.label)}</button>`).join('');
  $('snooze-note').textContent = task.lastSnoozeMinutes
    ? `Shorter than your last snooze (${formatDuration(task.lastSnoozeMinutes)}). It keeps shrinking until you answer.`
    : `Windows for a ${spoonsLabel(task.spoons)} task. Every snooze makes the next one shorter.`;

  const deferrals = deferralOptions(now, store.settings);
  $('oos-row').innerHTML = deferrals.map((o) => `<button type="button" class="btn oos" data-alert="defer" data-key="${o.key}">
      <strong>${esc(o.label)}</strong>
      <span>${esc(o.hint)} · ${esc(formatWhen(o.until, now))}</span>
    </button>`).join('');
  $('oos-block').hidden = !ui.alert.oosOpen;
  $('alert-oos').hidden = ui.alert.oosOpen;
  $('snooze-block').hidden = ui.alert.oosOpen;

  const waiting = store.alertQueue().length - 1;
  $('alert-queue').hidden = waiting <= 0;
  $('alert-queue').textContent = waiting > 0 ? `${plural(waiting, 'more alert')} waiting behind this one.` : '';
  renderAlertWait();
}

function renderAlertWait() {
  if (!ui.alert.id) return;
  const waited = Date.now() - ui.alert.shownAt;
  $('alert-wait').textContent = waited >= 60 * SECOND ? `Waiting ${formatDuration(waited / MINUTE)} for an answer.` : '';
}

function syncAlert(now) {
  const dialog = $('alert');
  const current = store.currentAlert();
  if (!current) {
    if (ui.alert.id) {
      ui.alert = { id: null, level: -1, shownAt: 0, lastNagAt: 0, oosOpen: false };
      notifier.stop();
    }
    document.body.classList.remove('alerting');
    if (dialog.open) dialog.close();
    return;
  }
  const isNew = current.id !== ui.alert.id || current.level !== ui.alert.level;
  if (isNew) {
    ui.alert = { id: current.id, level: current.level, shownAt: Date.now(), lastNagAt: Date.now(), oosOpen: false };
  }
  renderAlert(current, now);
  document.body.classList.add('alerting');
  if (!dialog.open) {
    try {
      dialog.showModal();
    } catch (err) {
      dialog.setAttribute('open', '');
    }
  }
  if (isNew) {
    notifier.alert(current, urgency(current.level));
    pulse();
  }
}

function answerAlert(action, target) {
  const task = store.currentAlert();
  if (!task) return;
  const now = store.now();
  notifier.unlock();
  try {
    if (action === 'complete') {
      const done = store.complete(task.id);
      toast(`Done. Logged with ${frictionSummary(done)}.`);
    } else if (action === 'snooze') {
      const minutes = Number(target.dataset.minutes);
      const next = store.snooze(task.id, minutes);
      toast(`Snoozed ${formatDuration(minutes)}. Back at ${formatTime(next.nextFireAt)}, and shorter next time.`);
    } else if (action === 'defer') {
      const next = store.defer(task.id, target.dataset.key);
      toast(`Parked. It comes back ${formatWhen(next.nextFireAt, now)}.`);
    } else if (action === 'oos') {
      ui.alert.oosOpen = true;
      renderAlert(task, now);
      const first = $('oos-row').querySelector('button');
      if (first) first.focus();
    } else if (action === 'oos-back') {
      ui.alert.oosOpen = false;
      renderAlert(task, now);
      $('alert-oos').focus();
    }
  } catch (err) {
    toast(err.message || 'Something went wrong.');
    render();
  }
}

// ---------------------------------------------------------------- the form

function suggestTime(now) {
  const d = new Date(now + 20 * MINUTE);
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
  return toClockInput(d.getTime());
}

function suggestPeriod(now) {
  const h = new Date(now).getHours();
  if (h < 11) return 'morning';
  if (h < 14) return 'midday';
  if (h < 17) return 'afternoon';
  if (h < 20) return 'evening';
  return 'night';
}

function openForm(task) {
  const now = store.now();
  ui.form.editingId = task ? task.id : null;
  ui.form.kind = task ? task.anchor.kind : 'exact';
  ui.form.period = task && task.anchor.kind === 'fuzzy' ? task.anchor.period : suggestPeriod(now);
  ui.form.spoons = task ? task.spoons : DEFAULT_SPOONS;

  $('form-title').textContent = task ? 'Edit task' : 'New task';
  $('form-submit').textContent = task ? 'Save changes' : 'Add task';
  $('f-title').value = task ? task.title : '';
  $('f-category').value = task ? task.category : '';
  $('f-date').value = task ? task.anchor.date : toDateInput(now);
  $('f-time').value = task && task.anchor.kind === 'exact' ? task.anchor.time : suggestTime(now);

  clearFormErrors();
  renderCategoryList();
  renderKindPicker();
  renderPeriodPicker();
  renderSpoonsPicker();
  updateAnchorPreview();
  showView('form');
  $('f-title').focus();
}

function renderCategoryList() {
  const set = new Set(CATEGORIES);
  for (const t of store.tasks) if (t.category) set.add(t.category);
  $('category-list').innerHTML = [...set].sort().map((c) => `<option value="${esc(c)}"></option>`).join('');
}

function renderKindPicker() {
  for (const b of $('kind-picker').querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.kind === ui.form.kind));
  $('anchor-exact').hidden = ui.form.kind !== 'exact';
  $('anchor-fuzzy').hidden = ui.form.kind !== 'fuzzy';
}

function renderPeriodPicker() {
  $('period-picker').innerHTML = PERIODS.map((p) => `<button type="button" role="radio" aria-checked="${ui.form.period === p.key}" data-period="${p.key}">
      <span class="choice-label">${esc(p.label)}</span>
      <span class="choice-hint">${esc(anchorLabel({ kind: 'exact', time: store.settings.periods[p.key] }))}</span>
    </button>`).join('');
}

function renderSpoonsPicker() {
  const sizes = Array.from({ length: MAX_SPOONS - MIN_SPOONS + 1 }, (_, i) => i + MIN_SPOONS);
  $('spoons-picker').innerHTML = sizes.map((n) => `<button type="button" role="radio" aria-checked="${ui.form.spoons === n}" data-spoons="${n}" aria-label="${esc(spoonsLabel(n))}">
      <span class="n">${n}</span>
      <span class="dots" aria-hidden="true">${'●'.repeat(n)}</span>
    </button>`).join('');
  $('spoons-hint').textContent = `${SPOON_HINTS[ui.form.spoons]} First snooze offered: ${formatDuration(BASE_MINUTES[ui.form.spoons])}.`;
}

function anchorFromForm() {
  return {
    date: $('f-date').value,
    kind: ui.form.kind,
    time: $('f-time').value,
    period: ui.form.period,
  };
}

function updateAnchorPreview() {
  const now = store.now();
  try {
    const dueAt = computeDueAt(anchorFromForm(), store.settings);
    $('anchor-preview').textContent = dueAt <= now
      ? `First nag: ${formatWhen(dueAt, now)}. That is already past, so it will nag immediately.`
      : `First nag: ${formatWhen(dueAt, now)} (${formatRelative(dueAt, now)}).`;
  } catch (err) {
    $('anchor-preview').textContent = '';
  }
}

const ERROR_FIELDS = {
  title: ['e-title', 'f-title'],
  category: ['e-category', 'f-category'],
  date: ['e-date', 'f-date'],
  time: ['e-time', 'f-time'],
  period: ['e-period', null],
  kind: ['e-period', null],
  spoons: ['e-spoons', null],
};

function clearFormErrors() {
  for (const [errId, inputId] of Object.values(ERROR_FIELDS)) {
    const err = $(errId);
    err.hidden = true;
    err.textContent = '';
    if (inputId) $(inputId).removeAttribute('aria-invalid');
  }
}

function showFormErrors(errors) {
  clearFormErrors();
  let focused = false;
  for (const [key, message] of Object.entries(errors)) {
    const spec = ERROR_FIELDS[key];
    if (!spec) continue;
    const [errId, inputId] = spec;
    $(errId).textContent = message;
    $(errId).hidden = false;
    if (inputId) {
      $(inputId).setAttribute('aria-invalid', 'true');
      if (!focused) {
        $(inputId).focus();
        focused = true;
      }
    }
  }
  if (!focused) $('form-submit').focus();
}

function submitForm(event) {
  event.preventDefault();
  const input = {
    title: $('f-title').value,
    category: $('f-category').value,
    spoons: ui.form.spoons,
    anchor: anchorFromForm(),
  };
  try {
    const task = ui.form.editingId ? store.updateTask(ui.form.editingId, input) : store.addTask(input);
    notifier.unlock();
    const now = store.now();
    const due = task.nextFireAt === null ? task.dueAt : task.nextFireAt;
    location.hash = '#tasks';
    if (task.state === 'alerting') toast('Saved.');
    else if (due <= now) toast('Saved. It is already due, so here comes the nag.');
    else toast(`Saved. First nag ${formatWhen(due, now)}.`);
    store.tick();
  } catch (err) {
    if (err instanceof ValidationError) showFormErrors(err.errors);
    else toast(err.message || 'Could not save that.');
  }
}

// ---------------------------------------------------------------- data actions

function loadDemo() {
  if (store.tasks.length && !window.confirm('Replace your current tasks with demo data?')) return;
  const { tasks } = buildDemo({ now: store.now(), settings: store.settings });
  store.importSnapshot({ tasks, settings: store.settings });
  toast(`Loaded ${plural(tasks.length, 'demo task')}. One is due in about a minute.`);
  location.hash = '#tasks';
}

function exportData() {
  const filename = `nag-${toDateInput(Date.now())}.json`;
  const json = JSON.stringify(store.snapshot(), null, 2);
  // Inside the claude.ai artifact viewer, downloads go through the viewer's
  // own save prompt; everywhere else a plain download link does the job.
  const viewer = window.claude && typeof window.claude.use === 'function'
    ? window.claude.use('downloads').catch(() => null)
    : Promise.resolve(null);
  viewer.then((downloads) => {
    if (downloads) {
      return downloads.save({ filename, data: json })
        .then(() => toast('Exported.'))
        .catch((err) => {
          if (!err || err.code !== 'declined') toast('Export did not go through.');
        });
    }
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return undefined;
  });
}

function importData(file) {
  if (!file) return;
  if (store.tasks.length && !window.confirm('Importing replaces your current tasks and settings. Continue?')) return;
  file.text().then((text) => {
    const snap = store.importSnapshot(JSON.parse(text));
    toast(`Imported ${plural(snap.tasks.length, 'task')}.`);
  }).catch((err) => toast(err.message || 'That file could not be read.'));
}

function eraseData() {
  if (!window.confirm('Erase every task, all history and your settings?')) return;
  store.clearAll();
  toast('Everything erased.');
}

// ---------------------------------------------------------------- simulation

function advanceClock(seconds) {
  clock.offset += seconds * SECOND;
  notifier.unlock();
  const fired = store.tick();
  if (!fired.length) render();
}

function jumpToNextAlert() {
  const t = store.nextFireTime();
  if (t === null) {
    toast('Nothing is waiting to alert.');
    return;
  }
  notifier.unlock();
  clock.offset = Math.max(clock.offset, t - Date.now() + SECOND);
  const fired = store.tick();
  if (!fired.length) render();
}

function resetClock() {
  clock.offset = 0;
  render();
  toast('Clock back to real time.');
}

// ---------------------------------------------------------------- native bridge

/**
 * A native wrapper (Capacitor, WKWebView) can expose window.NagNative with a
 * schedule(entries) function to mirror pending alerts into local notifications.
 */
function pushNativeSchedule() {
  const bridge = window.NagNative;
  if (!bridge || typeof bridge.schedule !== 'function') return;
  try {
    bridge.schedule(store.nativeSchedule());
  } catch (err) {
    console.warn('NagNative.schedule failed', err);
  }
}

// ---------------------------------------------------------------- tick

function tick() {
  const now = store.now();
  const fired = store.tick(now);
  if (!fired.length && ui.view === 'tasks' && Math.floor(now / MINUTE) !== ui.lastRenderMinute) {
    renderTasks(now);
    ui.lastRenderMinute = Math.floor(now / MINUTE);
  }
  if (ui.alert.id) {
    renderAlertWait();
    const every = store.settings.nagEverySeconds * SECOND;
    if (Date.now() - ui.alert.lastNagAt >= every) {
      ui.alert.lastNagAt = Date.now();
      notifier.nag(urgency(ui.alert.level));
      pulse();
    }
  }
}

// ---------------------------------------------------------------- events

function onClick(event) {
  const target = event.target.closest('button, a');
  if (!target) return;

  if (target.dataset.alert) {
    answerAlert(target.dataset.alert, target);
    return;
  }

  if (target.dataset.action === 'complete') {
    const done = store.complete(target.dataset.id);
    toast(`Done. Logged with ${frictionSummary(done)}.`);
    return;
  }
  if (target.dataset.action === 'delete') {
    const task = store.getTask(target.dataset.id);
    if (task && window.confirm(`Delete "${task.title}"? Its history goes with it.`)) store.deleteTask(task.id);
    return;
  }

  if (target.dataset.sim) {
    advanceClock(Number(target.dataset.sim));
    return;
  }
  switch (target.id) {
    case 'sim-next': jumpToNextAlert(); return;
    case 'sim-banner-reset': resetClock(); return;
    case 'empty-demo':
    case 'dash-demo':
    case 'data-demo': loadDemo(); return;
    case 'data-export': exportData(); return;
    case 'data-import': $('data-file').click(); return;
    case 'data-erase': eraseData(); return;
    case 'notif-enable':
      notifier.requestPermission().then(() => renderSettings());
      return;
    default: break;
  }

  if (target.dataset.kind) {
    ui.form.kind = target.dataset.kind;
    renderKindPicker();
    updateAnchorPreview();
    return;
  }
  if (target.dataset.period) {
    ui.form.period = target.dataset.period;
    renderPeriodPicker();
    updateAnchorPreview();
    return;
  }
  if (target.dataset.spoons) {
    ui.form.spoons = Number(target.dataset.spoons);
    renderSpoonsPicker();
  }
}

function init() {
  document.addEventListener('click', onClick);
  $('task-form').addEventListener('submit', submitForm);
  $('f-date').addEventListener('input', updateAnchorPreview);
  $('f-time').addEventListener('input', updateAnchorPreview);
  $('settings-form').addEventListener('change', () => {
    store.setSettings(readSettingsForm());
    toast('Settings saved.');
  });
  $('data-file').addEventListener('change', (e) => {
    importData(e.target.files && e.target.files[0]);
    e.target.value = '';
  });

  const dialog = $('alert');
  dialog.addEventListener('cancel', (e) => e.preventDefault());
  dialog.addEventListener('close', () => {
    if (store.currentAlert()) requestAnimationFrame(() => syncAlert(store.now()));
  });

  // Audio needs a user gesture before it can play; unlock on the first one.
  const unlockOnce = () => {
    notifier.unlock();
    document.removeEventListener('pointerdown', unlockOnce);
    document.removeEventListener('keydown', unlockOnce);
  };
  document.addEventListener('pointerdown', unlockOnce);
  document.addEventListener('keydown', unlockOnce);

  store.subscribe(() => render());
  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  setInterval(tick, SECOND);

  // A shared single-file build opens with example history so the dashboard
  // shows what it does; a real install starts empty.
  if (window.NAG_AUTO_DEMO && store.tasks.length === 0) {
    const { tasks } = buildDemo({ now: store.now(), settings: store.settings });
    store.importSnapshot({ tasks, settings: store.settings });
    toast('Example history loaded so you can see the dashboard. Erase it in Settings when you want a clean start.', 8000);
  }

  route();
  store.tick();

  if ('serviceWorker' in navigator && !window.NAG_SINGLE_FILE && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

init();

// Exposed for debugging and end-to-end tests.
window.nag = { store, clock, notifier };

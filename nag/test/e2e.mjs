// End-to-end check of the whole nag loop in a real browser.
//
//   node test/e2e.mjs [--shots <dir>] [--headed]
//
// Needs Playwright with Chromium (npm i -D playwright && npx playwright
// install chromium). Serves this directory on a random port, then drives
// the UI: create a task, advance the simulated clock, answer the cascading
// alerts, park it as "out of spoons", complete it, and read the dashboard.

import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const shotsDir = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;
const headed = args.includes('--headed');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

async function loadPlaywright() {
  const candidates = ['playwright', process.env.PLAYWRIGHT_MODULE].filter(Boolean);
  try {
    const globalRoot = execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const globalPw = path.join(globalRoot, 'playwright', 'index.mjs');
    if (existsSync(globalPw)) candidates.push(pathToFileURL(globalPw).href);
  } catch (err) {
    // npm not available; fall through
  }
  for (const spec of candidates) {
    try {
      return await import(spec);
    } catch (err) {
      // try the next candidate
    }
  }
  throw new Error('Playwright not found. Install it with: npm i -D playwright && npx playwright install chromium');
}

function serve() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT)) throw new Error('forbidden');
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch (err) {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let checks = 0;
function expect(condition, message) {
  checks += 1;
  if (!condition) throw new Error(`Check failed: ${message}`);
  console.log(`  ok  ${message}`);
}

async function shot(page, name) {
  if (!shotsDir) return;
  const dialogOpen = await page.$eval('#alert', (el) => el.open);
  await page.screenshot({ path: path.join(shotsDir, `${name}.png`), fullPage: !dialogOpen });
}

const pad = (n) => String(n).padStart(2, '0');
function inputsFor(ms) {
  const d = new Date(ms);
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

async function snoozeLabels(page) {
  return page.$$eval('#snooze-row button', (els) => els.map((b) => b.getAttribute('aria-label')));
}

async function alertOpen(page) {
  await page.waitForSelector('dialog#alert[open]', { timeout: 5000 });
}

async function alertClosed(page) {
  await page.waitForFunction(() => !document.querySelector('dialog#alert').open, null, { timeout: 5000 });
}

async function createTask(page, { title, category, spoons, offsetMinutes, kind = 'exact', period }) {
  await page.click('#new-task');
  await page.waitForSelector('#view-form:not([hidden])');
  await page.fill('#f-title', title);
  await page.fill('#f-category', category);
  const when = inputsFor(Date.now() + offsetMinutes * 60000);
  await page.fill('#f-date', when.date);
  if (kind === 'exact') {
    await page.fill('#f-time', when.time);
  } else {
    await page.click('#kind-picker [data-kind="fuzzy"]');
    await page.click(`#period-picker [data-period="${period}"]`);
  }
  if (spoons) await page.click(`#spoons-picker [data-spoons="${spoons}"]`);
  await page.click('#form-submit');
  await page.waitForSelector('#view-tasks:not([hidden])');
}

async function main() {
  const { chromium } = await loadPlaywright();
  if (shotsDir) await mkdir(shotsDir, { recursive: true });
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    serviceWorkers: 'block',
    reducedMotion: 'reduce',
    colorScheme: 'light',
  });
  context.setDefaultTimeout(10000);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('dialog', (d) => d.accept());

  try {
    console.log('\n1. Empty state and task creation');
    await page.goto(base);
    await page.waitForSelector('#view-tasks:not([hidden])');
    expect(!(await page.$eval('#empty-next', (el) => el.hidden)), 'empty state shows with no tasks');
    await shot(page, '01-empty');

    await page.click('#new-task');
    await page.waitForSelector('#view-form:not([hidden])');
    await page.click('#form-submit');
    expect(!(await page.$eval('#e-title', (el) => el.hidden)), 'submitting an empty form shows a title error');
    expect((await page.$eval('#spoons-picker [aria-checked="true"]', (el) => el.dataset.spoons)) === '2', 'spoons default to 2');
    await shot(page, '02-form-errors');
    await page.click('#form-cancel');

    await createTask(page, { title: 'Call the insurance company', category: 'admin', spoons: 3, offsetMinutes: 2 });
    let next = await page.$eval('#list-next', (el) => el.textContent);
    expect(/Call the insurance company/.test(next) && /Due in \d+ min/.test(next), 'task listed under Up next with a countdown');
    await shot(page, '03-task-listed');

    await page.click('#list-next a:has-text("Edit")');
    await page.waitForSelector('#view-form:not([hidden])');
    expect((await page.textContent('#form-title')).trim() === 'Edit task' && (await page.inputValue('#f-title')) === 'Call the insurance company', 'edit form is pre-filled');
    await page.fill('#f-title', 'Call the insurance company about the claim');
    await page.click('#form-submit');
    await page.waitForSelector('#view-tasks:not([hidden])');
    next = await page.$eval('#list-next', (el) => el.textContent);
    expect(/about the claim/.test(next) && /Due in \d+ min/.test(next), 'edited title saved and the anchor kept');

    await createTask(page, { title: 'Throwaway', category: 'other', offsetMinutes: 60, kind: 'fuzzy', period: 'night' });
    next = await page.$eval('#list-next', (el) => el.textContent);
    expect(/Throwaway/.test(next) && /Night/.test(next), 'fuzzy-anchored task listed with its part of day');
    await page.click('#list-next button[aria-label="Delete Throwaway"]');
    await page.waitForFunction(() => !/Throwaway/.test(document.querySelector('#list-next').textContent));
    expect(true, 'deleting a task removes it');

    console.log('\n2. Alert at the time anchor (level 0)');
    await page.click('[data-sim="300"]');
    await alertOpen(page);
    expect(await page.$eval('#alert', (el) => el.classList.contains('tier-calm')), 'first alert is the calm tier');
    expect((await page.textContent('#alert-heading')).trim() === 'Is this complete?', 'first alert asks "Is this complete?"');
    let labels = await snoozeLabels(page);
    expect(labels.join('|') === 'Snooze 10 min|Snooze 20 min|Snooze 40 min', `3-spoon task offers 10/20/40 min (${labels.join(', ')})`);
    expect(!(await page.$eval('#sim-banner', (el) => el.hidden)), 'simulated-clock banner is visible');
    await shot(page, '04-alert-calm');

    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    expect(await page.$eval('#alert', (el) => el.open), 'Escape does not dismiss the alert');

    console.log('\n3. Cascading snoozes');
    await page.click('#snooze-row button[aria-label="Snooze 20 min"]');
    await alertClosed(page);
    next = await page.$eval('#list-next', (el) => el.textContent);
    expect(/Snoozed until/.test(next) && /1× so far/.test(next), 'task shows as snoozed once');

    await page.click('#sim-next');
    await alertOpen(page);
    expect(await page.$eval('#alert', (el) => el.classList.contains('tier-firm')), 'second alert is the firm tier');
    labels = await snoozeLabels(page);
    expect(labels.join('|') === 'Snooze 5 min|Snooze 10 min', `level 1 offers only options shorter than 20 min (${labels.join(', ')})`);
    await page.click('#snooze-row button[aria-label="Snooze 10 min"]');
    await alertClosed(page);

    await page.click('#sim-next');
    await alertOpen(page);
    expect(await page.$eval('#alert', (el) => el.classList.contains('tier-loud')), 'third alert is the loud tier');
    labels = await snoozeLabels(page);
    expect(labels.join('|') === 'Snooze 3 min|Snooze 5 min', `level 2 offers 3/5 min (${labels.join(', ')})`);
    await page.click('#snooze-row button[aria-label="Snooze 5 min"]');
    await alertClosed(page);

    await page.click('#sim-next');
    await alertOpen(page);
    expect(await page.$eval('#alert', (el) => el.classList.contains('tier-hostile')), 'fourth alert is the hostile tier');
    labels = await snoozeLabels(page);
    expect(labels.join('|') === 'Snooze 1 min|Snooze 3 min', `level 3 offers 1/3 min (${labels.join(', ')})`);
    await shot(page, '05-alert-hostile');
    await page.click('#snooze-row button[aria-label="Snooze 3 min"]');
    await alertClosed(page);

    await page.click('#sim-next');
    await alertOpen(page);
    labels = await snoozeLabels(page);
    expect(labels.join('|') === 'Snooze 1 min', `level 4 is down to the one-minute nag (${labels.join(', ')})`);
    expect(/Nag #5/.test(await page.textContent('#alert-heading')), 'heading counts the nags');

    console.log('\n4. Out of spoons');
    await page.click('#alert-oos');
    await page.waitForSelector('#oos-block:not([hidden])');
    const oos = await page.$$eval('#oos-row button strong', (els) => els.map((b) => b.textContent.trim()));
    expect(oos.join('|') === 'Rest of today|Rest of this week|Until next month', 'three deferral choices offered');
    await shot(page, '06-out-of-spoons');
    await page.click('#oos-row [data-key="day"]');
    await alertClosed(page);
    next = await page.$eval('#list-next', (el) => el.textContent);
    expect(/Out of spoons · back Tomorrow/.test(next), 'task parked until tomorrow');
    await shot(page, '07-parked');

    await page.click('#sim-next');
    await alertOpen(page);
    expect(await page.$eval('#alert', (el) => el.classList.contains('tier-calm')), 'cascade resets to calm after a deferral');
    labels = await snoozeLabels(page);
    expect(labels.join('|') === 'Snooze 10 min|Snooze 20 min|Snooze 40 min', 'full snooze menu is back after the deferral');
    expect(/Alert 6/.test(await page.textContent('#alert-kicker')), 'kicker shows this is the sixth alert');

    console.log('\n5. Completion and persistence');
    await page.click('[data-alert="complete"]');
    await alertClosed(page);
    await page.click('#group-done summary');
    let done = await page.$eval('#list-done', (el) => el.textContent);
    expect(/about the claim/.test(done) && /4 snoozes, 1× out of spoons/.test(done), 'done list records 4 snoozes and 1 deferral');
    await shot(page, '08-done');

    await page.reload();
    await page.waitForSelector('#view-tasks:not([hidden])');
    await page.click('#group-done summary');
    done = await page.$eval('#list-done', (el) => el.textContent);
    expect(/4 snoozes, 1× out of spoons/.test(done), 'history survives a reload');
    expect(await page.$eval('#sim-banner', (el) => el.hidden), 'simulated clock resets on reload');

    console.log('\n6. Alert queue and reload while alerting');
    await createTask(page, { title: 'Take meds', category: 'health', spoons: 1, offsetMinutes: -1 });
    await alertOpen(page);
    expect(/Take meds/.test(await page.textContent('#alert-task')), 'a task anchored in the past alerts immediately');
    await page.reload();
    await alertOpen(page);
    expect(/Take meds/.test(await page.textContent('#alert-task')), 'an unanswered alert comes straight back after reload');
    labels = await snoozeLabels(page);
    expect(labels.join('|') === 'Snooze 3 min|Snooze 5 min|Snooze 10 min', `1-spoon task offers 3/5/10 min (${labels.join(', ')})`);
    await page.click('#snooze-row button[aria-label="Snooze 3 min"]');
    await alertClosed(page);

    await createTask(page, { title: 'Water the plants', category: 'chores', spoons: 2, offsetMinutes: -1 });
    await alertOpen(page);
    await page.evaluate(() => { window.nag.clock.offset += 5 * 60 * 1000; window.nag.store.tick(); });
    await page.waitForFunction(() => document.querySelector('#alert-queue') && !document.querySelector('#alert-queue').hidden);
    const first = await page.textContent('#alert-task');
    expect(/Take meds/.test(first), 'the more escalated alert (level 1) is shown first');
    expect(/1 more alert waiting/.test(await page.textContent('#alert-queue')), 'queue shows one more waiting');
    await page.click('[data-alert="complete"]');
    await page.waitForFunction(() => /Water the plants/.test(document.querySelector('#alert-task').textContent));
    expect(true, 'next queued alert appears after answering');
    await page.click('[data-alert="complete"]');
    await alertClosed(page);

    console.log('\n7. Dashboard');
    await page.click('.tab[data-view="dashboard"]');
    await page.waitForSelector('#view-dashboard:not([hidden])');
    const kpis = await page.$$eval('#kpis .kpi', (els) => els.map((el) => `${el.querySelector('.kpi-label').textContent}=${el.querySelector('.kpi-value').textContent}`));
    expect(kpis.includes('Completed=3'), `KPI completed (${kpis.join(', ')})`);
    expect(kpis.includes('Snoozes=5'), 'KPI total snoozes = 5');
    expect(kpis.includes('Out of spoons=1'), 'KPI deferrals = 1');
    const hardest = await page.$$eval('#hardest .rank', (els) => els.map((el) => `${el.querySelector('.rank-name').textContent}:${el.querySelector('.badge').textContent.trim()}`));
    expect(hardest[0] === 'admin:✕Hard', `admin is the hardest type and classified hard (${hardest.join(', ')})`);
    const easiest = await page.$$eval('#easiest .rank', (els) => els.map((el) => `${el.querySelector('.rank-name').textContent}:${el.querySelector('.badge').textContent.trim()}`));
    expect(easiest[0] === 'chores:✓Easy', `chores is the easiest type (${easiest.join(', ')})`);
    const rows = await page.$$eval('#table-category tbody tr', (trs) => trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim())));
    const adminRow = rows.find((r) => r[0] === 'admin');
    expect(adminRow && adminRow[3] === '4' && adminRow[6] === '1' && adminRow[7] === '4', `admin row: 4 snoozes, 1 deferral, peak level 4 (${adminRow && adminRow.join(' | ')})`);
    await shot(page, '09-dashboard-mobile');

    console.log('\n8. Settings, demo data and desktop layout');
    await page.click('.tab[data-view="settings"]');
    await page.waitForSelector('#view-settings:not([hidden])');
    await page.fill('#s-period-morning', '07:45');
    await page.dispatchEvent('#s-period-morning', 'change');
    expect((await page.evaluate(() => window.nag.store.settings.periods.morning)) === '07:45', 'changing a period time saves');
    await shot(page, '10-settings');
    await page.click('#data-demo');
    await page.waitForSelector('#view-tasks:not([hidden])');
    const count = await page.evaluate(() => window.nag.store.tasks.length);
    expect(count > 25, `demo data loaded (${count} tasks)`);
    await page.setViewportSize({ width: 1200, height: 900 });
    await shot(page, '11-tasks-desktop');
    await page.click('.tab[data-view="dashboard"]');
    await page.waitForSelector('#view-dashboard:not([hidden])');
    const insights = await page.$$eval('#insights li', (els) => els.map((el) => el.textContent));
    expect(insights.length >= 2, `insights generated (${insights.length})`);
    await shot(page, '12-dashboard-desktop');
    await context.close();

    const dark = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: 'block', reducedMotion: 'reduce', colorScheme: 'dark' });
    const darkPage = await dark.newPage();
    darkPage.on('pageerror', (err) => errors.push(String(err)));
    darkPage.on('dialog', (d) => d.accept());
    await darkPage.goto(base);
    await darkPage.waitForSelector('#view-tasks:not([hidden])');
    await darkPage.click('#empty-demo');
    await darkPage.waitForFunction(() => window.nag.store.tasks.length > 0);
    await shot(darkPage, '13-tasks-dark');
    await darkPage.click('#sim-next');
    await alertOpen(darkPage);
    await shot(darkPage, '14-alert-dark');
    await darkPage.click('.tab[data-view="dashboard"]').catch(() => {});
    await darkPage.click('[data-alert="complete"]');
    await alertClosed(darkPage);
    await darkPage.click('.tab[data-view="dashboard"]');
    await darkPage.waitForSelector('#view-dashboard:not([hidden])');
    await shot(darkPage, '15-dashboard-dark');
    await dark.close();

    expect(errors.length === 0, `no page errors (${errors.join('; ')})`);
    console.log(`\nAll ${checks} checks passed.`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(`\n${err.stack || err}`);
  process.exit(1);
});

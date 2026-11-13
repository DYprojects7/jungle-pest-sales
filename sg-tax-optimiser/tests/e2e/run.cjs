/* eslint-disable no-console */
/**
 * Browser end-to-end test for the single-file web calculator (SPEC section 10).
 *
 *   npm run build && node scripts/build-artifact.mjs && node tests/e2e/run.cjs
 *
 * Opens dist/index.html from a file:// URL in Chromium, checks the worked examples in SPEC Appendix A against
 * what the page shows, exercises the inputs, and saves screenshots to .tmp/screens/. One check builds a second
 * copy of the page with a shop address (VITE_BUY_URL) into .tmp/e2e-shop/ to see the link to the workbook.
 * Prints a PASS/FAIL line per check and exits non-zero if any check fails.
 *
 * The browser clock is fixed at 13 Nov 2026 (Singapore) unless a check says otherwise, so the deadline figures
 * are stable. Google Fonts is the only network host the page may touch, and it must never be needed: several
 * checks run with that host blocked or hanging.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
// The page under test is the build in dist/. SGTO_E2E_FILE points the same checks at another copy, for example
// the file that ships: SGTO_E2E_FILE=release/sg-tax-optimiser.html node tests/e2e/run.cjs
const DIST = process.env.SGTO_E2E_FILE ? path.resolve(ROOT, process.env.SGTO_E2E_FILE) : path.join(ROOT, 'dist', 'index.html');
// How long a step may wait for the page, in ms (Playwright's own default when unset).
const STEP_TIMEOUT = Number(process.env.SGTO_E2E_TIMEOUT) || 0;
const ARTIFACT = path.join(ROOT, 'dist', 'artifact.html');
const SHOTS = path.join(ROOT, '.tmp', 'screens');
const PAGE_URL = pathToFileURL(DIST).href;
const FIXED_NOW = new Date('2026-11-13T10:00:00+08:00');
const FONT_HOSTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;
/** Width of the inputs rail on desktop (--panel-w). */
const RAIL = 404;

const results = [];
const problems = []; // console errors, page errors, unexpected requests

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n      ${detail}` : ''}`);
}

async function check(name, fn) {
  try {
    await fn();
    record(name, true);
  } catch (err) {
    record(name, false, String(err && err.message ? err.message : err).split('\n').slice(0, 4).join(' | '));
  }
}

function expectEqual(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: expected "${expected}", got "${actual}"`);
}

function expectTrue(value, what) {
  if (!value) throw new Error(what);
}

/** Watch a page for anything that should not happen. Returns the list of font requests it made. */
function watch(page, label) {
  const fontRequests = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const where = msg.location() && msg.location().url ? msg.location().url : '';
    // A font that cannot be fetched (offline, sandbox, a check that blocks the host) is allowed.
    if (FONT_HOSTS.test(where)) return;
    problems.push(`[${label}] console error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => problems.push(`[${label}] page error: ${err.message}`));
  page.on('request', (req) => {
    const url = req.url();
    if (url.startsWith('file://') || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:')) return;
    if (FONT_HOSTS.test(url)) {
      fontRequests.push(url);
      return;
    }
    problems.push(`[${label}] unexpected network request: ${url}`);
  });
  return fontRequests;
}

/** Wait until the web fonts have arrived or failed, so layout is measured in a settled state. */
async function settleFonts(page) {
  await page
    .waitForFunction(
      () => {
        const link = document.querySelector('link[data-web-fonts]');
        return link && link.getAttribute('data-web-fonts') !== 'pending';
      },
      null,
      { timeout: 6000 },
    )
    .catch(() => {});
  await page
    .evaluate(
      () =>
        new Promise((resolve) => {
          const done = () => requestAnimationFrame(() => requestAnimationFrame(resolve));
          Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 4000))]).then(done, done);
        }),
    )
    .catch(() => {});
}

/**
 * Open the calculator. `fonts`: 'allow' (default), 'block' (the host refuses at once) or 'hang' (the host
 * never answers). `now` fixes the browser clock.
 */
async function newPage(browser, opts) {
  const {
    width,
    height,
    colorScheme = 'light',
    label,
    url = PAGE_URL,
    touch = false,
    now = FIXED_NOW,
    fonts = 'allow',
  } = opts;
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    hasTouch: touch,
    colorScheme,
    timezoneId: 'Asia/Singapore',
    locale: 'en-SG',
  });
  await context.clock.setFixedTime(now);
  if (STEP_TIMEOUT > 0) context.setDefaultTimeout(STEP_TIMEOUT);
  if (fonts === 'block') await context.route(FONT_HOSTS, (route) => route.abort());
  if (fonts === 'hang') await context.route(FONT_HOSTS, () => {});
  const page = await context.newPage();
  const fontRequests = watch(page, label);
  await page.goto(url, { timeout: 10000 });
  await page.waitForSelector('[data-testid="reco-tax-saved"]', { timeout: 10000 });
  if (fonts === 'allow') await settleFonts(page);
  else await page.waitForTimeout(250);
  return { context, page, fontRequests };
}

const text = async (page, testid) => (await page.locator(`[data-testid="${testid}"]`).first().innerText()).trim();
const flat = async (page, testid) => (await text(page, testid)).replace(/\s+/g, ' ');
const count = (page, selector) => page.locator(selector).count();

/** Type into a number field the way a person does, then leave it. */
async function setField(page, id, value) {
  const input = page.locator(`#${id}`);
  await input.click();
  await input.fill(String(value));
  await input.blur();
}

/** Back to the opening example. The Reset control only shows once something has been changed. */
async function resetToExample(page) {
  const reset = page.locator('[data-testid="reset"]');
  if ((await reset.count()) > 0) await reset.click();
  await page.waitForSelector('[data-testid="example-flag-plan"]');
}

async function choose(page, id) {
  // Segmented options and radios sit under (or beside) their label.
  await page.locator(`label[for="${id}"]`).click();
}

async function noJunk(page, where) {
  const body = await page.locator('body').innerText();
  const bad = /\bNaN\b|\bundefined\b|\bInfinity\b|\[object Object\]/.exec(body);
  if (bad) throw new Error(`"${bad[0]}" is showing on the page (${where})`);
}

async function overflow(page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
}

async function expectExample(page, where) {
  expectEqual(await text(page, 'reco-srs'), 'S$15,300', `${where}: SRS`);
  expectEqual(await text(page, 'reco-cpf-self'), 'S$8,000', `${where}: CPF top-up (self)`);
  expectEqual(await text(page, 'reco-tax-saved'), 'S$2,679.50', `${where}: tax saved`);
  expectEqual(await text(page, 'reco-tax-before'), 'S$6,639.00', `${where}: tax before`);
  expectEqual(await text(page, 'reco-tax-after'), 'S$3,959.50', `${where}: tax after`);
  expectEqual(await text(page, 'reco-locked'), 'S$23,300', `${where}: cash locked away`);
}

/** The headline tax-saved figure: how many lines it takes and whether it stays inside its column. */
async function heroBox(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="reco-tax-saved"]');
    const range = document.createRange();
    range.selectNodeContents(el);
    const ink = range.getBoundingClientRect();
    const column = el.parentElement.getBoundingClientRect();
    return {
      lines: new Set(Array.from(range.getClientRects()).map((r) => Math.round(r.top))).size,
      inkRight: Math.round(ink.right),
      columnRight: Math.round(column.right),
      fontSize: Math.round(parseFloat(getComputedStyle(el).fontSize)),
    };
  });
}

/** Scroll boxes around tables that currently scroll sideways, by their table's test id. */
async function scrollingTables(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.table-scroll'))
      .filter((box) => box.clientWidth > 0 && box.scrollWidth > box.clientWidth + 1)
      .map((box) => `${box.querySelector('table')?.getAttribute('data-testid')} ${box.scrollWidth}px in ${box.clientWidth}px`),
  );
}

/**
 * A restacked table row as it reads on screen: "Label value" for each cell that is shown, top to bottom. (The
 * labels are drawn from each cell's data-label, so innerText alone does not have them.)
 */
async function stackedBlock(page, rowSelector) {
  return page.locator(rowSelector).evaluate((row) =>
    Array.from(row.querySelectorAll('td'))
      .filter((cell) => cell.getClientRects().length > 0)
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
      .map((cell) => {
        // The label as drawn: the first string of the ::before content (an empty spoken form may follow it).
        const drawn = /^"((?:[^"\\]|\\.)*)"/.exec(getComputedStyle(cell, '::before').content);
        return `${drawn ? drawn[1].trim() : '(no label)'} ${cell.innerText.trim()}`;
      })
      .join(' | '),
  );
}

/** Form controls without an id, or without a <label for> pointing at them. */
async function unlabelledControls(page) {
  return page.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll('input, select, textarea')) {
      if (!el.id) bad.push(`${el.tagName} without id`);
      else if (!document.querySelector(`label[for="${el.id}"]`)) bad.push(`#${el.id} without label`);
    }
    const ids = Array.from(document.querySelectorAll('[id]')).map((el) => el.id);
    const twice = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (twice.length > 0) bad.push(`duplicate ids: ${Array.from(new Set(twice)).join(', ')}`);
    return bad;
  });
}

/** Drop-downs on screen whose chosen label is too long to show in full once closed. */
async function truncatedSelects(page) {
  return page.evaluate(() => {
    const ctx = document.createElement('canvas').getContext('2d');
    const cut = [];
    for (const select of document.querySelectorAll('select')) {
      if (select.offsetParent === null) continue;
      const style = getComputedStyle(select);
      ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const label = select.selectedOptions[0] ? select.selectedOptions[0].textContent : '';
      const need = ctx.measureText(label).width;
      const room = select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      if (need > room + 1) cut.push(`#${select.id} "${label}" needs ${Math.round(need)}px, has ${Math.round(room)}px`);
    }
    return cut;
  });
}

/** Replace the clipboard with a recorder, so the copied summary can be read back whatever the browser allows. */
async function recordClipboard(page) {
  await page.evaluate(() => {
    window.__copied = null;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (value) => {
          window.__copied = value;
          return Promise.resolve();
        },
      },
    });
  });
}

async function copiedSummary(page) {
  await page.locator('[data-testid="copy-summary"]').click();
  await page.waitForFunction(() => typeof window.__copied === 'string', null, { timeout: 3000 });
  return page.evaluate(() => window.__copied);
}

/** The whole page as it reads, with every folded section opened so nothing is left out. */
async function pageText(page) {
  await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true)));
  return (await page.locator('body').innerText()).replace(/\s+/g, ' ');
}

/** True when the element with this id comes before the other in the page. */
async function comesBefore(page, firstId, secondId) {
  return page.evaluate(
    ([a, b]) => {
      const first = document.getElementById(a);
      const second = document.getElementById(b);
      return !!first && !!second && !!(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
    },
    [firstId, secondId],
  );
}

/** Where a block sits: top and bottom in the viewport, and what element comes straight before it. */
async function placed(page, selector) {
  return page.locator(selector).first().evaluate((el) => {
    const box = el.getBoundingClientRect();
    return { top: Math.round(box.top + window.scrollY), bottom: Math.round(box.bottom + window.scrollY) };
  });
}

/** The product critic's modest earner: 29, S$5,200 a month, S$10,400 bonus, no other reliefs. */
async function enterModest(page) {
  await setField(page, 'age', '29');
  await setField(page, 'salary', '5200');
  await setField(page, 'bonus', '10400');
  await setField(page, 'reliefTotal', '0');
}

/** A foreigner on S$7,000 a month with a S$7,000 bonus and no other reliefs. */
async function enterForeigner(page) {
  await choose(page, 'residency-foreigner');
  await setField(page, 'salary', '7000');
  await setField(page, 'bonus', '7000');
  await setField(page, 'reliefTotal', '0');
}

/** SPEC Appendix A.2, entered from the opening example. */
async function enterA2(page) {
  await choose(page, 'residency-pr');
  await setField(page, 'age', '57');
  // At 57 the top-up that can still earn relief must be entered (SPEC 6.5); A.2 has S$50,000 of room.
  await setField(page, 'cpfSelfRoom', '50000');
  await setField(page, 'salary', '14000');
  await setField(page, 'bonus', '40000');
  await setField(page, 'reliefTotal', '30000');
  await setField(page, 'existingSrs', '5000');
  await page.locator('#useCpfFamily').check();
  await setField(page, 'cpfFamilyMax', '8000');
  await setField(page, 'cashLimit', '20000');
  await choose(page, 'depth-every');
  await choose(page, 'order-interest');
}

/** SPEC Appendix A.3, entered from the opening example. */
async function enterA3(page) {
  await setField(page, 'salary', '3500');
  await setField(page, 'bonus', '3500');
  await setField(page, 'reliefTotal', '0');
  await setField(page, 'age', '28');
}

async function main() {
  if (!fs.existsSync(DIST)) {
    console.error(`FAIL  ${path.relative(ROOT, DIST)} not found. Run "npm run build" first.`);
    process.exit(1);
  }
  fs.mkdirSync(SHOTS, { recursive: true });

  const browser = await chromium.launch();
  try {
    // ------------------------------------------------------------------ desktop, light
    const desktop = await newPage(browser, { width: 1280, height: 900, label: 'desktop-light' });
    const page = desktop.page;

    await check('single file: no external scripts and no stylesheet link in the markup', async () => {
      const html = fs.readFileSync(DIST, 'utf8');
      expectTrue(!/<script\b[^>]*\bsrc=/i.test(html), 'dist/index.html references an external script');
      const links = html.match(/<link\b[^>]*rel=["']?stylesheet[^>]*>/gi) || [];
      expectEqual(links.join(' '), '', 'a linked stylesheet would block the first render');
      // The tab icon travels inside the file, and the browser chrome is tinted for each colour scheme.
      expectTrue(/<link\b[^>]*rel="icon"[^>]*href="data:image\/svg\+xml,/.test(html.replace(/\s+/g, ' ')), 'no inline tab icon');
      expectEqual((html.match(/<meta name="theme-color"/g) || []).length, 2, 'theme-color metas');
    });

    await check('web fonts: asked for by the page itself after it has loaded, from Google Fonts only', async () => {
      expectTrue(desktop.fontRequests.length > 0, 'the page never asked for its web fonts');
      expectTrue(
        desktop.fontRequests[0].startsWith('https://fonts.googleapis.com/css2?'),
        `first font request was ${desktop.fontRequests[0]}`,
      );
      expectTrue(desktop.fontRequests[0].includes('display=swap'), 'the fonts stylesheet should use display=swap');
      expectEqual(await count(page, 'link[rel="stylesheet"]'), 1, 'stylesheet links added at run time');
    });

    await check('example (Appendix A.1): SRS S$15,300, CPF S$8,000, saved S$2,679.50, tax S$6,639.00 to S$3,959.50', async () => {
      await expectExample(page, 'on load');
      expectEqual(await text(page, 'reco-rate'), '11.5 cents', 'saving per dollar');
    });

    await check('example is labelled as an example and the recommendation is visible without interaction', async () => {
      for (const id of ['example-flag', 'example-flag-plan']) {
        const flag = await text(page, id);
        expectTrue(/example/i.test(flag) && /replace with your numbers/i.test(flag), `${id} reads "${flag}"`);
      }
      const box = await page.locator('[data-testid="reco-tax-saved"]').boundingBox();
      expectTrue(box && box.y >= 0 && box.y + box.height <= 900, 'the tax saved figure is not in the first screen');
      const headline = await text(page, 'reco-headline');
      expectTrue(
        headline.includes('S$15,300 into SRS') && headline.includes('S$8,000 into your CPF as a cash top-up'),
        `headline reads "${headline}"`,
      );
      expectTrue((await text(page, 'reco-reason')).length > 20, 'no reason sentence under the recommendation');
    });

    await check('the plan card at 1280px: the right-hand column ends level with the left, on the Copy summary button', async () => {
      const ends = await page.evaluate(() => {
        const bottom = (selector) => Math.round(document.querySelector(selector).getBoundingClientRect().bottom);
        return { main: bottom('.slab-main'), foot: bottom('.slip-foot'), copy: bottom('#copy-summary') };
      });
      expectTrue(Math.abs(ends.main - ends.foot) <= 1, `the columns end at ${ends.main}px and ${ends.foot}px`);
      expectTrue(ends.foot - ends.copy <= 1, `the copy button ends ${ends.foot - ends.copy}px above the column`);
      expectTrue(/48 days left to transfer, by 31 Dec 2026/.test(await flat(page, 'reco-deadline')), 'the deadline line');
    });

    // The page exactly as it opens, before any check changes it.
    await page.screenshot({ path: path.join(SHOTS, 'desktop-light.png'), fullPage: true });
    await page.screenshot({ path: path.join(SHOTS, 'desktop-light-fold.png') });

    await check('example reason quotes only a saving the page can reach (family top-up: S$3,478.00)', async () => {
      const reason = await flat(page, 'reco-reason');
      expectTrue(!reason.includes('2,359.50'), `the reason still quotes the unreachable S$2,359.50: "${reason}"`);
      expectTrue(!/next dollar of income/i.test(reason), `the reason mislabels the rate: "${reason}"`);
      // The scheme is named as its tick box names it: "CPF cash top-up to family".
      expectTrue(
        reason.includes('Switching on the CPF cash top-up to family would raise the saving to S$3,478.00'),
        `reason reads "${reason}"`,
      );
      expectEqual((await page.locator('label[for="useCpfFamily"]').innerText()).trim(), 'CPF cash top-up to family', 'the tick box it names');
      const notes = (await page.locator('[data-testid="warnings"]').innerText()).replace(/\s+/g, ' ');
      expectTrue(!notes.includes('2,359.50'), 'the notes under "Before you transfer" quote the unreachable saving');
      // Doing what the sentence says gives exactly the figure it quoted.
      await page.locator('#useCpfFamily').check();
      expectEqual(await text(page, 'reco-tax-saved'), 'S$3,478.00', 'tax saved with the family top-up on');
      const after = await flat(page, 'reco-reason');
      expectTrue(!/Switching on/.test(after), `nothing is left to switch on, but the reason reads "${after}"`);
      await resetToExample(page);
    });

    await check('example: ladder has one 11.5% tier, schedule is 2 months, 48 days to the deadline', async () => {
      expectEqual(await count(page, '[data-testid="ladder-table"] tbody tr'), 1, 'ladder rows');
      const row = await page.locator('[data-testid="ladder-table"] tbody tr').first().innerText();
      expectTrue(row.includes('11.5%') && row.includes('S$2,679.50'), `ladder row reads "${row.replace(/\s+/g, ' ')}"`);
      expectEqual(await text(page, 'days-left'), '48', 'days to the deadline');
      expectEqual(await count(page, '[data-testid="monthly-table"] tbody tr'), 2, 'schedule rows');
      const schedule = await page.locator('[data-testid="monthly-table"]').innerText();
      expectTrue(schedule.includes('S$7,650') && schedule.includes('S$4,000'), 'schedule should show S$7,650 and S$4,000');
      expectTrue((await count(page, 'svg.chart-svg rect')) > 0, 'the ladder chart drew no shapes');
    });

    await check('page structure: one h1, labelled controls with ids, live region, tables with scoped headers', async () => {
      expectEqual(await count(page, 'h1'), 1, 'h1 count');
      expectEqual((await unlabelledControls(page)).join(', '), '', 'controls without a label or id');
      expectEqual(await page.locator('[data-testid="live"]').getAttribute('aria-live'), 'polite', 'aria-live');
      const unscoped = await page.locator('table th:not([scope])').count();
      expectEqual(unscoped, 0, 'th cells without a scope');
      await noJunk(page, 'example');
    });

    await check('landmarks and tab stops: the header is a banner outside the inputs; tables that fit are not tab stops', async () => {
      expectEqual(await count(page, 'header h1'), 1, 'the page name should sit in the header');
      expectEqual(await count(page, 'aside header, main header, nav header'), 0, 'header inside another landmark');
      expectEqual(await count(page, 'main'), 1, 'main landmark');
      expectEqual(await count(page, 'aside[aria-label="Your numbers"]'), 1, 'inputs landmark');
      expectEqual((await scrollingTables(page)).join('; '), '', 'tables that scroll at 1280px');
      expectEqual(await count(page, '.table-scroll[tabindex]'), 0, 'table boxes that are tab stops without scrolling');
    });

    await check('figures are tabular, prose in tables and tags is not (no stretched hyphens)', async () => {
      const got = await page.evaluate(() => {
        const numeric = (selector) => getComputedStyle(document.querySelector(selector)).fontVariantNumeric;
        return {
          fact: numeric('[data-testid="facts-table"] tbody td'),
          tag: numeric('.tag'),
          amount: numeric('[data-testid="ladder-table"] td.num'),
          hero: numeric('[data-testid="reco-tax-saved"]'),
        };
      });
      expectEqual(got.fact, 'normal', 'facts cell');
      expectEqual(got.tag, 'normal', 'tag');
      expectEqual(got.amount, 'tabular-nums', 'figure column');
      expectEqual(got.hero, 'tabular-nums', 'headline figure');
    });

    await check('changing the salary updates the result (S$12,000 a month saves S$3,120.50)', async () => {
      const before = await text(page, 'reco-tax-saved');
      await setField(page, 'salary', '12,000');
      const after = await text(page, 'reco-tax-saved');
      expectTrue(after !== before, 'tax saved did not change');
      expectEqual(after, 'S$3,120.50', 'tax saved at S$12,000 a month');
      expectEqual(await page.locator('#salary').inputValue(), '12,000', 'salary shows formatted');
      expectEqual(await count(page, '[data-testid="example-flag"]'), 0, 'example label should go once edited');
      expectEqual(await count(page, '[data-testid="example-flag-plan"]'), 0, 'example label on the plan should go too');
      await noJunk(page, 'after salary change');
    });

    await check('state survives a reload', async () => {
      await page.reload();
      await page.waitForSelector('[data-testid="reco-tax-saved"]');
      expectEqual(await page.locator('#salary').inputValue(), '12,000', 'salary after reload');
      expectEqual(await text(page, 'reco-tax-saved'), 'S$3,120.50', 'tax saved after reload');
      expectEqual(await count(page, '[data-testid="example-flag"]'), 0, 'example label after reload');
    });

    await check('Reset to example restores the example, and Undo brings the numbers back', async () => {
      expectEqual(await count(page, '[data-testid="reset"]'), 1, 'Reset control is offered once the numbers change');
      await page.locator('[data-testid="reset"]').click();
      await expectExample(page, 'after reset');
      expectEqual(await page.locator('#salary').inputValue(), '10,000', 'salary after reset');
      expectEqual(await count(page, '[data-testid="example-flag"]'), 1, 'example label after reset');
      expectEqual(await count(page, '[data-testid="undo-reset"]'), 1, 'Undo should be offered after a reset');
      await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'undo-reset', null, { timeout: 2000 });
      await page.locator('[data-testid="undo-reset"]').click();
      expectEqual(await page.locator('#salary').inputValue(), '12,000', 'salary after undo');
      expectEqual(await text(page, 'reco-tax-saved'), 'S$3,120.50', 'tax saved after undo');
      expectEqual(await count(page, '[data-testid="undo-reset"]'), 0, 'Undo goes once used');
      await page.locator('[data-testid="reset"]').click();
      await setField(page, 'bonus', '15001');
      expectEqual(await count(page, '[data-testid="undo-reset"]'), 0, 'Undo goes once new numbers are typed');
      await resetToExample(page);
    });

    await check('the example that is left in: named in the panel, tagged on its fields, gone once each is set', async () => {
      await resetToExample(page);
      expectEqual(await count(page, '[data-testid="example-left"]'), 0, 'no line while the whole page is the example');
      expectEqual(await count(page, '.tag-example'), 0, 'no field tags while the whole page is the example');
      await setField(page, 'salary', '7000');
      expectTrue(/Your numbers/.test(await text(page, 'saved-flag')), 'the panel should say the numbers are the person\'s own');
      expectEqual(
        await flat(page, 'example-left'),
        "Still using the example's age, bonus and other reliefs.",
        'what is left of the example',
      );
      expectEqual(await text(page, 'bonus-flag'), 'Example value', 'tag on the bonus');
      expectEqual(await text(page, 'reliefTotal-flag'), 'Example value', 'tag on other reliefs');
      expectEqual(await count(page, '[data-testid="salary-flag"]'), 0, 'no tag on the salary that was typed');
      // Retyping the example's own figure is how somebody says "this one is right for me too".
      await setField(page, 'bonus', '15000');
      expectEqual(await count(page, '[data-testid="bonus-flag"]'), 0, 'tag on a bonus that was retyped');
      expectEqual(await flat(page, 'example-left'), "Still using the example's age and other reliefs.", 'after the bonus');
      await setField(page, 'age', '41');
      await setField(page, 'reliefTotal', '0');
      expectEqual(await count(page, '[data-testid="example-left"]'), 0, 'the line once every figure is set');
      expectEqual(await count(page, '.tag-example'), 0, 'field tags once every figure is set');
      await page.reload();
      await page.waitForSelector('[data-testid="reco-tax-saved"]');
      expectEqual(await count(page, '[data-testid="example-left"]'), 0, 'the line after a reload');
      await resetToExample(page);
    });

    await check('choices that only change the view leave the example an example: step, income year, "Which first?"', async () => {
      await page.locator('#simulator').evaluate((el) => (el.open = true));
      await page.locator('#simulatorStep').selectOption('2000');
      await choose(page, 'order-interest');
      expectTrue(
        (await flat(page, 'reco-headline')).startsWith('Put S$8,000 into your CPF as a cash top-up and S$15,300 into SRS'),
        'the order was applied',
      );
      await page.locator('#incomeYear').selectOption('2027');
      expectEqual(await text(page, 'ya'), 'YA2028', 'the income year was applied');
      expectEqual(await count(page, '[data-testid="example-flag"]'), 1, 'still labelled as the example');
      expectEqual(await count(page, '[data-testid="saved-flag"]'), 0, '"Your numbers" label');
      const stored = await page.evaluate(() => JSON.parse(window.localStorage.getItem('sgto:v1')));
      expectEqual(stored.ui, null, 'the example is not stored as somebody\'s numbers');
      const why = (await page.locator('#order-flexibility-detail').innerText()).replace(/\s+/g, ' ');
      expectTrue(/the whole amount is taxed and there is a 5% penalty/.test(why), `"Flexibility first" reads "${why}"`);
      await page.locator('#incomeYear').selectOption('2026');
      await choose(page, 'order-flexibility');
      await page.locator('#simulatorStep').selectOption('1000');
      await page.locator('#simulator').evaluate((el) => (el.open = false));
      await expectExample(page, 'after putting the view back');
    });

    await check('money inputs: commas accepted, letters dropped, empty is 0, formatted on blur', async () => {
      const bonus = page.locator('#bonus');
      await bonus.click();
      const selected = await bonus.evaluate((el) => el.selectionStart === 0 && el.selectionEnd === el.value.length);
      expectTrue(selected, 'clicking into a number field should select the whole value');
      await bonus.pressSequentially('1x8,5y00');
      expectEqual(await bonus.inputValue(), '18,500', 'typed value with letters dropped');
      await bonus.blur();
      expectEqual(await bonus.inputValue(), '18,500', 'bonus formatted on blur');
      await setField(page, 'bonus', '');
      expectEqual(await bonus.inputValue(), '0', 'empty bonus shows 0');
      await noJunk(page, 'empty bonus');
      await setField(page, 'bonus', '15000');
      expectEqual(await bonus.inputValue(), '15,000', 'bonus formatted with separators');
    });

    await check('money inputs: "12k", "10.000" and full-width digits are read as typed; a dropped minus sign is mentioned', async () => {
      const bonus = page.locator('#bonus');
      await setField(page, 'bonus', '12k');
      expectEqual(await bonus.inputValue(), '12,000', '"12k"');
      await setField(page, 'bonus', '1.5k');
      expectEqual(await bonus.inputValue(), '1,500', '"1.5k"');
      await setField(page, 'bonus', '10.000');
      expectEqual(await bonus.inputValue(), '10,000', '"10.000"');
      await setField(page, 'bonus', '1,234.56');
      expectEqual(await bonus.inputValue(), '1,234', '"1,234.56" drops the cents');
      await setField(page, 'bonus', '\uFF11\uFF18\uFF0C\uFF10\uFF10\uFF10');
      expectEqual(await bonus.inputValue(), '18,000', 'full-width digits');
      expectEqual(await count(page, '#bonus-note'), 0, 'no note when nothing was left out');
      await setField(page, 'bonus', '-5000');
      expectEqual(await bonus.inputValue(), '5,000', '"-5000"');
      const note = await page.locator('#bonus-note').innerText();
      expectTrue(/Only digits are read here, so this counts as S\$5,000/.test(note), `the note reads "${note}"`);
      await setField(page, 'age', '4k1');
      expectEqual(await page.locator('#age').inputValue(), '41', '"k" means nothing in an age');
      await noJunk(page, 'number entry');
      await resetToExample(page);
    });

    await check('limits explain themselves: SRS already contributed is held at S$15,300', async () => {
      await setField(page, 'existingSrs', '20000');
      expectEqual(await page.locator('#existingSrs').inputValue(), '15,300', 'SRS already contributed');
      const note = await page.locator('#existingSrs-note').innerText();
      expectTrue(note.includes('SRS is capped at S$15,300 a year'), `note reads "${note}"`);
      await setField(page, 'existingSrs', '0');
    });

    await check('number fields: typing 55 does not pass through the minimum age, and an empty age keeps the last one', async () => {
      await resetToExample(page);
      const age = page.locator('#age');
      await age.click();
      await age.press('Backspace');
      await age.pressSequentially('5');
      // Mid-way through "55": the plan must still be the one for age 35, not the one for a 15-year-old.
      expectEqual(await text(page, 'reco-srs'), 'S$15,300', 'SRS while "5" is in the age field');
      expectEqual(await count(page, '#useSrs:disabled'), 0, 'SRS should not be ruled out mid-typing');
      await age.pressSequentially('5');
      await age.blur();
      expectEqual(await age.inputValue(), '55', 'age after typing 55');
      expectEqual(await count(page, '#birthMonth'), 1, 'age 55 reached the engine');
      await setField(page, 'age', '');
      expectEqual(await age.inputValue(), '55', 'an emptied age keeps the last valid age');
      await setField(page, 'age', '9');
      expectEqual(await age.inputValue(), '15', 'an age below the range is corrected on leaving the field');
      expectTrue((await page.locator('#age-note').innerText()).includes('15 to 100'), 'the correction is explained');
      await resetToExample(page);
    });

    await check('number fields: clicking in and out without typing changes nothing', async () => {
      await choose(page, 'residency-foreigner');
      await setField(page, 'existingSrs', '30000');
      await choose(page, 'residency-citizen');
      expectEqual(await page.locator('#existingSrs').inputValue(), '30,000', 'SRS already contributed after the switch');
      const before = await text(page, 'reco-tax-saved');
      await page.locator('#existingSrs').click();
      await page.locator('#existingSrs').blur();
      expectEqual(await page.locator('#existingSrs').inputValue(), '30,000', 'value after focus and blur');
      expectEqual(await text(page, 'reco-tax-saved'), before, 'tax saved after focus and blur');
      expectTrue((await count(page, '[data-code="EXISTING_EXCEEDS_CAP"]')) > 0, 'the over-the-cap caution should still show');
      await resetToExample(page);
    });

    await check('CPF override: an empty field falls back to the estimate, and S$0 is called out', async () => {
      await page.locator('section[aria-labelledby="g-income"] details.more > summary').click();
      await page.locator('#cpfOverrideOn').check();
      expectEqual(await page.locator('#cpfOverride').inputValue(), '20,400', 'prefilled with the estimate');
      await setField(page, 'cpfOverride', '');
      expectEqual(await page.locator('#cpfOverride').inputValue(), '', 'an emptied override stays empty');
      expectEqual(await text(page, 'cpf-employee'), 'S$20,400', 'CPF used with an empty override');
      expectEqual(await text(page, 'reco-tax-saved'), 'S$2,679.50', 'tax saved with an empty override');
      await setField(page, 'cpfOverride', '0');
      expectTrue(
        /no CPF relief/i.test(await page.locator('#cpfOverride-caution').innerText()),
        'an override of S$0 should say what it means',
      );
      await setField(page, 'cpfOverride', '18000');
      expectEqual(await text(page, 'cpf-employee'), 'S$18,000', 'CPF used with an override');
      await resetToExample(page);
    });

    await check('annual pay: S$100,000 survives a round trip through Monthly and every dollar is counted', async () => {
      await choose(page, 'payMode-annual');
      expectEqual(await page.locator('#salary').inputValue(), '120,000', 'S$10,000 a month shown as a year');
      await setField(page, 'salary', '100000');
      expectEqual(await text(page, 'pay-counted'), 'S$115,000', 'pay counted with S$100,000 a year and a S$15,000 bonus');
      await choose(page, 'payMode-monthly');
      expectEqual(await page.locator('#salary').inputValue(), '8,333', 'monthly view of S$100,000 a year');
      await choose(page, 'payMode-annual');
      expectEqual(await page.locator('#salary').inputValue(), '100,000', 'annual salary after the round trip');
      const working = (await page.locator('[data-testid="working-table"]').innerText()).replace(/\s+/g, ' ');
      expectTrue(working.includes('Employment income S$115,000'), 'the tax working should use S$115,000');
      await page.locator('#monthsWorked').selectOption('3');
      expectEqual(await page.locator('label[for="salary"]').innerText(), 'Full-year salary', 'label for part of a year');
      await setField(page, 'bonus', '0');
      expectEqual(await text(page, 'pay-counted'), 'S$25,000', 'three months of S$100,000 a year');
      await resetToExample(page);
    });

    await check('low salary (Appendix A.3): nothing at 7%, then Every tax dollar gives SRS S$15,300 + CPF S$100', async () => {
      await enterA3(page);
      expectEqual(await text(page, 'reco-tax-before'), 'S$389.00', 'A.3 tax before');
      expectEqual(await text(page, 'reco-srs'), 'S$0', 'A.3 SRS at the 7% minimum');
      expectEqual(await text(page, 'reco-tax-saved'), 'S$0.00', 'A.3 tax saved at the 7% minimum');
      expectTrue(/nothing/i.test(await text(page, 'reco-headline')), 'S$0 plan should say so');
      expectTrue((await text(page, 'reco-reason')).includes('3.5 cents'), 'S$0 plan should explain the 3.5 cent saving');
      expectEqual(await count(page, '[data-testid="offer-every"]'), 1, 'offer of the Every tax dollar view');
      const bar = (await page.locator('[data-testid="sticky-bar"]').innerText()).replace(/\s+/g, ' ');
      expectTrue(/Nothing more to put in this year/.test(bar) && !/Save S\$0/.test(bar), `the bar reads "${bar}"`);
      const note = (await page.locator('[data-testid="warnings"] [data-code="BELOW_MIN_SAVING_RATE"]').innerText()).replace(/\s+/g, ' ');
      expectTrue(/3\.5 cents/.test(note) && /7 cents/.test(note) && !/%/.test(note), `the note reads "${note}"`);
      await choose(page, 'depth-every');
      expectEqual(await text(page, 'reco-srs'), 'S$15,300', 'A.3 SRS with Every tax dollar');
      expectEqual(await text(page, 'reco-cpf-self'), 'S$100', 'A.3 CPF with Every tax dollar');
      expectEqual(await text(page, 'reco-tax-after'), 'S$0.00', 'A.3 tax after');
      expectEqual(await text(page, 'reco-tax-saved'), 'S$389.00', 'A.3 tax saved');
      await noJunk(page, 'A.3');
    });

    await check('one rate, one unit: 2.53 cents on the card and 2.53 in the cents column of the comparison (A.3)', async () => {
      expectEqual(await text(page, 'reco-rate'), '2.53 cents', 'saving per dollar on the card');
      expectEqual(await text(page, 'plan-row-rate'), '2.53', 'saved per dollar in the plan row');
      const head = (await page.locator('[data-testid="scenario-table"] thead').innerText()).replace(/\s+/g, ' ');
      expectTrue(/Saved per dollar \(cents\)/.test(head), `the column headings read "${head}"`);
      const table = (await page.locator('[data-testid="scenario-table"] tbody').innerText()).replace(/\s+/g, ' ');
      expectTrue(!/%/.test(table), `the comparison still shows a percentage: "${table}"`);
    });

    await check('the offer button under a S$0 plan switches to Every tax dollar', async () => {
      await choose(page, 'depth-default');
      expectEqual(await text(page, 'reco-tax-saved'), 'S$0.00', 'back at the 7% minimum');
      const offer = (await page.locator('.slab-offer').innerText()).replace(/\s+/g, ' ');
      expectTrue(offer.includes('2.53 cents back per dollar'), `the offer reads "${offer}"`);
      await page.locator('[data-testid="offer-every"]').click();
      expectTrue(await page.locator('#depth-every').isChecked(), 'Every tax dollar should be selected');
      expectEqual(await text(page, 'reco-tax-saved'), 'S$389.00', 'tax saved after taking the offer');
    });

    await check('custom minimum: short option labels that fit the control', async () => {
      await choose(page, 'depth-custom');
      const labels = await page.locator('#customRate option').allInnerTexts();
      expectTrue(labels.length > 0 && labels.every((l) => /^[\d.]+ cents? or more$/.test(l.trim())), `options read ${JSON.stringify(labels)}`);
      await resetToExample(page);
    });

    await check('itemised reliefs add up, and long choices are listed in full instead of cut short in a drop-down', async () => {
      // A total the person typed is carried into the helper, the way Monthly and Annual keep the pay.
      await setField(page, 'reliefTotal', '5000');
      await choose(page, 'reliefMode-itemised');
      expectEqual(await text(page, 'relief-total'), 'S$5,000', 'the typed total carries into the helper');
      expectEqual(await page.locator('#relief-other').inputValue(), '5,000', '"Any other relief" after the switch');
      expectEqual(await text(page, 'reco-tax-saved'), 'S$2,679.50', 'the plan does not change on switching');
      expectEqual(await count(page, '[data-testid="relief-example-note"]'), 0, 'no example note on a typed total');
      await setField(page, 'relief-other', '0');
      expectEqual(await text(page, 'relief-total'), 'S$0', 'itemised total once that is cleared');
      await page.locator('#relief-spouse').check();
      await page.locator('#relief-qualifyingChild').selectOption('2');
      await choose(page, 'relief-nsmanSelf-3');
      expectEqual(await text(page, 'relief-total'), 'S$13,500', 'spouse + two children + NSman key appointment holder');
      const chosen = (await page.locator('label[for="relief-nsmanSelf-3"]').innerText()).trim();
      expectTrue(/Key appointment holder, no activities/.test(chosen), `the chosen NSman relief reads "${chosen}"`);
      expectEqual((await truncatedSelects(page)).join('; '), '', 'drop-downs that cut their label short');
      await page.locator('section[aria-labelledby="g-reliefs"] details.more > summary').click();
      expectEqual((await unlabelledControls(page)).join(', '), '', 'controls without a label or id in the helper');
      const working = (await page.locator('[data-testid="working-table"]').innerText()).replace(/\s+/g, ' ');
      expectTrue(working.includes('Other reliefs S$13,500'), 'the tax working should use the itemised total');
      // And back: the single field takes the itemised sum, so the plan stays where it was.
      const itemised = await text(page, 'reco-tax-saved');
      await choose(page, 'reliefMode-total');
      expectEqual(await page.locator('#reliefTotal').inputValue(), '13,500', 'the total after switching back');
      expectEqual(await text(page, 'reco-tax-saved'), itemised, 'tax saved after switching back');
      await resetToExample(page);
    });

    await check('foreigner: CPF schemes are hidden, the reason is given, and no CPF rule values are listed', async () => {
      expectEqual(await count(page, '#useCpfSelf'), 1, 'CPF self is offered to a citizen');
      const citizenRules = (await page.locator('.sources .rows').innerText()).replace(/\s+/g, ' ');
      expectTrue(/CPF cash top-up relief, self/.test(citizenRules), 'a citizen should see the CPF rule values');
      await choose(page, 'residency-foreigner');
      expectEqual(await count(page, '#useCpfSelf'), 0, 'CPF top-up (self) checkbox');
      expectEqual(await count(page, '#useCpfFamily'), 0, 'CPF top-up (family) checkbox');
      expectEqual(await count(page, '#existingCpfSelf'), 0, 'CPF self already-contributed field');
      expectEqual(await count(page, '#existingCpfFamily'), 0, 'CPF family already-contributed field');
      expectEqual(await count(page, '[data-testid="reco-cpf-self"]'), 0, 'CPF row in the recommendation');
      expectEqual(await count(page, '#useSrs'), 1, 'SRS stays');
      // The reason is given once, in the engine's words, where the missing columns of the lock-up facts would
      // be. (It used to be said a second time, in the page's own words, under "Schemes to use".)
      expectEqual(await count(page, '[data-testid="foreigner-note"]'), 0, 'a second "not open" line under "Schemes to use"');
      const note = await flat(page, 'facts-not-open');
      expectTrue(/Foreigners on work passes do not contribute to CPF/.test(note), `explanation reads "${note}"`);
      expectEqual(await text(page, 'reco-srs'), 'S$35,700', 'foreigner SRS cap');
      const rules = (await page.locator('.sources .rows').innerText()).replace(/\s+/g, ' ');
      expectTrue(!/top-up relief|ceiling for CPF|Retirement Sum|Healthcare Sum/.test(rules), `rule values read "${rules}"`);
      expectTrue(/SRS cap for you S\$35,700/.test(rules), 'the SRS cap should still be listed');
      // No CPF-named options that are "SRS only" under another name.
      const options = await page.locator('[data-testid="scenario-table"] tbody tr').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-scenario')));
      expectEqual(options.join(' '), 'none srsOnly recommended', 'options compared for a foreigner');
      await noJunk(page, 'foreigner');
    });

    await check('PR shows the PR year; age 55 shows the birth month; income year 2027 is flagged projected everywhere', async () => {
      await resetToExample(page);
      expectEqual(await count(page, '#prYear-1'), 0, 'PR year hidden for a citizen');
      expectEqual(await count(page, '#birthMonth'), 0, 'birth month hidden at 35');
      await choose(page, 'residency-pr');
      expectEqual(await count(page, '#prYear-1'), 1, 'PR year shown for a PR');
      await setField(page, 'age', '55');
      expectEqual(await count(page, '#birthMonth'), 1, 'birth month shown at 55');
      const years = await page.locator('#incomeYear option').allInnerTexts();
      expectTrue(years.some((y) => /2027/.test(y) && /projected/i.test(y)), `income years read ${JSON.stringify(years)}`);
      await page.locator('#incomeYear').selectOption('2027');
      expectTrue(/projected/i.test(await page.locator('#results').innerText()), 'results should flag projected rules');
      expectTrue(/YA2028 \(projected\)/.test(await flat(page, 'bar-fine')), `the bar reads "${await flat(page, 'bar-fine')}"`);
      await recordClipboard(page);
      const summary = await copiedSummary(page);
      expectTrue(/Projected rules/.test(summary), 'the copied summary should say the rules are projected');
      // The closed selector must show its whole label, not "2027 (YA202…".
      expectEqual((await truncatedSelects(page)).join('; '), '', 'drop-downs that cut their label short');
      await noJunk(page, 'projected year');
    });

    await check('PR in the first year: the note names a control that exists ("3rd year onwards")', async () => {
      await page.locator('#incomeYear').selectOption('2026');
      await choose(page, 'prYear-1');
      const note = await page.locator('[data-code="PR_GRADUATED_RATES"] p').first().innerText();
      const quoted = (/"([^"]+)"/.exec(note) || [])[1];
      const label = (await page.locator('label[for="prYear-3"]').innerText()).trim();
      expectEqual(label, quoted, 'the control the note points to');
      await resetToExample(page);
    });

    await check('Appendix A.2: CPF S$8,000, SRS S$10,300, family S$1,700, saved S$3,000.00, listed in the chosen order', async () => {
      await enterA2(page);
      expectEqual(await text(page, 'reco-cpf-self'), 'S$8,000', 'A.2 CPF self');
      expectEqual(await text(page, 'reco-srs'), 'S$10,300', 'A.2 SRS');
      expectEqual(await text(page, 'reco-cpf-family'), 'S$1,700', 'A.2 family');
      expectEqual(await text(page, 'reco-tax-before'), 'S$12,246.00', 'A.2 tax before');
      expectEqual(await text(page, 'reco-tax-after'), 'S$9,246.00', 'A.2 tax after');
      expectEqual(await text(page, 'reco-tax-saved'), 'S$3,000.00', 'A.2 tax saved');
      const headline = await flat(page, 'reco-headline');
      expectTrue(
        headline.startsWith(
          "Put S$8,000 into your CPF as a cash top-up, S$10,300 into SRS and S$1,700 into family members' CPF as a cash top-up.",
        ),
        `headline reads "${headline}"`,
      );
      const slip = await page.locator('.slip .row dt').allInnerTexts();
      expectEqual(slip.slice(0, 3).join(' | '), 'CPF cash top-up, self | SRS | CPF cash top-up, family', 'order of the scheme rows');
      const reason = await flat(page, 'reco-reason');
      expectEqual(
        reason,
        'This uses your whole S$20,000 cash limit. Without the limit the plan would save S$3,096.00 by locking away S$20,640.',
        'A.2 reason',
      );
      await noJunk(page, 'A.2');
    });

    await check('A.2 at 1280px: no table scrolls sideways, and the over-the-cap tier says why it saves nothing', async () => {
      expectEqual((await scrollingTables(page)).join('; '), '', 'tables that scroll');
      expectEqual(await count(page, '[data-testid="ladder-table"] tbody tr'), 2, 'ladder rows');
      const last = (await page.locator('[data-testid="ladder-table"] tbody tr').nth(1).innerText()).replace(/\s+/g, ' ');
      expectTrue(/No tax saved: over the S\$80,000 relief cap/.test(last) && /0%/.test(last), `tier reads "${last}"`);
      const first = (await page.locator('[data-testid="ladder-table"] tbody tr').first().innerText()).replace(/\s+/g, ' ');
      expectTrue(first.includes('S$20,000 of it'), `first tier reads "${first}"`);
      const cut = await page.evaluate(() => {
        const box = document.querySelector('[data-testid="ladder-table"]').closest('.table-scroll').getBoundingClientRect();
        return Array.from(document.querySelectorAll('[data-testid="ladder-table"] td, [data-testid="ladder-table"] th'))
          .filter((cell) => cell.getBoundingClientRect().right > box.right + 0.5)
          .map((cell) => cell.textContent);
      });
      expectEqual(cut.join(' | '), '', 'ladder cells cut off at the right');
      await page.locator('#ladder').evaluate((el) => el.scrollIntoView());
      await page.screenshot({ path: path.join(SHOTS, 'desktop-a2-ladder.png') });
      // Hovering a block reads out its figures, with S$ still written S$.
      await page.locator('.chart-hit').first().hover({ force: true });
      const tip = (await page.locator('.chart-tip').innerText()).replace(/\s+/g, ' ');
      expectTrue(tip.includes('S$3,096.00 saved') && tip.includes('In your plan: S$20,000 of it'), `the tip reads "${tip}"`);
      const spoken = await page.locator('.chart-hit').first().getAttribute('aria-label');
      expectTrue(spoken.includes('In your plan: S$20,000 of it.'), `the block is announced as "${spoken}"`);
      await page.mouse.move(2, 2);
    });

    await check('A.2 on a tablet (768px): every table still fits without sideways scrolling', async () => {
      await page.setViewportSize({ width: 768, height: 1024 });
      await page.waitForTimeout(200);
      expectEqual((await scrollingTables(page)).join('; '), '', 'tables that scroll at 768px');
      const o = await overflow(page);
      expectTrue(o.scrollWidth <= o.innerWidth, `scrollWidth ${o.scrollWidth} > innerWidth ${o.innerWidth}`);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.waitForTimeout(200);
    });

    await check('A.2 at 1024px, beside the narrower rail: no table scrolls sideways, the simulator included', async () => {
      await page.setViewportSize({ width: 1024, height: 768 });
      await page.locator('#simulator').evaluate((el) => (el.open = true));
      await page.waitForTimeout(250);
      const rail = await page.evaluate(() => Math.round(document.querySelector('.rail').getBoundingClientRect().width));
      expectEqual(rail, 336, 'rail width between 960px and 1199px');
      expectEqual((await scrollingTables(page)).join('; '), '', 'tables that scroll at 1024px');
      expectEqual(await count(page, '[data-testid="scroll-hint"]'), 0, 'scroll hints at 1024px');
      // Three scheme columns do not fit this column as a table, so the comparison is restacked in full.
      expectEqual(
        await page.locator('[data-testid="scenario-table"]').evaluate((t) => t.parentElement.getAttribute('data-stacked')),
        'rows',
        'the comparison at 1024px with three schemes',
      );
      const plan = await stackedBlock(page, '[data-scenario="recommended"]');
      expectTrue(plan.startsWith('Tax saved S$3,000.00 | Cash locked away S$20,000'), `the plan block reads "${plan}"`);
      expectTrue(/Wasted dollars None/.test(plan) && /CPF cash top-up, family S\$1,700/.test(plan), `the plan block reads "${plan}"`);
      const o = await overflow(page);
      expectTrue(o.scrollWidth <= o.innerWidth, `scrollWidth ${o.scrollWidth} > innerWidth ${o.innerWidth}`);
      await page.screenshot({ path: path.join(SHOTS, 'desktop-1024-a2.png'), fullPage: true });
    });
    await page.locator('#simulator').evaluate((el) => (el.open = false));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(200);

    await check('ladder chart: every label stays inside the drawing (A.2, and S$8,000 with SRS off)', async () => {
      const clipped = () =>
        page.evaluate(() => {
          const svg = document.querySelector('.chart-svg');
          const width = Number(svg.getAttribute('width'));
          const height = Number(svg.getAttribute('height'));
          return Array.from(svg.querySelectorAll('text'))
            .filter((t) => {
              const b = t.getBBox();
              return b.x < -0.5 || b.x + b.width > width + 0.5 || b.y < -0.5 || b.y + b.height > height + 0.5;
            })
            .map((t) => t.textContent);
        });
      expectEqual((await clipped()).join(', '), '', 'A.2 labels outside the drawing');
      await resetToExample(page);
      await page.locator('#useSrs').uncheck();
      expectEqual(await text(page, 'reco-locked'), 'S$8,000', 'cash locked away with SRS off');
      expectEqual((await clipped()).join(', '), '', 'labels outside the drawing at S$8,000');
      const ticks = await page.locator('.chart-svg .chart-tick').allTextContents();
      expectTrue(ticks.includes('8,000'), `x axis should end on 8,000: ${JSON.stringify(ticks)}`);
      const lede = (await page.locator('#compare .lede').innerText()).replace(/\s+/g, ' ');
      expectTrue(/even if you switched them off/.test(lede), 'Compare options should say it ignores switched-off schemes');
      await resetToExample(page);
    });

    await check('no tax to save: the ladder gives the reason in words in place of an empty chart', async () => {
      await setField(page, 'salary', '0');
      await setField(page, 'bonus', '0');
      expectEqual(await count(page, '[data-testid="ladder-flat"]'), 1, 'explanation in place of the chart');
      expectEqual(await count(page, 'svg.chart-svg'), 0, 'chart drawn with nothing to show');
      expectTrue((await count(page, '[data-testid="ladder-table"] tbody tr')) >= 1, 'the table should stay');
      expectTrue(/already tax-free/.test(await text(page, 'ladder-flat')), `explanation reads "${await text(page, 'ladder-flat')}"`);
      await noJunk(page, 'zero income');
      await resetToExample(page);
    });

    await check('no scheme switched on: one consistent message, with nothing about "schemes you switched on"', async () => {
      await page.locator('#useSrs').uncheck();
      await page.locator('#useCpfSelf').uncheck();
      expectTrue(/No scheme is switched on/.test(await flat(page, 'reco-reason')), 'the card should say no scheme is on');
      const note = (await page.locator('[data-testid="warnings"] [data-code="LEVER_LIMITS_PLAN"]').innerText()).replace(/\s+/g, ' ');
      expectTrue(/No scheme is switched on/.test(note) && !/5,039/.test(note), `the note reads "${note}"`);
      expectEqual(
        await flat(page, 'ladder-empty'),
        'No scheme is switched on. Switch one on under "Schemes to use" to see its ladder.',
        'the ladder with nothing switched on',
      );
      expectEqual(await count(page, '#ladder .lede'), 0, 'the lead-in about blocks and heights, with no chart under it');
      await resetToExample(page);
    });

    await check('schemes switched on but full: the ladder says so, and only offers what is there to switch on', async () => {
      await setField(page, 'existingSrs', '15300');
      await setField(page, 'existingCpfSelf', '8000');
      expectEqual(
        await flat(page, 'ladder-empty'),
        'The schemes you switched on are full for 2026. Switch on another under "Schemes to use" to see what it would save.',
        'the ladder with SRS and CPF self full',
      );
      await page.locator('#useCpfFamily').check();
      await setField(page, 'existingCpfFamily', '8000');
      expectEqual(await flat(page, 'ladder-empty'), 'The schemes you switched on are full for 2026.', 'with nothing left to switch on');
      await resetToExample(page);
    });

    await check('reliefs over the cap: one note about it, not two that end the same way', async () => {
      await setField(page, 'reliefTotal', '80000');
      expectEqual(await count(page, '[data-testid="warnings"] [data-code="RELIEF_CAP_EXCEEDED_BASELINE"]'), 1, 'the note about the reliefs');
      expectEqual(await count(page, '[data-testid="warnings"] [data-code="RELIEF_CAP_LIMITS_PLAN"]'), 0, 'the second note');
      const notes = (await page.locator('[data-testid="warnings"]').innerText()).replace(/\s+/g, ' ');
      expectEqual((notes.match(/would earn no tax relief/g) || []).length, 1, 'times "would earn no tax relief" is said');
      // With nothing changed by the plan, nothing in the working is marked as changed.
      expectEqual(await count(page, '[data-testid="working-table"] .changed'), 0, 'figures marked as changed by a S$0 plan');
      const lede = (await page.locator('#working .lede').innerText()).replace(/\s+/g, ' ');
      expectTrue(/Figures the plan changes are shaded/.test(lede), `the lead-in reads "${lede}"`);
      await resetToExample(page);
      const changed = await page.locator('[data-testid="working-table"] .changed').count();
      expectTrue(changed >= 4, `the example's plan should mark the lines it changes (${changed} marked)`);
      const totals = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid="working-table"] tr.is-total')).map((row) => ({
          label: row.querySelector('th').textContent,
          marked: row.querySelector('.changed') !== null,
          same: row.cells[1].textContent === row.cells[2].textContent.replace(' (changed by the plan)', ''),
        })),
      );
      expectEqual(totals.filter((t) => t.same && t.marked).map((t) => t.label).join(', '), '', 'unchanged totals marked as changed');
    });

    await check('simulator is collapsed by default and reacts to the step selector', async () => {
      expectTrue(!(await page.locator('#simulator').evaluate((el) => el.open)), 'simulator should start collapsed');
      await page.locator('#simulator > summary').click();
      const rows1000 = await count(page, '[data-testid="simulator-table"] tbody tr[data-step]');
      const link = () => page.locator('[data-jump="simulator"]').innerText();
      expectEqual((await link()).trim(), (await page.locator('#simulator-title').innerText()).trim(), 'the section link and its heading');
      await page.locator('#simulatorStep').selectOption('5000');
      const rows5000 = await count(page, '[data-testid="simulator-table"] tbody tr[data-step]');
      expectEqual(rows1000, 25, 'rows at S$1,000 steps up to S$23,300');
      expectEqual(rows5000, 6, 'rows at S$5,000 steps up to S$23,300');
      expectEqual((await link()).trim(), 'Every extra S$5,000', 'the section link after changing the step');
      const groups = await page.locator('[data-testid="simulator-table"] tr.group-row').allInnerTexts();
      expectEqual(groups.map((g) => g.trim().toLowerCase()).join(' | '), 'where you are now | in your plan', 'row groups for the example');
      await page.locator('#simulatorStep').selectOption('1000');
      await page.locator('#simulator > summary').click();
    });

    await check('theme toggle sets and removes data-theme', async () => {
      const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const light = await bg();
      await choose(page, 'theme-dark');
      expectEqual(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'dark', 'data-theme');
      const dark = await bg();
      expectTrue(dark !== light, 'background did not change in the dark theme');
      await choose(page, 'theme-light');
      expectEqual(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'light', 'data-theme');
      await choose(page, 'theme-system');
      expectEqual(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), null, 'data-theme');
    });

    await check('Copy summary copies the plan, with the reason that matches the card', async () => {
      await resetToExample(page);
      await recordClipboard(page);
      const summary = await copiedSummary(page);
      expectTrue(summary.includes('S$15,300') && summary.includes('S$2,679.50'), 'the summary is missing the plan');
      expectTrue(summary.includes('Example figures'), 'the summary of the example should say it is an example');
      expectTrue(!summary.includes('2,359.50'), 'the summary quotes the unreachable saving');
      expectTrue(summary.includes(await flat(page, 'reco-reason')), 'the summary reason should match the card');
    });

    await check('Copy summary when the browser refuses the clipboard: the whole summary is shown, selected, to copy by hand', async () => {
      for (const [how, breakClipboard] of [
        ['the clipboard rejects', () => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } })],
        ['there is no clipboard', () => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })],
      ]) {
        const own = await newPage(browser, { width: 1280, height: 900, label: 'copy-by-hand', fonts: 'block' });
        const p = own.page;
        // The 57-year-old with the room not entered: the caution must travel with the plan this way too.
        await setField(p, 'age', '57');
        await p.evaluate(breakClipboard);
        expectEqual(await count(p, '[data-testid="summary-text"]'), 0, `${how}: the box before the button is pressed`);
        await p.locator('[data-testid="copy-summary"]').click();
        const box = p.locator('[data-testid="summary-text"]');
        await box.waitFor({ timeout: 3000 });
        const shown = await box.inputValue();
        expectTrue(shown.startsWith('Singapore Tax Optimiser: plan for YA2027') && shown.includes('Put S$15,300 into SRS. You save S$1,759.50 in tax.'), `${how}: the summary reads "${shown.slice(0, 80)}"`);
        expectTrue(shown.includes('Check before you transfer:') && shown.includes('Your own CPF is left out until you enter how much you can still top up with relief (S$0 if you have set aside the Full Retirement Sum).'), `${how}: the summary should carry the caution`);
        expectTrue(shown.trim().endsWith(await flat(p, 'disclaimer')), `${how}: the summary should end with the disclaimer on the page`);
        // Selected from end to end and in focus, so one keystroke copies it; and the button does not claim "Copied".
        const state = await box.evaluate((el) => ({ focused: document.activeElement === el, from: el.selectionStart, to: el.selectionEnd, length: el.value.length, readOnly: el.readOnly }));
        expectTrue(state.focused && state.from === 0 && state.to === state.length && state.readOnly, `${how}: the box is ${JSON.stringify(state)}`);
        expectEqual((await p.locator('[data-testid="copy-summary"]').innerText()).trim(), 'Copy summary', `${how}: the button`);
        expectTrue(/copy it from here/.test(await p.locator('label[for="summary-text"]').innerText()), `${how}: the instruction above the box`);
        const o = await overflow(p);
        expectTrue(o.scrollWidth <= o.innerWidth, `${how}: scrollWidth ${o.scrollWidth} > innerWidth ${o.innerWidth}`);
        await own.context.close();
      }
    });

    await check('deadline passed (income year 2025): nothing tells the user to put money in now', async () => {
      await page.locator('#incomeYear').selectOption('2025');
      const headline = await flat(page, 'reco-headline');
      expectEqual(headline, 'The 31 Dec 2025 deadline has passed.', 'headline');
      const reason = await flat(page, 'reco-reason');
      expectTrue(/would have saved S\$2,679\.50 in tax for YA2026/.test(reason), `the card reads "${reason}"`);
      expectTrue(/counts for the following year/.test(reason), 'the card should say where money put in now counts');
      const card = (await page.locator('#recommendation').innerText()).replace(/\s+/g, ' ');
      expectTrue(!/\bPut S\$/.test(card) && !/You save/.test(card), `the card still instructs: "${card.slice(0, 200)}"`);
      expectTrue(/Tax this would have saved/.test(card), 'the figure should be labelled as what it would have saved');
      const bar = (await page.locator('[data-testid="sticky-bar"]').innerText()).replace(/\s+/g, ' ');
      expectTrue(!/^Save S\$/.test(bar) && /Deadline passed/.test(bar) && /would have saved S\$2,679\.50/.test(bar), `the bar reads "${bar}"`);
      const summary = await copiedSummary(page);
      expectTrue(/deadline for YA2026 has passed/.test(summary), 'the copied summary should say the deadline has passed');
      expectTrue(!/^Put S\$/m.test(summary) && !/You save/.test(summary), 'the copied summary still instructs');
      expectEqual(await count(page, '[data-scenario="recommended"] .tag-plan'), 0, '"Recommended" tag after the deadline');
      // Further down, nothing speaks as if the year were still open or suggests a way to save more.
      const before = (await page.locator('#before').innerText()).replace(/\s+/g, ' ');
      expectTrue(!/Switching on|would still save|Aim to transfer/.test(before), `"Before you transfer" still plans ahead: "${before.slice(0, 260)}"`);
      expectTrue(/The deadline for 2025 has passed/.test(before), 'the checklist should say the deadline has passed');
      expectEqual(await count(page, '[data-testid="warnings"] [data-code="LEVER_LIMITS_PLAN"]'), 0, 'the note about what stops the plan');
      await page.screenshot({ path: path.join(SHOTS, 'desktop-deadline-passed.png') });
    });

    await check('deadline passed: the notice offers the open year, and taking it brings the plan back', async () => {
      const button = page.locator('[data-testid="notice-switch-year"]');
      expectEqual((await button.innerText()).trim(), 'Plan for 2026 instead', 'the offer in the notice');
      expectEqual(await count(page, '[data-testid="reco-switch-year"]'), 1, 'the same offer on the card');
      await button.click();
      expectEqual(await page.locator('#incomeYear').inputValue(), '2026', 'income year after taking the offer');
      expectTrue((await flat(page, 'reco-headline')).startsWith('Put S$15,300 into SRS'), 'the plan should be back');
      expectEqual(await count(page, '[data-code="DEADLINE_PASSED"]'), 0, 'deadline notice for the open year');
    });

    await desktop.context.close();

    // ------------------------------------------------------------------ safeguards from the rule audit
    // Each of these opens its own copy of the page, so none depends on what an earlier check left behind.
    const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    const DISCLAIMER =
      'This is an estimate for planning, not tax, legal or financial advice. It is not affiliated with IRAS or the ' +
      'CPF Board. Check your eligibility and limits with IRAS, the CPF Board and your SRS bank before transferring ' +
      'money. CPF top-ups cannot be reversed.';
    const LEFT_OUT = 'Your own CPF is left out until you enter how much you can still top up with relief';

    await check('shared facts: nine lock-up rows per scheme, the cautions, what is left out and the disclaimer, as the engine words them', async () => {
      const own = await newPage(browser, { width: 1280, height: 900, label: 'facts', fonts: 'block' });
      const p = own.page;
      const heads = (await p.locator('[data-testid="facts-table"] thead th').allInnerTexts()).map((h) => h.trim());
      expectEqual(heads.slice(1).join(' | '), 'SRS | CPF cash top-up, self | CPF cash top-up, family', 'columns for a citizen');
      const rows = await p.locator('[data-testid="facts-table"] tbody tr').evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-fact')));
      expectEqual(rows.join(' '), 'relief lockedUntil sooner earns taxLater limits noRelief who deadline', 'the nine facts');
      const cell = async (factId, column) =>
        (await p.locator(`[data-testid="facts-table"] tr[data-fact="${factId}"] td`).nth(column).innerText()).replace(/\s+/g, ' ');
      // Sentences the rule audit asked for, which the page's old table did not have.
      expectTrue(/If you have left Singapore, there is no tax-free amount/.test(await cell('taxLater', 0)), `"Tax later" for SRS reads "${await cell('taxLater', 0)}"`);
      expectTrue(/A voluntary contribution to all three CPF accounts/.test(await cell('noRelief', 1)), `"No relief for" reads "${await cell('noRelief', 1)}"`);
      expectTrue(/the first S\$2,000 a year topped up for a member on the Matched Retirement Savings Scheme, and the first S\$1,000 a year to MediSave/.test(await cell('noRelief', 2)), `family "No relief for" reads "${await cell('noRelief', 2)}"`);
      expectTrue(/It cannot be withdrawn at 55 or used for housing/.test(await cell('lockedUntil', 1)), `"Locked until" for CPF reads "${await cell('lockedUntil', 1)}"`);
      expectTrue(/earned no more than S\$8,000 in 2025 \(the year before the top-up\)/.test(await cell('who', 2)), `"Who qualifies" reads "${await cell('who', 2)}"`);
      const cautions = await p.locator('[data-testid="transfer-cautions"] li').allInnerTexts();
      expectEqual(cautions.length, 6, 'things only the person can check, for a citizen');
      expectTrue(/at least 183 days in 2026/.test(cautions[0]), `the first caution reads "${cautions[0]}"`);
      expectTrue(cautions.some((c) => /choose the retirement top-up \(Special or Retirement Account\) or the MediSave top-up/.test(c)), 'the caution about which CPF transaction to choose');
      expectEqual((await p.locator('[data-testid="not-modelled"] li').count()), 8, 'entries under "What this does not model"');
      expectEqual(await flat(p, 'disclaimer'), DISCLAIMER, 'the disclaimer');
      // The reasons under "Which first?" are those same facts, so the two cannot drift apart.
      const why = (await p.locator('#order-flexibility-detail').innerText()).replace(/\s+/g, ' ');
      expectTrue(why.includes(await cell('sooner', 0)) && why.includes(await cell('sooner', 1)), `"Flexibility first" reads "${why}"`);
      const interest = (await p.locator('#order-interest-detail').innerText()).replace(/\s+/g, ' ');
      expectTrue(interest.includes(await cell('earns', 1)) && interest.includes(await cell('earns', 0)), `"Guaranteed interest first" reads "${interest}"`);
      // From 55 the account-limits row is the one for a Retirement Account.
      await setField(p, 'age', '57');
      expectTrue(/accepts top-ups to your Retirement Account up to the Enhanced Retirement Sum \(S\$440,800\)/.test(await cell('limits', 1)), `"Account limits" at 57 reads "${await cell('limits', 1)}"`);
      await own.context.close();
    });

    await check('foreigner: SRS is the only column, one line says CPF top-ups are not open, and no other CPF sentence is on the page', async () => {
      const own = await newPage(browser, { width: 1280, height: 900, label: 'foreigner-cpf', fonts: 'block' });
      const p = own.page;
      await enterForeigner(p);
      const heads = (await p.locator('[data-testid="facts-table"] thead th').allInnerTexts()).map((h) => h.trim());
      expectEqual(heads.slice(1).join(' | '), 'SRS', 'columns for a foreigner');
      const line = await flat(p, 'facts-not-open');
      expectTrue(/CPF top-ups do not earn tax relief/.test(line) && /S\$35,700 a year into SRS/.test(line), `the line under the facts reads "${line}"`);
      expectEqual(await count(p, '[data-testid="warnings"] [data-code="FOREIGNER_NO_CPF"]'), 0, 'the same line said a second time in the notes');
      expectTrue(/taxed as a non-resident: 15% or the resident rates/.test((await p.locator('tr[data-fact="taxLater"] td').first().innerText()).replace(/\s+/g, ' ')), 'the foreigner\'s "Tax later"');
      expectTrue(/give their SRS bank a declaration each year/.test((await p.locator('tr[data-fact="who"] td').first().innerText()).replace(/\s+/g, ' ')), 'the foreigner\'s "Who qualifies"');
      // Everything the page says, with every folded part opened and the five months that raise one more caution.
      await p.locator('#monthsWorked').selectOption('5');
      await choose(p, 'depth-every');
      await choose(p, 'payMode-annual');
      // The line read out to screen readers settles a moment after the last change; it is part of the page too.
      await p.waitForTimeout(1100);
      let body = await pageText(p);
      expectTrue(/Aim to transfer a few working days before 31 December 2026/.test(body), 'the checklist should be on the page being read');
      // What may name CPF on a foreigner's page: the product's strapline, the ONE line that says CPF top-ups are
      // not open to them, and two sentences of the shared wording that the page renders as the engine gives
      // them (the disclaimer; a passing mention in what the tool leaves out). The last line of the checklist no
      // longer names the CPF Board for someone who cannot make a CPF top-up.
      expectEqual(await count(p, '[data-testid="foreigner-note"]'), 0, 'a second line, in other words, saying CPF top-ups are not open');
      expectEqual(body.split(line).length - 1, 1, 'times the "not open" line is on the page');
      // (The disclaimer, which is the engine's and is the same for everyone, ends "CPF top-ups cannot be reversed.")
      expectEqual((body.split(DISCLAIMER).join(' ').match(/CPF top-ups/g) || []).length, 1, 'sentences about CPF top-ups on a foreigner\'s page, the disclaimer aside');
      const allowed = [
        'Year-end SRS and CPF planner',
        line,
        DISCLAIMER,
        'Investment returns inside SRS or CPF, and what your balances will be at retirement.',
      ];
      expectTrue(
        body.includes('Banks stop taking same-day SRS contributions before midnight on the last day.'),
        'the checklist should end with the bank cut-off alone for a foreigner',
      );
      for (const sentence of allowed) {
        expectTrue(body.includes(sentence), `expected to find "${sentence.slice(0, 60)}" on the page`);
        body = body.split(sentence).join(' ');
      }
      const left = body.match(/[^.]*\b(CPF|Retirement Account|Special Account)\b[^.]*\./g) || [];
      expectEqual(left.map((sentence) => sentence.trim()).join(' || '), '', 'CPF sentences on a foreigner\'s page');
      // "Which first?" orders schemes; with one scheme there is nothing to order.
      expectEqual(await count(p, '#order-flexibility'), 0, '"Which first?" for someone with one scheme');
      const working = (await p.locator('[data-testid="working-table"]').innerText()).replace(/\s+/g, ' ');
      expectTrue(/SRS relief/.test(working) && /Earned Income Relief/.test(working), 'the working should keep the reliefs that apply');
      expectEqual(await count(p, '[data-testid="monthly-deadlines"] li'), 1, 'cut-off lines in the monthly plan');
      expectTrue(/^SRS:/.test((await p.locator('[data-testid="monthly-deadlines"] li').first().innerText()).trim()), 'the one cut-off line is the bank\'s');
      await noJunk(p, 'foreigner, everything open');
      await own.context.close();
    });

    await check('age 57, room blank: own CPF is left out, the card and the caution under it say why, and the field is asked for', async () => {
      const own = await newPage(browser, { width: 1280, height: 900, label: 'age-57', fonts: 'block' });
      const p = own.page;
      // Below 55 the field is optional and a blank means "not limiting".
      expectEqual((await p.locator('label[for="cpfSelfRoom"]').innerText()).trim(), 'Top-up that can still earn relief (optional)', 'the label at 35');
      expectEqual(await p.locator('#cpfSelfRoom').getAttribute('aria-required'), null, 'aria-required at 35');
      expectEqual(await count(p, '[data-testid="cpfSelfRoom-needed"]'), 0, '"Needed" at 35');
      expectTrue(/Leave this empty if those limits are far off/.test(await p.locator('#cpfSelfRoom-hint').innerText()), 'the hint at 35');
      await setField(p, 'age', '57');
      expectEqual(await text(p, 'reco-srs'), 'S$15,300', 'SRS at 57');
      expectEqual(await text(p, 'reco-cpf-self'), 'Left out', 'own CPF at 57 with the room blank');
      expectEqual(await text(p, 'reco-tax-saved'), 'S$1,759.50', 'tax saved at 57 with the room blank');
      expectEqual(await text(p, 'reco-locked'), 'S$15,300', 'cash locked away');
      const headline = await flat(p, 'reco-headline');
      expectEqual(headline, 'Put S$15,300 into SRS. You save S$1,759.50 in tax.', 'headline');
      const reason = await flat(p, 'reco-reason');
      expectTrue(reason.includes(`${LEFT_OUT}.`), `the card reads "${reason}"`);
      expectTrue(!/filled every scheme you switched on|no room left for it/.test(reason), `the card calls the schemes full: "${reason}"`);
      // The engine's caution, in its own words, straight under the card.
      const caution = p.locator('[data-testid="plan-cautions"] [data-code="CPF_SELF_ROOM_UNCONFIRMED"]');
      const said = (await caution.locator('p').innerText()).replace(/\s+/g, ' ');
      expectEqual(
        said,
        'From age 55 the CPF Board accepts top-ups up to the Enhanced Retirement Sum (S$440,800), but only the part up to the Full Retirement Sum (S$220,400) earns relief, and a top-up cannot be reversed. Your own CPF is left out until you enter how much you can still top up with relief (S$0 if you have set aside the Full Retirement Sum).',
        'the caution',
      );
      // The field: asked for, marked while blank, and it says where to find the figure.
      expectEqual((await p.locator('label[for="cpfSelfRoom"]').innerText()).trim(), 'Top-up that can still earn relief', 'the label at 57');
      expectEqual(await text(p, 'cpfSelfRoom-needed'), 'Needed', 'the mark on the blank field');
      expectEqual(await p.locator('#cpfSelfRoom').getAttribute('aria-required'), 'true', 'aria-required at 57');
      const hint = (await p.locator('#cpfSelfRoom-hint').innerText()).replace(/\s+/g, ' ');
      expectEqual(
        hint,
        'Log in to CPF and open the Retirement dashboard to see how much you can still top up with tax relief. From 55 the CPF Board accepts more than that, and the extra earns no relief and cannot be taken back. Enter S$0 if you have already set aside the Full Retirement Sum (S$220,400).',
        'the hint: where to find the figure, and that S$0 is an answer',
      );
      // Where to find it is the engine's own caution, the same sentence as in the checklist lower down.
      const checklist = (await p.locator('[data-testid="transfer-cautions"] li').allInnerTexts()).map((c) => c.replace(/\s+/g, ' ').trim());
      expectTrue(checklist.some((c) => c.startsWith('Log in to CPF') && hint.startsWith(c)), 'the hint should open with the checklist\'s own line about the Retirement dashboard');
      expectTrue(/left out of the plan/.test(await p.locator('#cpfSelfRoom-caution').innerText()), 'the note under the blank field');
      // A way to jump to it.
      await p.locator('[data-testid="caution-enter-room"]').click();
      await p.waitForFunction(() => document.activeElement && document.activeElement.id === 'cpfSelfRoom', null, { timeout: 3000 });
      await p.waitForFunction(
        () => {
          const box = document.getElementById('cpfSelfRoom').getBoundingClientRect();
          return box.top >= 0 && box.bottom <= window.innerHeight;
        },
        null,
        { timeout: 3000 },
      );
      await p.screenshot({ path: path.join(SHOTS, 'desktop-57-room-blank.png') });
      // The comparison respects the same rule: nothing is assumed about their own CPF.
      const options = await p.locator('[data-testid="scenario-table"] tbody tr').evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-scenario')));
      expectEqual(options.join(' '), 'none srsOnly recommended', 'options compared while the room is blank');
      expectTrue(/Your own CPF is left out of them until you enter/.test((await p.locator('#compare .lede').innerText()).replace(/\s+/g, ' ')), 'the comparison should say why it has no CPF option');
      const summary = await (async () => {
        await recordClipboard(p);
        return copiedSummary(p);
      })();
      expectTrue(summary.includes(said), 'the copied summary should carry the caution');
      expectTrue(summary.includes('Check before you transfer:'), 'the copied summary should head the cautions');
      await own.context.close();
    });

    await check('age 57, room filled: the plan uses it (S$3,000, then S$0, then more than S$8,000), and nothing is marked as needed', async () => {
      const own = await newPage(browser, { width: 1280, height: 900, label: 'age-57-filled', fonts: 'block' });
      const p = own.page;
      await setField(p, 'age', '57');
      await setField(p, 'cpfSelfRoom', '3000');
      expectEqual(await text(p, 'reco-cpf-self'), 'S$3,000', 'own CPF with S$3,000 of room');
      expectEqual(await text(p, 'reco-tax-saved'), 'S$2,104.50', 'tax saved with S$3,000 of room');
      expectEqual(await count(p, '[data-testid="plan-cautions"]'), 0, 'cautions under the card once the room is entered');
      expectEqual(await count(p, '[data-testid="cpfSelfRoom-needed"]'), 0, '"Needed" once the room is entered');
      expectEqual(await count(p, '#cpfSelfRoom-caution'), 0, 'the note under the field once it is filled');
      const note = (await p.locator('[data-testid="warnings"] [data-code="AGE_55_PLUS_TOPUP"] p').innerText()).replace(/\s+/g, ' ');
      expectTrue(/The plan uses the room you entered \(S\$3,000\); check it against your CPF Retirement dashboard/.test(note), `the note reads "${note}"`);
      expectTrue((await flat(p, 'reco-headline')).startsWith('Put S$15,300 into SRS and S$3,000 into your CPF as a cash top-up.'), 'headline with the room entered');
      // S$0 is an answer: the Full Retirement Sum is already set aside.
      await setField(p, 'cpfSelfRoom', '0');
      expectEqual(await text(p, 'reco-cpf-self'), 'S$0', 'own CPF with no room');
      expectEqual(await count(p, '[data-testid="plan-cautions"]'), 0, 'cautions with S$0 entered');
      expectTrue(/^You have filled every scheme you switched on/.test(await flat(p, 'reco-reason')), `the reason with S$0 reads "${await flat(p, 'reco-reason')}"`);
      // Any figure confirms it, one above the yearly cap included.
      await setField(p, 'cpfSelfRoom', '50000');
      expectEqual(await text(p, 'reco-cpf-self'), 'S$8,000', 'own CPF with plenty of room');
      // Emptied again, it is asked for again.
      await setField(p, 'cpfSelfRoom', '');
      expectEqual(await text(p, 'reco-cpf-self'), 'Left out', 'own CPF once the field is emptied');
      expectEqual(await count(p, '[data-testid="cpfSelfRoom-needed"]'), 1, '"Needed" once the field is emptied');
      // With nothing else switched on, the plan is "nothing yet", never "the schemes are full".
      await p.locator('#useSrs').uncheck();
      expectEqual(await flat(p, 'reco-headline'), 'Nothing to put in yet.', 'headline with only the unconfirmed CPF switched on');
      expectTrue((await flat(p, 'reco-reason')).startsWith(`Nothing can go in yet. ${LEFT_OUT}`), `the reason reads "${await flat(p, 'reco-reason')}"`);
      expectTrue(/There is no ladder to draw yet/.test(await flat(p, 'ladder-empty')), `the ladder reads "${await flat(p, 'ladder-empty')}"`);
      await noJunk(p, 'age 57');
      await own.context.close();
    });

    await check('Appendix A.2b: the same person with the room left blank gets SRS S$10,300 + family S$8,000 and saves S$2,745.00', async () => {
      const own = await newPage(browser, { width: 1280, height: 900, label: 'a2b', fonts: 'block' });
      const p = own.page;
      await enterA2(p);
      await setField(p, 'cpfSelfRoom', '');
      expectEqual(await text(p, 'reco-srs'), 'S$10,300', 'A.2b SRS');
      expectEqual(await text(p, 'reco-cpf-family'), 'S$8,000', 'A.2b family');
      expectEqual(await text(p, 'reco-cpf-self'), 'Left out', 'A.2b own CPF');
      expectEqual(await text(p, 'reco-tax-after'), 'S$9,501.00', 'A.2b tax after');
      expectEqual(await text(p, 'reco-tax-saved'), 'S$2,745.00', 'A.2b tax saved');
      const codes = await p.locator('[data-testid="plan-cautions"] > li').evaluateAll((items) => items.map((li) => li.getAttribute('data-code')));
      expectEqual(codes.join(' '), 'CPF_SELF_ROOM_UNCONFIRMED FAMILY_TOPUP_CHECKS', 'cautions under the card');
      await own.context.close();
    });

    await check('cautions sit with the recommendation: directly under the card, on the first screen, and are not repeated lower down', async () => {
      const own = await newPage(browser, { width: 1280, height: 900, label: 'cautions', fonts: 'block' });
      const p = own.page;
      expectEqual(await count(p, '[data-testid="plan-cautions"]'), 0, 'cautions on the untouched example');
      await setField(p, 'age', '57');
      await p.locator('#useCpfFamily').check();
      await p.locator('#hasPtr').check();
      const codes = await p.locator('[data-testid="plan-cautions"] > li').evaluateAll((items) => items.map((li) => li.getAttribute('data-code')));
      expectEqual(codes.join(' '), 'CPF_SELF_ROOM_UNCONFIRMED FAMILY_TOPUP_CHECKS PARENTHOOD_TAX_REBATE', 'cautions under the card');
      await p.evaluate(() => window.scrollTo(0, 0));
      const card = await placed(p, '#recommendation');
      const block = await placed(p, '.answer-checks');
      const hero = await p.locator('[data-testid="reco-tax-saved"]').boundingBox();
      expectTrue(hero && hero.y >= 0 && hero.y + hero.height <= 900, 'the cautions must not push the answer off the first screen');
      expectTrue(block.top >= card.bottom && block.top - card.bottom <= 24, `the cautions start ${block.top - card.bottom}px under the card`);
      expectTrue(block.top < 900, `the cautions start at ${block.top}px, below the first screen`);
      // Nothing comes between the card and its cautions.
      expectTrue(await p.evaluate(() => document.querySelector('.answer-checks').previousElementSibling.id === 'recommendation'), 'the cautions should follow the card directly');
      // Each is said once on the page.
      for (const code of codes) {
        expectEqual(await count(p, `[data-code="${code}"]`), 1, `times ${code} is shown`);
        expectEqual(await count(p, `[data-testid="warnings"] [data-code="${code}"]`), 0, `${code} in the list lower down`);
      }
      const family = (await p.locator('[data-code="FAMILY_TOPUP_CHECKS"] p').innerText()).replace(/\s+/g, ' ');
      expectEqual(
        family,
        'Family top-ups: the part the Government matches earns you no relief — the first S$2,000 a year for a member on the Matched Retirement Savings Scheme, S$1,000 for MediSave. The amounts here are top-ups beyond that, to a family member who qualifies.',
        'the family caution',
      );
      await recordClipboard(p);
      const summary = await copiedSummary(p);
      for (const code of codes) {
        const message = (await p.locator(`[data-code="${code}"] p`).innerText()).replace(/\s+/g, ' ');
        expectTrue(summary.includes(`- ${message}`), `the copied summary is missing the ${code} caution`);
      }
      // The live region tells a screen-reader user that there are things to check.
      await p.waitForFunction(() => /3 things to check before you act/.test(document.querySelector('[data-testid="live"]').textContent), null, { timeout: 4000 });
      await own.context.close();

      // On a phone the cautions are the next thing after the card, with the newcomer's lines folded under them.
      const phone = await newPage(browser, { width: 390, height: 844, label: 'cautions-phone', touch: true, fonts: 'block' });
      const q = phone.page;
      await q.locator('[data-testid="toggle-inputs"]').click();
      await setField(q, 'age', '57');
      await q.locator('[data-testid="toggle-inputs"]').click();
      const phoneCard = await placed(q, '#recommendation');
      const phoneBlock = await placed(q, '.answer-checks');
      expectTrue(phoneBlock.top >= phoneCard.bottom && phoneBlock.top - phoneCard.bottom <= 24, `on a phone the cautions start ${phoneBlock.top - phoneCard.bottom}px under the card`);
      const heroPhone = await q.locator('[data-testid="reco-tax-saved"]').boundingBox();
      expectTrue(heroPhone && heroPhone.y + heroPhone.height <= 844, 'on a phone the answer stays on the first screen');
      // The jump opens the folded form and lands in the field.
      expectTrue(!(await q.locator('#cpfSelfRoom').isVisible()), 'the form should start folded');
      await q.locator('[data-testid="caution-enter-room"]').tap();
      await q.waitForFunction(() => document.activeElement && document.activeElement.id === 'cpfSelfRoom', null, { timeout: 4000 });
      expectTrue(await q.locator('#cpfSelfRoom').isVisible(), 'the field should be on screen after the jump');
      const o = await overflow(q);
      expectTrue(o.scrollWidth <= o.innerWidth, `scrollWidth ${o.scrollWidth} > innerWidth ${o.innerWidth}`);
      await phone.context.close();
    });

    await check('Parenthood Tax Rebate tick-box: under Other reliefs, raises the caution, changes no figure, and is remembered', async () => {
      const own = await newPage(browser, { width: 1280, height: 900, label: 'ptr', fonts: 'block' });
      const p = own.page;
      expectTrue(await p.evaluate(() => !!document.querySelector('section[aria-labelledby="g-reliefs"] #hasPtr')), 'the tick-box should be under Other reliefs');
      expectEqual((await p.locator('label[for="hasPtr"]').innerText()).trim(), 'I have unused Parenthood Tax Rebate', 'the label');
      // The line under it covers every unused rebate, one first claimed this year included: a parent whose
      // child was born in the income year is exactly who the caution is for. (It used to say "left over from
      // earlier years".)
      const detail = (await p.locator('#hasPtr-detail').innerText()).replace(/\s+/g, ' ').trim();
      expectEqual(
        detail,
        'Any Parenthood Tax Rebate you have not used up, including the rebate for a child born in 2026. No amount is needed: ticking this adds a caution beside the plan.',
        'the line under the tick-box',
      );
      expectTrue(!/earlier years/.test(detail), `the line still narrows the rebate to earlier years: "${detail}"`);
      expectTrue(!(await p.locator('#hasPtr').isChecked()), 'the box starts unticked');
      await p.locator('#hasPtr').check();
      const said = (await p.locator('[data-testid="plan-cautions"] [data-code="PARENTHOOD_TAX_REBATE"] p').innerText()).replace(/\s+/g, ' ');
      expectEqual(
        said,
        'With unused Parenthood Tax Rebate your tax bill this year may already be S$0. This plan would then save no cash now: it makes the rebate last longer, so the benefit arrives in a later year.',
        'the caution',
      );
      await expectExample(p, 'with the box ticked');
      expectEqual(await count(p, '[data-testid="example-flag-plan"]'), 0, 'ticking the box makes the numbers the person\'s own');
      await p.reload();
      await p.waitForSelector('[data-testid="reco-tax-saved"]');
      expectTrue(await p.locator('#hasPtr').isChecked(), 'the box after a reload');
      expectEqual(await count(p, '[data-code="PARENTHOOD_TAX_REBATE"]'), 1, 'the caution after a reload');
      await p.locator('#hasPtr').uncheck();
      expectEqual(await count(p, '[data-code="PARENTHOOD_TAX_REBATE"]'), 0, 'the caution once unticked');
      await own.context.close();
    });

    await check('residency: one line under every choice says what a tax resident is (183 days in the income year)', async () => {
      const own = await newPage(browser, { width: 1280, height: 900, label: 'residency', fonts: 'block' });
      const p = own.page;
      for (const choice of ['citizen', 'pr', 'foreigner']) {
        await choose(p, `residency-${choice}`);
        const hint = await flat(p, 'residency-hint');
        // "Broadly": 183 days is the main test, not the only one (SPEC 5.4), as the checklist also says.
        expectTrue(
          hint.startsWith('This tool is for tax residents: broadly, people who stayed or worked in Singapore for at least 183 days in 2026.'),
          `under ${choice} the line reads "${hint}"`,
        );
      }
      expectTrue(/A non-resident gets no personal reliefs and no SRS relief/.test(await flat(p, 'residency-hint')), 'the foreigner\'s line');
      await p.locator('#incomeYear').selectOption('2027');
      expectTrue(/183 days in 2027/.test(await flat(p, 'residency-hint')), 'the line names the income year on screen');
      await own.context.close();
    });

    await check('default preset: named by its figure, 7 cents for citizens and PRs and 11.5 cents for foreigners, and it moves with the residency', async () => {
      const own = await newPage(browser, { width: 1280, height: 900, label: 'preset', fonts: 'block' });
      const p = own.page;
      const label = async () => (await p.locator('label[for="depth-default"]').innerText()).trim();
      const minimum = () => p.evaluate(() => JSON.parse(window.localStorage.getItem('sgto:v1')).ui);
      expectEqual(await label(), '7 cents or more', 'the default for a citizen');
      expectTrue(await p.locator('#depth-default').isChecked(), 'the default is selected on opening');
      expectEqual(await count(p, '[data-testid="depth-foreigner-note"]'), 0, 'the foreigner\'s line for a citizen');
      await choose(p, 'residency-pr');
      expectEqual(await label(), '7 cents or more', 'the default for a PR');
      // The foreigner of the brief: S$7,000 a month, S$7,000 bonus, no other reliefs.
      await enterForeigner(p);
      expectEqual(await label(), '11.5 cents or more', 'the default for a foreigner');
      expectTrue(await p.locator('#depth-default').isChecked(), 'the default stays selected when the residency changes');
      expectEqual(await text(p, 'reco-srs'), 'S$10,000', 'SRS for the foreigner at the default');
      expectEqual(await text(p, 'reco-rate'), '11.5 cents', 'saving per dollar for the foreigner at the default');
      expectEqual(await text(p, 'reco-tax-saved'), 'S$1,150.00', 'tax saved for the foreigner at the default');
      expectEqual(
        await flat(p, 'reco-reason'),
        'Beyond this, each extra dollar would save 7 cents or less, below the default minimum of 11.5 cents.',
        'the reason for the foreigner at the default',
      );
      expectEqual(
        await flat(p, 'depth-foreigner-note'),
        'A foreigner who has left Singapore pays at least 7.5 cents per dollar in tax to take SRS out, so the 7% rung would be a loss. That is why your default is 11.5 cents or more. You can still choose to go deeper.',
        'the line that says why',
      );
      expectEqual(await flat(p, 'depth-hint'), 'Only lock away dollars that each save at least 11.5 cents in tax.', 'the line under the control');
      const caution = async () => (await p.locator('[data-testid="plan-cautions"] [data-code="SRS_NON_RESIDENT_WITHDRAWAL"] p').innerText()).replace(/\s+/g, ' ');
      expectEqual(
        await caution(),
        "If you have left Singapore when you withdraw, SRS is taxed as a non-resident's: at least 7.5 cents per dollar withdrawn at retirement age or under the 10-year rule for foreigners, and at least 20 cents if earlier.",
        'the caution at the default',
      );
      expectEqual(await count(p, '[data-code="TAX_RESIDENCY_CHECK"]'), 0, 'the residency check for a full year');
      await p.evaluate(() => window.scrollTo(0, 0));
      await p.screenshot({ path: path.join(SHOTS, 'desktop-foreigner.png') });
      // They can still go deeper, and are then told how much of the plan loses money on the way out.
      await choose(p, 'depth-every');
      expectEqual(await text(p, 'reco-srs'), 'S$35,700', 'SRS for the foreigner with every tax dollar');
      expectTrue((await caution()).endsWith('S$25,700 of this plan saves less than 7.5 cents per dollar today.'), `the caution reads "${await caution()}"`);
      // A custom minimum starts from this person's default, not from the 7 cents they never chose.
      await choose(p, 'depth-custom');
      expectEqual(await p.locator('#customRate').inputValue(), '0.115', 'where a custom minimum starts for a foreigner');
      expectEqual(await text(p, 'reco-srs'), 'S$10,000', 'SRS for the foreigner on opening Custom');
      await choose(p, 'depth-default');
      // Opening Custom is not picking a rate, so it starts from the default of whoever is looking now. As a
      // citizen it opens on 7 cents; back as a foreigner it must open on 11.5 cents again, never on 7.
      await choose(p, 'residency-citizen');
      await choose(p, 'depth-custom');
      expectEqual(await p.locator('#customRate').inputValue(), '0.07', 'where a custom minimum starts for a citizen');
      await choose(p, 'depth-default');
      await choose(p, 'residency-foreigner');
      await choose(p, 'depth-custom');
      expectEqual(await p.locator('#customRate').inputValue(), '0.115', 'Custom for a foreigner after a citizen had looked at it');
      expectEqual(await text(p, 'reco-srs'), 'S$10,000', 'SRS for the foreigner on opening Custom again');
      expectTrue(!/of this plan saves less/.test(await caution()), `a minimum nobody chose brought in dollars that lose money: "${await caution()}"`);
      // With Custom open and nothing picked, the figure follows the residency the way the default does.
      await choose(p, 'residency-citizen');
      expectEqual(await p.locator('#customRate').inputValue(), '0.07', 'an unpicked custom minimum after switching to citizen');
      await choose(p, 'residency-foreigner');
      expectEqual(await p.locator('#customRate').inputValue(), '0.115', 'an unpicked custom minimum after switching back');
      // A rate the person does pick is theirs: it stays through a change of residency and a reload.
      await p.locator('#customRate').selectOption('0.07');
      expectEqual(await text(p, 'reco-srs'), 'S$35,700', 'SRS once the foreigner has picked 7 cents');
      expectTrue((await caution()).endsWith('S$25,700 of this plan saves less than 7.5 cents per dollar today.'), 'the caution for a picked 7 cents');
      await choose(p, 'residency-pr');
      await choose(p, 'residency-foreigner');
      expectEqual(await p.locator('#customRate').inputValue(), '0.07', 'a picked rate after a change of residency');
      await p.reload();
      await p.waitForSelector('[data-testid="reco-tax-saved"]');
      expectEqual(await p.locator('#customRate').inputValue(), '0.07', 'a picked rate after a reload');
      await choose(p, 'depth-default');
      // Five months of work: asked to check that they are a tax resident at all.
      await p.locator('#monthsWorked').selectOption('5');
      const check5 = (await p.locator('[data-testid="plan-cautions"] [data-code="TAX_RESIDENCY_CHECK"] p').innerText()).replace(/\s+/g, ' ');
      expectEqual(
        check5,
        'You worked here for half the year or less. You are a tax resident only if you were in Singapore for at least 183 days (IRAS has further rules for stays that span two years). Non-residents get no reliefs, so this plan would not apply.',
        'the caution for five months',
      );
      await p.locator('#monthsWorked').selectOption('7');
      expectEqual(await count(p, '[data-code="TAX_RESIDENCY_CHECK"]'), 0, 'the residency check at seven months');
      await p.locator('#monthsWorked').selectOption('12');
      // Back to a citizen with the default still selected: the rate goes back to 7 cents.
      await choose(p, 'residency-citizen');
      expectEqual(await label(), '7 cents or more', 'the default once a citizen again');
      expectEqual((await minimum()).depth, 'default', 'the stored choice is the preset, not a rate');
      expectEqual(await text(p, 'reco-rate'), '7 cents', 'saving per dollar for a citizen on the same pay');
      expectEqual(await text(p, 'reco-locked'), 'S$23,300', 'a citizen on the same pay goes down to the 7% rung');
      // No label passes a judgement.
      const labels = (await p.locator('fieldset:has(#depth-default) label').allInnerTexts()).join(' | ');
      expectTrue(!/worth/i.test(labels), `the labels read "${labels}"`);
      expectTrue(!/worth it/i.test(await pageText(p)), '"worth it" is still on the page');
      await own.context.close();
    });

    await check('a foreigner\'s S$0 plan: the way to Every tax dollar says what those dollars cost on the way out', async () => {
      const own = await newPage(browser, { width: 1280, height: 900, label: 'foreigner-offer', fonts: 'block' });
      const p = own.page;
      const CAVEAT = 'of that plan saves less than 7.5 cents per dollar, the least you would pay in tax to take SRS out after leaving Singapore.';
      // S$7,000 a month and a S$7,000 bonus over five months: nothing clears the foreigner's default.
      await enterForeigner(p);
      await p.locator('#monthsWorked').selectOption('5');
      expectEqual(await text(p, 'reco-tax-saved'), 'S$0.00', 'tax saved at the default');
      expectEqual(await flat(p, 'reco-headline'), 'Nothing more to put in this year.', 'headline');
      const offer = await flat(p, 'offer');
      expectTrue(
        offer.startsWith('Going all the way down the ladder would save S$620.00 by locking away S$21,000: 2.95 cents back per dollar.'),
        `the offer reads "${offer}"`,
      );
      expectEqual(await flat(p, 'offer-caveat'), `All ${CAVEAT}`, 'what the offered plan costs on the way out');
      expectTrue(
        await p.evaluate(() => {
          const caveat = document.querySelector('[data-testid="offer-caveat"]');
          const button = document.querySelector('[data-testid="offer-every"]');
          return !!(caveat.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING) && caveat.parentElement === button.parentElement;
        }),
        'the cost should be read before the button, in the same block',
      );
      // The note lower down points to the same view, so it carries the same sentence.
      const note = (await p.locator('[data-testid="warnings"] [data-code="BELOW_MIN_SAVING_RATE"] p').innerText()).replace(/\s+/g, ' ');
      expectTrue(note.endsWith(`to see a plan with these smaller savings. All ${CAVEAT}`), `the note reads "${note}"`);
      await p.evaluate(() => window.scrollTo(0, 0));
      await p.screenshot({ path: path.join(SHOTS, 'desktop-foreigner-nothing.png') });
      // They can still go deeper, and the engine's caution then counts the same dollars.
      await p.locator('[data-testid="offer-every"]').click();
      expectEqual(await text(p, 'reco-srs'), 'S$21,000', 'SRS with every tax dollar');
      expectEqual(await text(p, 'reco-tax-saved'), 'S$620.00', 'tax saved with every tax dollar');
      expectEqual(await count(p, '[data-testid="offer"]'), 0, 'the offer once it has been taken');
      const caution = (await p.locator('[data-testid="plan-cautions"] [data-code="SRS_NON_RESIDENT_WITHDRAWAL"] p').innerText()).replace(/\s+/g, ' ');
      expectTrue(caution.endsWith('S$21,000 of this plan saves less than 7.5 cents per dollar today.'), `the caution reads "${caution}"`);
      // A whole year on S$5,000 a month: the same, in that plan's own figures.
      await choose(p, 'depth-default');
      await p.locator('#monthsWorked').selectOption('12');
      await setField(p, 'salary', '5000');
      await setField(p, 'bonus', '0');
      expectTrue((await flat(p, 'offer')).startsWith('Going all the way down the ladder would save S$1,814.00 by locking away S$35,700: 5.08 cents back per dollar.'), `the offer reads "${await flat(p, 'offer')}"`);
      expectEqual(await flat(p, 'offer-caveat'), `All ${CAVEAT}`, 'the cost for S$5,000 a month');
      // A minimum of 15 cents picked on a higher salary, then S$7,000 a month again: nothing clears it, and
      // going all the way down would bring in S$10,000 at 11.5 cents, which does clear the cost of leaving.
      // Only the rest is counted.
      await setField(p, 'salary', '15000');
      await setField(p, 'bonus', '7000');
      await choose(p, 'depth-custom');
      await p.locator('#customRate').selectOption('0.15');
      await setField(p, 'salary', '7000');
      expectEqual(
        await flat(p, 'reco-reason'),
        'Nothing clears your minimum. Each extra dollar would save 11.5 cents or less in tax, and you asked for at least 15 cents.',
        'the reason at a 15 cent minimum the person picked',
      );
      expectTrue(/by locking away S\$35,700:/.test(await flat(p, 'offer')), `the offer reads "${await flat(p, 'offer')}"`);
      expectEqual(await flat(p, 'offer-caveat'), `S$25,700 ${CAVEAT}`, 'the cost when part of the offered plan clears it');
      // A citizen is told nothing of the kind (Appendix A.3).
      await choose(p, 'depth-default');
      await choose(p, 'residency-citizen');
      await enterA3(p);
      expectTrue((await flat(p, 'offer')).includes('2.53 cents back per dollar'), `a citizen's offer reads "${await flat(p, 'offer')}"`);
      expectEqual(await count(p, '[data-testid="offer-caveat"]'), 0, 'a cost of leaving for a citizen');
      const citizenNote = (await p.locator('[data-testid="warnings"] [data-code="BELOW_MIN_SAVING_RATE"] p').innerText()).replace(/\s+/g, ' ');
      expectTrue(citizenNote.endsWith('to see these smaller savings.'), `a citizen's note reads "${citizenNote}"`);
      await noJunk(p, 'foreigner with nothing recommended');
      await own.context.close();
    });

    await check('a higher saving is credited only to a scheme that would receive money (57, own CPF off, room not entered)', async () => {
      const own = await newPage(browser, { width: 1280, height: 900, label: 'what-if', fonts: 'block' });
      const p = own.page;
      await setField(p, 'age', '57');
      await p.locator('#useCpfSelf').uncheck();
      expectEqual(await text(p, 'reco-srs'), 'S$15,300', 'SRS');
      expectEqual(await count(p, '[data-testid="reco-cpf-self"]'), 0, 'a row for the own CPF that is switched off');
      const reason = await flat(p, 'reco-reason');
      // The whole increase is the family top-up: the own CPF would be switched on and get nothing, because
      // from 55 it is left out until its room is entered. (The card used to credit both.)
      expectTrue(
        reason.endsWith('Switching on the CPF cash top-up to family would raise the saving to S$2,679.50, if you have a family member who qualifies.'),
        `the card reads "${reason}"`,
      );
      expectTrue(!/top-up to yourself/.test(reason), `the card credits the own CPF: "${reason}"`);
      const note = (await p.locator('[data-testid="warnings"] [data-code="LEVER_LIMITS_PLAN"] p').innerText()).replace(/\s+/g, ' ');
      expectEqual(note, reason, 'the note under "About your numbers"');
      await recordClipboard(p);
      const summary = await copiedSummary(p);
      expectTrue(summary.includes(`Why it stops there: ${reason}`), 'the copied summary should give the same reason');
      // Doing exactly what the sentence says gives exactly the saving it quotes.
      await p.locator('#useCpfFamily').check();
      expectEqual(await text(p, 'reco-tax-saved'), 'S$2,679.50', 'tax saved with the family top-up switched on');
      expectEqual(await text(p, 'reco-cpf-family'), 'S$8,000', 'the family top-up');
      // With the room entered the own CPF would receive money, so then it is named.
      await p.locator('#useCpfFamily').uncheck();
      await p.locator('#useCpfSelf').check();
      await setField(p, 'cpfSelfRoom', '8000');
      await p.locator('#useCpfSelf').uncheck();
      expectTrue(
        (await flat(p, 'reco-reason')).includes('Switching on the CPF cash top-up to yourself and the CPF cash top-up to family would raise the saving to S$3,344.80'),
        `with the room entered the card reads "${await flat(p, 'reco-reason')}"`,
      );
      await own.context.close();
    });

    await check('numbers saved by the previous version still load: the old default preset is the default, and nothing is ticked', async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, timezoneId: 'Asia/Singapore', locale: 'en-SG' });
      await context.clock.setFixedTime(FIXED_NOW);
      await context.route(FONT_HOSTS, (route) => route.abort());
      const p = await context.newPage();
      watch(p, 'old-state');
      await p.goto(PAGE_URL);
      await p.waitForSelector('[data-testid="reco-tax-saved"]');
      // What version 1.0.0 stored: the preset was called 'worth', and there was no tick-box.
      const previous = {
        isExample: false, edited: ['salary', 'age'], incomeYear: 2026, residency: 'citizen', prYear: 3, age: 41, birthMonth: 12,
        payMode: 'monthly', salary: 12000, salaryOther: null, bonus: 15000, monthsWorked: 12, otherIncome: 0, expenses: 0,
        donations: 0, cpfOverrideOn: false, cpfOverride: null, existingSrs: 0, existingCpfSelf: 0, existingCpfFamily: 0,
        reliefMode: 'total', reliefTotal: 5000, reliefItems: {}, useSrs: true, useCpfSelf: true, useCpfFamily: false,
        cpfSelfRoom: null, cpfFamilyMax: null, depth: 'worth', customRate: 0.07, cashLimit: 9000, order: 'flexibility', simulatorStep: 1000,
      };
      const load = async (ui) => {
        await p.evaluate((value) => window.localStorage.setItem('sgto:v1', value), JSON.stringify({ v: 1, theme: 'system', ui }));
        await p.reload();
        await p.waitForSelector('[data-testid="reco-tax-saved"]');
      };
      await load(previous);
      expectEqual(await p.locator('#salary').inputValue(), '12,000', 'saved salary');
      expectEqual(await p.locator('#age').inputValue(), '41', 'saved age');
      expectEqual(await p.locator('#cashLimit').inputValue(), '9,000', 'saved cash limit');
      expectTrue(await p.locator('#depth-default').isChecked(), 'the old default preset loads as the default');
      expectTrue(!(await p.locator('#hasPtr').isChecked()), 'the tick-box that did not exist loads unticked');
      expectEqual(await text(p, 'reco-locked'), 'S$9,000', 'the saved plan');
      expectEqual(await flat(p, 'example-left'), "Still using the example's bonus and other reliefs.", 'what was still the example\'s');
      // A foreigner's saved default becomes the foreigner's default, which no longer recommends the 7% rung.
      await load({ ...previous, residency: 'foreigner', salary: 7000, bonus: 7000, reliefTotal: 0, cashLimit: null });
      expectTrue(await p.locator('#depth-default').isChecked(), 'a foreigner\'s old default');
      expectEqual(await text(p, 'reco-srs'), 'S$10,000', 'a foreigner\'s saved plan at the new default');
      // Someone of 57 who had left the room blank: their own CPF is now left out until they enter it.
      await load({ ...previous, age: 57, cashLimit: null });
      expectEqual(await text(p, 'reco-cpf-self'), 'Left out', 'own CPF for saved numbers at 57');
      expectEqual(await count(p, '[data-code="CPF_SELF_ROOM_UNCONFIRMED"]'), 1, 'the caution for saved numbers at 57');
      await context.close();
    });

    await check('how long the cash is locked: on the card for each scheme in the plan, and sensible past those ages', async () => {
      const own = await newPage(browser, { width: 1280, height: 900, label: 'horizon', fonts: 'block' });
      const p = own.page;
      const lines = async () => (await p.locator('[data-testid="reco-horizon"] li').allInnerTexts()).map((l) => l.replace(/\s+/g, ' ').trim()).join(' ');
      expectEqual(await lines(), 'SRS: locked until 64, about 29 years. CPF: paid out monthly from 65, about 30 years.', 'for a 35-year-old');
      expectTrue(await p.evaluate(() => !!document.querySelector('#recommendation [data-testid="reco-horizon"]')), 'the lines should be on the card');
      // 64 is the age a first contribution made now locks in. The card says so straight under the lines, so
      // someone with an older SRS account is not told the wrong age, and "Locked until" gives the ages.
      const NOTE = 'If you have paid into SRS before, your SRS age was set by your first contribution and may be lower than 64.';
      const note = async () => ((await count(p, '[data-testid="reco-horizon-note"]')) > 0 ? flat(p, 'reco-horizon-note') : '');
      expectEqual(await note(), NOTE, 'the condition on the SRS age for a 35-year-old');
      expectTrue(
        await p.evaluate(() => document.querySelector('[data-testid="reco-horizon-note"]').previousElementSibling === document.querySelector('[data-testid="reco-horizon"]')),
        'the condition should sit straight under the lock-up lines, on the card',
      );
      expectTrue(/64 if that is on or after 1 July 2026, 63 if it was between 1 July 2022 and 30 June 2026, 62 if earlier/.test((await p.locator('tr[data-fact="lockedUntil"] td').first().innerText()).replace(/\s+/g, ' ')), 'the ages are in the "Locked until" fact');
      await p.locator('#useCpfSelf').uncheck();
      expectEqual(await lines(), 'SRS: locked until 64, about 29 years.', 'with SRS alone in the plan');
      await p.locator('#useCpfSelf').check();
      await p.locator('#useSrs').uncheck();
      expectEqual(await lines(), 'CPF: paid out monthly from 65, about 30 years.', 'with the CPF top-up alone in the plan');
      expectEqual(await note(), '', 'the SRS condition with no SRS in the plan');
      await p.locator('#useSrs').check();
      await p.locator('#useCpfFamily').check();
      expectTrue((await lines()).endsWith('Family top-up: You cannot take it back. A top-up cannot be reversed.'), `with a family top-up: "${await lines()}"`);
      await p.locator('#useCpfFamily').uncheck();
      await setField(p, 'age', '64');
      await setField(p, 'cpfSelfRoom', '8000');
      expectEqual(await lines(), 'SRS: locked until 64, an age you have already reached. CPF: paid out monthly from 65, about 1 year.', 'at 64');
      expectEqual(await note(), '', 'the SRS condition for someone who has reached the age shown');
      await setField(p, 'age', '70');
      expectEqual(await lines(), 'SRS: locked until 64, an age you have already reached. CPF: paid out monthly from 65, an age you have already reached.', 'at 70');
      // A PR of 57 who has already put S$5,000 into SRS this year: certainly not a first contribution.
      await resetToExample(p);
      await choose(p, 'residency-pr');
      await setField(p, 'age', '57');
      await setField(p, 'existingSrs', '5000');
      expectEqual(await lines(), 'SRS: locked until 64, about 7 years.', 'for a PR of 57 with SRS already this year');
      expectEqual(await note(), NOTE, 'the condition for someone who has contributed before');
      // A foreigner of 34: the retirement age is not the only way out, and for them not the first. The line
      // names the 10-year rule that the caution under the card and the "Tax later" fact describe.
      await resetToExample(p);
      await enterForeigner(p);
      await setField(p, 'age', '34');
      expectEqual(
        await lines(),
        'SRS: locked until 64, about 30 years, or until you can use the 10-year rule for foreigners if that comes first.',
        'for a foreigner of 34',
      );
      expectEqual(await note(), NOTE, 'the condition for a foreigner');
      expectTrue(/under the 10-year rule for foreigners/.test(await flat(p, 'plan-cautions')), 'the caution under the card names the same rule');
      expectTrue(/after keeping the account for 10 years \(the rule for foreigners\)/.test((await p.locator('tr[data-fact="taxLater"] td').first().innerText()).replace(/\s+/g, ' ')), 'the rule is given in full under "Tax later"');
      await recordClipboard(p);
      expectTrue(
        (await copiedSummary(p)).includes(`How long it is locked: SRS: locked until 64, about 30 years, or until you can use the 10-year rule for foreigners if that comes first. ${NOTE}`),
        'the foreigner\'s copied summary should carry both conditions',
      );
      // A foreigner past the age shown has nothing left to qualify.
      await setField(p, 'age', '66');
      expectEqual(await lines(), 'SRS: locked until 64, an age you have already reached.', 'for a foreigner of 66');
      expectEqual(await note(), '', 'the condition for a foreigner of 66');
      await resetToExample(p);
      await setField(p, 'age', '70');
      await setField(p, 'cpfSelfRoom', '8000');
      // A S$0 plan locks nothing away, and a closed year is not described as if it were open.
      await enterA3(p);
      expectEqual(await count(p, '[data-testid="reco-horizon"]'), 0, 'lock-up lines on a S$0 plan');
      await resetToExample(p);
      await p.locator('#incomeYear').selectOption('2025');
      expectEqual(await count(p, '[data-testid="reco-horizon"]'), 0, 'lock-up lines after the deadline');
      await p.locator('#incomeYear').selectOption('2026');
      await recordClipboard(p);
      expectTrue(
        (await copiedSummary(p)).includes(`How long it is locked: SRS: locked until 64, about 29 years. CPF: paid out monthly from 65, about 30 years. ${NOTE}`),
        'the copied summary should say how long the cash is locked, with the condition on the SRS age',
      );
      await own.context.close();
    });

    await check('a CPF amount is always a "cash top-up": headline, card rows, tables, monthly plan and the copied summary', async () => {
      const own = await newPage(browser, { width: 1280, height: 900, label: 'cash-top-up', fonts: 'block' });
      const p = own.page;
      await p.locator('#useCpfFamily').check();
      const headline = await flat(p, 'reco-headline');
      expectTrue(
        headline.startsWith("Put S$15,300 into SRS, S$8,000 into your CPF as a cash top-up and S$8,000 into family members' CPF as a cash top-up."),
        `headline reads "${headline}"`,
      );
      const slip = await p.locator('.slip .row dt').allInnerTexts();
      expectEqual(slip.slice(0, 3).join(' | '), 'SRS | CPF cash top-up, self | CPF cash top-up, family', 'the card rows');
      for (const id of ['scenario-table', 'monthly-table']) {
        const heads = (await p.locator(`[data-testid="${id}"] thead th`).allInnerTexts()).map((h) => h.replace(/\s+/g, ' ').trim());
        expectTrue(heads.includes('CPF cash top-up, self') && heads.includes('CPF cash top-up, family'), `${id} headings read ${JSON.stringify(heads)}`);
      }
      const fullYear = await flat(p, 'full-year');
      expectTrue(
        fullYear.includes("S$1,275 into SRS, S$667 into your CPF as a cash top-up and S$667 into family members' CPF as a cash top-up"),
        `the January line reads "${fullYear}"`,
      );
      await recordClipboard(p);
      const summary = await copiedSummary(p);
      expectTrue(summary.includes('- CPF cash top-up, self: S$8,000') && summary.includes('- CPF cash top-up, family: S$8,000'), 'the summary rows');
      expectTrue(summary.includes('(SRS S$7,650; CPF cash top-up, self S$4,000; CPF cash top-up, family S$4,000)'), 'the summary\'s monthly lines');
      // Nowhere, on the page or in the summary, is an amount put just "into your CPF".
      const body = await pageText(p);
      for (const [where, words] of [['the page', body], ['the copied summary', summary]]) {
        const bare = /into (your|family members') CPF(?! as a cash top-up)/.exec(words);
        expectTrue(!bare, `${where} says "${bare && words.slice(Math.max(0, bare.index - 30), bare.index + 50)}"`);
      }
      // The bar's target is the card, and the announcement a screen reader hears is worded the same way.
      await p.waitForFunction(() => /into your CPF as a cash top-up/.test(document.querySelector('[data-testid="live"]').textContent), null, { timeout: 4000 });
      await own.context.close();
    });

    await check('hints: what counts as bonus, what to include in "Already contributed", and the matched amounts beside the family option', async () => {
      const own = await newPage(browser, { width: 1280, height: 900, label: 'hints', fonts: 'block' });
      const p = own.page;
      const bonus = (await p.locator('#bonus-hint').innerText()).replace(/\s+/g, ' ');
      expectTrue(/commissions or incentives paid less often than monthly/.test(bonus) && /Those paid every month belong in the salary/.test(bonus), `the bonus hint reads "${bonus}"`);
      expectEqual(await flat(p, 'existing-hint'), 'Include anything your employer paid into your SRS or topped up to your CPF in cash.', 'the hint under "Already contributed"');
      expectEqual((await p.locator('#existingCpfFamily-hint').innerText()).trim(), 'Leave out any part the Government matched.', 'the hint on the family amount');
      await p.locator('#useCpfFamily').check();
      // The matched amounts are worded once, by the engine: the hint is the checklist's own line, whole, so
      // the form and the checklist cannot drift apart (it used to be a hand-written near-copy).
      const checklist = async () => (await p.locator('[data-testid="transfer-cautions"] li').allInnerTexts()).map((c) => c.replace(/\s+/g, ' ').trim());
      const family = await flat(p, 'family-hint');
      expectEqual(
        family,
        'For a family top-up, check that the family member qualifies and count only what the Government does not match: the first S$2,000 a year topped up for a member on the Matched Retirement Savings Scheme, and the first S$1,000 a year to MediSave for a member on the Matched MediSave Scheme earns you no relief. A top-up cannot be reversed.',
        'the family hint for 2026',
      );
      expectTrue((await checklist()).includes(family), 'the family hint should be one of the lines under "Check before you move money"');
      expectEqual(await p.locator('#cpfFamilyMax').getAttribute('aria-describedby'), 'cpfFamilyMax-hint', 'the hint is tied to its field');
      // Income year 2025: the Matched MediSave Scheme had not started, so no MediSave figure is given.
      await p.locator('#incomeYear').selectOption('2025');
      const family2025 = await flat(p, 'family-hint');
      expectTrue(
        /count only what the Government does not match: the first S\$2,000 a year topped up for a member on the Matched Retirement Savings Scheme earns you no relief\./.test(family2025) && !/MediSave/.test(family2025),
        `the family hint for 2025 reads "${family2025}"`,
      );
      expectTrue((await checklist()).includes(family2025), 'the 2025 family hint should be the checklist\'s line for 2025');
      const caution2025 = (await p.locator('[data-testid="plan-cautions"] [data-code="FAMILY_TOPUP_CHECKS"] p').innerText()).replace(/\s+/g, ' ');
      expectTrue(/Matched Retirement Savings Scheme\. The amounts here/.test(caution2025) && !/MediSave/.test(caution2025), `the family caution for 2025 reads "${caution2025}"`);
      const noRelief2025 = (await p.locator('tr[data-fact="noRelief"] td').nth(2).innerText()).replace(/\s+/g, ' ');
      expectTrue(/Matched Retirement Savings Scheme\.$/.test(noRelief2025) && !/MediSave/.test(noRelief2025), `"No relief for" in 2025 reads "${noRelief2025}"`);
      await noJunk(p, 'income year 2025 with a family top-up');
      // A foreigner is not told about CPF in the "Already contributed" hint.
      await p.locator('#incomeYear').selectOption('2026');
      await choose(p, 'residency-foreigner');
      expectEqual(await flat(p, 'existing-hint'), 'Include anything your employer paid into your SRS.', 'the hint for a foreigner');
      await own.context.close();
    });

    await check('cash limit: asked near the top as "How much cash can you spare this year?", and the plan stays within it', async () => {
      const own = await newPage(browser, { width: 1280, height: 900, label: 'cash', fonts: 'block' });
      const p = own.page;
      expectEqual((await p.locator('label[for="cashLimit"]').innerText()).trim(), 'How much cash can you spare this year? (optional)', 'the question');
      expectEqual(await p.locator('#cashLimit').inputValue(), '', 'no limit on opening');
      // Straight after the pay, before everything else the form asks.
      for (const later of ['existingSrs', 'reliefTotal', 'useSrs', 'depth-default', 'order-flexibility']) {
        expectTrue(await comesBefore(p, 'cashLimit', later), `the cash question should come before #${later}`);
      }
      expectTrue(await comesBefore(p, 'bonus', 'cashLimit'), 'the cash question should follow the pay');
      const groups = await p.locator('#inputs .group-title').allInnerTexts();
      expectEqual(groups.map((g) => g.trim()).slice(0, 3).join(' | '), 'About you | Income | Cash to spare', 'the first three groups of the form');
      expectEqual(await count(p, '#inputs input[id="cashLimit"]'), 1, 'cash limit fields');
      await enterModest(p);
      expectEqual(await text(p, 'reco-locked'), 'S$17,240', 'the modest earner with no limit');
      await setField(p, 'cashLimit', '5000');
      expectEqual(await flat(p, 'reco-headline'), 'Put S$5,000 into SRS. You save S$350.00 in tax.', 'the modest earner with S$5,000 to spare');
      await own.context.close();
      // On a phone the answer to it is on the short card, so it can be seen without opening the form.
      const phone = await newPage(browser, { width: 390, height: 844, label: 'cash-phone', touch: true, fonts: 'block' });
      await phone.page.locator('[data-testid="toggle-inputs"]').click();
      await setField(phone.page, 'cashLimit', '5000');
      await phone.page.locator('[data-testid="toggle-inputs"]').click();
      expectTrue(/Cash to spare: S\$5,000/.test(await flat(phone.page, 'inputs-summary')), `the short card reads "${await flat(phone.page, 'inputs-summary')}"`);
      await phone.context.close();
    });

    await check('monthly plan: says when an instalment is more than the monthly salary and points to the cash limit; cut-offs only for schemes in the plan', async () => {
      const own = await newPage(browser, { width: 1280, height: 900, label: 'monthly', fonts: 'block' });
      const p = own.page;
      // The opening example: two cut-off lines, one per scheme in the plan, in the shared wording.
      const cutOffs = async () => (await p.locator('[data-testid="monthly-deadlines"] li').allInnerTexts()).map((l) => l.replace(/\s+/g, ' ').trim());
      expectEqual((await cutOffs()).length, 2, 'cut-off lines for the example');
      expectTrue(/^SRS: 31 December, or your bank's earlier cut-off\./.test((await cutOffs())[0]), `the first reads "${(await cutOffs())[0]}"`);
      expectTrue(/^CPF cash top-up: The money must reach the CPF Board by 31 December\./.test((await cutOffs())[1]), `the second reads "${(await cutOffs())[1]}"`);
      await enterModest(p);
      const note = await flat(p, 'monthly-affordability');
      expectTrue(
        note.includes('S$8,620 a month is more than your monthly salary. It would have to come from your bonus or savings.'),
        `the note reads "${note}"`,
      );
      await p.locator('[data-testid="monthly-cash-limit"]').click();
      await p.waitForFunction(() => document.activeElement && document.activeElement.id === 'cashLimit', null, { timeout: 3000 });
      // Within what they can spare, the instalments are below the salary and the note goes.
      await setField(p, 'cashLimit', '5000');
      expectEqual(await count(p, '[data-testid="monthly-affordability"]'), 0, 'the note once the instalments fit the salary');
      expectEqual((await cutOffs()).length, 1, 'cut-off lines for an SRS-only plan');
      expectTrue(!/CPF/.test((await cutOffs()).join(' ')), `an SRS-only plan is told "${(await cutOffs()).join(' ')}"`);
      // No salary entered: nothing to compare with.
      await setField(p, 'cashLimit', '');
      await setField(p, 'salary', '0');
      await setField(p, 'bonus', '120000');
      expectTrue((await count(p, '[data-testid="monthly-table"] tbody tr')) > 0, 'a plan with only a bonus still has a schedule');
      expectEqual(await count(p, '[data-testid="monthly-affordability"]'), 0, 'the note with no salary entered');
      // A CPF-only plan hears about the CPF Board and not about banks.
      await resetToExample(p);
      await p.locator('#useSrs').uncheck();
      expectEqual((await cutOffs()).length, 1, 'cut-off lines for a CPF-only plan');
      expectTrue(/^CPF cash top-up:/.test((await cutOffs())[0]) && !/bank/i.test((await cutOffs())[0]), `a CPF-only plan is told "${(await cutOffs())[0]}"`);
      // A S$0 plan has no cut-off to meet.
      await resetToExample(p);
      await enterA3(p);
      expectEqual(await count(p, '[data-testid="monthly-deadlines"]'), 0, 'cut-off lines under a S$0 plan');
      expectEqual(await count(p, '[data-testid="monthly-affordability"]'), 0, 'the note under a S$0 plan');
      await own.context.close();
    });

    await check('"New to this?": under the card, three or four short lines, open on a wide screen and folded on a phone', async () => {
      const own = await newPage(browser, { width: 1280, height: 900, label: 'new-to-this', fonts: 'block' });
      const p = own.page;
      const block = p.locator('[data-testid="new-to-this"]');
      expectEqual((await block.locator('summary').innerText()).trim(), 'New to this?', 'the heading');
      expectTrue(await block.evaluate((el) => el.open), 'open on a wide screen');
      expectTrue(await p.evaluate(() => document.querySelector('[data-testid="new-to-this"]').previousElementSibling.id === 'recommendation'), 'straight under the card when there is no caution');
      const lines = (await block.locator('li').allInnerTexts()).map((l) => l.replace(/\s+/g, ' ').trim());
      expectTrue(lines.length >= 3 && lines.length <= 4, `${lines.length} lines`);
      expectTrue(/^SRS: .*voluntary retirement account at DBS, OCBC or UOB\. You must open it before your first contribution\.$/.test(lines[0]), `the SRS line reads "${lines[0]}"`);
      expectTrue(/^CPF cash top-up: .*Special or Retirement Account, or MediSave.*It is not a "contribution to my three CPF accounts"\.$/.test(lines[1]), `the CPF line reads "${lines[1]}"`);
      expectTrue(/The bank and the CPF Board report both to IRAS for you\.$/.test(lines[2]), `the last line reads "${lines[2]}"`);
      expectTrue(lines.every((l) => l.length <= 240), 'the lines should be short');
      // It can be folded away, and stays folded while the numbers change.
      await block.locator('summary').click();
      await setField(p, 'salary', '9000');
      expectTrue(!(await block.evaluate((el) => el.open)), 'stays folded once folded');
      await own.context.close();
      const phone = await newPage(browser, { width: 390, height: 844, label: 'new-to-this-phone', touch: true, fonts: 'block' });
      const folded = phone.page.locator('[data-testid="new-to-this"]');
      expectTrue(!(await folded.evaluate((el) => el.open)), 'folded on a phone');
      expectTrue((await folded.evaluate((el) => el.getBoundingClientRect().height)) <= 48, 'one line tall on a phone');
      await folded.locator('summary').tap();
      expectTrue(await folded.locator('li').first().isVisible(), 'opens on a tap');
      const o = await overflow(phone.page);
      expectTrue(o.scrollWidth <= o.innerWidth, `scrollWidth ${o.scrollWidth} > innerWidth ${o.innerWidth}`);
      await phone.context.close();
    });

    await check('Itemise on the untouched example: the helper opens empty, the example\'s S$5,000 stays counted and stays labelled', async () => {
      const own = await newPage(browser, { width: 1280, height: 900, label: 'itemise', fonts: 'block' });
      const p = own.page;
      // The whole page is still the example: switching the view does not make its numbers somebody's own.
      await choose(p, 'reliefMode-itemised');
      expectEqual(await p.locator('#relief-other').inputValue(), '0', '"Any other relief" on the untouched example');
      expectEqual(await text(p, 'relief-total'), 'S$5,000', 'the total still counted');
      expectTrue(/the example's S\$5,000 is still counted/.test(await flat(p, 'relief-example-note')), `the note reads "${await flat(p, 'relief-example-note')}"`);
      await expectExample(p, 'after switching to Itemise');
      expectEqual(await count(p, '[data-testid="example-flag-plan"]'), 1, 'still labelled as the example');
      await choose(p, 'reliefMode-total');
      expectEqual(await p.locator('#reliefTotal').inputValue(), '5,000', 'the total after switching back');
      expectEqual(await count(p, '[data-testid="example-flag-plan"]'), 1, 'still the example after switching back');
      // The critic's case: 29, S$5,200 a month, S$10,400 bonus, other reliefs never touched.
      await setField(p, 'age', '29');
      await setField(p, 'salary', '5200');
      await setField(p, 'bonus', '10400');
      expectEqual(await flat(p, 'example-left'), "Still using the example's other reliefs.", 'before tapping Itemise');
      expectEqual(await text(p, 'reliefTotal-flag'), 'Example value', 'the tag before tapping Itemise');
      const before = await flat(p, 'reco-headline');
      expectEqual(before, 'Put S$12,240 into SRS. You save S$856.80 in tax.', 'the plan with the example\'s S$5,000');
      await choose(p, 'reliefMode-itemised');
      expectEqual(await flat(p, 'example-left'), "Still using the example's other reliefs.", 'the panel note after tapping Itemise');
      expectEqual(await text(p, 'relief-total-flag'), 'Example value', 'the tag on the helper\'s total');
      expectEqual(await p.locator('#relief-other').inputValue(), '0', 'the example total must not be carried into the helper');
      expectEqual(await flat(p, 'reco-headline'), before, 'the plan after tapping Itemise');
      await p.screenshot({ path: path.join(SHOTS, 'desktop-itemise-example.png') });
      // Entering a relief replaces the example's figure with the person's own list.
      await p.locator('#relief-spouse').check();
      expectEqual(await text(p, 'relief-total'), 'S$2,000', 'the total once a relief is entered');
      expectEqual(await count(p, '[data-testid="example-left"]'), 0, 'the panel note once a relief is entered');
      expectEqual(await count(p, '[data-testid="relief-example-note"]'), 0, 'the helper note once a relief is entered');
      expectEqual(await count(p, '[data-testid="relief-total-flag"]'), 0, 'the tag once a relief is entered');
      // Someone with none of them says so with one press, and gets the S$0 plan the critic expected.
      await p.locator('[data-testid="reset"]').click();
      await setField(p, 'age', '29');
      await setField(p, 'salary', '5200');
      await setField(p, 'bonus', '10400');
      await choose(p, 'reliefMode-itemised');
      await p.locator('[data-testid="relief-none"]').click();
      expectEqual(await text(p, 'relief-total'), 'S$0', 'the total after "I have none of these"');
      expectEqual(await flat(p, 'reco-headline'), 'Put S$15,300 into SRS and S$1,940 into your CPF as a cash top-up. You save S$1,206.80 in tax.', 'the plan with no other reliefs');
      expectEqual(await count(p, '[data-testid="example-left"]'), 0, 'the panel note after "I have none of these"');
      await own.context.close();
    });

    await check('polish: "the default minimum" until the person chooses one; a simulator row at the plan\'s own total', async () => {
      const own = await newPage(browser, { width: 1280, height: 900, label: 'polish', fonts: 'block' });
      const p = own.page;
      await enterA3(p);
      expectEqual(
        await flat(p, 'reco-reason'),
        'Nothing clears the minimum. Each extra dollar would save 3.5 cents or less in tax, and the default minimum is 7 cents.',
        'a S$0 plan at a minimum the person never chose',
      );
      const note = (await p.locator('[data-testid="warnings"] [data-code="BELOW_MIN_SAVING_RATE"] p').innerText()).replace(/\s+/g, ' ');
      expectTrue(/below the default minimum of 7 cents/.test(note) && !/you set|you asked/.test(note), `the note reads "${note}"`);
      // Having used the control and come back to the default preset, it is still the default: nobody is told
      // they "asked for" the figure of a preset. (The page used to say "you asked for" from the first touch.)
      await choose(p, 'depth-every');
      await choose(p, 'depth-default');
      expectEqual(
        await flat(p, 'reco-reason'),
        'Nothing clears the minimum. Each extra dollar would save 3.5 cents or less in tax, and the default minimum is 7 cents.',
        'the same plan with the default preset selected again',
      );
      const noteAgain = (await p.locator('[data-testid="warnings"] [data-code="BELOW_MIN_SAVING_RATE"] p').innerText()).replace(/\s+/g, ' ');
      expectTrue(/below the default minimum of 7 cents/.test(noteAgain) && !/you set|you asked/.test(noteAgain), `the note reads "${noteAgain}"`);
      // A minimum they choose themselves is theirs, at the same figure.
      await choose(p, 'depth-custom');
      expectEqual(await p.locator('#customRate').inputValue(), '0.07', 'the custom minimum');
      expectEqual(
        await flat(p, 'reco-reason'),
        'Nothing clears your minimum. Each extra dollar would save 3.5 cents or less in tax, and you asked for at least 7 cents.',
        'the same plan at a minimum the person chose',
      );
      const noteOwn = (await p.locator('[data-testid="warnings"] [data-code="BELOW_MIN_SAVING_RATE"] p').innerText()).replace(/\s+/g, ' ');
      expectTrue(/below the 7 cents minimum you set/.test(noteOwn), `the note for a chosen minimum reads "${noteOwn}"`);
      // The default that moved with the residency is the default too.
      await choose(p, 'depth-default');
      await choose(p, 'residency-foreigner');
      await setField(p, 'salary', '5000');
      await setField(p, 'bonus', '0');
      expectEqual(
        await flat(p, 'reco-reason'),
        'Nothing clears the minimum. Each extra dollar would save 7 cents or less in tax, and the default minimum is 11.5 cents.',
        'a foreigner back on the default preset after using the control',
      );
      // The modest earner's plan is S$17,240: in S$1,000 steps no row lands on it, so one is added.
      await p.locator('[data-testid="reset"]').click();
      await enterModest(p);
      expectEqual(
        await flat(p, 'reco-reason'),
        'Beyond this, each extra dollar would save 3.5 cents or less, below the default minimum of 7 cents.',
        'where a plan stops at a minimum the person never chose',
      );
      await p.locator('#simulator').evaluate((el) => (el.open = true));
      const row = p.locator('[data-testid="simulator-table"] tr[data-plan-total]');
      expectEqual(await row.count(), 1, 'rows at the plan\'s own total');
      const cells = (await row.locator('th, td').allInnerTexts()).map((c) => c.replace(/\s+/g, ' ').trim());
      expectTrue(/^S\$17,240/.test(cells[0]) && /Your plan's total/.test(cells[0]), `the row is headed "${cells[0]}"`);
      expectEqual(cells.slice(1, 5).join(' | '), 'S$16.80 | 7 | S$1,206.80 | S$550.00', 'the step that ends on the plan total');
      expectEqual(cells.slice(5).join(' | '), 'S$15,300 | S$1,940', 'its split is the plan\'s own');
      expectEqual(await row.evaluate((tr) => tr.parentElement.getAttribute('data-group')), 'plan', 'the row sits in "In your plan"');
      const next = (await p.locator('[data-testid="simulator-table"] tbody[data-group="beyond"] tr[data-step]').first().locator('th, td').allInnerTexts()).map((c) => c.replace(/\s+/g, ' ').trim());
      expectEqual(next.slice(0, 3).join(' | '), 'S$18,000 | S$26.60 | 3.5', 'the first step beyond the plan shows its own rate');
      expectEqual(await count(p, '[data-testid="simulator-table"] tbody tr[data-step]'), 26, 'rows: the engine\'s 25 and the one at the plan total');
      // A step that does land on it adds nothing: S$23,300 is already the example's last row.
      await p.locator('[data-testid="reset"]').click();
      expectEqual(await count(p, '[data-testid="simulator-table"] tbody tr[data-step]'), 25, 'rows for the example');
      expectEqual(await count(p, '[data-testid="simulator-table"] tr[data-plan-total]'), 1, 'the example\'s last row is marked as the plan total');
      await own.context.close();
    });

    await check('version in the footer, and no link to a shop in a build that was given no shop address', async () => {
      const own = await newPage(browser, { width: 1280, height: 900, label: 'footer', fonts: 'block' });
      const p = own.page;
      expectEqual(await text(p, 'version'), `version ${VERSION}`, 'the version in the footer');
      expectTrue(await p.evaluate(() => !!document.querySelector('footer [data-testid="version"]')), 'the version should be in a footer element');
      expectEqual(await count(p, '[data-testid="shop-link"], [data-testid="shop-link-foot"], .shop'), 0, 'shop links without a shop address');
      expectTrue(!/Get the Excel/.test(await pageText(p)), 'the link text is showing without a shop address');
      expectEqual(await count(p, 'a[href=""], a:not([href])'), 0, 'links that go nowhere');
      await own.context.close();
    });

    await check('built with a shop address (VITE_BUY_URL): one link to the workbook under the card and one in the footer', async () => {
      const shopDir = path.join(ROOT, '.tmp', 'e2e-shop');
      const address = 'https://example.com/sg-tax-workbook?from=calculator';
      fs.rmSync(shopDir, { recursive: true, force: true });
      execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', shopDir, '--emptyOutDir', '--logLevel', 'error'], {
        cwd: ROOT,
        env: { ...process.env, VITE_BUY_URL: address },
        stdio: 'pipe',
      });
      const built = fs.readFileSync(path.join(shopDir, 'index.html'), 'utf8');
      expectTrue(!/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|\beval\s*\(/.test(built), 'the build with a shop link contains a network API');
      const shop = await newPage(browser, { width: 1280, height: 900, label: 'shop', fonts: 'block', url: pathToFileURL(path.join(shopDir, 'index.html')).href });
      const p = shop.page;
      await expectExample(p, 'the build with a shop address');
      for (const id of ['shop-link', 'shop-link-foot']) {
        const link = p.locator(`[data-testid="${id}"] a`);
        expectEqual(await link.count(), 1, `${id}: links`);
        expectEqual((await link.innerText()).trim(), 'Get the Excel / Google Sheets workbook', `${id}: text`);
        expectEqual(await link.getAttribute('href'), address, `${id}: address`);
        expectEqual(await link.getAttribute('target'), '_blank', `${id}: target`);
        expectEqual(await link.getAttribute('rel'), 'noopener', `${id}: rel`);
      }
      expectEqual(await count(p, `a[href="${address}"]`), 2, 'links to the shop on the page');
      expectTrue(await p.evaluate(() => !!document.querySelector('.answer [data-testid="shop-link"]') && !!document.querySelector('footer [data-testid="shop-link-foot"]')), 'one under the card and one in the footer');
      const o = await overflow(p);
      expectTrue(o.scrollWidth <= o.innerWidth, `scrollWidth ${o.scrollWidth} > innerWidth ${o.innerWidth}`);
      await p.screenshot({ path: path.join(SHOTS, 'desktop-shop-link.png') });
      await shop.context.close();
      // The page itself still asks for nothing: opening it made no request beyond the fonts stylesheet.
    });

    // Screenshots to look at: the 57-year-old with the room blank, the foreigner, and the foreigner for whom
    // nothing is recommended (five months of work), wide and narrow, light and dark.
    for (const [name, setup] of [
      ['57-blank', async (p) => setField(p, 'age', '57')],
      ['foreigner', async (p) => enterForeigner(p)],
      [
        'foreigner-nothing',
        async (p) => {
          await enterForeigner(p);
          await p.locator('#monthsWorked').selectOption('5');
        },
      ],
    ]) {
      for (const [width, height] of [[1280, 900], [390, 844]]) {
        for (const scheme of ['light', 'dark']) {
          await check(`${name} at ${width}px, ${scheme}: the answer is on the first screen, nothing overflows, nothing is clipped`, async () => {
            const view = await newPage(browser, { width, height, colorScheme: scheme, label: `${name}-${width}-${scheme}`, touch: width < 960 });
            const p = view.page;
            if (width < 960) await p.locator('[data-testid="toggle-inputs"]').click();
            await setup(p);
            if (width < 960) await p.locator('[data-testid="toggle-inputs"]').click();
            await p.evaluate(() => window.scrollTo(0, 0));
            await p.waitForTimeout(150);
            const hero = await p.locator('[data-testid="reco-tax-saved"]').boundingBox();
            expectTrue(hero && hero.y >= 0 && hero.y + hero.height <= height, 'the tax-saved figure is not on the first screen');
            const o = await overflow(p);
            expectTrue(o.scrollWidth <= o.innerWidth, `scrollWidth ${o.scrollWidth} > innerWidth ${o.innerWidth}`);
            // No line of the card or of the cautions runs past its box.
            const clipped = await p.evaluate(() =>
              Array.from(document.querySelectorAll('.answer p, .answer li, .answer dt, .answer dd, .answer h2, .answer h3, .answer summary, .answer button'))
                .filter((el) => el.getClientRects().length > 0 && el.scrollWidth > el.clientWidth + 1)
                .map((el) => el.textContent.trim().slice(0, 40)),
            );
            expectEqual(clipped.join(' | '), '', 'text wider than its box');
            await p.screenshot({ path: path.join(SHOTS, `${name}-${width}-${scheme}-fold.png`) });
            await p.screenshot({ path: path.join(SHOTS, `${name}-${width}-${scheme}.png`), fullPage: true });
            await view.context.close();
          });
        }
      }
    }

    // ------------------------------------------------------------------ desktop, dark
    const desktopDark = await newPage(browser, { width: 1280, height: 900, colorScheme: 'dark', label: 'desktop-dark' });
    await check('dark colour scheme: example renders with a dark background', async () => {
      await expectExample(desktopDark.page, 'dark');
      const rgb = await desktopDark.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const parts = (rgb.match(/\d+/g) || []).map(Number);
      expectTrue(parts.length >= 3 && parts[0] + parts[1] + parts[2] < 200, `body background is ${rgb}`);
    });
    await desktopDark.page.screenshot({ path: path.join(SHOTS, 'desktop-dark.png'), fullPage: true });
    await desktopDark.page.screenshot({ path: path.join(SHOTS, 'desktop-dark-fold.png') });
    await desktopDark.context.close();

    // ------------------------------------------------------------------ wide screens
    await check('wide screens: the results sit beside the rail at 1280px and are centred in the space at 2560px', async () => {
      const wide = await newPage(browser, { width: 2560, height: 1200, label: 'wide' });
      const at = async () =>
        wide.page.evaluate(() => {
          const r = document.querySelector('#results').getBoundingClientRect();
          return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) };
        });
      const big = await at();
      expectTrue(Math.abs(big.left - RAIL - (2560 - big.right)) <= 2, `at 2560px the results span ${big.left} to ${big.right}`);
      expectTrue(big.width >= 900 && big.width <= 1100, `at 2560px the results are ${big.width}px wide`);
      await wide.page.screenshot({ path: path.join(SHOTS, 'desktop-wide.png') });
      await wide.page.setViewportSize({ width: 1280, height: 900 });
      await wide.page.waitForTimeout(150);
      const small = await at();
      // 16px page gutter, then a 24px gap after the rail.
      expectEqual(small.left, RAIL + 16 + 24, 'left edge of the results at 1280px');
      expectEqual(small.right, 1280 - 16, 'right edge of the results at 1280px');
      await wide.context.close();
    });

    // ------------------------------------------------------------------ phone, light and dark
    for (const scheme of ['light', 'dark']) {
      const phone = await newPage(browser, { width: 390, height: 844, colorScheme: scheme, label: `phone-${scheme}`, touch: true });
      const p = phone.page;
      const barMain = p.locator('[data-testid="sticky-bar"] .readout-main');

      await check(`phone 390px, ${scheme}: no horizontal overflow`, async () => {
        await expectExample(p, `phone ${scheme}`);
        const o = await overflow(p);
        expectTrue(o.scrollWidth <= o.innerWidth, `scrollWidth ${o.scrollWidth} > innerWidth ${o.innerWidth}`);
      });

      await check(`phone 390px, ${scheme}: labelled as an example once per screen, under the "Example numbers" card`, async () => {
        expectEqual(await text(p, 'panel-title'), 'Example numbers', 'heading of the numbers card');
        expectEqual(await count(p, '.stamp'), 1, 'example stamps on the page');
        const flag = await text(p, 'example-flag-plan');
        expectTrue(/example/i.test(flag) && /replace with your numbers/i.test(flag), `the plan stamp reads "${flag}"`);
        const box = await p.locator('[data-testid="reco-tax-saved"]').boundingBox();
        expectTrue(box && box.y + box.height <= 844, 'the tax saved figure is not in the first screen');
      });

      await p.screenshot({ path: path.join(SHOTS, `phone-${scheme}.png`), fullPage: true });
      await p.screenshot({ path: path.join(SHOTS, `phone-${scheme}-fold.png`) });

      await check(`phone 390px, ${scheme}: the bottom bar steps back while the figure is on screen, then shows the saving`, async () => {
        const bar = p.locator('[data-testid="sticky-bar"]');
        expectEqual(await bar.evaluate((el) => getComputedStyle(el).position), 'fixed', 'bar position');
        expectTrue(!(await barMain.isVisible()), 'the bar should not repeat the figure while it is on screen');
        const fine = await flat(p, 'bar-fine');
        expectTrue(/Estimate only/i.test(fine) && /not tax advice/i.test(fine) && /YA2027/.test(fine), `the bar reads "${fine}"`);
        await p.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await barMain.waitFor({ state: 'visible', timeout: 3000 });
        const label = (await bar.innerText()).replace(/\s+/g, ' ');
        expectTrue(/Save S\$2,679\.50/.test(label) && /lock away S\$23,300/.test(label), `bar reads "${label}"`);
        expectTrue(/Estimate only/i.test(label), 'the estimate line should stay');
        await barMain.click();
        await p.waitForFunction(
          () => {
            const r = document.getElementById('recommendation').getBoundingClientRect();
            return r.top < window.innerHeight * 0.6 && r.bottom > 0;
          },
          null,
          { timeout: 5000 },
        );
        await barMain.waitFor({ state: 'hidden', timeout: 3000 });
      });

      await check(`phone 390px, ${scheme}: tapping a ladder block shows its figures, tapping again hides them`, async () => {
        const block = p.locator('.chart-hit').first();
        await block.evaluate((el) => el.scrollIntoView({ block: 'center' }));
        await block.tap();
        const tip = p.locator('.chart-tip');
        await tip.waitFor({ state: 'visible', timeout: 3000 });
        expectTrue((await tip.innerText()).includes('S$2,679.50'), 'the tip should show the tax saved by the tier');
        const box = await tip.boundingBox();
        expectTrue(box && box.x >= 0 && box.x + box.width <= 390, 'the tip should stay inside the screen');
        await block.tap();
        await tip.waitFor({ state: 'detached', timeout: 3000 });
      });

      await check(`phone 390px, ${scheme}: stacked lock-up facts keep the 16px gutter; a table that scrolls is a named tab stop`, async () => {
        const edges = await p.evaluate(() => {
          const left = (el) => {
            const range = document.createRange();
            range.selectNodeContents(el);
            return Math.round(range.getBoundingClientRect().left);
          };
          const table = document.querySelector('[data-testid="facts-table"]');
          return { heading: left(table.querySelector('tbody th')), fact: left(table.querySelector('tbody td')) };
        });
        expectTrue(edges.fact >= 16, `fact text starts ${edges.fact}px from the screen edge`);
        expectEqual(edges.fact, edges.heading, 'facts and their row heading should share a left edge');
        await p.locator('#simulator').evaluate((el) => (el.open = true));
        await p.waitForTimeout(200);
        const box = p.locator('[data-testid="simulator-table"]').locator('xpath=ancestor::div[contains(@class,"table-scroll")]');
        expectEqual(await box.getAttribute('tabindex'), '0', 'a scrolling table box should be a tab stop');
        expectEqual(await box.getAttribute('role'), 'region', 'a scrolling table box should be a region');
        expectTrue(((await box.getAttribute('aria-label')) || '').length > 0, 'a scrolling table box should be named');
      });

      await check(`phone 390px, ${scheme}: tables that do not fit are restacked in full; the one that scrolls says so`, async () => {
        // Every figure of the ladder, the comparison and the band table is on screen: nothing starts off to the right.
        const cut = await p.evaluate(() => {
          const out = [];
          for (const id of ['ladder-table', 'scenario-table', 'monthly-table', 'band-table', 'working-table', 'facts-table']) {
            const table = document.querySelector(`[data-testid="${id}"]`);
            for (const cell of table.querySelectorAll('tbody th, tbody td, tfoot th, tfoot td')) {
              const r = cell.getBoundingClientRect();
              if (r.width > 0 && (r.right > window.innerWidth + 0.5 || r.left < -0.5)) out.push(`${id}: ${cell.textContent.slice(0, 24)}`);
            }
          }
          return out;
        });
        expectEqual(cut.slice(0, 4).join(' | '), '', 'cells that start or end off screen');
        const stacked = (id) => p.locator(`[data-testid="${id}"]`).evaluate((t) => t.parentElement.getAttribute('data-stacked'));
        expectEqual(await stacked('scenario-table'), 'rows', 'the comparison on a phone');
        expectEqual(await stacked('ladder-table'), 'rows', 'the ladder figures on a phone');
        // The block leads with what the option saves, and carries every column of the table.
        expectEqual(
          await stackedBlock(p, '[data-scenario="recommended"]'),
          'Tax saved S$2,679.50 | Cash locked away S$23,300 | Saved per dollar (cents) 11.5 | Wasted dollars None | ' +
            'SRS S$15,300 | CPF cash top-up, self S$8,000 | Tax S$3,959.50',
          'the plan block of the comparison',
        );
        // A scheme an option puts nothing into is left out of its block.
        expectEqual(
          await stackedBlock(p, '[data-scenario="srsOnly"]'),
          'Tax saved S$1,759.50 | Cash locked away S$15,300 | Saved per dollar (cents) 11.5 | Wasted dollars None | ' +
            'SRS S$15,300 | Tax S$4,879.50',
          'the "SRS only" block',
        );
        // Restacked tables keep their table semantics for screen readers.
        expectEqual(await p.locator('[data-testid="scenario-table"]').getAttribute('role'), 'table', 'role of a restacked table');
        expectEqual(await p.locator('[data-testid="scenario-table"] tbody td').first().getAttribute('role'), 'cell', 'role of its cells');
        // The simulator is 25 rows of eight figures: it scrolls, shades the side with more, and says so.
        const sim = p.locator('[data-testid="simulator-table"]');
        const wrap = sim.locator('xpath=ancestor::div[contains(@class,"table-wrap")]');
        expectEqual(await wrap.getAttribute('data-more-right'), 'true', 'shading on the side with more columns');
        expectEqual(await wrap.getAttribute('data-more-left'), null, 'shading on the left before scrolling');
        const hint = wrap.locator('xpath=following-sibling::p[@data-testid="scroll-hint"]');
        expectTrue(/Scroll sideways/.test(await hint.innerText()), 'the line that says the table scrolls');
        const heads = await sim.locator('thead th').allInnerTexts();
        expectEqual(heads.slice(0, 3).map((h) => h.replace(/\s+/g, ' ').trim()).join(' | '), 'Extra contribution | This step saves | Per dollar (cents)', 'the first columns of the simulator');
        const firstTwo = await sim.locator('thead th').evaluateAll((cells) => cells.slice(0, 3).every((c) => c.getBoundingClientRect().right <= window.innerWidth));
        expectTrue(firstTwo, 'what each step saves should be on screen without scrolling');
        await sim.locator('xpath=ancestor::div[contains(@class,"table-scroll")]').evaluate((el) => (el.scrollLeft = el.scrollWidth));
        await p.waitForFunction(() => document.querySelector('[data-testid="simulator-table"]').closest('.table-wrap').getAttribute('data-more-right') === null, null, { timeout: 2000 });
        await sim.evaluate((el) => el.closest('#simulator').scrollIntoView());
        await p.screenshot({ path: path.join(SHOTS, `phone-${scheme}-simulator.png`) });
        const o = await overflow(p);
        expectTrue(o.scrollWidth <= o.innerWidth, `scrollWidth ${o.scrollWidth} > innerWidth ${o.innerWidth}`);
      });
      await p.locator('#simulator').evaluate((el) => (el.open = false));

      await check(`phone 390px, ${scheme}: thumb-sized targets, and the whole bottom bar goes to the plan`, async () => {
        const height = (selector) => p.locator(selector).first().evaluate((el) => Math.round(el.getBoundingClientRect().height));
        expectTrue((await height('label[for="theme-dark"]')) >= 40, `theme segment is ${await height('label[for="theme-dark"]')}px tall`);
        expectTrue((await height('.jump-link')) >= 40, `section link is ${await height('.jump-link')}px tall`);
        await p.locator('[data-testid="toggle-inputs"]').click();
        expectTrue((await height('label[for="payMode-annual"]')) >= 40, `Monthly/Annual segment is ${await height('label[for="payMode-annual"]')}px tall`);
        expectTrue((await height('label[for="reliefMode-itemised"]')) >= 40, `One total/Itemise segment is ${await height('label[for="reliefMode-itemised"]')}px tall`);
        expectTrue((await height('label[for="useSrs"]')) >= 40, `scheme label is ${await height('label[for="useSrs"]')}px tall`);
        expectTrue((await height('details.more > summary')) >= 40, `"More options" is ${await height('details.more > summary')}px tall`);
        // A tap just left of the tick box still lands on its label.
        await p.locator('#useCpfSelf').evaluate((el) => el.scrollIntoView({ block: 'center' }));
        const tick = await p.locator('#useCpfSelf').boundingBox();
        await p.touchscreen.tap(tick.x + tick.width + 4, tick.y + tick.height + 8);
        expectTrue(!(await p.locator('#useCpfSelf').isChecked()), 'a tap just below and beside the tick box should switch the scheme off');
        await p.touchscreen.tap(tick.x - 6, tick.y - 6);
        expectTrue(await p.locator('#useCpfSelf').isChecked(), 'a tap just above and left of the tick box should switch it back on');
        await p.locator('#useCpfSelf').tap();
        expectTrue(!(await p.locator('#useCpfSelf').isChecked()), 'a tap on the tick box itself should switch it once');
        await resetToExample(p);
        await p.locator('[data-testid="toggle-inputs"]').click();
        // Anywhere on the bar, not only its first line.
        await p.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await barMain.waitFor({ state: 'visible', timeout: 3000 });
        const fine = await p.locator('[data-testid="bar-fine"]').boundingBox();
        await p.touchscreen.tap(fine.x + 60, fine.y + fine.height / 2);
        await p.waitForFunction(
          () => {
            const r = document.getElementById('recommendation').getBoundingClientRect();
            return r.top < window.innerHeight * 0.6 && r.bottom > 0;
          },
          null,
          { timeout: 5000 },
        );
      });
      // Whatever happened above, the next check starts from the example with the form folded away.
      if ((await p.locator('[data-testid="toggle-inputs"]').getAttribute('aria-expanded')) === 'true') {
        await p.locator('[data-testid="toggle-inputs"]').click();
      }
      await resetToExample(p);

      await check(`phone 390px, ${scheme}: inputs open without overflow, still none at 360px`, async () => {
        await p.evaluate(() => window.scrollTo(0, 0));
        expectTrue(!(await p.locator('#salary').isVisible()), 'inputs should start collapsed on a phone');
        await p.locator('[data-testid="toggle-inputs"]').click();
        expectTrue(await p.locator('#salary').isVisible(), 'inputs should open');
        let o = await overflow(p);
        expectTrue(o.scrollWidth <= o.innerWidth, `inputs open: scrollWidth ${o.scrollWidth} > ${o.innerWidth}`);
        await p.screenshot({ path: path.join(SHOTS, `phone-${scheme}-inputs.png`), fullPage: true });
        await p.setViewportSize({ width: 360, height: 780 });
        await p.waitForTimeout(150);
        o = await overflow(p);
        expectTrue(o.scrollWidth <= o.innerWidth, `360px: scrollWidth ${o.scrollWidth} > ${o.innerWidth}`);
        // The far end of the long form has a way on, and a way to fold it up again.
        await p.locator('[data-testid="inputs-see-plan"]').click();
        await p.waitForFunction(
          () => {
            const r = document.getElementById('recommendation').getBoundingClientRect();
            return r.top < window.innerHeight * 0.6 && r.bottom > 0;
          },
          null,
          { timeout: 5000 },
        );
        await p.locator('[data-testid="inputs-hide"]').click();
        await p.locator('#salary').waitFor({ state: 'hidden', timeout: 3000 });
        o = await overflow(p);
        expectTrue(o.scrollWidth <= o.innerWidth, `360px collapsed: scrollWidth ${o.scrollWidth} > ${o.innerWidth}`);
        await noJunk(p, `phone ${scheme}`);
      });

      await phone.context.close();
    }

    await check('touch: tapping a second and a third ladder tier shows each on the first tap (A.3)', async () => {
      const phone = await newPage(browser, { width: 390, height: 844, label: 'phone-tiers', touch: true });
      const p = phone.page;
      await p.locator('[data-testid="toggle-inputs"]').click();
      await enterA3(p);
      await p.locator('[data-testid="toggle-inputs"]').click();
      const hits = p.locator('.chart-hit');
      expectEqual(await hits.count(), 3, 'ladder tiers for A.3');
      await p.locator('.chart-svg').evaluate((el) => el.scrollIntoView({ block: 'center' }));
      const tip = p.locator('.chart-tip');
      const shown = async () => ((await tip.count()) > 0 ? (await tip.innerText()).replace(/\s+/g, ' ') : null);
      await hits.nth(0).tap({ force: true });
      await p.waitForTimeout(150);
      expectTrue(/S\$0 to S\$5,400/.test((await shown()) || ''), `after tier 1: ${await shown()}`);
      await hits.nth(1).tap({ force: true });
      await p.waitForTimeout(150);
      expectTrue(/S\$5,400 to S\$15,400/.test((await shown()) || ''), `after tier 2: ${await shown()}`);
      await hits.nth(2).tap({ force: true });
      await p.waitForTimeout(150);
      expectTrue(/No tax saved/.test((await shown()) || ''), `after tier 3: ${await shown()}`);
      await hits.nth(2).tap({ force: true });
      await p.waitForTimeout(150);
      expectEqual(await shown(), null, 'a second tap on the same tier puts the figures away');
      await hits.nth(0).tap({ force: true });
      await p.waitForTimeout(150);
      expectTrue(/S\$0 to S\$5,400/.test((await shown()) || ''), `back to tier 1: ${await shown()}`);
      await p.screenshot({ path: path.join(SHOTS, 'phone-ladder-tiers.png') });
      await phone.context.close();
    });

    // ------------------------------------------------------------------ web fonts never needed
    await check('fonts host hangs: the calculator loads, mounts and paints without it', async () => {
      const started = Date.now();
      const hung = await newPage(browser, { width: 1280, height: 900, label: 'fonts-hang', fonts: 'hang' });
      const took = Date.now() - started;
      expectTrue(took < 5000, `the page took ${took} ms to mount with the fonts host hanging`);
      await hung.page.waitForTimeout(400);
      expectEqual(await hung.page.evaluate(() => document.readyState), 'complete', 'document.readyState');
      await expectExample(hung.page, 'fonts hanging');
      // Frames are being produced: a page held up by a pending stylesheet neither runs animation frames nor
      // lets a screenshot through. (Paint timing entries are not available under the fixed test clock.)
      const frame = await Promise.race([
        hung.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve('frame')))),
        new Promise((resolve) => setTimeout(() => resolve('no frame'), 3000)),
      ]);
      expectEqual(frame, 'frame', 'animation frames with the fonts host hanging');
      expectEqual(
        await hung.page.evaluate(() => document.querySelector('link[data-web-fonts]').getAttribute('data-web-fonts')),
        'pending',
        'the fonts request should still be waiting',
      );
      await hung.page.screenshot({ path: path.join(SHOTS, 'desktop-fonts-hanging.png'), timeout: 5000 });
      await setField(hung.page, 'salary', '12000');
      expectEqual(await text(hung.page, 'reco-tax-saved'), 'S$3,120.50', 'still calculates with the fonts host hanging');
      await hung.context.close();
    });

    for (const [width, height] of [
      [1280, 900],
      [1240, 900],
      [390, 844],
      [360, 740],
      [320, 640],
    ]) {
      await check(`fonts blocked, ${width}px: the tax-saved figure stays on one line inside its column`, async () => {
        const plain = await newPage(browser, { width, height, label: `nofonts-${width}`, fonts: 'block', touch: width < 960 });
        const hero = await heroBox(plain.page);
        expectEqual(hero.lines, 1, 'lines taken by the figure');
        expectTrue(hero.inkRight <= hero.columnRight + 1, `the figure ends at ${hero.inkRight}px, its column at ${hero.columnRight}px`);
        const o = await overflow(plain.page);
        expectTrue(o.scrollWidth <= o.innerWidth, `scrollWidth ${o.scrollWidth} > innerWidth ${o.innerWidth}`);
        if (width === 1280 || width === 360) {
          await plain.page.screenshot({ path: path.join(SHOTS, `nofonts-${width}.png`) });
        }
        await plain.context.close();
      });
    }

    await check('a much wider fallback font: the figure is scaled down to fit, never split or spilled', async () => {
      const plain = await newPage(browser, { width: 1280, height: 900, label: 'wide-fallback', fonts: 'block' });
      const before = await heroBox(plain.page);
      await plain.page.addStyleTag({
        content: '.hero-figure{font-family:"DejaVu Sans Mono","Liberation Mono",monospace!important;font-stretch:normal!important;letter-spacing:.04em!important}',
      });
      // A change of column width makes the page refit, as a window resize or a late font would.
      await plain.page.setViewportSize({ width: 1262, height: 900 });
      await plain.page.waitForTimeout(250);
      const after = await heroBox(plain.page);
      expectEqual(after.lines, 1, 'lines taken by the figure');
      expectTrue(after.inkRight <= after.columnRight + 1, `the figure ends at ${after.inkRight}px, its column at ${after.columnRight}px`);
      expectTrue(after.fontSize < before.fontSize, `the figure was not scaled down (${before.fontSize}px to ${after.fontSize}px)`);
      expectTrue(after.fontSize >= 36, `the figure was scaled down too far: ${after.fontSize}px`);
      await plain.context.close();
    });

    // ------------------------------------------------------------------ the calendar moves on
    await check('back in January with the untouched example: the example for the new year, with no Stop notice', async () => {
      const visit = await newPage(browser, { width: 1280, height: 900, label: 'january-example' });
      await expectExample(visit.page, 'first visit');
      await visit.context.clock.setFixedTime(new Date('2027-01-05T10:00:00+08:00'));
      await visit.page.reload();
      await visit.page.waitForSelector('[data-testid="reco-tax-saved"]');
      expectEqual(await visit.page.locator('#incomeYear').inputValue(), '2027', 'income year in January 2027');
      expectEqual(await count(visit.page, '[data-code="DEADLINE_PASSED"]'), 0, 'deadline notices');
      expectEqual(await count(visit.page, '[data-testid="example-flag"]'), 1, 'still labelled as the example');
      expectTrue((await flat(visit.page, 'reco-headline')).startsWith('Put S$'), 'the example plan should be current');
      await visit.context.close();
    });

    await check('back in January with saved numbers: told the year has closed, offered 2027, and Reset is there', async () => {
      const visit = await newPage(browser, { width: 1280, height: 900, label: 'january-saved' });
      await setField(visit.page, 'salary', '12000');
      await visit.context.clock.setFixedTime(new Date('2027-01-05T10:00:00+08:00'));
      await visit.page.reload();
      await visit.page.waitForSelector('[data-testid="reco-tax-saved"]');
      expectEqual(await visit.page.locator('#salary').inputValue(), '12,000', 'saved salary');
      expectEqual(await visit.page.locator('#incomeYear').inputValue(), '2026', 'saved income year');
      expectEqual(await flat(visit.page, 'reco-headline'), 'The 31 Dec 2026 deadline has passed.', 'headline');
      expectEqual(await count(visit.page, '[data-testid="reset"]'), 1, 'Reset to example');
      const offer = visit.page.locator('[data-testid="notice-switch-year"]');
      expectEqual((await offer.innerText()).trim(), 'Plan for 2027 instead', 'the offer in the notice');
      await offer.click();
      expectEqual(await visit.page.locator('#incomeYear').inputValue(), '2027', 'income year after taking the offer');
      expectEqual(await visit.page.locator('#salary').inputValue(), '12,000', 'the numbers carry over');
      expectTrue((await flat(visit.page, 'reco-headline')).startsWith('Put S$'), 'a live plan for 2027');
      await visit.context.close();
    });

    await check('the last day and the last fortnight are said plainly, at the top', async () => {
      const lastDay = await newPage(browser, { width: 1280, height: 900, label: 'last-day', now: new Date('2026-12-31T09:00:00+08:00') });
      expectEqual(await flat(lastDay.page, 'reco-deadline'), 'Today is the last day to transfer', 'card on 31 December');
      expectTrue(/last day today/.test(await flat(lastDay.page, 'bar-fine')), 'bar on 31 December');
      expectEqual(await count(lastDay.page, '[data-testid="top-notices"] [data-code="DEADLINE_SOON"]'), 1, 'deadline notice at the top');
      expectTrue(/Today, 31 December 2026, is the last day/.test(await flat(lastDay.page, 'countdown')), 'countdown on 31 December');
      await lastDay.context.close();
      const soon = await newPage(browser, { width: 390, height: 844, label: 'last-week', touch: true, now: new Date('2026-12-25T09:00:00+08:00') });
      expectEqual(await count(soon.page, '[data-testid="top-notices"] [data-code="DEADLINE_SOON"]'), 1, 'deadline notice at the top, 6 days out');
      expectTrue(/6 days left to transfer/.test(await flat(soon.page, 'reco-deadline')), 'card with 6 days left');
      await soon.page.screenshot({ path: path.join(SHOTS, 'phone-deadline-soon.png') });
      await soon.context.close();
    });

    await check('a tab left open follows the calendar: the countdown, the last day, then the deadline passed', async () => {
      const open = await newPage(browser, { width: 390, height: 844, label: 'open-tab', touch: true, now: new Date('2026-12-20T22:00:00+08:00') });
      const p = open.page;
      expectTrue(/11 days left to transfer/.test(await flat(p, 'reco-deadline')), `on 20 December the card reads "${await flat(p, 'reco-deadline')}"`);
      await p.locator('[data-testid="toggle-inputs"]').click();
      await setField(p, 'salary', '9000');
      await p.locator('[data-testid="toggle-inputs"]').click();
      // The same page, eleven days later: it is looked at again.
      await open.context.clock.setFixedTime(new Date('2026-12-31T09:00:00+08:00'));
      await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await p.waitForFunction(() => /last day/i.test(document.querySelector('[data-testid="reco-deadline"]').textContent), null, { timeout: 3000 });
      expectEqual(await flat(p, 'reco-deadline'), 'Today is the last day to transfer', 'card on 31 December');
      expectTrue(/last day today/.test(await flat(p, 'bar-fine')), 'bar on 31 December');
      expectEqual(await count(p, '[data-testid="top-notices"] [data-code="DEADLINE_SOON"]'), 1, 'last-day notice at the top');
      // And three days after that.
      await open.context.clock.setFixedTime(new Date('2027-01-03T09:00:00+08:00'));
      await p.evaluate(() => window.dispatchEvent(new Event('focus')));
      await p.waitForFunction(() => /deadline has passed/.test(document.querySelector('[data-testid="reco-headline"]').textContent), null, { timeout: 3000 });
      expectEqual(await flat(p, 'reco-headline'), 'The 31 Dec 2026 deadline has passed.', 'headline on 3 January');
      expectEqual(await count(p, '[data-testid="top-notices"] [data-code="DEADLINE_PASSED"]'), 1, 'Stop notice at the top');
      const card = (await p.locator('#recommendation').innerText()).replace(/\s+/g, ' ');
      expectTrue(!/\bPut S\$/.test(card) && !/left to transfer/.test(card), `the card still instructs: "${card.slice(0, 200)}"`);
      expectTrue(/deadline passed/.test(await flat(p, 'bar-fine')), 'bar on 3 January');
      // Editing a number does not bring the instruction back.
      await p.locator('[data-testid="toggle-inputs"]').click();
      await setField(p, 'salary', '9100');
      expectEqual(await flat(p, 'reco-headline'), 'The 31 Dec 2026 deadline has passed.', 'headline after an edit on 3 January');
      await open.context.close();

      // The untouched example moves on with the date: in January it is the example for the new year.
      const example = await newPage(browser, { width: 1280, height: 900, label: 'open-tab-example', now: new Date('2026-12-20T22:00:00+08:00') });
      expectEqual(await example.page.locator('#incomeYear').inputValue(), '2026', 'income year on 20 December');
      await example.context.clock.setFixedTime(new Date('2027-01-03T09:00:00+08:00'));
      await example.page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
      await example.page.waitForFunction(() => document.querySelector('#incomeYear').value === '2027', null, { timeout: 3000 });
      expectEqual(await count(example.page, '[data-code="DEADLINE_PASSED"]'), 0, 'deadline notices on the example in January');
      expectEqual(await count(example.page, '[data-testid="example-flag"]'), 1, 'still labelled as the example');
      expectTrue((await flat(example.page, 'reco-headline')).startsWith('Put S$'), 'the example plan should be current');
      await example.context.close();
    });

    await check('a tab left open over midnight catches up by itself, within a minute', async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, timezoneId: 'Asia/Singapore', locale: 'en-SG' });
      await context.clock.install({ time: new Date('2026-12-30T23:59:30+08:00') });
      const night = await context.newPage();
      watch(night, 'midnight');
      await night.goto(PAGE_URL);
      await night.waitForSelector('[data-testid="reco-tax-saved"]');
      expectTrue(/1 day left to transfer/.test(await flat(night, 'reco-deadline')), `before midnight the card reads "${await flat(night, 'reco-deadline')}"`);
      // Nobody touches the page: only its own clock check runs.
      await context.clock.runFor(95_000);
      await night.waitForFunction(() => /last day/i.test(document.querySelector('[data-testid="reco-deadline"]').textContent), null, { timeout: 3000 });
      expectEqual(await flat(night, 'reco-deadline'), 'Today is the last day to transfer', 'card after midnight');
      await context.close();
    });

    await check('opened years later (2028): says the deadline has passed and that a newer version is needed', async () => {
      const late = await newPage(browser, { width: 390, height: 844, label: 'year-2028', touch: true, now: new Date('2028-03-02T10:00:00+08:00') });
      expectEqual(await flat(late.page, 'reco-headline'), 'The 31 Dec 2027 deadline has passed.', 'headline in March 2028');
      expectEqual(await count(late.page, '[data-testid="reco-switch-year"]'), 0, 'no year to offer');
      const outdated = await flat(late.page, 'reco-outdated');
      expectTrue(/rules up to income year 2027/.test(outdated) && /2028 needs a newer version/.test(outdated), `the card reads "${outdated}"`);
      const o = await overflow(late.page);
      expectTrue(o.scrollWidth <= o.innerWidth, `scrollWidth ${o.scrollWidth} > innerWidth ${o.innerWidth}`);
      await late.context.close();
    });

    // ------------------------------------------------------------------ on paper
    await check('print: light paper whatever the theme, no bar or controls, the inputs listed, the chart scaled to the page', async () => {
      const paper = await newPage(browser, { width: 1280, height: 900, colorScheme: 'dark', label: 'print' });
      const p = paper.page;
      await p.emulateMedia({ media: 'print' });
      await p.setViewportSize({ width: 718, height: 1000 }); // an A4 page inside 14mm margins
      await p.waitForTimeout(300);
      const seen = await p.evaluate(() => {
        const shown = (selector) => {
          const el = document.querySelector(selector);
          return !!el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
        };
        const lum = (colour) => {
          const [r, g, b] = (colour.match(/[\d.]+/g) || []).map(Number);
          return Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
        };
        const slab = getComputedStyle(document.querySelector('.slab'));
        const svg = document.querySelector('.chart-svg').getBoundingClientRect();
        const box = document.querySelector('#ladder').getBoundingClientRect();
        return {
          bar: shown('[data-testid="sticky-bar"]'),
          jump: shown('.jump'),
          theme: shown('.brand .seg'),
          copy: shown('#copy-summary'),
          form: shown('#inputs'),
          toggle: shown('#toggle-inputs'),
          summary: shown('.summary-lines'),
          page: lum(getComputedStyle(document.body).backgroundColor),
          slab: lum(slab.backgroundColor),
          slabInk: lum(getComputedStyle(document.querySelector('[data-testid="reco-tax-saved"]')).color),
          slabBorder: parseFloat(slab.borderTopWidth),
          meter: getComputedStyle(document.querySelector('.meter-saved')).printColorAdjust,
          rail: getComputedStyle(document.querySelector('.rail')).position,
          chartFits: svg.right <= box.right + 1 && svg.width > 300,
          overflow: document.documentElement.scrollWidth - window.innerWidth,
        };
      });
      expectEqual([seen.bar, seen.jump, seen.theme, seen.copy, seen.form, seen.toggle].join(' '), 'false false false false false false', 'bar, section links, theme toggle, copy button, form, form toggle');
      expectTrue(seen.summary, 'the numbers behind the plan should be listed in place of the form');
      expectTrue(seen.page > 240, `the page background has luminance ${seen.page}`);
      expectTrue(seen.slab > 240 && seen.slabInk < 60, `the plan card prints ${seen.slabInk} on ${seen.slab}`);
      expectTrue(seen.slabBorder >= 1, 'the plan card should have a border on paper');
      expectEqual(seen.meter, 'exact', 'print-color-adjust on the tax meter');
      expectEqual(seen.rail, 'static', 'position of the rail (a fixed one repeats on every page)');
      expectTrue(seen.chartFits, 'the ladder chart should scale to the page width');
      expectTrue(seen.overflow <= 0, `the printed page is ${seen.overflow}px wider than the paper`);
      await p.screenshot({ path: path.join(SHOTS, 'print-a4.png'), fullPage: true });
      await p.pdf({ path: path.join(SHOTS, 'print-a4.pdf'), format: 'A4' });
      await paper.context.close();
    });

    // ------------------------------------------------------------------ works without storage
    await check('works when localStorage throws', async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
      await context.clock.setFixedTime(FIXED_NOW);
      await context.addInitScript(() => {
        Object.defineProperty(window, 'localStorage', {
          configurable: true,
          get() {
            throw new Error('blocked');
          },
        });
      });
      const blocked = await context.newPage();
      watch(blocked, 'no-storage');
      await blocked.goto(PAGE_URL);
      await blocked.waitForSelector('[data-testid="reco-tax-saved"]', { timeout: 15000 });
      await expectExample(blocked, 'without storage');
      await setField(blocked, 'salary', '12000');
      expectEqual(await text(blocked, 'reco-tax-saved'), 'S$3,120.50', 'still calculates without storage');
      expectTrue(/will not save/.test(await text(blocked, 'saved-flag')), 'the page should say the numbers are not kept');
      await context.close();
    });

    await check('unparseable or outdated saved data is ignored', async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
      await context.clock.setFixedTime(FIXED_NOW);
      const stale = await context.newPage();
      watch(stale, 'stale-storage');
      await stale.goto(PAGE_URL);
      await stale.waitForSelector('[data-testid="reco-tax-saved"]');
      for (const junk of ['{not json', JSON.stringify({ v: 0, ui: { salary: 1 } }), JSON.stringify({ v: 1, ui: 'nope' })]) {
        await stale.evaluate((value) => window.localStorage.setItem('sgto:v1', value), junk);
        await stale.reload();
        await stale.waitForSelector('[data-testid="reco-tax-saved"]');
        await expectExample(stale, `saved data ${junk.slice(0, 12)}`);
      }
      await context.close();
    });

    // ------------------------------------------------------------------ artifact fragment
    const hostSkeleton = (fragment, htmlAttributes = '') =>
      `<!doctype html><html lang="en"${htmlAttributes}><head><meta charset="utf-8">` +
      '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
      '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}' +
      'body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>' +
      `</head><body>\n${fragment}\n</body></html>`;

    await check('artifact fragment: right shape, and runs inside a minimal host skeleton', async () => {
      execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-artifact.mjs')], { stdio: 'pipe' });
      const fragment = fs.readFileSync(ARTIFACT, 'utf8');
      const outside = fragment.replace(/(<script\b[^>]*>)[\s\S]*?<\/script>/gi, '$1</script>');
      for (const tag of ['<!doctype', '<html', '<head', '<body', '<link']) {
        expectTrue(!outside.toLowerCase().includes(tag), `fragment contains ${tag}`);
      }
      // The fragment can ask for the fonts stylesheet and nothing else: no fetch, no other network API.
      const api = /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource/.exec(fragment);
      expectTrue(!api, `the fragment contains a network API: ${api && api[0]}`);
      const order = ['<title>', '<meta name="claude:viewport-fit-sides" content="cover">', '<style>', '<div id="app">', '<script type="module">'];
      let at = -1;
      for (const piece of order) {
        const next = outside.indexOf(piece, at + 1);
        expectTrue(next > at, `fragment is missing ${piece} or has it out of order`);
        at = next;
      }
      const wrapped = path.join(ROOT, '.tmp', 'artifact-host.html');
      fs.writeFileSync(wrapped, hostSkeleton(fragment));
      const host = await newPage(browser, { width: 390, height: 844, label: 'artifact', url: pathToFileURL(wrapped).href });
      await expectExample(host.page, 'artifact fragment');
      const o = await overflow(host.page);
      expectTrue(o.scrollWidth <= o.innerWidth, `artifact: scrollWidth ${o.scrollWidth} > ${o.innerWidth}`);
      await host.context.close();
    });

    await check('artifact host that sets data-theme: "System" leaves it alone and hands it back', async () => {
      const fragment = fs.readFileSync(ARTIFACT, 'utf8');
      const wrapped = path.join(ROOT, '.tmp', 'artifact-host-dark.html');
      fs.writeFileSync(wrapped, hostSkeleton(fragment, ' data-theme="dark"'));
      const host = await newPage(browser, { width: 1280, height: 900, colorScheme: 'light', label: 'artifact-dark', url: pathToFileURL(wrapped).href });
      const theme = () => host.page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      expectEqual(await theme(), 'dark', 'data-theme after the calculator mounts');
      const rgb = await host.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const parts = (rgb.match(/\d+/g) || []).map(Number);
      expectTrue(parts[0] + parts[1] + parts[2] < 200, `the host asked for dark but the background is ${rgb}`);
      await choose(host.page, 'theme-light');
      expectEqual(await theme(), 'light', 'data-theme after choosing Light');
      await choose(host.page, 'theme-system');
      expectEqual(await theme(), 'dark', 'data-theme after going back to System');
      await host.context.close();
    });

    await check('no console errors, page errors or unexpected network requests', async () => {
      expectEqual(problems.join(' || '), '', 'problems seen while testing');
    });
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed. Screenshots: ${path.relative(ROOT, SHOTS)}/`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FAIL  the test run crashed:', err);
  process.exit(1);
});

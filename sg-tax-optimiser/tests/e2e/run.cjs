/* eslint-disable no-console */
/**
 * Browser end-to-end test for the single-file web calculator (SPEC section 10).
 *
 *   npm run build && node scripts/build-artifact.mjs && node tests/e2e/run.cjs
 *
 * Opens dist/index.html from a file:// URL in Chromium, checks the worked examples in SPEC Appendix A against
 * what the page shows, exercises the inputs, and saves screenshots to .tmp/screens/.
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
const DIST = path.join(ROOT, 'dist', 'index.html');
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

/** SPEC Appendix A.2, entered from the opening example. */
async function enterA2(page) {
  await choose(page, 'residency-pr');
  await setField(page, 'age', '57');
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
    console.error('FAIL  dist/index.html not found. Run "npm run build" first.');
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
        headline.includes('S$15,300 into SRS') && headline.includes('S$8,000 into your CPF'),
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
      expectTrue(
        reason.includes('Switching on the family CPF top-up would raise the saving to S$3,478.00'),
        `reason reads "${reason}"`,
      );
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
      expectTrue((await flat(page, 'reco-headline')).startsWith('Put S$8,000 into your CPF and S$15,300 into SRS'), 'the order was applied');
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
      await choose(page, 'depth-worth');
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
      await choose(page, 'reliefMode-itemised');
      // Like Monthly and Annual, the switch keeps the reliefs: the typed total goes into "Any other relief".
      expectEqual(await text(page, 'relief-total'), 'S$5,000', 'the typed total carries into the helper');
      expectEqual(await page.locator('#relief-other').inputValue(), '5,000', '"Any other relief" after the switch');
      expectEqual(await text(page, 'reco-tax-saved'), 'S$2,679.50', 'the plan does not change on switching');
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
      expectTrue(/CPF top-up relief, self/.test(citizenRules), 'a citizen should see the CPF rule values');
      await choose(page, 'residency-foreigner');
      expectEqual(await count(page, '#useCpfSelf'), 0, 'CPF top-up (self) checkbox');
      expectEqual(await count(page, '#useCpfFamily'), 0, 'CPF top-up (family) checkbox');
      expectEqual(await count(page, '#existingCpfSelf'), 0, 'CPF self already-contributed field');
      expectEqual(await count(page, '#existingCpfFamily'), 0, 'CPF family already-contributed field');
      expectEqual(await count(page, '[data-testid="reco-cpf-self"]'), 0, 'CPF row in the recommendation');
      expectEqual(await count(page, '#useSrs'), 1, 'SRS stays');
      const note = await text(page, 'foreigner-note');
      expectTrue(/no CPF account/i.test(note), `explanation reads "${note}"`);
      expectEqual(await text(page, 'reco-srs'), 'S$35,700', 'foreigner SRS cap');
      const rules = (await page.locator('.sources .rows').innerText()).replace(/\s+/g, ' ');
      expectTrue(!/CPF top-up relief|ceiling for CPF|Retirement Sum|Healthcare Sum/.test(rules), `rule values read "${rules}"`);
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
        headline.startsWith("Put S$8,000 into your CPF, S$10,300 into SRS and S$1,700 into family members' CPF."),
        `headline reads "${headline}"`,
      );
      const slip = await page.locator('.slip .row dt').allInnerTexts();
      expectEqual(slip.slice(0, 3).join(' | '), 'CPF top-up, self | SRS | CPF top-up, family', 'order of the scheme rows');
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
      const plan = (await page.locator('[data-scenario="recommended"]').innerText()).replace(/\s+/g, ' ');
      expectTrue(/Tax saved S\$3,000\.00/.test(plan) && /Wasted dollars None/.test(plan), `the plan block reads "${plan}"`);
      const o = await overflow(page);
      expectTrue(o.scrollWidth <= o.innerWidth, `scrollWidth ${o.scrollWidth} > innerWidth ${o.innerWidth}`);
      await page.screenshot({ path: path.join(SHOTS, 'desktop-1024-a2.png'), fullPage: true });
      // And with the opening example, at the bottom of the two-column range, every table is still a table.
      await page.locator('#simulator').evaluate((el) => (el.open = false));
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.waitForTimeout(200);
    });

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
        const plan = (await p.locator('[data-scenario="recommended"]').innerText()).replace(/\s+/g, ' ');
        expectTrue(/^Your plan Recommended Tax saved S\$2,679\.50 Cash locked away S\$23,300/.test(plan), `the plan block reads "${plan}"`);
        expectTrue(/Wasted dollars None/.test(plan) && /Tax S\$3,959\.50/.test(plan), 'the plan block should carry every column');
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
        await p.locator('#simulator').evaluate((el) => (el.open = false));
        const o = await overflow(p);
        expectTrue(o.scrollWidth <= o.innerWidth, `scrollWidth ${o.scrollWidth} > innerWidth ${o.innerWidth}`);
      });

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
        const tick = await p.locator('#useCpfSelf').boundingBox();
        await p.touchscreen.tap(tick.x + tick.width + 4, tick.y + tick.height + 8);
        expectTrue(!(await p.locator('#useCpfSelf').isChecked()), 'a tap beside the tick box should switch the scheme off');
        await p.locator('#useCpfSelf').tap();
        expectTrue(await p.locator('#useCpfSelf').isChecked(), 'a tap on the tick box itself should switch it back on');
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

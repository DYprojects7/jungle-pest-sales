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
 * The browser clock is fixed at 13 Nov 2026 (Singapore) so the deadline figures are stable.
 * Google Fonts is the only network host the page may touch; if it cannot be reached the page must still work.
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

/** Watch a page for anything that should not happen. */
function watch(page, label) {
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const where = msg.location() && msg.location().url ? msg.location().url : '';
    // A font that cannot be fetched (offline, sandbox) is allowed: the page has system fallbacks.
    if (FONT_HOSTS.test(where)) return;
    problems.push(`[${label}] console error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => problems.push(`[${label}] page error: ${err.message}`));
  page.on('request', (req) => {
    const url = req.url();
    if (url.startsWith('file://') || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:')) return;
    if (FONT_HOSTS.test(url)) return;
    problems.push(`[${label}] unexpected network request: ${url}`);
  });
}

async function newPage(browser, { width, height, colorScheme = 'light', label, url = PAGE_URL }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme,
    timezoneId: 'Asia/Singapore',
    locale: 'en-SG',
  });
  await context.clock.setFixedTime(FIXED_NOW);
  const page = await context.newPage();
  watch(page, label);
  await page.goto(url);
  await page.waitForSelector('[data-testid="reco-tax-saved"]', { timeout: 15000 });
  // Give web fonts a moment; carry on with system fonts if they do not arrive.
  await page
    .evaluate(() => Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 4000))]))
    .catch(() => {});
  return { context, page };
}

const text = async (page, testid) => (await page.locator(`[data-testid="${testid}"]`).first().innerText()).trim();
const count = (page, selector) => page.locator(selector).count();

/** Type into a number field the way a person does, then leave it. */
async function setField(page, id, value) {
  const input = page.locator(`#${id}`);
  await input.click();
  await input.fill(String(value));
  await input.blur();
}

async function choose(page, id) {
  // Segmented options are radios laid under their label.
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

    await check('single file: no external scripts, one Google Fonts stylesheet at most', async () => {
      const html = fs.readFileSync(DIST, 'utf8');
      expectTrue(!/<script\b[^>]*\bsrc=/i.test(html), 'dist/index.html references an external script');
      const links = html.match(/<link\b[^>]*rel="stylesheet"[^>]*>/gi) || [];
      for (const link of links) {
        expectTrue(/href="https:\/\/fonts\.googleapis\.com\//.test(link), `unexpected stylesheet link: ${link}`);
      }
    });

    await check('example (Appendix A.1): SRS S$15,300, CPF S$8,000, saved S$2,679.50, tax S$6,639.00 to S$3,959.50', async () => {
      await expectExample(page, 'on load');
      expectEqual(await text(page, 'reco-rate'), '11.5 cents', 'saving per dollar');
    });

    await check('example is labelled as an example and the recommendation is visible without interaction', async () => {
      const flag = await text(page, 'example-flag');
      expectTrue(/example/i.test(flag) && /replace with your numbers/i.test(flag), `example label reads "${flag}"`);
      const box = await page.locator('[data-testid="reco-tax-saved"]').boundingBox();
      expectTrue(box && box.y >= 0 && box.y + box.height <= 900, 'the tax saved figure is not in the first screen');
      const headline = await text(page, 'reco-headline');
      expectTrue(
        headline.includes('S$15,300 into SRS') && headline.includes('S$8,000 into your CPF'),
        `headline reads "${headline}"`,
      );
      expectTrue((await text(page, 'reco-reason')).length > 20, 'no reason sentence under the recommendation');
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
      const unlabelled = await page.evaluate(() => {
        const bad = [];
        for (const el of document.querySelectorAll('input, select, textarea')) {
          if (!el.id) bad.push(`${el.tagName} without id`);
          else if (!document.querySelector(`label[for="${el.id}"]`)) bad.push(`#${el.id} without label`);
        }
        return bad;
      });
      expectEqual(unlabelled.join(', '), '', 'controls without a label or id');
      expectEqual(await page.locator('[data-testid="live"]').getAttribute('aria-live'), 'polite', 'aria-live');
      const unscoped = await page.locator('table th:not([scope])').count();
      expectEqual(unscoped, 0, 'th cells without a scope');
      await noJunk(page, 'example');
    });

    await page.screenshot({ path: path.join(SHOTS, 'desktop-light.png'), fullPage: true });

    await check('changing the salary updates the result (S$12,000 a month saves S$3,120.50)', async () => {
      const before = await text(page, 'reco-tax-saved');
      await setField(page, 'salary', '12,000');
      const after = await text(page, 'reco-tax-saved');
      expectTrue(after !== before, 'tax saved did not change');
      expectEqual(after, 'S$3,120.50', 'tax saved at S$12,000 a month');
      expectEqual(await page.locator('#salary').inputValue(), '12,000', 'salary shows formatted');
      expectEqual(await count(page, '[data-testid="example-flag"]'), 0, 'example label should go once edited');
      await noJunk(page, 'after salary change');
    });

    await check('state survives a reload', async () => {
      await page.reload();
      await page.waitForSelector('[data-testid="reco-tax-saved"]');
      expectEqual(await page.locator('#salary').inputValue(), '12,000', 'salary after reload');
      expectEqual(await text(page, 'reco-tax-saved'), 'S$3,120.50', 'tax saved after reload');
      expectEqual(await count(page, '[data-testid="example-flag"]'), 0, 'example label after reload');
    });

    await check('Reset to example restores the example', async () => {
      await page.locator('[data-testid="reset"]').click();
      await expectExample(page, 'after reset');
      expectEqual(await page.locator('#salary').inputValue(), '10,000', 'salary after reset');
      expectEqual(await count(page, '[data-testid="example-flag"]'), 1, 'example label after reset');
    });

    await check('money inputs: commas accepted, letters dropped, empty is 0, formatted on blur', async () => {
      const bonus = page.locator('#bonus');
      await bonus.click();
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

    await check('limits explain themselves: SRS already contributed is held at S$15,300', async () => {
      await setField(page, 'existingSrs', '20000');
      expectEqual(await page.locator('#existingSrs').inputValue(), '15,300', 'SRS already contributed');
      const note = await page.locator('#existingSrs-note').innerText();
      expectTrue(note.includes('SRS is capped at S$15,300 a year'), `note reads "${note}"`);
      await setField(page, 'existingSrs', '0');
    });

    await check('low salary (Appendix A.3): nothing at 7%, then Every tax dollar gives SRS S$15,300 + CPF S$100', async () => {
      await setField(page, 'salary', '3500');
      await setField(page, 'bonus', '3500');
      await setField(page, 'reliefTotal', '0');
      await setField(page, 'age', '28');
      expectEqual(await text(page, 'reco-tax-before'), 'S$389.00', 'A.3 tax before');
      expectEqual(await text(page, 'reco-srs'), 'S$0', 'A.3 SRS at the 7% minimum');
      expectEqual(await text(page, 'reco-tax-saved'), 'S$0.00', 'A.3 tax saved at the 7% minimum');
      expectTrue(/nothing/i.test(await text(page, 'reco-headline')), 'S$0 plan should say so');
      expectTrue((await text(page, 'reco-reason')).includes('3.5 cents'), 'S$0 plan should explain the 3.5 cent saving');
      expectEqual(await count(page, '[data-testid="offer-every"]'), 1, 'offer of the Every tax dollar view');
      await choose(page, 'depth-every');
      expectEqual(await text(page, 'reco-srs'), 'S$15,300', 'A.3 SRS with Every tax dollar');
      expectEqual(await text(page, 'reco-cpf-self'), 'S$100', 'A.3 CPF with Every tax dollar');
      expectEqual(await text(page, 'reco-tax-after'), 'S$0.00', 'A.3 tax after');
      expectEqual(await text(page, 'reco-tax-saved'), 'S$389.00', 'A.3 tax saved');
      await noJunk(page, 'A.3');
    });

    await check('the offer button under a S$0 plan switches to Every tax dollar', async () => {
      await choose(page, 'depth-worth');
      expectEqual(await text(page, 'reco-tax-saved'), 'S$0.00', 'back at the 7% minimum');
      await page.locator('[data-testid="offer-every"]').click();
      expectTrue(await page.locator('#depth-every').isChecked(), 'Every tax dollar should be selected');
      expectEqual(await text(page, 'reco-tax-saved'), 'S$389.00', 'tax saved after taking the offer');
    });

    await check('foreigner: CPF schemes are hidden and the reason is given', async () => {
      await page.locator('[data-testid="reset"]').click();
      expectEqual(await count(page, '#useCpfSelf'), 1, 'CPF self is offered to a citizen');
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
      await noJunk(page, 'foreigner');
    });

    await check('PR shows the PR year; age 55 shows the birth month; income year 2027 is flagged projected', async () => {
      await page.locator('[data-testid="reset"]').click();
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
      await noJunk(page, 'projected year');
    });

    await check('simulator is collapsed by default and reacts to the step selector', async () => {
      await page.locator('[data-testid="reset"]').click();
      expectTrue(!(await page.locator('#simulator').evaluate((el) => el.open)), 'simulator should start collapsed');
      await page.locator('#simulator > summary').click();
      const rows1000 = await count(page, '[data-testid="simulator-table"] tbody tr');
      await page.locator('#simulatorStep').selectOption('5000');
      const rows5000 = await count(page, '[data-testid="simulator-table"] tbody tr');
      expectEqual(rows1000, 25, 'rows at S$1,000 steps up to S$23,300');
      expectEqual(rows5000, 6, 'rows at S$5,000 steps up to S$23,300');
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

    await check('Copy summary copies, or shows the summary selected when the browser refuses', async () => {
      await page.locator('[data-testid="reset"]').click();
      await page.locator('[data-testid="copy-summary"]').click();
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="copy-summary"]').textContent.trim() === 'Copied' ||
          document.querySelector('[data-testid="summary-text"]') !== null,
        null,
        { timeout: 5000 },
      );
      if ((await count(page, '[data-testid="summary-text"]')) > 0) {
        const value = await page.locator('[data-testid="summary-text"]').inputValue();
        expectTrue(value.includes('S$15,300') && value.includes('S$2,679.50'), 'fallback summary is missing the plan');
      }
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
    await desktopDark.context.close();

    // ------------------------------------------------------------------ phone, light and dark
    for (const scheme of ['light', 'dark']) {
      const phone = await newPage(browser, { width: 390, height: 844, colorScheme: scheme, label: `phone-${scheme}` });
      const p = phone.page;

      await check(`phone 390px, ${scheme}: no horizontal overflow`, async () => {
        await expectExample(p, `phone ${scheme}`);
        const o = await overflow(p);
        expectTrue(o.scrollWidth <= o.innerWidth, `scrollWidth ${o.scrollWidth} > innerWidth ${o.innerWidth}`);
      });

      await p.screenshot({ path: path.join(SHOTS, `phone-${scheme}.png`), fullPage: true });

      await check(`phone 390px, ${scheme}: sticky bar shows the saving and scrolls to the recommendation`, async () => {
        const bar = p.locator('[data-testid="sticky-bar"]');
        expectEqual(await bar.evaluate((el) => getComputedStyle(el).position), 'fixed', 'bar position');
        const label = (await bar.innerText()).replace(/\s+/g, ' ');
        expectTrue(/Save S\$2,679\.50/.test(label) && /lock away S\$23,300/.test(label), `bar reads "${label}"`);
        expectTrue(/Estimate only/i.test(label) && /YA2027/.test(label), 'bar should carry the estimate line');
        await p.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await bar.locator('button').click();
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
        await p.locator('[data-testid="toggle-inputs"]').click();
        o = await overflow(p);
        expectTrue(o.scrollWidth <= o.innerWidth, `360px collapsed: scrollWidth ${o.scrollWidth} > ${o.innerWidth}`);
        await noJunk(p, `phone ${scheme}`);
      });

      await phone.context.close();
    }

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
    await check('artifact fragment: right shape, and runs inside a minimal host skeleton', async () => {
      execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-artifact.mjs')], { stdio: 'pipe' });
      const fragment = fs.readFileSync(ARTIFACT, 'utf8');
      const outside = fragment.replace(/(<script\b[^>]*>)[\s\S]*?<\/script>/gi, '$1</script>');
      for (const tag of ['<!doctype', '<html', '<head', '<body']) {
        expectTrue(!outside.toLowerCase().includes(tag), `fragment contains ${tag}`);
      }
      const order = ['<title>', '<meta name="claude:viewport-fit-sides" content="cover">', '<style>', '<div id="app">', '<script type="module">'];
      let at = -1;
      for (const piece of order) {
        const next = outside.indexOf(piece, at + 1);
        expectTrue(next > at, `fragment is missing ${piece} or has it out of order`);
        at = next;
      }
      const link = outside.indexOf('<link ');
      if (link !== -1) {
        expectTrue(link > outside.indexOf('<meta ') && link < outside.indexOf('<style>'), 'font link is out of order');
      }
      const wrapped = path.join(ROOT, '.tmp', 'artifact-host.html');
      fs.writeFileSync(
        wrapped,
        '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
          '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
          '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}' +
          'body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>' +
          `</head><body>\n${fragment}\n</body></html>`,
      );
      const host = await newPage(browser, { width: 390, height: 844, label: 'artifact', url: pathToFileURL(wrapped).href });
      await expectExample(host.page, 'artifact fragment');
      const o = await overflow(host.page);
      expectTrue(o.scrollWidth <= o.innerWidth, `artifact: scrollWidth ${o.scrollWidth} > ${o.innerWidth}`);
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

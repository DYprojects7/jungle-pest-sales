// Turns the single-file build (dist/index.html) into dist/artifact.html: a FRAGMENT for a host page that
// supplies its own <!doctype>, <html>, <head> and <body>.
//
// Order in the fragment: <title>, the viewport-fit meta, the <style> block(s), the app mount element, then
// the inlined <script type="module">.
//
// There is no font <link>: the page adds the Google Fonts stylesheet itself after it has loaded
// (src/web/fonts.ts), so a slow or blocked fonts host cannot hold up the first render. A <link rel="stylesheet">
// in the build would bring that problem back, so this script refuses to package one.
//
// Usage: node scripts/build-artifact.mjs            (after `npm run build`)
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const from = resolve(root, 'dist/index.html');
const to = resolve(root, 'dist/artifact.html');

function fail(message) {
  console.error(`build-artifact: ${message}`);
  process.exit(1);
}

let html;
try {
  html = readFileSync(from, 'utf8');
} catch {
  fail('dist/index.html not found. Run "npm run build" first.');
}

// 1. The inlined module script. Inline JS cannot contain a literal closing script tag, so the first
//    closing tag after the opening one ends it.
const scripts = [];
let rest = html;
for (;;) {
  const open = /<script\b[^>]*>/i.exec(rest);
  if (!open) break;
  const start = open.index;
  const bodyStart = start + open[0].length;
  const end = rest.indexOf('</script>', bodyStart);
  if (end === -1) fail('unterminated <script> in dist/index.html.');
  if (/\bsrc\s*=/.test(open[0])) fail('dist/index.html has an external <script>; the build is not a single file.');
  scripts.push(rest.slice(bodyStart, end));
  rest = rest.slice(0, start) + rest.slice(end + '</script>'.length);
}
if (scripts.length === 0) fail('no inlined <script> found in dist/index.html.');

// 1b. Vite's modulepreload polyfill. It opens the bundle, never runs in a browser that supports
//     <link rel="modulepreload"> (and this single-file page has no such links anyway), but it holds the only
//     fetch() call in the file. The fragment is published in a sandboxed viewer and makes no network call of
//     its own apart from the fonts stylesheet, so the polyfill is taken out here. Only the exact shape Vite
//     emits is removed; anything else is left alone. (dist/index.html keeps it until vite.config.ts sets
//     build.modulePreload.polyfill to false.)
const POLYFILL =
  /^\s*\(function\(\)\{const (\w+)=document\.createElement\("link"\)\.relList;if\(\1&&\1\.supports&&\1\.supports\("modulepreload"\)\)return;[\s\S]{0,1200}?fetch\(\w+\.href,\w+\)\}\}\)\(\);/;
let polyfillRemoved = false;
for (let i = 0; i < scripts.length; i += 1) {
  const without = scripts[i].replace(POLYFILL, '');
  if (without !== scripts[i]) {
    scripts[i] = without;
    polyfillRemoved = true;
  }
}
if (/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource/.test(scripts.join('\n'))) {
  fail('the script can make a network request (fetch, XMLHttpRequest, sendBeacon, WebSocket or EventSource).');
}

// 2. Style blocks.
const styles = [];
rest = rest.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_, css) => {
  styles.push(css);
  return '';
});
if (styles.length === 0) fail('no inlined <style> found in dist/index.html.');

// 3. Title, font links, mount element.
const title = /<title>([\s\S]*?)<\/title>/i.exec(rest)?.[1]?.trim();
if (!title) fail('no <title> found in dist/index.html.');

for (const match of rest.matchAll(/<link\b[^>]*>/gi)) {
  const tag = match[0];
  if (!/\brel\s*=\s*["']?stylesheet/i.test(tag)) continue;
  const href = /\bhref\s*=\s*"([^"]+)"/i.exec(tag)?.[1] ?? '(no href)';
  fail(
    `dist/index.html links a stylesheet in its markup (${href}). A linked stylesheet blocks the first render ` +
      'until its host answers. Web fonts are added by src/web/fonts.ts after the page has loaded.',
  );
}

// The only stylesheet the page may ask for at run time is the Google Fonts one.
const sheetUrls = scripts.join('\n').match(/https:\/\/[^"'`\s)]+\/css2?\?[^"'`\s)]*/g) ?? [];
for (const url of sheetUrls) {
  if (!url.startsWith('https://fonts.googleapis.com/')) fail(`unexpected stylesheet URL in the script: ${url}`);
}

const mount = /<div\b[^>]*\bid="app"[^>]*>\s*<\/div>/i.exec(rest)?.[0];
if (!mount) fail('mount element <div id="app"></div> not found in dist/index.html.');

const fragment = [
  `<title>${title}</title>`,
  '<meta name="claude:viewport-fit-sides" content="cover">',
  ...styles.map((css) => `<style>${css}</style>`),
  mount,
  ...scripts.map((js) => `<script type="module">${js}</script>`),
  '',
].join('\n');

// 4. Refuse to write anything that is not a fragment.
const outsideScript = fragment.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
for (const tag of ['<!doctype', '<html', '<head', '<body', '</html', '</head', '</body']) {
  if (outsideScript.toLowerCase().includes(tag)) fail(`the fragment still contains ${tag}.`);
}

writeFileSync(to, fragment);
console.log(
  `dist/artifact.html (${(statSync(to).size / 1024).toFixed(1)} kB): title, viewport-fit meta, ` +
    `${styles.length} style block(s), mount, ${scripts.length} module script(s); no linked stylesheet` +
    (polyfillRemoved ? '; modulepreload polyfill removed' : ''),
);

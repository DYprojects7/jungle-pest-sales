// Turns the single-file build (dist/index.html) into dist/artifact.html: a FRAGMENT for a host page that
// supplies its own <!doctype>, <html>, <head> and <body>.
//
// Order in the fragment: <title>, the viewport-fit meta, any Google Fonts <link>, the <style> block(s),
// the app mount element, then the inlined <script type="module">.
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

const fontLinks = [];
for (const match of rest.matchAll(/<link\b[^>]*>/gi)) {
  const tag = match[0];
  const href = /\bhref\s*=\s*"([^"]+)"/i.exec(tag)?.[1];
  if (!href) continue;
  if (!/\brel\s*=\s*"stylesheet"/i.test(tag)) continue;
  if (!href.startsWith('https://fonts.googleapis.com/')) {
    fail(`unexpected external stylesheet: ${href}. Only Google Fonts may be linked.`);
  }
  fontLinks.push(`<link rel="stylesheet" href="${href}">`);
}

const mount = /<div\b[^>]*\bid="app"[^>]*>\s*<\/div>/i.exec(rest)?.[0];
if (!mount) fail('mount element <div id="app"></div> not found in dist/index.html.');

const fragment = [
  `<title>${title}</title>`,
  '<meta name="claude:viewport-fit-sides" content="cover">',
  ...fontLinks,
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
    `${fontLinks.length} font link(s), ${styles.length} style block(s), mount, ${scripts.length} module script(s)`,
);

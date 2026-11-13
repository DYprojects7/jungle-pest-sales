// Copies the single-file web build into release/ under a stable, human-friendly name.
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const from = resolve(root, 'dist/index.html');
const to = resolve(root, 'release/sg-tax-optimiser.html');

mkdirSync(dirname(to), { recursive: true });
copyFileSync(from, to);
console.log(`release/sg-tax-optimiser.html (${(statSync(to).size / 1024).toFixed(1)} kB)`);

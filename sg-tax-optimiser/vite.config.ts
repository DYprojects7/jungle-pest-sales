import { readFileSync } from 'node:fs';
import { defineConfig, loadEnv } from 'vite';
import preact from '@preact/preset-vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { safeWebAddress } from './src/web/address';

// The version shown in the page's footer is the one in package.json.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// The web calculator builds to ONE self-contained HTML file (dist/index.html):
// it can be opened offline, emailed, hosted on any static host, or sold as a download.
//
// VITE_BUY_URL (optional, read at build time from the environment or a .env file) is the shop address of the
// paid workbook. With it the page shows one link to the workbook; without it, none.
// release/sg-tax-optimiser.html is built without it (see tests/web/release.test.ts).
//
// The value is checked here and written into the build explicitly. A variable that is set but empty, or is not
// a web address, is built exactly as if it were not set: the output is the same file, byte for byte, so a
// shell that happens to export an empty VITE_BUY_URL cannot make the release file look stale.
export default defineConfig(({ mode }) => {
  const buyUrl = safeWebAddress(loadEnv(mode, process.cwd(), 'VITE_').VITE_BUY_URL);
  return {
    plugins: [preact(), viteSingleFile()],
    define: {
      __APP_VERSION__: JSON.stringify(version),
      'import.meta.env.VITE_BUY_URL': JSON.stringify(buyUrl),
    },
    build: {
      target: 'es2020',
      outDir: 'dist',
      emptyOutDir: true,
      // Everything is inlined into one file, so there is nothing to preload. Without this Vite ships a polyfill
      // containing a fetch() call that never runs; the sold file should contain no network API at all.
      modulePreload: { polyfill: false },
    },
  };
});

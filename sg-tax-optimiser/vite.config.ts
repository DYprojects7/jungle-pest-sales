import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// The web calculator builds to ONE self-contained HTML file (dist/index.html):
// it can be opened offline, emailed, hosted on any static host, or sold as a download.
export default defineConfig({
  plugins: [preact(), viteSingleFile()],
  build: {
    target: 'es2020',
    outDir: 'dist',
    emptyOutDir: true,
    // Everything is inlined into one file, so there is nothing to preload. Without this Vite ships a polyfill
    // containing a fetch() call that never runs; the sold file should contain no network API at all.
    modulePreload: { polyfill: false },
  },
});

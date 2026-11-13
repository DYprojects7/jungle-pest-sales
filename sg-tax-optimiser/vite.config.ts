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
  },
});

import { readdirSync } from 'node:fs';
import { defineConfig } from 'vite';

// Two-letter codes that have a flag asset, as a ~800-byte string instead of
// bundling flag-icons' 40 KB country.json just to check membership.
const flagCodes = readdirSync(new URL('./node_modules/flag-icons/flags/4x3/', import.meta.url))
  .filter((file) => /^[a-z]{2}\.svg$/.test(file))
  .map((file) => file.slice(0, 2))
  .join(' ');

export default defineConfig({
  base: '/',
  define: {
    __FLAG_CODES__: JSON.stringify(flagCodes),
  },
  server: {
    proxy: {
      '/api': {
        target: 'https://i.taos.one',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});

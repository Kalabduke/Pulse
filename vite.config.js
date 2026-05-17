import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 3000,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      input: {
        main: 'index.html'
      }
    }
  },
  // Copy sw.js to the root of the output so it can be served at /sw.js
  // and have the correct service worker scope (entire origin)
  publicDir: 'public',
});

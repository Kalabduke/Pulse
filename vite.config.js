import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 3000,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      input: { main: 'index.html' }
    }
  },
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util']
  },
  define: {
    // Bake credentials into the build — safe for client-side (protected by RLS)
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(
      process.env.VITE_SUPABASE_URL || 'https://hrbophzmwuhmzyibjuge.supabase.co'
    ),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(
      process.env.VITE_SUPABASE_ANON_KEY || ''
    ),
    'import.meta.env.VITE_VAPID_PUBLIC_KEY': JSON.stringify(
      process.env.VITE_VAPID_PUBLIC_KEY || 'BAx_IvgftHBJZ7Ok8uas2cSTZey_YFeCLGKC3uIvQrof298PKE5Rly0ZtWfpHbgygjatEBUBTn4w6MJiwfg4HeM'
    ),
  },
  publicDir: 'public',
});

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
  define: {
    // Bake credentials into the build — safe for client-side (protected by RLS)
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(
      process.env.VITE_SUPABASE_URL || 'https://hrbophzmwuhmzylbjuge.supabase.co'
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

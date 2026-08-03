import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.pulse.statusapp',
  appName: 'Pulse',
  webDir: 'dist',
  server: {
    url: 'https://pulse-gray-eight.vercel.app',
    cleartext: false,
    // Allow navigation within the Vercel app and Supabase auth callbacks
    // This keeps OAuth redirects inside the WebView instead of opening Chrome
    allowNavigation: [
      'pulse-gray-eight.vercel.app',
      '*.supabase.co',
      'accounts.google.com',
      '*.google.com'
    ]
  },
  android: {
    allowMixedContent: false,
    backgroundColor: '#0c0d12',
    webContentsDebuggingEnabled: false,
    // Override URL loading to keep all auth flows in WebView
    overrideUserAgent: null,
    appendUserAgent: null
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert']
    }
  }
};

export default config;

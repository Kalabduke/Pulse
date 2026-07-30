import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.pulse.statusapp',
  appName: 'Pulse',
  webDir: 'dist',
  server: {
    // Point to the live Vercel URL so OAuth redirects and Supabase auth work correctly
    // on the native Android build. Remove this for a fully offline/local build.
    url: 'https://pulse-gray-eight.vercel.app',
    cleartext: false
  },
  android: {
    allowMixedContent: false,
    backgroundColor: '#0c0d12',
    webContentsDebuggingEnabled: false
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert']
    }
  }
};

export default config;

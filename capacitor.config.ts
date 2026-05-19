import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.pulse.statusapp',
  appName: 'Pulse',
  webDir: 'dist',
  server: {
    // Use live URL so the app always has latest version
    url: 'https://pulse-gray-eight.vercel.app',
    cleartext: false
  },
  android: {
    allowMixedContent: false,
    backgroundColor: '#0c0d12'
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert']
    }
  }
};

export default config;

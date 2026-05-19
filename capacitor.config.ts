import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.pulse.statusapp',
  appName: 'Pulse',
  webDir: 'dist',
  // No server.url — use bundled assets for true native app
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

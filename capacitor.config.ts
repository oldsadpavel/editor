import type { CapacitorConfig } from '@capacitor/cli';

// MPI Remote — the Android app controlling the editor on the PC through Insider (src/mobile, built by vite.mobile.config.ts).
const config: CapacitorConfig = {
  appId: 'com.oldsadpavel.mpi.remote',
  appName: 'MPI Remote',
  webDir: 'dist/mobile',
  android: { allowMixedContent: false },
  server: { androidScheme: 'https' },
  plugins: {
    // Insider's OAuth endpoints have no CORS: requests go through the native HTTP client
    CapacitorHttp: { enabled: true },
  },
};

export default config;

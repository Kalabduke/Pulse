package com.pulse.statusapp;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Create the FCM channel up front so background push notifications are
        // never dropped (Android requires the channel to exist before showing).
        PulseChannels.ensure(this);
    }

    @Override
    protected void onStart() {
        super.onStart();
        // App is visible — let PulseFCMService skip OS notifications (realtime
        // toasts handle updates while the app is open, same as the web SW).
        PulseFCMService.appForeground = true;
    }

    @Override
    protected void onStop() {
        super.onStop();
        PulseFCMService.appForeground = false;
    }
}

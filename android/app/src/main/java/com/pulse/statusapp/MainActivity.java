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

        // Lock zoom on the WebView — the app scales itself proportionally to the
        // screen, so pinch-zoom and double-tap zoom would only break the layout.
        if (getBridge() != null && getBridge().getWebView() != null) {
            android.webkit.WebSettings settings = getBridge().getWebView().getSettings();
            settings.setSupportZoom(false);
            settings.setBuiltInZoomControls(false);
            settings.setDisplayZoomControls(false);
            settings.setTextZoom(100);
        }
    }

    @Override
    // NOTE: Capacitor 8's BridgeActivity declares onStart()/onStop() as public —
    // overriding them with protected fails with "weaker access privileges".
    public void onStart() {
        super.onStart();
        // App is visible — let PulseFCMService skip OS notifications (realtime
        // toasts handle updates while the app is open, same as the web SW).
        PulseFCMService.appForeground = true;
    }

    @Override
    public void onStop() {
        super.onStop();
        PulseFCMService.appForeground = false;
    }
}

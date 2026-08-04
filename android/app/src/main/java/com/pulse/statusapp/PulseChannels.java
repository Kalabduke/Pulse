package com.pulse.statusapp;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;

/** Shared notification-channel setup so MainActivity and PulseFCMService agree. */
public final class PulseChannels {

    public static final String CHANNEL_ID   = "pulse_status";
    public static final String CHANNEL_NAME = "Friend Status Updates";
    public static final String CHANNEL_DESC = "Notified when a friend updates their Pulse status or sends you a message";

    private PulseChannels() {}

    /** Create the channel if it doesn't exist (idempotent). Safe to call anytime. */
    public static void ensure(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;

        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;

        NotificationChannel channel = manager.getNotificationChannel(CHANNEL_ID);
        if (channel != null) return;

        channel = new NotificationChannel(
            CHANNEL_ID,
            CHANNEL_NAME,
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription(CHANNEL_DESC);
        channel.enableVibration(true);
        channel.setVibrationPattern(new long[]{0, 150, 80, 150});
        channel.setShowBadge(true);
        channel.enableLights(true);
        manager.createNotificationChannel(channel);
    }
}

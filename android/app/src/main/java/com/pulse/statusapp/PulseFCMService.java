package com.pulse.statusapp;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.SystemClock;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

public class PulseFCMService extends FirebaseMessagingService {

    private static final String CHANNEL_ID      = "pulse_status";
    private static final String CHANNEL_NAME    = "Friend Status Updates";
    private static final String CHANNEL_DESC    = "Notified when a friend updates their Pulse status";
    private static final String GROUP_KEY       = "com.pulse.statusapp.STATUS_GROUP";
    private static final int    GROUP_NOTIF_ID  = 0;
    private static final String PREFS_NAME      = "PulsePrefs";

    @Override
    public void onMessageReceived(RemoteMessage remoteMessage) {
        super.onMessageReceived(remoteMessage);

        String friendName = "A friend";
        String emoji      = "💫";
        String statusText = "Updated their status";

        if (remoteMessage.getData().size() > 0) {
            friendName = remoteMessage.getData().getOrDefault("friendName", friendName);
            emoji      = remoteMessage.getData().getOrDefault("emoji",      emoji);
            statusText = remoteMessage.getData().getOrDefault("statusText", statusText);
        }

        // Dedup: skip if same friend notified within 8 seconds
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String dedupKey  = "lastNotif_" + friendName;
        long   lastTime  = prefs.getLong(dedupKey, 0);
        long   now       = SystemClock.elapsedRealtime();
        if (now - lastTime < 8000) return;

        // Save for widget + dedup
        SharedPreferences.Editor editor = prefs.edit();
        editor.putString("latestFriendName", friendName);
        editor.putString("latestEmoji",      emoji);
        editor.putString("latestStatus",     statusText);
        editor.putLong("latestTime",         System.currentTimeMillis());
        editor.putLong(dedupKey,             now);
        editor.apply();

        PulseWidget.updateAllWidgets(this);
        showNotification(friendName, emoji, statusText);
    }

    @Override
    public void onNewToken(String token) {
        super.onNewToken(token);
        // Token refresh handled by Capacitor in the WebView
    }

    private void showNotification(String friendName, String emoji, String statusText) {
        createNotificationChannel();

        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this, friendName.hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        // Individual notification per friend — replaces itself via tag
        int notifId = Math.abs(friendName.hashCode());

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_pulse)
            .setContentTitle(emoji + " " + friendName)
            .setContentText("\u201c" + statusText + "\u201d")
            .setStyle(new NotificationCompat.BigTextStyle()
                .bigText("\u201c" + statusText + "\u201d")
                .setSummaryText("Pulse"))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_SOCIAL)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .setGroup(GROUP_KEY)
            .setVibrate(new long[]{0, 150, 80, 150});

        NotificationManagerCompat manager = NotificationManagerCompat.from(this);

        // Show the individual notification
        try {
            manager.notify(notifId, builder.build());
        } catch (SecurityException e) {
            // Permission not granted — ignore silently
            return;
        }

        // Show/update the group summary notification
        NotificationCompat.Builder summary = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_pulse)
            .setContentTitle("Pulse")
            .setContentText("Friends updated their status")
            .setStyle(new NotificationCompat.InboxStyle()
                .setSummaryText("Pulse Status Updates"))
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setGroupSummary(true)
            .setGroup(GROUP_KEY)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent);

        try {
            manager.notify(GROUP_NOTIF_ID, summary.build());
        } catch (SecurityException ignored) {}
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                CHANNEL_NAME,
                NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription(CHANNEL_DESC);
            channel.enableVibration(true);
            channel.setVibrationPattern(new long[]{0, 150, 80, 150});
            channel.setShowBadge(true);
            channel.enableLights(true);

            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }
}

package com.pulse.statusapp;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.SystemClock;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

public class PulseFCMService extends FirebaseMessagingService {

    private static final String CHANNEL_ID      = PulseChannels.CHANNEL_ID;
    private static final String GROUP_KEY       = "com.pulse.statusapp.STATUS_GROUP";
    private static final int    GROUP_NOTIF_ID  = 0;
    private static final String PREFS_NAME      = "PulsePrefs";

    // Set by MainActivity — when the app is open the in-app realtime toasts
    // handle updates, so we skip the OS notification (matches the web SW which
    // checks app visibility).
    public static volatile boolean appForeground = false;

    @Override
    public void onMessageReceived(RemoteMessage remoteMessage) {
        super.onMessageReceived(remoteMessage);

        // The edge function sends a DATA-ONLY message (no notification block) so
        // this service is the single display path. It supplies type, senderId,
        // notifTitle/notifBody (pre-rendered) plus the raw fields for the widget.
        String type        = "status";
        String friendName  = "A friend";
        String senderId    = "";
        String emoji       = "💫";
        String statusText  = "Updated their status";
        String messageText = "";
        String imageUrl    = "";
        String notifTitle  = "";
        String notifBody   = "";

        if (remoteMessage.getData().size() > 0) {
            type        = remoteMessage.getData().getOrDefault("type",        type);
            friendName  = remoteMessage.getData().getOrDefault("friendName",  friendName);
            senderId    = remoteMessage.getData().getOrDefault("senderId",    senderId);
            emoji       = remoteMessage.getData().getOrDefault("emoji",       emoji);
            statusText  = remoteMessage.getData().getOrDefault("statusText",  statusText);
            messageText = remoteMessage.getData().getOrDefault("messageText", messageText);
            imageUrl    = remoteMessage.getData().getOrDefault("imageUrl",    imageUrl);
            notifTitle  = remoteMessage.getData().getOrDefault("notifTitle",  notifTitle);
            notifBody   = remoteMessage.getData().getOrDefault("notifBody",   notifBody);
        }

        boolean isMessage = "message".equals(type);
        // Prefer the edge function's rendered title/body; fall back to building
        // them locally (older edge-function deploys without notifTitle/notifBody).
        if (notifTitle.isEmpty()) {
            notifTitle = emoji + " " + friendName;
        }
        if (notifBody.isEmpty()) {
            notifBody = isMessage
                ? (messageText.isEmpty()
                    ? (imageUrl.isEmpty() ? "Sent you a message" : "📎 Photo")
                    : messageText)
                : "\u201c" + statusText + "\u201d";
        }
        String body = notifBody;

        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);

        // App is open — realtime toasts already notify the user; skip the OS
        // notification entirely (but still update the widget).
        if (appForeground) {
            saveForWidget(prefs, senderId, friendName, emoji, isMessage, body, statusText);
            return;
        }

        // Dedup: skip if same sender notified within 8 seconds (use ID, not name)
        String dedupKey  = "lastNotif_" + (senderId.isEmpty() ? friendName : senderId);
        long   lastTime  = prefs.getLong(dedupKey, 0);
        long   now       = SystemClock.elapsedRealtime();
        if (now - lastTime < 8000) return;

        saveForWidget(prefs, senderId, friendName, emoji, isMessage, body, statusText);
        prefs.edit().putLong(dedupKey, now).apply();

        showNotification(notifTitle, body);
    }

    // Persist the latest update for the home-screen widget (shared with dedup prefs).
    private void saveForWidget(SharedPreferences prefs, String senderId, String friendName,
                               String emoji, boolean isMessage, String body, String statusText) {
        SharedPreferences.Editor editor = prefs.edit();
        editor.putString("latestFriendName", friendName);
        editor.putString("latestEmoji",      emoji);
        editor.putString("latestStatus",     isMessage ? body : statusText);
        editor.putLong("latestTime",         System.currentTimeMillis());
        editor.apply();

        PulseWidget.updateAllWidgets(this);
    }

    @Override
    public void onNewToken(String token) {
        super.onNewToken(token);
        // Token refresh handled by Capacitor in the WebView
    }

    private void showNotification(String title, String body) {
        PulseChannels.ensure(this);

        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this, title.hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        // Individual notification per sender — replaced when a new one arrives
        int notifId = Math.abs(title.hashCode());

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_pulse)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle()
                .bigText(body)
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

}

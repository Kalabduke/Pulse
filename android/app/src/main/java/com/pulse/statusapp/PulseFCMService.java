package com.pulse.statusapp;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import org.json.JSONObject;

public class PulseFCMService extends FirebaseMessagingService {

    private static final String CHANNEL_ID = "pulse_status";
    private static final String CHANNEL_NAME = "Pulse Status Updates";
    private static final String PREFS_NAME = "PulsePrefs";

    @Override
    public void onMessageReceived(RemoteMessage remoteMessage) {
        super.onMessageReceived(remoteMessage);

        String friendName = "A friend";
        String emoji = "💫";
        String statusText = "Updated their status";

        // Parse data payload
        if (remoteMessage.getData().size() > 0) {
            friendName = remoteMessage.getData().getOrDefault("friendName", friendName);
            emoji = remoteMessage.getData().getOrDefault("emoji", emoji);
            statusText = remoteMessage.getData().getOrDefault("statusText", statusText);
        }

        // Save latest status to SharedPreferences for the widget
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        SharedPreferences.Editor editor = prefs.edit();
        editor.putString("latestFriendName", friendName);
        editor.putString("latestEmoji", emoji);
        editor.putString("latestStatus", statusText);
        editor.putLong("latestTime", System.currentTimeMillis());
        editor.apply();

        // Update the home screen widget
        PulseWidget.updateAllWidgets(this);

        // Show heads-up notification
        showNotification(friendName, emoji, statusText);
    }

    @Override
    public void onNewToken(String token) {
        super.onNewToken(token);
        // Token is handled by the web app via Capacitor
    }

    private void showNotification(String friendName, String emoji, String statusText) {
        createNotificationChannel();

        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_ONE_SHOT | PendingIntent.FLAG_IMMUTABLE
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_pulse)
            .setContentTitle(emoji + " " + friendName)
            .setContentText("\"" + statusText + "\"")
            .setStyle(new NotificationCompat.BigTextStyle()
                .bigText("\"" + statusText + "\""))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent);

        NotificationManager manager =
            (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);

        // Use unique ID per friend so notifications stack
        int notifId = friendName.hashCode();
        manager.notify(notifId, builder.build());
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                CHANNEL_NAME,
                NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription("Real-time status updates from your Pulse friends");
            channel.enableVibration(true);
            channel.setShowBadge(true);

            NotificationManager manager = getSystemService(NotificationManager.class);
            manager.createNotificationChannel(channel);
        }
    }
}

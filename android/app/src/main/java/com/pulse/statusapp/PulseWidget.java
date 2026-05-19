package com.pulse.statusapp;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.widget.RemoteViews;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

public class PulseWidget extends AppWidgetProvider {

    private static final String PREFS_NAME = "PulsePrefs";

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        for (int appWidgetId : appWidgetIds) {
            updateWidget(context, appWidgetManager, appWidgetId);
        }
    }

    public static void updateAllWidgets(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        ComponentName widget = new ComponentName(context, PulseWidget.class);
        int[] ids = manager.getAppWidgetIds(widget);
        for (int id : ids) {
            updateWidget(context, manager, id);
        }
    }

    private static void updateWidget(Context context, AppWidgetManager manager, int widgetId) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);

        String friendName = prefs.getString("latestFriendName", "No updates yet");
        String emoji = prefs.getString("latestEmoji", "💫");
        String statusText = prefs.getString("latestStatus", "Waiting for friends...");
        long time = prefs.getLong("latestTime", 0);

        String timeStr = "";
        if (time > 0) {
            long diff = System.currentTimeMillis() - time;
            long mins = diff / 60000;
            long hours = mins / 60;
            if (mins < 1) timeStr = "Just now";
            else if (mins < 60) timeStr = mins + "m ago";
            else if (hours < 24) timeStr = hours + "h ago";
            else timeStr = new SimpleDateFormat("MMM d", Locale.getDefault()).format(new Date(time));
        }

        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.pulse_widget);
        views.setTextViewText(R.id.widget_emoji, emoji);
        views.setTextViewText(R.id.widget_friend_name, friendName);
        views.setTextViewText(R.id.widget_status_text, "\"" + statusText + "\"");
        views.setTextViewText(R.id.widget_time, timeStr);

        // Tap widget to open app
        Intent intent = new Intent(context, MainActivity.class);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            context, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        views.setOnClickPendingIntent(R.id.widget_root, pendingIntent);

        manager.updateAppWidget(widgetId, views);
    }
}

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Generate a JWT for Firebase service account authentication
async function getFirebaseAccessToken(serviceAccount: any): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: serviceAccount.client_email,
    sub: serviceAccount.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/firebase.messaging'
  };

  const encode = (obj: any) => btoa(JSON.stringify(obj))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  const signingInput = `${encode(header)}.${encode(payload)}`;

  // Import the private key
  const pemKey = serviceAccount.private_key;
  const pemBody = pemKey
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');

  const keyBytes = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyBytes,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  const jwt = `${signingInput}.${btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')}`;

  // Exchange JWT for access token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });

  const tokenData = await tokenRes.json();
  return tokenData.access_token;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
    const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

    // ---- 1. Verify the caller — only the status owner can trigger pushes ----
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } }
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const body = await req.json();
    const { type = 'status', userId, emoji, statusText, name, recipientId, messageText, imageUrl } = body;

    let friendIds: string[] = [];

    if (type === 'message') {
      // ---- DM push: caller is the SENDER, recipientId is who gets notified ----
      if (!recipientId || recipientId === user.id) {
        return new Response(JSON.stringify({ error: 'recipientId required and must differ from the caller' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // Only notify if the two users are actually connected (anti-spam)
      const { data: conn } = await supabase
        .from('connections')
        .select('id')
        .eq('status', 'connected')
        .or(`and(user_id.eq.${user.id},friend_id.eq.${recipientId}),and(user_id.eq.${recipientId},friend_id.eq.${user.id})`);

      if (!conn || conn.length === 0) {
        return new Response(JSON.stringify({ error: 'Users are not connected' }), {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      friendIds = [recipientId];
    } else {
      // ---- Status push: the update must belong to the authenticated caller ----
      if (!userId || userId !== user.id) {
        return new Response(JSON.stringify({ error: 'userId must match the authenticated user' }), {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const { data: connections, error: connError } = await supabase
        .from('connections')
        .select('user_id, friend_id')
        .eq('status', 'connected')
        .or(`user_id.eq.${userId},friend_id.eq.${userId}`);

      if (connError) throw connError;

      friendIds = (connections ?? [])
        .map((c: any) => c.user_id === userId ? c.friend_id : c.user_id)
        .filter((id: string) => id !== userId);
    }

    if (friendIds.length === 0) {
      return new Response(JSON.stringify({ sent: 0, reason: 'no friends' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Shared notification content — differs by type.
    // Fetch the sender's identity from profiles server-side instead of trusting
    // the request body, so a connected friend can't spoof the notification title.
    const isMessage = type === 'message';
    const { data: senderProfile } = await supabase
      .from('profiles')
      .select('name, status_emoji')
      .eq('id', user.id)
      .maybeSingle();

    const senderName = senderProfile?.name || name || 'A friend';
    const senderEmoji = senderProfile?.status_emoji || emoji || (isMessage ? '💬' : '💫');

    const notifTitle = `${senderEmoji} ${senderName}`;
    const notifBody = isMessage
      ? (messageText || (imageUrl ? '📎 Photo' : 'Sent you a message'))
      : `"${statusText || 'Updated their status'}"`;
    const notifUrl = isMessage ? `/?chat=${user.id}` : '/';

    // ---- 3. Android FCM push (native app) ----
    const serviceAccountStr = Deno.env.get('FIREBASE_SERVICE_ACCOUNT') ?? '';
    let sent = 0;
    let tokenTotal = 0;
    const errors: string[] = [];
    if (serviceAccountStr) {
      const serviceAccount = JSON.parse(serviceAccountStr);
      const projectId = serviceAccount.project_id;

      // FCM data payloads cap at ~4KB — slice long messages here too.
      const fcmMessageText = (messageText || '').slice(0, 300);
      const fcmNotifBody = isMessage
        ? (fcmMessageText || (imageUrl ? '📎 Photo' : 'Sent you a message'))
        : `"${(statusText || 'Updated their status').slice(0, 300)}"`;

      const { data: tokens } = await supabase
        .from('fcm_tokens')
        .select('token, user_id')
        .in('user_id', friendIds);

      tokenTotal = tokens?.length ?? 0;
      if (tokens && tokens.length > 0) {
        const accessToken = await getFirebaseAccessToken(serviceAccount);

        for (const { token, user_id } of tokens) {
          try {
            // DATA-ONLY message: the custom PulseFCMService is the single display
            // path (channel, dedup, widget all applied). A `notification` block
            // would let the system tray display it directly, bypassing our
            // service (no widget update, no dedup) AND double-fire with our
            // service when the app is foregrounded.
            const message = {
              message: {
                token,
                data: {
                  type: isMessage ? 'message' : 'status',
                  friendName: senderName,
                  senderId: user.id,       // dedup key — names collide, IDs don't
                  emoji: senderEmoji,
                  statusText: (statusText || '').slice(0, 300),
                  messageText: fcmMessageText,
                  imageUrl: imageUrl || '',
                  url: notifUrl,
                  notifTitle,             // rendered by PulseFCMService
                  notifBody: fcmNotifBody // rendered by PulseFCMService
                },
                android: {
                  priority: 'high'
                }
              }
            };

            const res = await fetch(
              `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
              {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${accessToken}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify(message)
              }
            );

            if (res.ok) {
              sent++;
            } else {
              const err = await res.json();
              if (err.error?.status === 'NOT_FOUND' || err.error?.status === 'INVALID_ARGUMENT') {
                await supabase.from('fcm_tokens').delete()
                  .eq('token', token).eq('user_id', user_id);
              }
              errors.push(err.error?.message || 'Unknown FCM error');
            }
          } catch (e: any) {
            errors.push(e.message);
          }
        }
      }
    }

    // ---- 4. Web push (PWA / browsers) via VAPID ----
    const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY') ?? '';
    const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
    const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@pulse.app';
    let webSent = 0;

    if (VAPID_PUBLIC && VAPID_PRIVATE) {
      webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

      const { data: subs } = await supabase
        .from('push_subscriptions')
        .select('subscription, user_id')
        .in('user_id', friendIds);

      const payload = JSON.stringify({
        type: isMessage ? 'message' : 'status',
        friendName: senderName,
        senderId: user.id,       // dedup key — names collide, IDs don't
        emoji: senderEmoji,
        statusText: statusText || '',
        messageText: (messageText || '').slice(0, 300),
        imageUrl: imageUrl || '',
        url: notifUrl
      });

      for (const row of (subs ?? [])) {
        try {
          await webpush.sendNotification(row.subscription, payload, { TTL: 3600 });
          webSent++;
        } catch (e: any) {
          // 404/410 → subscription is gone; clean it up
          if (e?.statusCode === 404 || e?.statusCode === 410) {
            await supabase.from('push_subscriptions').delete()
              .eq('user_id', row.user_id)
              .eq('subscription->>endpoint', row.subscription?.endpoint ?? '');
          }
          errors.push(e?.body ?? 'Web push error');
        }
      }
    }

    return new Response(JSON.stringify({ sent, total: tokenTotal, webSent, errors }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

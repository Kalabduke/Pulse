import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const body = await req.json();
    const { userId, emoji, statusText, name } = body;

    if (!userId) {
      return new Response(JSON.stringify({ error: 'userId required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Find all connected friends of this user
    const { data: connections, error: connError } = await supabase
      .from('connections')
      .select('user_id, friend_id')
      .eq('status', 'connected')
      .or(`user_id.eq.${userId},friend_id.eq.${userId}`);

    if (connError) throw connError;

    // Get the friend IDs (everyone except the updater)
    const friendIds = connections
      .map(c => c.user_id === userId ? c.friend_id : c.user_id)
      .filter(id => id !== userId);

    if (friendIds.length === 0) {
      return new Response(JSON.stringify({ sent: 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Get push subscriptions for all friends
    const { data: subscriptions, error: subError } = await supabase
      .from('push_subscriptions')
      .select('*')
      .in('user_id', friendIds);

    if (subError) throw subError;
    if (!subscriptions || subscriptions.length === 0) {
      return new Response(JSON.stringify({ sent: 0, reason: 'no subscriptions' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY') ?? '';
    const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
    const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@pulse.app';

    let sent = 0;
    const errors = [];

    for (const sub of subscriptions) {
      try {
        const payload = JSON.stringify({
          friendName: name || 'A friend',
          emoji: emoji || '💫',
          statusText: statusText || 'Updated their status',
          url: '/'
        });

        // Use web-push via fetch to the push endpoint
        const pushResponse = await sendWebPush({
          subscription: sub.subscription,
          payload,
          vapidPublicKey: VAPID_PUBLIC_KEY,
          vapidPrivateKey: VAPID_PRIVATE_KEY,
          vapidSubject: VAPID_SUBJECT
        });

        if (pushResponse.ok || pushResponse.status === 201) {
          sent++;
        } else if (pushResponse.status === 410 || pushResponse.status === 404) {
          // Subscription expired — remove it
          await supabase
            .from('push_subscriptions')
            .delete()
            .eq('id', sub.id);
        }
      } catch (e) {
        errors.push(e.message);
      }
    }

    return new Response(JSON.stringify({ sent, errors }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

// Minimal web-push implementation using VAPID
async function sendWebPush({ subscription, payload, vapidPublicKey, vapidPrivateKey, vapidSubject }) {
  const endpoint = subscription.endpoint;
  const keys = subscription.keys;

  // Import VAPID private key
  const privateKeyBytes = base64UrlDecode(vapidPrivateKey);
  const publicKeyBytes = base64UrlDecode(vapidPublicKey);

  const vapidKey = await crypto.subtle.importKey(
    'raw',
    privateKeyBytes,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  // Build VAPID JWT
  const now = Math.floor(Date.now() / 1000);
  const origin = new URL(endpoint).origin;
  const header = base64UrlEncode(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = base64UrlEncode(JSON.stringify({
    aud: origin,
    exp: now + 12 * 3600,
    sub: vapidSubject
  }));

  const signingInput = `${header}.${claims}`;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    vapidKey,
    new TextEncoder().encode(signingInput)
  );

  const jwt = `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;

  // Encrypt the payload
  const encryptedPayload = await encryptPayload(payload, keys);

  return fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `vapid t=${jwt},k=${vapidPublicKey}`,
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': '86400'
    },
    body: encryptedPayload
  });
}

async function encryptPayload(payload, keys) {
  const authSecret = base64UrlDecode(keys.auth);
  const clientPublicKey = base64UrlDecode(keys.p256dh);

  // Generate server key pair
  const serverKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );

  const serverPublicKey = await crypto.subtle.exportKey('raw', serverKeyPair.publicKey);

  // Import client public key
  const clientKey = await crypto.subtle.importKey(
    'raw',
    clientPublicKey,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );

  // Derive shared secret
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: clientKey },
    serverKeyPair.privateKey,
    256
  );

  // HKDF to derive content encryption key and nonce
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hkdf(authSecret, sharedSecret, 'Content-Encoding: auth\0', 32);
  const cek = await hkdf(salt, prk, buildInfo('aesgcm', clientPublicKey, new Uint8Array(serverPublicKey)), 16);
  const nonce = await hkdf(salt, prk, buildInfo('nonce', clientPublicKey, new Uint8Array(serverPublicKey)), 12);

  // Encrypt
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const payloadBytes = new TextEncoder().encode(payload);
  const paddedPayload = new Uint8Array(payloadBytes.length + 2);
  paddedPayload.set(payloadBytes, 2);

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    key,
    paddedPayload
  );

  // Build aes128gcm content
  const result = new Uint8Array(
    16 + 4 + 1 + serverPublicKey.byteLength + encrypted.byteLength
  );
  let offset = 0;
  result.set(salt, offset); offset += 16;
  result.set(new Uint8Array([0, 0, 0x10, 0x00]), offset); offset += 4; // rs = 4096
  result.set(new Uint8Array([serverPublicKey.byteLength]), offset); offset += 1;
  result.set(new Uint8Array(serverPublicKey), offset); offset += serverPublicKey.byteLength;
  result.set(new Uint8Array(encrypted), offset);

  return result;
}

async function hkdf(salt, ikm, info, length) {
  const saltKey = await crypto.subtle.importKey('raw', salt, 'HMAC', false, ['sign']);
  // This is a simplified version — use a proper HKDF library in production
  const prk = await crypto.subtle.sign('HMAC', saltKey, ikm instanceof ArrayBuffer ? ikm : ikm.buffer);
  return new Uint8Array(prk).slice(0, length);
}

function buildInfo(type, clientKey, serverKey) {
  const encoder = new TextEncoder();
  const typeBytes = encoder.encode(`Content-Encoding: ${type}\0P-256\0`);
  const info = new Uint8Array(typeBytes.length + 2 + clientKey.length + 2 + serverKey.length);
  let offset = 0;
  info.set(typeBytes, offset); offset += typeBytes.length;
  info.set(new Uint8Array([0, clientKey.length]), offset); offset += 2;
  info.set(clientKey, offset); offset += clientKey.length;
  info.set(new Uint8Array([0, serverKey.length]), offset); offset += 2;
  info.set(serverKey, offset);
  return info;
}

function base64UrlDecode(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, '=');
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}

function base64UrlEncode(data) {
  const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

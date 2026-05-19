import { createClient } from '@supabase/supabase-js';

// Global Supabase client reference
let supabase = null;

/* ==========================================
   CLIENT INITIALIZATION
   ========================================== */

/**
 * Initialize Supabase client.
 * Priority: 1. Passed arguments, 2. localStorage, 3. Vite env variables.
 */
export function initSupabase(url = null, anonKey = null) {
  const configUrl = url
    || localStorage.getItem('pulse_supabase_url')
    || import.meta.env.VITE_SUPABASE_URL;
  const configKey = anonKey
    || localStorage.getItem('pulse_supabase_anon_key')
    || import.meta.env.VITE_SUPABASE_ANON_KEY;

  if (!configUrl || !configKey) return false;

  // Persist custom credentials
  if (url && anonKey) {
    localStorage.setItem('pulse_supabase_url', url);
    localStorage.setItem('pulse_supabase_anon_key', anonKey);
  }

  try {
    supabase = createClient(configUrl, configKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    });
    return true;
  } catch (err) {
    console.error('[Pulse] Failed to initialize Supabase:', err);
    return false;
  }
}

/** Returns true if the client is ready (or can be auto-initialized). */
export function isSupabaseConfigured() {
  if (supabase) return true;
  return initSupabase();
}

/** Clear saved credentials and destroy the client. */
export function resetSupabaseConfig() {
  localStorage.removeItem('pulse_supabase_url');
  localStorage.removeItem('pulse_supabase_anon_key');
  supabase = null;
}

/** Internal helper — throws if client is not ready. */
function client() {
  if (!supabase && !initSupabase()) {
    throw new Error('Supabase is not configured. Please add your project URL and anon key.');
  }
  return supabase;
}

/* ==========================================
   AUTHENTICATION
   ========================================== */

/**
 * Sign in with email and password.
 */
export async function signInWithPassword(email, password) {
  const { data, error } = await client().auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

/**
 * Create a new account with email, password, and display name.
 */
export async function signUpWithPassword(email, password, name) {
  const { data, error } = await client().auth.signUp({
    email,
    password,
    options: {
      data: { name },
      emailRedirectTo: window.location.origin
    }
  });
  if (error) throw error;
  return data;
}
/**
 * Sign in with Google OAuth (redirects to Google then back).
 */
export async function signInWithGoogle() {
  const { data, error } = await client().auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin,
      queryParams: { prompt: 'select_account' }
    }
  });
  if (error) throw error;
  return data;
}

/**
 * Send a password reset email.
 */
export async function sendPasswordReset(email) {
  const { error } = await client().auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}?reset=true`
  });
  if (error) throw error;
}

/** Sign the current user out. */
export async function signOutUser() {
  const { error } = await client().auth.signOut();
  if (error) throw error;
}

/**
 * Returns the current user's profile, or null if not logged in.
 * Falls back to partial auth metadata if the DB trigger hasn't fired yet.
 */
export async function getSessionAndProfile(savedHash = '', savedSearch = '') {
  // First try to get session normally
  let { data: { session }, error: sessionError } = await client().auth.getSession();
  if (sessionError) throw sessionError;

  // If no session, try extracting from saved URL params (cleaned before render)
  if (!session) {
    // Handle token hash from email confirmation / OAuth
    if (savedHash && savedHash.includes('access_token')) {
      const hashParams = new URLSearchParams(savedHash.substring(1));
      const accessToken = hashParams.get('access_token');
      const refreshToken = hashParams.get('refresh_token');
      if (accessToken) {
        const { data, error } = await client().auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken || ''
        });
        if (!error && data.session) session = data.session;
      }
    }

    // Handle PKCE code exchange
    const code = new URLSearchParams(savedSearch).get('code');
    if (code) {
      const { data, error } = await client().auth.exchangeCodeForSession(code);
      if (!error && data.session) session = data.session;
    }
  }

  if (!session) return null;

  const user = session.user;

  const { data: profile, error: profileError } = await client()
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  if (profileError) {
    // Profile doesn't exist yet — create it now (trigger may have missed OAuth signups)
    const { data: newProfile, error: insertError } = await client()
      .from('profiles')
      .upsert({
        id: user.id,
        name: user.user_metadata?.full_name || user.user_metadata?.name || user.email.split('@')[0],
        status_emoji: '👋',
        status_text: 'Just joined Pulse!',
        updated_at: new Date().toISOString()
      }, { onConflict: 'id' })
      .select()
      .single();

    if (insertError) {
      console.warn('[Pulse] Could not create profile:', insertError.message);
      return {
        id: user.id,
        email: user.email,
        name: user.user_metadata?.full_name || user.email.split('@')[0],
        status_emoji: '👋',
        status_text: 'Connecting...',
        updated_at: new Date().toISOString()
      };
    }
    return { ...newProfile, email: user.email };
  }

  return { ...profile, email: user.email };
}

/* ==========================================
   STATUS & PROFILES
   ========================================== */

/**
 * Update the current user's display name, emoji, and status text.
 * Uses upsert so it works even if the profile row doesn't exist yet.
 * Also logs to status_history.
 */
export async function updateStatus(name, emoji, text) {
  const { data: { user } } = await client().auth.getUser();
  if (!user) throw new Error('Not logged in.');

  const { data, error } = await client()
    .from('profiles')
    .upsert({
      id: user.id,
      name,
      status_emoji: emoji,
      status_text: text,
      updated_at: new Date().toISOString()
    }, { onConflict: 'id' })
    .select()
    .single();

  if (error) throw error;

  // Log to history (fire and forget — don't block on failure)
  client()
    .from('status_history')
    .insert({ user_id: user.id, status_emoji: emoji, status_text: text })
    .then(({ error: histErr }) => {
      if (histErr) console.warn('[Pulse] History log failed:', histErr.message);
    });

  return data;
}

/**
 * Fetch the last 15 status updates across all connected friends (not self).
 * Returns entries sorted newest first, with the friend's name included.
 */
export async function fetchFriendsStatusHistory(connectedFriendIds) {
  if (!connectedFriendIds || connectedFriendIds.length === 0) return [];

  const { data, error } = await client()
    .from('status_history')
    .select(`
      id,
      status_emoji,
      status_text,
      created_at,
      profile:profiles!status_history_user_id_fkey(id, name)
    `)
    .in('user_id', connectedFriendIds)
    .order('created_at', { ascending: false })
    .limit(15);

  if (error) throw error;
  return data || [];
}

/**
 * Fetch the last 15 status updates for a given user ID.
 */
export async function fetchStatusHistory(userId) {
  const { data, error } = await client()
    .from('status_history')
    .select('id, status_emoji, status_text, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(15);

  if (error) throw error;
  return data || [];
}

/* ==========================================
   CONNECTIONS
   ========================================== */

/**
 * Fetch all connections (pending + connected) for the current user.
 * Returns a normalized array of connection objects.
 */
export async function fetchConnections() {
  const { data: { user } } = await client().auth.getUser();
  if (!user) throw new Error('Not logged in.');

  const { data, error } = await client()
    .from('connections')
    .select(`
      id,
      status,
      nickname,
      created_at,
      sender:profiles!connections_user_id_fkey(id, name, status_emoji, status_text, updated_at),
      receiver:profiles!connections_friend_id_fkey(id, name, status_emoji, status_text, updated_at)
    `)
    .or(`user_id.eq.${user.id},friend_id.eq.${user.id}`);

  if (error) throw error;

  return data.map(conn => {
    const isSender = conn.sender?.id === user.id;
    const friend = isSender ? conn.receiver : conn.sender;

    return {
      connectionId: conn.id,
      status: conn.status,
      isOutgoing: isSender,
      nickname: conn.nickname || null,
      friendId: friend?.id,
      name: friend?.name || 'Unknown',
      displayName: conn.nickname?.trim() || friend?.name || 'Unknown',
      statusEmoji: friend?.status_emoji || '😊',
      statusText: friend?.status_text || 'Available',
      updatedAt: friend?.updated_at
    };
  });
}

/**
 * Send a connection request to a friend.
 * Accepts a Pulse User ID (UUID) or an exact display name.
 * Enforces the 5-connection MVP limit.
 */
export async function sendConnectionRequest(friendIdOrName) {
  const { data: { user } } = await client().auth.getUser();
  if (!user) throw new Error('Not logged in.');

  const query = friendIdOrName.trim();

  if (!query) throw new Error('Please enter a Pulse ID or display name.');

  // Prevent self-connection
  if (query.toLowerCase() === user.id.toLowerCase()) {
    throw new Error("You can't connect with yourself!");
  }

  // Enforce 5-connection limit
  const existing = await fetchConnections();
  const activeCount = existing.filter(c => c.status === 'connected').length;
  if (activeCount >= 5) {
    throw new Error('MVP limit: You can only have up to 5 connections.');
  }

  // Look up friend by UUID or exact display name
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let friendProfile = null;

  if (uuidRegex.test(query)) {
    const { data, error } = await client()
      .from('profiles')
      .select('id, name')
      .eq('id', query)
      .maybeSingle();
    if (error) throw error;
    friendProfile = data;
  } else {
    const { data, error } = await client()
      .from('profiles')
      .select('id, name')
      .ilike('name', query)
      .maybeSingle();
    if (error) throw error;
    friendProfile = data;
  }

  if (!friendProfile) {
    throw new Error("Friend not found. Check their Pulse ID or display name.");
  }

  if (friendProfile.id === user.id) {
    throw new Error("You can't connect with yourself!");
  }

  // Check for duplicate connection
  const duplicate = existing.find(c => c.friendId === friendProfile.id);
  if (duplicate) {
    throw new Error(`You already have a ${duplicate.status} connection with this person.`);
  }

  const { data, error } = await client()
    .from('connections')
    .insert({ user_id: user.id, friend_id: friendProfile.id, status: 'pending' })
    .select()
    .single();

  if (error) throw error;
  return data;
}

// Keep the old export name as an alias for backward compatibility
export const inviteFriendByEmail = sendConnectionRequest;

/**
 * Set or clear a nickname for a connection.
 * Only the user who owns the connection (user_id) can set their own nickname for a friend.
 */
export async function setConnectionNickname(connectionId, nickname) {
  const { data, error } = await client()
    .from('connections')
    .update({ nickname: nickname?.trim() || null })
    .eq('id', connectionId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

/**
 * Accept a pending incoming connection request.
 */
export async function acceptInvitation(connectionId) {
  const { data, error } = await client()
    .from('connections')
    .update({ status: 'connected' })
    .eq('id', connectionId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

/**
 * Delete a connection (reject, cancel, or disconnect).
 */
export async function removeConnection(connectionId) {
  const { error } = await client()
    .from('connections')
    .delete()
    .eq('id', connectionId);
  if (error) throw error;
}

/**
 * Save an FCM token for native Android push notifications.
 */
export async function saveFcmToken(token) {
  const { data: { user } } = await client().auth.getUser();
  if (!user) throw new Error('Not logged in.');

  const { error } = await client()
    .from('fcm_tokens')
    .upsert({ user_id: user.id, token }, { onConflict: 'token' });

  if (error) throw error;
}

/* ==========================================
   PUSH SUBSCRIPTIONS
   ========================================== */

/**
 * Save a Web Push subscription to the database.
 */
export async function savePushSubscription(subscription) {
  const { data: { user } } = await client().auth.getUser();
  if (!user) throw new Error('Not logged in.');

  const subJson = subscription.toJSON();

  // Don't insert endpoint — it's a generated column derived from subscription jsonb
  const { error } = await client()
    .from('push_subscriptions')
    .upsert({
      user_id: user.id,
      subscription: subJson
    }, { onConflict: 'user_id,endpoint' });

  if (error) throw error;
}

/**
 * Notify friends via Edge Function after a status update.
 */
export async function notifyFriendsOfUpdate(userId, name, emoji, statusText) {
  try {
    const supabaseUrl = localStorage.getItem('pulse_supabase_url')
      || import.meta.env.VITE_SUPABASE_URL;
    const anonKey = localStorage.getItem('pulse_supabase_anon_key')
      || import.meta.env.VITE_SUPABASE_ANON_KEY;

    await fetch(`${supabaseUrl}/functions/v1/bright-processor`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${anonKey}`
      },
      body: JSON.stringify({ userId, name, emoji, statusText })
    });
  } catch (err) {
    console.warn('[Pulse] Push notification failed:', err.message);
  }
}

/* ==========================================
   REAL-TIME SUBSCRIPTIONS
   ========================================== */

/**
 * Subscribe to live profile updates and connection changes.
 * Fires `callback` with a typed event object whenever something changes.
 *
 * @param {string} userId - The current user's ID (used for logging/filtering)
 * @param {Function} callback - ({ type, record, event? }) => void
 * @returns The Supabase RealtimeChannel (call .unsubscribe() to clean up)
 */
export function subscribeToPulseSync(userId, callback) {
  if (!isSupabaseConfigured()) return null;

  return client()
    .channel(`pulse-sync-${userId}`)
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'profiles' },
      (payload) => {
        callback({ type: 'profile_updated', record: payload.new });
      }
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'connections' },
      (payload) => {
        callback({
          type: 'connection_changed',
          event: payload.eventType,
          record: payload.new || payload.old
        });
      }
    )
    .subscribe((status) => {
      console.log('[Pulse] Realtime channel status:', status);
    });
}

// @ts-check
import './style.css';
import {
  dbGet,
  dbSet,
  dbDelete,
  clearUserCache,
  dashKey,
  chatKey
} from './db.js';
import {
  initSupabase,
  isSupabaseConfigured,
  resetSupabaseConfig,
  signInWithPassword,
  signUpWithPassword,
  signInWithGoogle,
  sendPasswordReset,
  signOutUser,
  getSessionAndProfile,
  updateStatus,
  fetchConnections,
  fetchFriendsStatusHistory,
  sendConnectionRequest,
  setConnectionNickname,
  acceptInvitation,
  removeConnection,
  subscribeToPulseSync,
  savePushSubscription,
  saveFcmToken,
  notifyFriendsOfUpdate,
  uploadStatusImage,
  sendDirectMessage,
  fetchDirectMessages,
  markMessagesAsRead,
  markMessagesAsDelivered,
  toggleMessageReaction,
  deleteDirectMessage,
  searchDirectMessages,
  updateLastSeen,
  upsertPrivateStatus,
  fetchPrivateStatusesForMe,
  clearOutgoingPrivateStatuses,
  startLocationShare,
  updateLocationShare,
  stopLocationShare,
  fetchActiveLocationShares,
  fetchMyActiveShares,
  setTypingStatus,
  deleteStatusImage,
  notifyFriendOfMessage,
  setMyUsername,
  isUsernameTaken,
  deactivateAccount,
  reactivateAccount,
  requestAccountDeletion,
  cancelAccountDeletion,
  client
} from './supabase.js';

// Inline SVG icons — stroke="currentColor" so they inherit the text color
const ICON_EYE = '<svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
const ICON_EYE_OFF = '<svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>';

const _savedHash = window.location.hash;
const _savedSearch = window.location.search;
(function cleanUrl() {
  const hasToken = _savedHash && (
    _savedHash.includes('access_token') ||
    _savedHash.includes('type=')
  );
  const hasCode = _savedSearch && new URLSearchParams(_savedSearch).has('code');
  if (hasToken || hasCode) {
    window.history.replaceState(null, '', window.location.pathname);
  }
})();

/* ==========================================
   APP STATE
   ========================================== */
const state = {
  userProfile: null,
  connections: [],
  selectedEmoji: '😊',
  realtimeChannel: null,
  authMode: 'signin',
  pollInterval: null,
  privateStatuses: {},
  privateSentByMe: {},
  locationInterval: null,      // GPS polling interval when sharing
  sharingLocationWith: [],     // list of friendIds we're sharing with
  friendLocations: {}          // friendId → { latitude, longitude, updatedAt }
};

let currentStatusImage = null;
let currentStatusImageUrl = null;
let isStatusImageRemoved = false;
let currentChatImage = null;
let currentChatFriend = null;
let currentReplyTo = null; // { id, content_text, image_url, sender_id }

// Chat pagination + typing state
let chatMessageLimit = 50;      // messages loaded per chat session (grows via "Load earlier")
let chatPagingUp = false;       // true only while the user is loading earlier messages
let chatTypingSentAt = 0;       // last time we broadcast "typing…"
let friendTypingTimer = null;
let chatMessagesCache = {};     // msg.id → msg for the open chat (in-place realtime patches)
let openReactPicker = null;     // currently open reaction picker element
let openActionSheet = null;     // currently open bubble action sheet element
let longPressTimer = null;      // long-press timer for the reaction picker
let longPressTarget = null;     // bubble being long-pressed
let longPressFired = false;     // long-press fired → suppress the follow-up tap
let toastChatFriend = null;     // friendId to open when the toast is tapped
let chatSearchMode = false;     // search bar + results overlay active

// Quick-reaction set shown in the per-message picker
const REACTION_EMOJIS = ['👍','❤️','😂','😮','😢','🔥','🎉','😍','🙏','💯','👏','🤯'];

const cache = {
  connections: null,
  connectionsAt: 0,
  TTL: 180000  // 3 min cache — reduces DB calls on slow connections
};

function getCachedConnections() {
  if (cache.connections && Date.now() - cache.connectionsAt < cache.TTL) {
    return cache.connections;
  }
  return null;
}

function setCachedConnections(data) {
  cache.connections = data;
  cache.connectionsAt = Date.now();
}

function invalidateCache() {
  cache.connections = null;
  cache.connectionsAt = 0;
}

/* ==========================================
   ONLINE PRESENCE — 60 SECOND THRESHOLD
   ========================================== */
const ONLINE_THRESHOLD_MS = 60 * 1000;

function isOnline(lastSeenTimestamp) {
  if (!lastSeenTimestamp) return false;
  const diff = Date.now() - new Date(lastSeenTimestamp).getTime();
  return diff < ONLINE_THRESHOLD_MS;
}

function startHeartbeat() {
  updateLastSeen().catch(() => {});
  setInterval(() => {
    // Only ping when tab is visible — saves battery and DB writes
    if (document.visibilityState === 'visible') {
      updateLastSeen().catch(() => {});
    }
  }, 20000);
}

/* ==========================================
   IMAGE COMPRESSION
   ========================================== */
function compressImage(file, maxWidth = 1200, quality = 0.8, mirrorFix = false) {
  return new Promise((resolve, reject) => {
    // Validate file type — images only
    if (!file.type.startsWith('image/')) {
      return reject(new Error('Only image files are allowed.'));
    }
    // No size limit — compress everything regardless of how large it is
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let w = img.width, h = img.height;
        if (w > maxWidth) { h = (h * maxWidth) / w; w = maxWidth; }
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (mirrorFix) {
          // Un-mirror front camera: flip horizontally
          ctx.translate(w, 0);
          ctx.scale(-1, 1);
        }
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob((blob) => {
          resolve(new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' }));
        }, 'image/jpeg', quality);
      };
      img.onerror = reject;
      img.src = /** @type {string} */ (e.target.result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Downscale an image file and return a compressed JPEG data URL.
// Used for chat backgrounds so we don't blow the ~5MB localStorage quota.
function compressImageToDataUrl(file, maxWidth = 900, quality = 0.72) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      return reject(new Error('Only images are allowed.'));
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let w = img.width, h = img.height;
        if (w > maxWidth) { h = (h * maxWidth) / w; w = maxWidth; }
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => reject(new Error('Could not read image.'));
      img.src = /** @type {string} */ (e.target.result);
    };
    reader.onerror = () => reject(new Error('Could not read file.'));
    reader.readAsDataURL(file);
  });
}

/* ==========================================
   TOAST NOTIFICATIONS
   ========================================== */
let toastTimer = null;

function showToast(text, type = 'success') {
  const toast = document.getElementById('global-toast');
  const textEl = document.getElementById('toast-text');
  const iconEl = document.getElementById('toast-icon');
  if (!toast || !textEl || !iconEl) return;

  textEl.textContent = text;
  iconEl.textContent = type === 'success' ? '✨' : type === 'error' ? '⚠️' : 'ℹ️';
  toast.className = `toast show toast-${type}`;

  clearTimeout(toastTimer);
  // Errors stay longer so user can read them
  const duration = type === 'error' ? 6000 : 4000;
  toastChatFriend = null; // a plain toast must not open the previous DM chat
  toast.style.cursor = '';
  toast.style.pointerEvents = 'none'; // base toast is display-only
  toastTimer = setTimeout(() => {
    toast.className = 'toast';
  }, duration);
}

// DM in-app notification — tappable toast that opens the chat
function showDmToast(friendId, title, body) {
  const toast = document.getElementById('global-toast');
  const textEl = document.getElementById('toast-text');
  const iconEl = document.getElementById('toast-icon');
  if (!toast || !textEl || !iconEl) return;
  toastChatFriend = friendId || null;
  textEl.textContent = `${title}: ${body}`;
  iconEl.textContent = '💬';
  toast.className = 'toast show toast-info';
  toast.style.cursor = friendId ? 'pointer' : '';
  // DM toasts are tappable — re-enable pointer events (base toast is display-only)
  toast.style.pointerEvents = friendId ? 'auto' : 'none';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.className = 'toast';
    toast.style.pointerEvents = 'none';
    toastChatFriend = null;
  }, 6000);
}

/* ==========================================
   ROUTING
   ========================================== */
function navigateTo(viewName) {
  const views = {
    config: document.getElementById('config-view'),
    auth: document.getElementById('auth-view'),
    dashboard: document.getElementById('dashboard-view'),
    chat: document.getElementById('chat-view')
  };

  // On desktop, hide the sidebar rail on the auth/config screens
  const root = document.getElementById('app-root');
  if (root) root.classList.toggle('auth-mode', viewName === 'auth' || viewName === 'config');

  Object.entries(views).forEach(([key, el]) => {
    if (!el) return;
    el.style.display = key === viewName ? 'flex' : 'none';
  });
}

async function checkNavigationState() {
  if (!isSupabaseConfigured()) {
    navigateTo('config');
    return;
  }

  try {
    const profile = await getSessionAndProfile(_savedHash, _savedSearch);

    if (profile) {
      state.userProfile = profile;
      state.selectedEmoji = profile.status_emoji || '😊';
      // Instagram-style: logging back in automatically reactivates a deactivated account
      if (profile.deactivated_at) {
        reactivateAccount().catch(() => {});
        state.userProfile = { ...state.userProfile, deactivated_at: null };
      }
      navigateTo('dashboard');
      invalidateCache();
      await loadDashboardData();
      // Refresh keeps you in the chat you had open instead of dumping you
      // back on the dashboard
      restoreOpenChatFromStorage();
      setupRealtimeSync();
      startPollingFallback();
      setTimeout(requestNotificationPermission, 3000);
      setTimeout(registerFCMToken, 4000);
      // Returning users who already granted permission never see the banner —
      // re-subscribe silently so their push subscription stays valid.
      setTimeout(() => {
        if ('Notification' in window && Notification.permission === 'granted') {
          subscribeToPushNotifications().catch(() => {});
        }
      }, 5000);
      startHeartbeat();
      resumeLocationSharing();
      handleDeepLinks();
      // New users pick their @username once they're in
      setTimeout(maybeShowUsernameOnboarding, 1200);
    } else {
      navigateTo('auth');
      setAuthMode('signin');
    }
  } catch (err) {
    console.error('[Pulse] Navigation check error:', err);
    navigateTo('auth');
    setAuthMode('signin');
  }
}

/* ==========================================
   DEEP LINKS (?invite=, ?action=)
   ========================================== */
let _inviteHandled = false;

function handleDeepLinks() {
  const params = new URLSearchParams(_savedSearch);

  // PWA shortcut: /?action=update-status → open status modal directly
  if (params.get('action') === 'update-status') {
    setTimeout(() => document.getElementById('btn-open-status-modal')?.click(), 500);
    const clean = new URLSearchParams(_savedSearch);
    clean.delete('action');
    const qs = clean.toString();
    window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
  }

  // Invite link: /?invite=<pulseId> → auto-send a connection request
  const inviteId = params.get('invite');
  if (inviteId && !_inviteHandled) {
    _inviteHandled = true;
    handleInviteLink(inviteId);
  }

  // Notification tap: /?chat=<friendId> → open that conversation
  const chatId = params.get('chat');
  if (chatId) {
    setTimeout(() => {
      const friend = state.connections.find(c => c.friendId === chatId && c.status === 'connected');
      if (friend) {
        openChat(friend);
      } else {
        showToast('Message from a friend — connect to reply.', 'info');
      }
    }, 400);
    const clean = new URLSearchParams(_savedSearch);
    clean.delete('chat');
    const qs = clean.toString();
    window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
  }
}

async function handleInviteLink(friendId) {
  const myId = state.userProfile?.id;
  if (!friendId || !myId) return;

  // Already connected? The invite param can be a uuid (legacy) or a @username.
  const handle = String(friendId).replace(/^@/, '').toLowerCase();
  const existing = state.connections.find(c =>
    c.friendId === friendId ||
    (c.username && c.username.toLowerCase() === handle)
  );
  if (existing) {
    showToast(existing.status === 'connected'
      ? 'Already connected with this friend! ✅'
      : 'Invite already pending for this friend.');
    return;
  }

  try {
    await sendConnectionRequest(friendId);
    showToast('Connected via invite! ✨');
    invalidateCache();
    await loadDashboardData();
    const clean = new URLSearchParams(_savedSearch);
    clean.delete('invite');
    const qs = clean.toString();
    window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
  } catch (err) {
    showToast(err.message || 'Could not connect via invite.', 'error');
  }
}

/* ==========================================
   AUTH HELPERS
   ========================================== */
function showAuthError(msg) {
  const box = document.getElementById('auth-error-msg');
  if (!box) return;
  box.textContent = msg;
  box.style.display = 'block';
}

function clearAuthError() {
  const box = document.getElementById('auth-error-msg');
  if (box) box.style.display = 'none';
}

function setAuthMode(mode) {
  state.authMode = mode;

  const tabSignin = document.getElementById('tab-signin');
  const tabSignup = document.getElementById('tab-signup');
  const fieldName = document.getElementById('field-name');
  const fieldConfirm = document.getElementById('field-confirm');
  const linkForgot = document.getElementById('link-forgot');
  const label = document.getElementById('btn-auth-label');
  const passwordInput = document.getElementById('auth-password');

  if (mode === 'signin') {
    tabSignin?.classList.add('active');
    tabSignup?.classList.remove('active');
    if (fieldName) fieldName.style.display = 'none';
    if (fieldConfirm) fieldConfirm.style.display = 'none';
    if (linkForgot) linkForgot.style.display = 'block';
    if (label) label.textContent = 'Sign In';
    if (passwordInput) passwordInput.autocomplete = 'current-password';
  } else {
    tabSignup?.classList.add('active');
    tabSignin?.classList.remove('active');
    if (fieldName) fieldName.style.display = 'flex';
    if (fieldConfirm) fieldConfirm.style.display = 'flex';
    if (linkForgot) linkForgot.style.display = 'none';
    if (label) label.textContent = 'Create Account';
    if (passwordInput) passwordInput.autocomplete = 'new-password';
  }

  clearAuthError();
}

/* ==========================================
   REAL-TIME SYNC
   ========================================== */
async function setupRealtimeSync() {
  if (state.realtimeChannel) {
    state.realtimeChannel.unsubscribe();
    state.realtimeChannel = null;
  }

  if (!state.userProfile) return;

  // Only subscribe to friend profile updates (free-tier realtime hygiene)
  const friendIds = state.connections
    .filter(c => c.status === 'connected')
    .map(c => c.friendId);

  state.realtimeChannel = subscribeToPulseSync(state.userProfile.id, async (change) => {
    if (change.type === 'profile_updated') {
      const updatedId = change.record.id;

      if (updatedId === state.userProfile.id) {
        state.userProfile = { ...state.userProfile, ...change.record };
        updateMyStatusUI();
      } else {
        const isFriend = state.connections.some(
          c => c.friendId === updatedId && c.status === 'connected'
        );
        if (isFriend) {
          const friend = state.connections.find(c => c.friendId === updatedId);
          const displayName = friend?.nickname?.trim() || change.record.name || 'A friend';
          const emoji = change.record.status_emoji || '💫';
          const text = change.record.status_text || 'Updated their status';

          // Skip if ONLY last_seen changed — that's just a heartbeat, not a real update
          const prev = friend;
          const emojiChanged = emoji !== (prev?.statusEmoji || '😊');
          const textChanged = text !== (prev?.statusText || 'Available');
          const imageChanged = change.record.status_image_url !== (prev?.statusImageUrl || null);
          if (!emojiChanged && !textChanged && !imageChanged) return;

          // Dedup: only notify + reload once per friend per 5 seconds
          const dedupKey = `rt-${updatedId}`;
          const now = Date.now();
          if (!state._rtDedup) state._rtDedup = {};
          if (state._rtDedup[dedupKey] && now - state._rtDedup[dedupKey] < 5000) return;
          state._rtDedup[dedupKey] = now;

          notifyFriendStatusUpdate(displayName, emoji, text, updatedId);
          showToast(`${emoji} ${displayName} updated their status!`);
          invalidateCache();
          await loadDashboardData();
        }
      }
    } else if (change.type === 'connection_changed') {
      invalidateCache();
      await loadDashboardData();
      // Friend list changed — resubscribe so profile filters match new friends
      setupRealtimeSync();
    } else if (change.type === 'new_message') {
      const msg = change.record;
      // Dedup: realtime can redeliver the same INSERT after a reconnect — a
      // duplicate would double-bump the unread badge. Same pattern as status
      // updates (state._rtDedup, 5s window).
      if (msg?.id) {
        if (!state._rtMsgDedup) state._rtMsgDedup = {};
        const now = Date.now();
        if (state._rtMsgDedup[msg.id] && now - state._rtMsgDedup[msg.id] < 5000) return;
        state._rtMsgDedup[msg.id] = now;
      }
      const isSelf = msg.sender_id === state.userProfile?.id;
      if (isSelf && currentChatFriend && msg.recipient_id === currentChatFriend.friendId) {
        // Echo of my own send — append in place if this chat is open. Deduped
        // by appendChatMessage's cache guard, so it can't double-append even
        // when the optimistic append already ran.
        appendChatMessage(msg);
      } else if (!isSelf && currentChatFriend && msg.sender_id === currentChatFriend.friendId) {
        // Chat is open → append the bubble in place, mark delivered + read.
        // Idempotent: my own send's echo is deduped by appendChatMessage's
        // cache guard, so it can't double-append even if it races the send.
        appendChatMessage(msg);
        markMessagesAsDelivered(currentChatFriend.friendId).catch(() => {});
        markMessagesAsRead(currentChatFriend.friendId).catch(() => {});
      } else if (!isSelf) {
        // In-app DM notification — sender name + preview, tap to open the chat
        const sender = (state.connections || []).find(c => c.friendId === msg.sender_id);
        const senderName = sender?.displayName || sender?.name || 'A friend';
        const senderEmoji = sender?.statusEmoji || '💬';
        const preview = msg.content_text
          ? (msg.content_text.length > 50 ? msg.content_text.slice(0, 50) + '…' : msg.content_text)
          : (msg.image_url ? '📎 Photo' : 'New message');
        showDmToast(msg.sender_id, `${senderEmoji} ${senderName}`, preview);
        // Device received it → sender gets a ✓✓ delivered receipt immediately
        if (msg.sender_id) markMessagesAsDelivered(msg.sender_id).catch(() => {});
        // Live unread badge — bump the sender's count in place and re-render
        // just the feed, instead of a full dashboard reload per message.
        if (sender) {
          sender.unreadCount = (sender.unreadCount || 0) + 1;
          renderFriendsFeed();
        } else {
          // Sender isn't in our list yet — fall back to a fresh load
          invalidateCache();
          await loadDashboardData();
        }
      }
    } else if (change.type === 'message_updated') {
      // Read/delivered receipt or reaction → patch just that bubble, no reload
      if (currentChatFriend) patchMessageBubble(change.record);
    } else if (change.type === 'message_deleted') {
      // A message in this conversation was deleted — remove it in place
      const rec = change.record;
      if (currentChatFriend) {
        const isMine = rec?.sender_id === state.userProfile?.id;
        const otherId = isMine ? rec?.recipient_id : rec?.sender_id;
        if (rec?.id && otherId === currentChatFriend.friendId) removeChatMessageRow(rec.id);
        // Deletion from another conversation — nothing to refresh while chat is open
      } else {
        invalidateCache();
        await loadDashboardData();
      }
    } else if (change.type === 'typing_updated') {
      handleTypingEvent(change.record, change.eventType);
    } else if (change.type === 'private_status_updated') {
      const rec = change.record;
      state.privateStatuses[rec.from_user_id] = rec;
      renderFriendsFeed();
      const friend = state.connections.find(c => c.friendId === rec.from_user_id);
      const name = friend?.nickname?.trim() || friend?.name || 'A friend';
      showToast(`${rec.status_emoji} ${name} sent you a private status!`);
    } else if (change.type === 'location_updated') {
      const rec = change.record;
      if (rec && rec.is_active) {
        state.friendLocations[rec.from_user_id] = {
          latitude: rec.latitude,
          longitude: rec.longitude,
          updatedAt: rec.updated_at
        };
      } else if (rec) {
        delete state.friendLocations[rec.from_user_id];
      }
      renderFriendLocations();
    }
  }, friendIds);
}
function renderSkeletons() {
  const friendsEl = document.getElementById('friends-status-container');
  const historyEl = document.getElementById('status-history-container');

  if (friendsEl && !friendsEl.querySelector('.user-status-card')) {
    friendsEl.innerHTML = `
      <div class="glass-card user-status-card" style="border:none;box-shadow:none;">
        <div class="skeleton skeleton-avatar"></div>
        <div style="flex:1;display:flex;flex-direction:column;gap:8px;">
          <div class="skeleton skeleton-line" style="width:45%;"></div>
          <div class="skeleton skeleton-line" style="width:80%;"></div>
        </div>
      </div>
      <div class="glass-card user-status-card" style="border:none;box-shadow:none;">
        <div class="skeleton skeleton-avatar"></div>
        <div style="flex:1;display:flex;flex-direction:column;gap:8px;">
          <div class="skeleton skeleton-line" style="width:40%;"></div>
          <div class="skeleton skeleton-line" style="width:75%;"></div>
        </div>
      </div>
    `;
  }

  if (historyEl && !historyEl.querySelector('.history-item')) {
    historyEl.innerHTML = `
      <div class="skeleton skeleton-card"></div>
      <div class="skeleton skeleton-card"></div>
      <div class="skeleton skeleton-card"></div>
    `;
  }
}

async function loadDashboardData() {
  try {
    // Show the ad slot once the dashboard renders (idempotent, no-op until
    // real AdSense/AdMob IDs are configured in src/ads.js). Ads load lazily
    // so they never block the first dashboard paint.
    import('./ads.js').then(m => m.initAds()).catch(() => {});

    const cachedConns = getCachedConnections();
    if (!cachedConns) {
      // Instant first paint from last session's IndexedDB cache while the
      // fresh network data loads (skeletons only when nothing is cached).
      if (state.userProfile?.id) {
        const idb = await dbGet('kv', dashKey(state.userProfile.id));
        if (idb?.connections?.length) {
          state.connections = idb.connections;
          renderFriendsFeed();
          renderPendingInvites();
        }
      }
      renderSkeletons();
    }

    // fetchPrivateStatusesForMe is safe — if the table doesn't exist yet it returns empty
    const [profile, connections, privateStatuses] = await Promise.all([
      getSessionAndProfile(_savedHash, _savedSearch),
      cachedConns ? Promise.resolve(cachedConns) : fetchConnections(),
      fetchPrivateStatusesForMe().catch(() => ({ received: [], sent: [] }))
    ]);

    if (profile) {
      state.userProfile = profile;
      updateMyStatusUI();
    }

    // Build two lookups:
    // privateStatuses[friendId] = what THEY sent to ME (shown on their card)
    // privateSentByMe[friendId] = what I sent TO THEM (shown as sent preview on their card)
    state.privateStatuses = {};
    state.privateSentByMe = {};
    if (privateStatuses) {
      (privateStatuses.received || []).forEach(ps => {
        state.privateStatuses[ps.from_user_id] = ps;
      });
      (privateStatuses.sent || []).forEach(ps => {
        state.privateSentByMe[ps.to_user_id] = ps;
      });
    }

    // Load active location shares from friends
    const locations = await fetchActiveLocationShares().catch(() => []);
    locations.forEach(loc => {
      state.friendLocations[loc.from_user_id] = {
        latitude: loc.latitude,
        longitude: loc.longitude,
        updatedAt: loc.updated_at
      };
    });

    // Load who I'm currently sharing with
    const myShares = await fetchMyActiveShares().catch(() => []);
    state.sharingLocationWith = myShares;
    updateLocationIndicator();

    if (!cachedConns) setCachedConnections(connections);
    // Persist a copy so the next boot paints instantly (and works offline)
    if (state.userProfile?.id) {
      dbSet('kv', dashKey(state.userProfile.id), { connections, savedAt: Date.now() });
    }
    state.connections = connections;
    renderFriendsFeed();
    renderFriendLocations();
    renderPendingInvites();

    const directSelect = document.getElementById('direct-friend-select');
    if (directSelect) {
      directSelect.innerHTML = '<option value="">Select a friend...</option>';
      connections
        .filter(c => c.status === 'connected')
        .forEach(c => {
          const opt = document.createElement('option');
          opt.value = c.friendId;
          opt.textContent = c.displayName;
          directSelect.appendChild(opt);
        });
    }

    const connectedFriendIds = connections
      .filter(c => c.status === 'connected')
      .map(c => c.friendId);

    if (connectedFriendIds.length > 0) {
      try {
        const history = await fetchFriendsStatusHistory(connectedFriendIds);
        renderStatusHistory(history, connections);
      } catch (err) {
        console.warn('[Pulse] History fetch failed:', err.message);
        renderStatusHistory([], connections);
        // Show error in history container rather than silent empty state
        const hc = document.getElementById('status-history-container');
        if (hc) hc.innerHTML = `<div style="font-size:13px;color:hsl(var(--text-muted));font-style:italic;">Could not load history — will retry on next refresh.</div>`;
      }
    } else {
      renderStatusHistory([], connections);
    }

  } catch (err) {
    console.error('[Pulse] Dashboard load error:', err);
    const msg = !navigator.onLine
      ? 'You appear to be offline. Using cached data.'
      : err.message?.includes('timeout') || err.message?.includes('network')
        ? 'Slow connection — some data may be outdated.'
        : 'Failed to sync. Check your connection.';
    showToast(msg, 'error');
  }
}

function updateMyStatusUI() {
  if (!state.userProfile) return;

  const myName = document.getElementById('my-name');
  const myAvatar = document.getElementById('my-avatar');
  const myAvatarContainer = document.getElementById('my-avatar-container');
  const myStatusBubble = document.getElementById('my-status-bubble');
  const myStatusImage = document.getElementById('my-status-image');
  const idDisplay = document.getElementById('my-id-display');
  const myDot = document.getElementById('my-pulse-dot');

  if (myName) myName.textContent = state.userProfile.name || 'My Status';

  // Show photo in avatar circle if available, else emoji
  if (myAvatarContainer) {
    if (state.userProfile.status_image_url) {
      const url = state.userProfile.status_image_url;
      const mtype = state.userProfile.status_media_type || 'image';
      const isVid = isVideoUrl(url, mtype);
      myAvatarContainer.classList.add('has-photo');
      myAvatarContainer.style.cursor = 'zoom-in';
      myAvatarContainer.onclick = () => openFullMedia(url, isVid);
      if (myAvatar) {
        myAvatar.innerHTML = isVid
          ? `<video autoplay loop muted playsinline style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block;">
               <source src="${escapeHtml(url)}" type="video/mp4">
               <source src="${escapeHtml(url)}" type="video/webm">
             </video>`
          : `<img src="${escapeHtml(url)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block;">`;
      }
    } else {
      myAvatarContainer.classList.remove('has-photo');
      myAvatarContainer.style.cursor = '';
      myAvatarContainer.onclick = null;
      if (myAvatar) myAvatar.textContent = state.userProfile.status_emoji || '👋';
    }
  } else {
    if (myAvatar) myAvatar.textContent = state.userProfile.status_emoji || '👋';
  }

  if (myStatusBubble) {
    myStatusBubble.textContent = `"${state.userProfile.status_text || 'Available'}"`;
  }
  // Hide the old below-card image since photo is now in avatar
  if (myStatusImage) myStatusImage.style.display = 'none';

  if (idDisplay) {
    const uname = state.userProfile.username;
    idDisplay.textContent = uname ? `@${uname}` : 'Set username';
    idDisplay.title = uname ? 'Click to copy your username' : 'Set your username in Update Status';
  }
  if (myDot) {
    myDot.className = 'online-pulse-dot';
  }

  // Keep the desktop sidebar me-row in sync (rename / status updates go
  // through this function but not through renderFriendsFeed)
  const sAvatar = document.getElementById('sidebar-me-avatar');
  const sName = document.getElementById('sidebar-me-name');
  const sUsername = document.getElementById('sidebar-me-username');
  if (sAvatar) sAvatar.textContent = state.userProfile.status_emoji || '👋';
  if (sName) sName.textContent = state.userProfile.name || 'Me';
  if (sUsername) sUsername.textContent = state.userProfile.username ? `@${state.userProfile.username}` : '';
}

/* ==========================================
   EMOJI PICKER
   ========================================== */
const EMOJI_CATEGORIES = {
  mood: ['😊','😄','😁','🥰','😍','🤩','😎','🥳','😂','🤣','😅','😌','😏','🤔','😐','😑','😶','🙄','😒','😔','😞','😟','😕','🙁','😣','😖','😫','😩','🥺','😢','😭','😤','😠','😡','🤬','😈','👿','😱','😨','😰','😥','😓','🤗','🤭','🤫','🤥','😬','🤐','😷','🤒','🤕','🤢','🤮','🥴','😵','🤯','🥶','🥵','😴','💤','🤤','😪'],
  health: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','🩺','💊','🩹','🏥','🧬','🦷','🦴','👁️','🫀','🫁','🧠','💪','🦾','🏃','🧘','🛌','😴','🔋','⚡','🌡️','🩻','🧪'],
  activity: ['💻','📱','🎮','🎧','🎵','🎶','📚','✏️','🖊️','🎨','🎭','🎬','📷','🎤','🎸','🥁','🎹','⚽','🏀','🏈','⚾','🎾','🏐','🏉','🎱','🏓','🏸','🥊','🏋️','🤸','🚴','🏊','🧗','🤾','🎯','🎲','♟️','🧩','🚀','✈️','🛸','🔭','🔬','⚗️','🧪','💡','🔧','🛠️','🏆','🥇','🎖️'],
  nature: ['🌿','🌱','🌲','🌳','🌴','🌵','🌾','🍀','🍁','🍂','🍃','🌺','🌸','🌼','🌻','🌹','🌷','💐','🍄','🌊','🌈','⭐','🌟','✨','💫','☀️','🌤️','⛅','🌥️','☁️','🌦️','🌧️','⛈️','🌩️','🌨️','❄️','☃️','⛄','🌬️','💨','🌪️','🌫️','🌊','🌙','🌛','🌜','🌝','🌞','🪐','🌍','🌎','🌏'],
  food: ['🍕','🍔','🌮','🌯','🥗','🍜','🍝','🍛','🍣','🍱','🥟','🍤','🍙','🍚','🍘','🍥','🥮','🍢','🧆','🥚','🍳','🥞','🧇','🥓','🥩','🍗','🍖','🌭','🥪','🥙','🧀','🥨','🥐','🥖','🍞','🥜','🌰','🍫','🍬','🍭','🍮','🍯','🍰','🎂','🧁','🍩','🍪','☕','🍵','🧃','🥤','🧋','🍺','🍻','🥂','🍷','🥃','🍸','🍹'],
  travel: ['✈️','🚀','🛸','🚁','🛩️','🚂','🚃','🚄','🚅','🚆','🚇','🚈','🚉','🚊','🚝','🚞','🚋','🚌','🚍','🚎','🚐','🚑','🚒','🚓','🚔','🚕','🚖','🚗','🚘','🚙','🛻','🚚','🚛','🚜','🏎️','🏍️','🛵','🚲','🛴','🛹','🛼','🚏','🛣️','🛤️','⛽','🚦','🚥','🗺️','🧭','🏔️','⛰️','🌋','🗻','🏕️','🏖️','🏜️','🏝️','🏞️','🏟️','🏛️','🗼','🗽','🗿','🏰','🏯','🕌','🕍','⛪','🕋']
};

let currentEmojiCategory = 'mood';

function renderEmojiGrid(category, selectedEmoji) {
  const grid = document.getElementById('emoji-grid');
  if (!grid) return;

  const emojis = EMOJI_CATEGORIES[category] || EMOJI_CATEGORIES.mood;
  grid.innerHTML = emojis.map(e => `
    <button class="emoji-btn ${e === selectedEmoji ? 'active' : ''}" data-emoji="${e}" type="button">${e}</button>
  `).join('');

  grid.querySelectorAll('.emoji-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectEmoji(btn.dataset.emoji);
    });
  });
}

function selectEmoji(emoji) {
  state.selectedEmoji = emoji;
  const preview = document.getElementById('emoji-preview');
  if (preview) preview.textContent = emoji;
  const customInput = document.getElementById('emoji-custom-input');
  if (customInput) customInput.value = emoji;
  document.querySelectorAll('#emoji-grid .emoji-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.emoji === emoji);
  });
  updateStatusLivePreview();
}

function initEmojiPicker() {
  document.getElementById('emoji-category-tabs')?.querySelectorAll('.emoji-cat-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.emoji-cat-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentEmojiCategory = tab.dataset.cat;
      renderEmojiGrid(currentEmojiCategory, state.selectedEmoji);
    });
  });

  const customInput = document.getElementById('emoji-custom-input');
  customInput?.addEventListener('input', (e) => {
    const val = e.target.value.trim();
    if (!val) return;
    const chars = [...val];
    const emoji = chars[0];
    if (emoji) selectEmoji(emoji);
  });

  renderEmojiGrid(currentEmojiCategory, state.selectedEmoji);
}

/* ==========================================
   TIME FORMATTING
   ========================================== */
function formatTimeAgo(timestamp) {
  if (!timestamp) return 'Just now';
  const diffMs = Date.now() - new Date(timestamp).getTime();
  const s = Math.floor(diffMs / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);

  if (s < 10) return 'Just now';
  if (s < 60) return `${s}s ago`;
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${d}d ago`;
}

/* ==========================================
   FRIENDS FEED RENDERER
   ========================================== */
function renderFriendsFeed() {
  const container = document.getElementById('friends-status-container');
  const counterEl = document.getElementById('connected-count');
  if (!container) return;

  // Keep the desktop sidebar rail in sync (no-op when hidden on phones)
  renderDesktopSidebar();

  const connected = state.connections.filter(c => c.status === 'connected');
  if (counterEl) counterEl.textContent = `${connected.length}/5`;

  if (connected.length === 0) {
    container.innerHTML = `
      <div class="glass-card empty-state-card">
        <span class="empty-icon">👥</span>
        No connected friends yet. Share your @username below to start syncing lockscreens in real-time!
      </div>
    `;
    return;
  }

  container.innerHTML = '';

  connected.forEach(friend => {
    // Check if this friend sent us a private status — override public status if so
    const ps = state.privateStatuses[friend.friendId];
    const sentByMe = state.privateSentByMe[friend.friendId];
    const displayEmoji = ps?.status_emoji  ?? friend.statusEmoji;
    const displayText  = ps?.status_text   ?? friend.statusText;
    const displayImage = ps?.status_image_url ?? friend.statusImageUrl;
    const displayTime  = ps?.updated_at    ?? friend.updatedAt;

    const hasImage = !!displayImage;
    const hasUnread = friend.unreadCount > 0;
    const online = isOnline(friend.lastSeen);

    const card = document.createElement('div');
    card.className = 'glass-card user-status-card';
    card.dataset.friendId = friend.friendId;

    const privateBadge = ps
      ? `<span class="direct-status-badge">🔒 Private</span>`
      : '';

    // Show what YOU sent them privately as a subtle sub-row
    const sentPreview = sentByMe
      ? `<div class="private-sent-preview">
           <span>📤 You sent privately:</span>
           <span>${escapeHtml(sentByMe.status_emoji)} ${escapeHtml(sentByMe.status_text || '')}</span>
           ${sentByMe.status_image_url ? `<img src="${escapeHtml(sentByMe.status_image_url)}" onclick="event.stopPropagation();openFullImage('${escapeHtml(sentByMe.status_image_url)}')" alt="">` : ''}
         </div>`
      : '';

    const isVideo = hasImage && isVideoUrl(displayImage, ps?.status_media_type || friend.statusMediaType);

    // IMAGE or VIDEO: both go in the avatar circle
    // Photos: object-fit cover fills circle nicely
    // Videos: loop silently in the circle, tap opens full player
    const avatarInner = hasImage
      ? isVideo
        ? `<video autoplay loop muted playsinline
             style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block;cursor:pointer;">
             <source src="${escapeHtml(displayImage)}" type="video/mp4">
             <source src="${escapeHtml(displayImage)}" type="video/webm">
           </video>`
        : `<img src="${escapeHtml(displayImage)}" alt=""
             style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block;cursor:zoom-in;">`
      : `<span>${escapeHtml(displayEmoji || '😊')}</span>`;

    // No separate video card below — everything in the circle
    const videoCard = '';

    card.innerHTML = `
      <div class="avatar-container${hasImage ? ' has-photo' : ''}" style="position:relative;flex-shrink:0;">
        ${avatarInner}
        ${online ? '<span class="online-pulse-dot"></span>' : '<span class="offline-dot"></span>'}
        ${hasUnread ? `<span class="unread-badge">${friend.unreadCount}</span>` : ''}
      </div>
      <div class="status-details" style="flex:1;min-width:0;overflow:hidden;">
        <div class="status-user-name" style="flex-wrap:wrap;row-gap:4px;">
          <span class="friend-display-name" style="font-size:14px;font-weight:700;">${escapeHtml(friend.nickname?.trim() || friend.name)}</span>
          ${friend.nickname ? `<span class="real-name-tag">${escapeHtml(friend.name)}</span>` : ''}
        </div>
        ${privateBadge}
        <div class="status-bubble">"${escapeHtml(displayText || 'Available')}"</div>
        ${videoCard}
        <div class="status-time">${formatTimeAgo(displayTime)}</div>
        ${sentPreview}
      </div>
      <div style="display:flex;flex-direction:row;gap:4px;align-self:flex-start;flex-shrink:0;margin-left:auto;">
        <button class="btn btn-secondary btn-small nickname-btn" data-conn-id="${escapeHtml(friend.connectionId)}" data-friend-id="${escapeHtml(friend.friendId)}" data-current-nickname="${escapeHtml(friend.nickname || '')}" data-real-name="${escapeHtml(friend.name)}" title="${friend.nickname ? 'Edit nickname' : 'Add nickname'}" style="padding:5px 8px;font-size:13px;line-height:1;">${friend.nickname ? '<svg class="icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>' : '<svg class="icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/><circle cx="12" cy="12" r="4"/></svg>'}</button>
        <button class="btn btn-secondary btn-small btn-small-danger remove-connection-btn" data-conn-id="${escapeHtml(friend.connectionId)}" title="Remove connection" style="padding:5px 8px;font-size:13px;line-height:1;"><svg class="icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
      </div>
    `;
    container.appendChild(card);
  });

  container.querySelectorAll('.user-status-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.btn')) return;
      const avatarEl = e.target.closest('.avatar-container.has-photo');
      if (avatarEl) {
        const vid = avatarEl.querySelector('video');
        const img = avatarEl.querySelector('img');
        if (vid) {
          const src = vid.querySelector('source')?.src || vid.src;
          openFullMedia(src, true);
          return;
        }
        if (img) {
          openFullImage(img.src);
          return;
        }
      }
      const friendId = card.dataset.friendId;
      const friend = state.connections.find(c => c.friendId === friendId);
      if (friend) openChat(friend);
    });
  });

  container.querySelectorAll('.nickname-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const connId = btn.dataset.connId;
      const friendId = btn.dataset.friendId;
      const currentNickname = btn.dataset.currentNickname;
      const realName = btn.dataset.realName;

      const input = await showNicknameModal({ realName, currentNickname });
      if (input === null) return;

      try {
        await setConnectionNickname(connId, input, friendId);
        showToast(input.trim() ? `Nickname set to "${input.trim()}"` : 'Nickname cleared.');
        invalidateCache();
        await loadDashboardData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  container.querySelectorAll('.remove-connection-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const connId = btn.dataset.connId;
      const confirmed = await showConfirmModal({
        icon: '💔',
        title: 'Disconnect friend?',
        body: 'They will no longer see your status and you won\'t see theirs.',
        okLabel: 'Disconnect',
        okDanger: true
      });
      if (!confirmed) return;
      try {
        await removeConnection(connId);
        showToast('Friend disconnected.');
        invalidateCache();
        await loadDashboardData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });
}

/* ==========================================
   PENDING INVITES
   ========================================== */
function renderPendingInvites() {
  const container = document.getElementById('pending-invites-container');
  if (!container) return;

  const pending = state.connections.filter(c => c.status === 'pending');

  if (pending.length === 0) {
    container.innerHTML = `
      <div style="font-size: 12px; color: hsl(var(--text-muted)); font-style: italic; padding: 4px 0;">
        No pending requests.
      </div>
    `;
    return;
  }

  container.innerHTML = '';

  pending.forEach(conn => {
    const card = document.createElement('div');
    card.className = 'friend-item';

    if (conn.isOutgoing) {
      card.innerHTML = `
        <div class="friend-item-info">
          <div class="friend-avatar">✉️</div>
          <div class="friend-details">
            <span class="friend-name">${escapeHtml(conn.name)}</span>
            <span class="friend-email">Outgoing invite — waiting for them to accept</span>
          </div>
        </div>
        <div class="friend-actions">
          <button class="btn btn-secondary btn-small btn-small-danger cancel-invite-btn" data-conn-id="${conn.connectionId}">Cancel</button>
        </div>
      `;
    } else {
      card.innerHTML = `
        <div class="friend-item-info">
          <div class="friend-avatar">🔔</div>
          <div class="friend-details">
            <span class="friend-name">${escapeHtml(conn.name)}</span>
            <span class="friend-email">Wants to connect with you! · ${formatTimeAgo(conn.createdAt)}</span>
          </div>
        </div>
        <div class="friend-actions">
          <button class="btn btn-secondary btn-small btn-small-success accept-invite-btn" data-conn-id="${conn.connectionId}">Accept</button>
          <button class="btn btn-secondary btn-small btn-small-danger cancel-invite-btn" data-conn-id="${conn.connectionId}">Reject</button>
        </div>
      `;
    }

    container.appendChild(card);
  });

  container.querySelectorAll('.accept-invite-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await acceptInvitation(btn.dataset.connId);
        showToast('Connected! You can now see each other\'s status.');
        invalidateCache();
        await loadDashboardData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  container.querySelectorAll('.cancel-invite-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await removeConnection(btn.dataset.connId);
        showToast('Invite removed.');
        invalidateCache();
        await loadDashboardData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });
}

/* ==========================================
   STATUS HISTORY
   ========================================== */
function renderStatusHistory(history, connections = []) {
  const container = document.getElementById('status-history-container');
  if (!container) return;

  if (!history || history.length === 0) {
    container.innerHTML = `<div style="font-size: 13px; color: hsl(var(--text-muted)); font-style: italic; padding: 4px 0;">No history yet — connect with friends and their updates will appear here.</div>`;
    return;
  }

  // Show up to 5 most recent entries across all friends
  // We fetch 15 from DB so private statuses from one friend don't get pushed out
  const recent = history.slice(0, 5);

  container.innerHTML = `<div class="history-list">${recent.map(entry => {
    const realName = entry.profile?.name || 'Unknown';
    const conn = connections.find(c => c.friendId === entry.profile?.id);
    const displayName = conn?.nickname?.trim() || realName;
    const hasImage = entry.status_image_url;

    return `
      <div class="history-item${hasImage ? ' history-item-media' : ''}"
        data-img="${escapeHtml(entry.status_image_url || '')}"
        data-is-video="${isVideoUrl(entry.status_image_url, entry.status_media_type) ? '1' : '0'}">
        <div class="history-emoji">${escapeHtml(entry.status_emoji)}</div>
        <div class="history-details">
          <span class="history-name">${escapeHtml(displayName)}</span>
          <span class="history-text">"${escapeHtml(entry.status_text || '')}"</span>
          ${hasImage ? (isVideoUrl(entry.status_image_url, entry.status_media_type)
            ? `<video controls playsinline muted preload="metadata"
                style="width:100%;border-radius:10px;display:block;margin-top:6px;background:#000;">
                 <source src="${escapeHtml(entry.status_image_url)}" type="video/mp4">
                 <source src="${escapeHtml(entry.status_image_url)}" type="video/webm">
               </video>`
            : `<img src="${escapeHtml(entry.status_image_url)}" class="history-image" alt="Status image" loading="lazy" style="cursor:zoom-in;">`)
          : ''}
          <span class="history-time">${formatTimeAgo(entry.created_at)}</span>
        </div>
      </div>
    `;
  }).join('')}</div>`;

  // Event delegation for history item media clicks — no inline onclick (XSS fix)
  container.querySelectorAll('.history-item-media').forEach(item => {
    item.style.cursor = 'pointer';
    item.addEventListener('click', (e) => {
      if (e.target.tagName === 'VIDEO') return; // let video controls work
      const img = item.dataset.img;
      const isVid = item.dataset.isVideo === '1';
      if (img) isVid ? openFullMedia(img, true) : openFullImage(img);
    });
  });
}

/* ==========================================
   CHAT / DM VIEW
   ========================================== */
/* ==========================================
   TYPING INDICATOR UI
   ========================================== */
function showTypingIndicator() {
  const el = document.getElementById('chat-typing-indicator');
  if (!el) return;
  el.style.display = 'block';
}

function hideTypingIndicator() {
  const el = document.getElementById('chat-typing-indicator');
  if (!el) return;
  el.style.display = 'none';
}

function handleTypingEvent(record, eventType) {
  if (!currentChatFriend || !record) return;
  if (record.from_user_id !== currentChatFriend.friendId) return;

  if (eventType === 'DELETE') {
    clearTimeout(friendTypingTimer);
    hideTypingIndicator();
    return;
  }

  showTypingIndicator();
  clearTimeout(friendTypingTimer);
  // Hide 3s after the last typing ping
  friendTypingTimer = setTimeout(hideTypingIndicator, 3000);
}

/* ==========================================
   OPEN-CHAT PERSISTENCE — survive page refresh (same tab)
   ========================================== */
const OPEN_CHAT_KEY = 'pulse_open_chat';

function saveOpenChat(friend) {
  try {
    sessionStorage.setItem(OPEN_CHAT_KEY, JSON.stringify({
      friendId: friend.friendId,
      at: Date.now()
    }));
  } catch { /* storage unavailable — refresh just lands on dashboard */ }
}

function clearOpenChat() {
  try { sessionStorage.removeItem(OPEN_CHAT_KEY); } catch { /* ignore */ }
}

// After connections load on boot, re-open the chat that was open before refresh
function restoreOpenChatFromStorage() {
  if (new URLSearchParams(_savedSearch).has('chat')) return; // deep link wins
  try {
    const raw = sessionStorage.getItem(OPEN_CHAT_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!saved?.friendId) return;
    const friend = state.connections.find(
      c => c.friendId === saved.friendId && c.status === 'connected'
    );
    if (friend) {
      openChat(friend);
    } else {
      clearOpenChat(); // friend gone or disconnected — drop the stale entry
    }
  } catch { /* malformed storage — ignore */ }
}

async function openChat(friend) {
  currentChatFriend = friend;
  saveOpenChat(friend);
  chatMessageLimit = 50;
  chatPagingUp = false;
  chatMessagesCache = {};
  closeReactPicker();
  closeChatSearch();
  clearTimeout(friendTypingTimer);
  hideTypingIndicator();

  document.getElementById('chat-friend-emoji').textContent = friend.statusEmoji;
  document.getElementById('chat-friend-name').textContent = friend.displayName;

  document.querySelectorAll('.view-container').forEach(v => v.style.display = 'none');
  const chatView = document.getElementById('chat-view');
  if (chatView) chatView.style.display = 'flex';

  // Restore saved background for this friend
  const msgs = document.getElementById('chat-messages');
  const savedBg = localStorage.getItem(`pulse-chat-bg-${friend.friendId}`);
  if (msgs) {
    if (savedBg) {
      msgs.style.backgroundImage = `url(${savedBg})`;
      msgs.style.backgroundSize = 'cover';
      msgs.style.backgroundPosition = 'center';
      msgs.style.backgroundAttachment = 'local';
    } else {
      msgs.style.backgroundImage = '';
    }
  }
  // Show the remove button only when this chat has a background set
  const bgRemoveBtn = document.getElementById('chat-bg-remove-btn');
  if (bgRemoveBtn) bgRemoveBtn.style.display = savedBg ? '' : 'none';

  await loadChatMessages(friend.friendId);
  // Deliver first, then read — gives the sender both receipts in order.
  // Best-effort: if the delivered_at column doesn't exist yet (migration not
  // run), chat must still open — never block on these.
  markMessagesAsDelivered(friend.friendId).catch(() => {});
  markMessagesAsRead(friend.friendId).catch(() => {});

  friend.unreadCount = 0;
  renderFriendsFeed();

  const container = document.getElementById('chat-messages');
  if (container) container.scrollTop = container.scrollHeight;
}

function formatChatDay(date) {
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((startToday.getTime() - startDay.getTime()) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

async function loadChatMessages(friendId, limit = chatMessageLimit, keepScroll = false) {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  // Re-render destroys any open reaction picker — drop the stale reference
  closeReactPicker();

  // Preserve scroll when paging up (loading earlier messages) or when a
  // background poll refresh must not yank the user away from what they're reading
  const wasPaging = chatPagingUp || keepScroll;
  const prevHeight = container.scrollHeight;
  const prevScrollTop = container.scrollTop;
  const myId = state.userProfile?.id;

  // Instant re-open: paint the locally cached copy before the network round-trip
  let paintedFromCache = false;
  if (!wasPaging && myId) {
    const cached = await dbGet('chats', chatKey(myId, friendId));
    if (Array.isArray(cached) && cached.length > 0) {
      chatMessagesCache = {};
      const rows = [];
      let lastDayKey = '';
      cached.forEach(msg => {
        const d = new Date(msg.created_at);
        const dayKey = d.toDateString();
        if (dayKey !== lastDayKey) {
          lastDayKey = dayKey;
          rows.push(`<div class="chat-date-sep">${escapeHtml(formatChatDay(d))}</div>`);
        }
        rows.push(buildChatRow(msg, myId));
        chatMessagesCache[msg.id] = msg;
      });
      container.innerHTML = rows.join('');
      container.scrollTop = container.scrollHeight;
      paintedFromCache = true;
    }
  }
  if (!paintedFromCache) container.innerHTML = '<div class="spinner" style="margin:auto;"></div>';

  try {
    const messages = await fetchDirectMessages(friendId, limit);

    if (messages.length === 0) {
      chatMessagesCache = {};
      container.innerHTML = '<div style="text-align:center;color:hsl(var(--text-muted));padding:40px 0;">No messages yet. Say hello! 👋</div>';
      // Nothing to keep — drop any stale cached copy of this conversation
      if (myId) dbDelete('chats', chatKey(myId, friendId));
      return;
    }

    const hasOlder = messages.length >= limit; // we filled the page — older ones exist
    const loadMoreHtml = hasOlder
      ? `<button class="chat-load-more btn btn-secondary btn-small" style="align-self:center;">↑ Load earlier</button>`
      : '';

    const rows = [];
    let lastDayKey = '';
    chatMessagesCache = {};

    messages.forEach(msg => {
      const d = new Date(msg.created_at);
      const dayKey = d.toDateString();

      if (dayKey !== lastDayKey) {
        lastDayKey = dayKey;
        rows.push(`<div class="chat-date-sep">${escapeHtml(formatChatDay(d))}</div>`);
      }

      rows.push(buildChatRow(msg, myId));
      chatMessagesCache[msg.id] = msg;
    });

    container.innerHTML = loadMoreHtml + rows.join('');

    // Load earlier — fetch more and keep the view anchored
    container.querySelector('.chat-load-more')?.addEventListener('click', async () => {
      chatMessageLimit += 50;
      chatPagingUp = true;
      await loadChatMessages(friendId, chatMessageLimit);
    });

    if (wasPaging) {
      // Keep roughly the same messages in view after prepending older ones
      container.scrollTop = container.scrollHeight - prevHeight + prevScrollTop;
      chatPagingUp = false;
    } else {
      container.scrollTop = container.scrollHeight;
    }

    // Persist the freshly loaded page so the next open paints instantly
    if (myId) dbSet('chats', chatKey(myId, friendId), messages);
  } catch (err) {
    chatPagingUp = false;
    // If we painted the cached copy, keep it — the fetch failed (e.g. offline)
    // and wiping the visible history for an error message defeats the cache.
    if (!paintedFromCache) {
      container.innerHTML = '<div style="text-align:center;color:hsl(var(--text-muted));">Failed to load messages</div>';
    }
  }
}

/* ==========================================
   CHAT ROW RENDERING — shared by load, append & patch
   ========================================== */
function renderTicksHtml(msg) {
  const fmt = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  // 3-state receipt: sent ✓ → delivered ✓✓ → read ✓✓ + time
  if (msg.read_at) {
    return `<span class="chat-tick read" title="Read at ${fmt(msg.read_at)}">✓✓</span>`
         + `<span class="chat-read-time">${fmt(msg.read_at)}</span>`;
  }
  if (msg.delivered_at) {
    return `<span class="chat-tick delivered" title="Delivered at ${fmt(msg.delivered_at)}">✓✓</span>`;
  }
  return `<span class="chat-tick" title="Sent at ${fmt(msg.created_at)}">✓</span>`;
}

function renderReactionsHtml(msg, myId) {
  const reactions = msg.reactions || {};
  const entries = Object.entries(reactions)
    .filter(([, ids]) => Array.isArray(ids) && ids.length > 0);
  if (entries.length === 0) return '';
  const pills = entries.map(([emoji, ids]) => {
    const count = ids.length;
    const mine = ids.includes(myId);
    return `<button class="chat-reaction-pill${mine ? ' mine' : ''}" data-msg-id="${escapeHtml(msg.id)}" data-emoji="${escapeHtml(emoji)}" title="${count} reaction${count > 1 ? 's' : ''}${mine ? ' · you' : ''}">${escapeHtml(emoji)} ${count}</button>`;
  }).join('');
  return `<div class="chat-reactions">${pills}</div>`;
}

function buildChatRow(msg, myId) {
  const isSent = msg.sender_id === myId;
  const friendEmoji = currentChatFriend?.statusEmoji || '😊';
  const d = new Date(msg.created_at);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const isVideo = msg.image_url && isVideoUrl(msg.image_url, null);
  const mediaHtml = msg.image_url
    ? isVideo
      ? `<video src="${escapeHtml(msg.image_url)}" style="max-width:100%;border-radius:12px;margin-top:6px;display:block;" controls playsinline preload="metadata"></video>`
      : `<img src="${escapeHtml(msg.image_url)}" alt="Shared image" loading="lazy" onclick="openFullImage('${escapeHtml(msg.image_url)}')" style="max-width:100%;border-radius:12px;margin-top:6px;display:block;cursor:zoom-in;">`
    : '';

  const replyHtml = msg.reply
    ? `<div class="chat-reply-preview">
         <span class="chat-reply-bar-line"></span>
         <span class="chat-reply-text">${escapeHtml(msg.reply?.content_text || (msg.reply?.image_url ? '📎 Media' : ''))}</span>
       </div>`
    : '';

  const ticks = isSent ? `<span class="chat-tick-area">${renderTicksHtml(msg)}</span>` : '';
  const reactionsHtml = renderReactionsHtml(msg, myId);
  const avatarHtml = isSent ? '' : `<span class="chat-avatar">${escapeHtml(friendEmoji)}</span>`;

  return `
    <div class="chat-row ${isSent ? 'sent' : 'received'}">
      ${avatarHtml}
      <div class="chat-col">
        <div class="chat-bubble ${isSent ? 'sent' : 'received'}" data-msg-id="${escapeHtml(msg.id)}"
          data-content="${escapeHtml(msg.content_text || '')}"
          data-image="${escapeHtml(msg.image_url || '')}"
          data-sender="${escapeHtml(msg.sender_id)}">
          ${replyHtml}
          ${msg.content_text ? `<div>${escapeHtml(msg.content_text)}</div>` : ''}
          ${mediaHtml}
          <div class="chat-meta">
            <span class="chat-bubble-time">${time}</span>
            ${ticks}
          </div>
        </div>
        ${reactionsHtml}
      </div>
    </div>
  `;
}

/* ==========================================
   IN-PLACE REALTIME UPDATES — no full chat reload
   ========================================== */
function patchMessageBubble(msg) {
  const container = document.getElementById('chat-messages');
  if (!container || !currentChatFriend) return;

  // Only patch messages in the open conversation
  const isMine = msg.sender_id === state.userProfile?.id;
  const otherId = isMine ? msg.recipient_id : msg.sender_id;
  if (otherId !== currentChatFriend.friendId) return;

  // Skip no-op echoes — my own batch read/delivered marking comes back as
  // one message_updated per row with unchanged reactions, which would churn
  // the whole list on every chat open. Only re-render when something visible
  // actually changed (reactions, or a receipt field we display).
  const cached = chatMessagesCache[msg.id];
  if (cached) {
    const reactionsSame = JSON.stringify(cached.reactions || {}) === JSON.stringify(msg.reactions || {});
    const receiptsSame = cached.read_at === msg.read_at && cached.delivered_at === msg.delivered_at;
    if (reactionsSame && receiptsSame) return;
  }

  const bubble = container.querySelector(`[data-msg-id="${CSS.escape(msg.id)}"]`);
  if (!bubble) return;

  // Keep the cache in sync for future appends/patches
  chatMessagesCache[msg.id] = { ...(chatMessagesCache[msg.id] || {}), ...msg };
  persistCurrentChat();

  // 1) Receipt ticks — only for our own sent messages
  if (isMine) {
    const tickArea = bubble.querySelector('.chat-tick-area');
    if (tickArea) tickArea.innerHTML = renderTicksHtml(msg);
  }

  // 2) Reactions — both sides can react
  patchReactionsOnly(msg.id, msg.reactions || {});
}

function patchReactionsOnly(msgId, reactions) {
  const container = document.getElementById('chat-messages');
  const bubble = container?.querySelector(`[data-msg-id="${CSS.escape(msgId)}"]`);
  if (!bubble) return;
  // Reactions live in the row's .chat-col (sibling of the bubble) since the
  // chat-col restructure — target that, falling back to the bubble for safety.
  const host = bubble.closest('.chat-col') || bubble;
  const html = renderReactionsHtml({ id: msgId, reactions }, state.userProfile?.id);
  const old = host.querySelector('.chat-reactions');
  if (old) {
    old.outerHTML = html;
  } else if (html) {
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    host.appendChild(wrap.firstChild);
  }
}

// Debounced write of the open conversation's messages to IndexedDB, so sends,
// receipts and reactions survive a refresh. chatMessagesCache only holds the
// open chat, so its values ARE this conversation.
let _chatPersistTimer = null;
function persistCurrentChat() {
  const myId = state.userProfile?.id;
  if (!myId || !currentChatFriend) return;
  clearTimeout(_chatPersistTimer);
  _chatPersistTimer = setTimeout(() => {
    const msgs = Object.values(chatMessagesCache)
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    if (msgs.length) dbSet('chats', chatKey(myId, currentChatFriend.friendId), msgs);
  }, 500);
}

// Append a freshly-inserted message bubble without re-rendering the whole chat.
// Returns true if the bubble was appended, false if it bailed (missing
// container/context, or already in the cache) — callers use that to decide
// whether to fall back to a full fetch.
function appendChatMessage(msg) {
  const container = document.getElementById('chat-messages');
  if (!container || !currentChatFriend) return false;
  if (!msg?.id) return false;

  // Dedup — the widened realtime INSERT filter now echoes my own sends back,
  // so guard against double-appending a message already in the DOM/cache.
  if (chatMessagesCache[msg.id]) return;

  const myId = state.userProfile?.id;
  if (!myId) return;

  // If the container is showing the empty state, clear it first
  if (!container.querySelector('.chat-row') && container.textContent.includes('No messages yet')) {
    container.innerHTML = '';
  }

  // Day separator if the new message lands on a different day than the last one
  const rows = container.querySelectorAll('.chat-row');
  const lastRow = rows[rows.length - 1];
  const lastMsgId = lastRow?.querySelector('.chat-bubble')?.dataset.msgId;
  const lastMsg = lastMsgId ? chatMessagesCache[lastMsgId] : null;
  if (lastMsg) {
    const lastDay = new Date(lastMsg.created_at).toDateString();
    const msgDay = new Date(msg.created_at).toDateString();
    if (msgDay !== lastDay) {
      const sep = document.createElement('div');
      sep.className = 'chat-date-sep';
      sep.textContent = formatChatDay(new Date(msg.created_at));
      container.appendChild(sep);
    }
  }

  const wrap = document.createElement('div');
  wrap.innerHTML = buildChatRow(msg, myId);
  container.appendChild(wrap.firstChild);
  chatMessagesCache[msg.id] = msg;
  persistCurrentChat();

  // Scroll to bottom only if the user was already at/near the bottom
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 120;
  if (nearBottom) container.scrollTop = container.scrollHeight;
  return true;
}

/* ==========================================
   REACTIONS — toggle + quick picker
   ========================================== */
async function toggleReaction(msgId, emoji) {
  const cached = chatMessagesCache[msgId];
  if (!cached) return;
  const myId = state.userProfile?.id;
  if (!myId) return;
  const original = cached.reactions || {};

  // Optimistic flip so the pill responds instantly
  const reactions = { ...original };
  const list = Array.isArray(reactions[emoji]) ? [...reactions[emoji]] : [];
  const idx = list.indexOf(myId);
  if (idx >= 0) list.splice(idx, 1);
  else list.push(myId);
  if (list.length) reactions[emoji] = list;
  else delete reactions[emoji];
  cached.reactions = reactions;
  chatMessagesCache[msgId] = cached;
  patchReactionsOnly(msgId, reactions);

  const result = await toggleMessageReaction(msgId, emoji);
  if (result) {
    // Server is source of truth — reconcile (multi-device / dedup)
    const updated = chatMessagesCache[msgId] || cached;
    updated.reactions = result;
    chatMessagesCache[msgId] = updated;
    patchReactionsOnly(msgId, result);
  } else {
    // RPC failed (e.g. SQL not deployed yet) — revert the optimistic flip
    cached.reactions = original;
    chatMessagesCache[msgId] = cached;
    patchReactionsOnly(msgId, original);
    showToast('Reactions need the new SQL — run the migration.', 'error');
  }
  persistCurrentChat();
}

function toggleReactPicker(msgId, btn) {
  if (openReactPicker?.dataset.msgId === msgId) {
    closeReactPicker();
    return;
  }
  closeReactPicker();
  const bubble = btn.closest('.chat-bubble');
  if (!bubble) return;
  const picker = document.createElement('div');
  picker.className = 'chat-react-picker';
  picker.dataset.msgId = msgId;
  picker.innerHTML = REACTION_EMOJIS.map(e => `<button type="button" data-emoji="${e}">${e}</button>`).join('');
  bubble.appendChild(picker);
  openReactPicker = picker;
  // Pickers open BELOW the bubble — keep them fully in view.
  picker.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function closeReactPicker() {
  if (openReactPicker) {
    openReactPicker.remove();
    openReactPicker = null;
  }
  if (openActionSheet) {
    openActionSheet.remove();
    openActionSheet = null;
  }
}

/* ==========================================
   CHAT ACTION SHEET — tap a bubble → Reply / Copy / Delete
   ========================================== */
function showChatActionSheet(msgId, bubble) {
  if (openActionSheet?.dataset.msgId === msgId) {
    closeReactPicker();
    return;
  }
  closeReactPicker();

  const isSent = bubble.classList.contains('sent');
  const hasText = !!bubble.dataset.content;
  const hasImage = !!bubble.dataset.image;

  const sheet = document.createElement('div');
  sheet.className = 'chat-action-sheet';
  sheet.dataset.msgId = msgId;
  sheet.innerHTML = `
    <button type="button" class="chat-action-btn" data-action="reply" data-msg-id="${escapeHtml(msgId)}">
      <svg class="icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg> Reply
    </button>
    ${hasText || hasImage ? `<button type="button" class="chat-action-btn" data-action="copy" data-msg-id="${escapeHtml(msgId)}">
      <svg class="icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy</button>` : ''}
    ${isSent ? `<button type="button" class="chat-action-btn danger" data-action="delete" data-msg-id="${escapeHtml(msgId)}">
      <svg class="icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> Delete</button>` : ''}
  `;
  bubble.appendChild(sheet);
  openActionSheet = sheet;
  // Popovers open BELOW the bubble — make sure they're never clipped at the
  // bottom of the scrollable chat area.
  sheet.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function closeChatActionSheet() {
  if (openActionSheet) {
    openActionSheet.remove();
    openActionSheet = null;
  }
}

function copyMessageText(msgId) {
  const bubble = document.querySelector(`#chat-messages .chat-bubble[data-msg-id="${CSS.escape(msgId)}"]`);
  if (!bubble) return;
  const text = bubble.dataset.content || (bubble.dataset.image ? bubble.dataset.image : '');
  if (!text) return;
  navigator.clipboard?.writeText(text)
    .then(() => showToast('Copied to clipboard! 📋'))
    .catch(() => {});
}

function clearChatLongPress() {
  if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  longPressTarget = null;
}

/* ==========================================
   CHAT SEARCH — full-history search inside a conversation
   ========================================== */
function openChatSearch() {
  chatSearchMode = true;
  closeReactPicker();
  const bar = document.getElementById('chat-search-bar');
  const input = document.getElementById('chat-search-input');
  const results = document.getElementById('chat-search-results');
  const msgs = document.getElementById('chat-messages');
  if (bar) bar.style.display = 'flex';
  if (msgs) msgs.style.display = 'none';
  if (results) {
    results.style.display = 'flex';
    results.innerHTML = '<div class="chat-search-empty">Type to search this chat…</div>';
  }
  if (input) { input.value = ''; setTimeout(() => input.focus(), 50); }
}

function closeChatSearch() {
  chatSearchMode = false;
  const bar = document.getElementById('chat-search-bar');
  const input = document.getElementById('chat-search-input');
  const results = document.getElementById('chat-search-results');
  const msgs = document.getElementById('chat-messages');
  if (bar) bar.style.display = 'none';
  if (results) { results.style.display = 'none'; results.innerHTML = ''; }
  if (msgs) msgs.style.display = 'flex';
  if (input) input.value = '';
}

async function runChatSearch() {
  if (!currentChatFriend) return;
  const input = document.getElementById('chat-search-input');
  const q = input?.value.trim();
  const results = document.getElementById('chat-search-results');
  if (!results) return;
  if (!q) {
    results.innerHTML = '<div class="chat-search-empty">Type to search this chat…</div>';
    return;
  }
  results.innerHTML = '<div class="spinner" style="margin:auto;"></div>';
  try {
    const found = await searchDirectMessages(currentChatFriend.friendId, q);
    renderChatSearchResults(found, q);
  } catch (err) {
    console.warn('[Pulse] Chat search failed:', err.message);
    results.innerHTML = '<div class="chat-search-empty">Search failed — try again.</div>';
  }
}

function renderChatSearchResults(results, query) {
  const container = document.getElementById('chat-search-results');
  if (!container) return;
  const myId = state.userProfile?.id;
  if (results.length === 0) {
    container.innerHTML = `<div class="chat-search-empty">No matches for “${escapeHtml(query)}”.</div>`;
    return;
  }
  container.innerHTML = `<div class="chat-search-count">${results.length} result${results.length > 1 ? 's' : ''} for “${escapeHtml(query)}”</div>` +
    results.map(r => {
      const isMine = r.sender_id === myId;
      const time = new Date(r.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const text = r.content_text || (r.image_url ? (isVideoUrl(r.image_url, null) ? '🎬 Video' : '🖼️ Photo') : '');
      return `<button class="chat-search-result" data-msg-id="${escapeHtml(r.id)}">
        <span class="chat-search-result-emoji">${isMine ? '🙂' : escapeHtml(currentChatFriend?.statusEmoji || '😊')}</span>
        <span class="chat-search-result-body">
          <span class="chat-search-result-meta">${isMine ? 'You' : escapeHtml(currentChatFriend?.displayName || 'Friend')} · ${time}</span>
          <span class="chat-search-result-text">${escapeHtml(text.length > 90 ? text.slice(0, 90) + '…' : text)}</span>
        </span>
      </button>`;
    }).join('');
}

// Scroll to an already-loaded message and flash it
function jumpToMessage(msgId) {
  closeChatSearch();
  const bubble = document.querySelector(`.chat-bubble[data-msg-id="${CSS.escape(msgId)}"]`);
  if (!bubble) {
    showToast('Message is outside the loaded window — load earlier messages.', 'error');
    return;
  }
  const row = bubble.closest('.chat-row');
  if (row) {
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('chat-jump-flash');
    setTimeout(() => row.classList.remove('chat-jump-flash'), 2000);
  }
}

/* ==========================================
   DELETE MESSAGE — sender-only, confirm + in-place removal
   ========================================== */
function removeChatMessageRow(msgId) {
  if (!msgId) return;
  delete chatMessagesCache[msgId];
  persistCurrentChat();
  // Remove the bubble row in the open chat
  const bubble = document.querySelector(`.chat-bubble[data-msg-id="${CSS.escape(msgId)}"]`);
  if (bubble) {
    const row = bubble.closest('.chat-row');
    if (row) row.remove();
  }
  // Also drop any stale entry in the open search-results view
  document.querySelectorAll(`.chat-search-result[data-msg-id="${CSS.escape(msgId)}"]`).forEach(el => el.remove());
  // If the deleted message was being replied to, clear the reply bar
  if (currentReplyTo?.id === msgId) clearReply();
}

async function confirmDeleteMessage(msgId) {
  if (!msgId) return;
  const confirmed = await showConfirmModal({
    icon: '🗑️',
    title: 'Delete message?',
    body: 'This deletes the message for both of you. It cannot be undone.',
    okLabel: 'Delete'
  });
  if (!confirmed) return;
  try {
    await deleteDirectMessage(msgId);
    removeChatMessageRow(msgId);
    showToast('Message deleted');
  } catch (err) {
    console.warn('[Pulse] Delete failed:', err.message);
    showToast('Could not delete message.', 'error');
  }
}

function setReply(msg) {
  currentReplyTo = msg;
  const bar = document.getElementById('chat-reply-bar');
  const text = document.getElementById('chat-reply-bar-text');
  if (!bar || !text) return;
  const preview = msg.content_text || (msg.image_url ? '📎 Media' : '');
  text.textContent = `↩ ${preview.slice(0, 60)}${preview.length > 60 ? '…' : ''}`;
  bar.style.display = 'flex';
  document.getElementById('chat-input')?.focus();
}

function clearReply() {
  currentReplyTo = null;
  const bar = document.getElementById('chat-reply-bar');
  if (bar) bar.style.display = 'none';
}

async function sendChatMessage() {
  const input   = document.getElementById('chat-input');
  const text    = input?.value.trim() || '';
  const sendBtn = document.getElementById('chat-send-btn');

  if (!text && !currentChatImage) return;
  if (!currentChatFriend) return;

  sendBtn.disabled = true;
  const replyToId = currentReplyTo?.id || null;

  try {
    let imageUrl = null;
    if (currentChatImage) {
      if (currentChatImage._cloudinaryUrl) {
        imageUrl = currentChatImage._cloudinaryUrl;
      } else {
        showToast('Uploading...');
        imageUrl = await uploadStatusImage(currentChatImage);
      }
    }

    // Capture the reply preview BEFORE clearReply() nulls currentReplyTo
    const replyTo = currentReplyTo
      ? { id: currentReplyTo.id, content_text: currentReplyTo.content_text, image_url: currentReplyTo.image_url, sender_id: currentReplyTo.sender_id }
      : null;

    const sentMsg = await sendDirectMessage(currentChatFriend.friendId, text, imageUrl, replyToId);
    if (input) input.value = '';
    removeChatImage();
    clearReply();
    // Stop broadcasting typing once the message is sent
    setTypingStatus(currentChatFriend.friendId, false);
    chatTypingSentAt = 0;
    // Push a lock-screen notification to the friend (in-app is handled by realtime)
    notifyFriendOfMessage(
      currentChatFriend.friendId,
      state.userProfile?.name || 'A friend',
      state.userProfile?.status_emoji || '💬',
      text || '',
      imageUrl
    );
    // Real-time: append my sent message in place (no full chat reload). Always
    // append optimistically — the realtime INSERT echo of my own send (same
    // real id) is deduped by appendChatMessage's cache guard, so it can't
    // double-append. No channel-state gate: supabase-js v2 reports 'subscribed',
    // not 'joined', and the old gate made sent messages invisible until refresh.
    // If the append bailed (missing container, stale context), fall back to a
    // fresh fetch so the sent message still renders.
    if (!appendChatMessage({ ...sentMsg, reply: replyTo })) {
      await loadChatMessages(currentChatFriend.friendId);
    }
  } catch (err) {
    showToast(err.message || 'Failed to send', 'error');
  } finally {
    sendBtn.disabled = false;
  }
}

function removeChatImage() {
  currentChatImage = null;
  const preview = document.getElementById('chat-image-preview');
  const img = document.getElementById('chat-preview-img');
  if (preview) preview.style.display = 'none';
  if (img) img.src = '';
  const fileInput = document.getElementById('chat-file-input');
  const camInput = document.getElementById('chat-camera-input');
  if (fileInput) fileInput.value = '';
  if (camInput) camInput.value = '';
}

async function handleChatImage(file, fromFrontCamera = false) {
  if (!file) return;
  try {
    showToast('Processing...');
    const compressed = await compressImage(file, 1200, 0.8, fromFrontCamera);
    currentChatImage = compressed;
    const preview = document.getElementById('chat-image-preview');
    const img = document.getElementById('chat-preview-img');
    if (img) img.src = URL.createObjectURL(compressed);
    if (preview) preview.style.display = 'block';
  } catch (err) {
    showToast('Failed to process image', 'error');
  }
}

/* ==========================================
   STATUS + CHAT MEDIA HANDLERS
   ========================================== */
async function handleStatusMedia(file, fromFrontCamera = false) {
  if (!file) return;
  if (file.type.startsWith('video/')) {
    await handleStatusVideo(file);
  } else {
    await handleStatusImage(file, fromFrontCamera);
  }
}

async function handleStatusVideo(file) {
  if (!file) return;
  const progressEl = _showVideoProgress();
  try {
    // Lazy-load FFmpeg only when a video is actually compressed
    const { compressVideoFFmpeg } = await import('./videoCompress.js');
    const compressed = await compressVideoFFmpeg(file, (pct) => {
      _updateVideoProgress(progressEl, pct);
    });
    _hideVideoProgress(progressEl);

    // If Cloudinary returned a URL, use it directly
    if (compressed._cloudinaryUrl) {
      currentStatusImage = compressed;
      currentStatusImage._cloudinaryUrl = compressed._cloudinaryUrl;
      isStatusImageRemoved = false;

      const preview = document.getElementById('status-image-preview');
      if (preview) {
        preview.innerHTML = `
          <video src="${compressed._cloudinaryUrl}"
            controls playsinline muted
            style="width:100%;border-radius:12px;max-height:200px;display:block;"></video>
          <button id="status-remove-image" class="status-remove-img" type="button" title="Remove">✕</button>
        `;
        preview.style.display = 'block';
        preview.querySelector('#status-remove-image')?.addEventListener('click', removeStatusImage);
      }
      updateStatusLivePreview();
      showToast('Video ready ✅');
    } else {
      // Fallback: normal image-style processing
      currentStatusImage = compressed;
      isStatusImageRemoved = false;
      const preview = document.getElementById('status-image-preview');
      const img = document.getElementById('status-preview-img');
      if (img) img.src = URL.createObjectURL(compressed);
      if (preview) preview.style.display = 'block';
      updateStatusLivePreview();
      const sizeLabel = _sizeLabel(compressed.size);
      showToast(`Video ready (${sizeLabel}) ✅`);
    }
  } catch (err) {
    _hideVideoProgress(progressEl);
    showToast(err.message || 'Video upload failed.', 'error');
  }
}

async function handleChatVideo(file) {
  if (!file) return;
  const progressEl = _showVideoProgress();
  try {
    // Lazy-load FFmpeg only when a video is actually compressed
    const { compressVideoFFmpeg } = await import('./videoCompress.js');
    const compressed = await compressVideoFFmpeg(file, (pct) => {
      _updateVideoProgress(progressEl, pct);
    });
    _hideVideoProgress(progressEl);

    const videoUrl = compressed._cloudinaryUrl || URL.createObjectURL(compressed);
    currentChatImage = compressed;

    const preview = document.getElementById('chat-image-preview');
    if (preview) {
      preview.innerHTML = `
        <video src="${videoUrl}"
          style="height:80px;border-radius:10px;border:1px solid var(--border-glow);"
          playsinline muted autoplay loop></video>
        <button id="chat-remove-image" class="chat-remove-img">×</button>
      `;
      preview.style.display = 'block';
      preview.querySelector('#chat-remove-image')?.addEventListener('click', removeChatImage);
    }
    showToast('Video ready ✅');
  } catch (err) {
    _hideVideoProgress(progressEl);
    showToast(err.message || 'Video upload failed.', 'error');
  }
}

function _sizeLabel(bytes) {
  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(0)}KB`
    : `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function _showVideoProgress() {
  const el = document.createElement('div');
  el.id = 'video-progress-overlay';
  el.innerHTML = `
    <div class="video-progress-box">
      <div style="font-size:24px;margin-bottom:10px;">🎬</div>
      <div id="vp-label" style="font-size:14px;font-weight:600;margin-bottom:12px;">Loading…</div>
      <div class="video-progress-bar-track">
        <div class="video-progress-bar-fill" id="vp-fill" style="width:0%"></div>
      </div>
      <div id="vp-pct" style="font-size:12px;color:hsl(var(--text-muted));margin-top:8px;">0%</div>
    </div>
  `;
  document.body.appendChild(el);
  return el;
}

function _updateVideoProgress(el, pct) {
  if (!el) return;
  const fill  = el.querySelector('#vp-fill');
  const label = el.querySelector('#vp-label');
  const pctEl = el.querySelector('#vp-pct');
  if (fill)  fill.style.width = `${pct}%`;
  if (pctEl) pctEl.textContent = `${pct}%`;
  // Keep the copy calm and user-friendly — never expose internal terms like
  // "compressing". Just show progress.
  if (label) label.textContent = 'Loading…';
}

function _hideVideoProgress(el) {
  el?.remove();
}

async function handleStatusImage(file, fromFrontCamera = false) {
  if (!file) return;

  // If an emoji (non-default) is already selected, ask user to remove it first
  // We only block if the emoji was intentionally picked (not the default)
  const emojiPreview = document.getElementById('emoji-preview');
  const currentEmoji = emojiPreview?.textContent?.trim();
  const isDefaultEmoji = !currentEmoji || currentEmoji === '😊';

  if (!isDefaultEmoji) {
    const confirmed = await showConfirmModal({
      icon: '🖼️',
      title: 'Replace emoji with photo?',
      body: 'You have an emoji selected. Using a photo will replace it as your status visual.',
      okLabel: 'Use Photo',
      okDanger: false
    });
    if (!confirmed) return;
    // Reset emoji to default
    selectEmoji('😊');
  }

  try {
    showToast('Processing image...');
    const compressed = await compressImage(file, 1200, 0.8, fromFrontCamera);
    currentStatusImage = compressed;
    isStatusImageRemoved = false;
    const preview = document.getElementById('status-image-preview');
    const img = document.getElementById('status-preview-img');
    if (img) img.src = URL.createObjectURL(compressed);
    if (preview) preview.style.display = 'block';
    // Disable emoji grid visually when photo is active
    _setEmojiPickerDisabled(true);
    updateStatusLivePreview();
  } catch (err) {
    showToast('Failed to process image', 'error');
  }
}

function removeStatusImage() {
  currentStatusImage = null;
  currentStatusImageUrl = null;
  isStatusImageRemoved = true;
  const preview = document.getElementById('status-image-preview');
  const img = document.getElementById('status-preview-img');
  if (preview) preview.style.display = 'none';
  if (img) img.src = '';
  const fileInput = document.getElementById('status-file-input');
  const camInput = document.getElementById('status-camera-input');
  if (fileInput) fileInput.value = '';
  if (camInput) camInput.value = '';
  // Re-enable emoji picker
  _setEmojiPickerDisabled(false);
  updateStatusLivePreview();
}

function _setEmojiPickerDisabled(disabled) {
  const grid = document.getElementById('emoji-grid');
  const tabs = document.getElementById('emoji-category-tabs');
  const customInput = document.getElementById('emoji-custom-input');
  const overlay = document.getElementById('emoji-picker-overlay');

  if (disabled) {
    if (grid) grid.style.opacity = '0.3';
    if (grid) grid.style.pointerEvents = 'none';
    if (tabs) tabs.style.opacity = '0.3';
    if (tabs) tabs.style.pointerEvents = 'none';
    if (customInput) customInput.disabled = true;
    if (overlay) overlay.style.display = 'flex';
  } else {
    if (grid) grid.style.opacity = '';
    if (grid) grid.style.pointerEvents = '';
    if (tabs) tabs.style.opacity = '';
    if (tabs) tabs.style.pointerEvents = '';
    if (customInput) customInput.disabled = false;
    if (overlay) overlay.style.display = 'none';
  }
}

/* Live preview card — mirrors what friends will see as you compose */
function updateStatusLivePreview() {
  const nameEl = document.getElementById('status-live-name');
  const textEl = document.getElementById('status-live-text');
  const emojiEl = document.getElementById('status-live-emoji');
  const avatarImg = document.getElementById('status-live-image');
  if (!nameEl || !textEl) return;

  const name = document.getElementById('status-name-input')?.value?.trim() || state.userProfile?.name || 'My Status';
  const text = document.getElementById('status-text-input')?.value?.trim();
  const emoji = document.getElementById('emoji-preview')?.textContent?.trim() || state.selectedEmoji || '😊';

  nameEl.textContent = name;
  textEl.textContent = text ? `"${text}"` : '"What\'s happening?"';
  if (emojiEl) emojiEl.textContent = emoji;

  // If a photo/video is attached, swap the avatar to show it
  const preview = document.getElementById('status-image-preview');
  let mediaSrc = '';
  if (preview && preview.style.display !== 'none') {
    const img = preview.querySelector('img');
    const vid = preview.querySelector('video');
    mediaSrc = (img && img.src) || (vid && (vid.src || vid.currentSrc)) || '';
  }
  if (avatarImg && mediaSrc) {
    avatarImg.src = mediaSrc;
    avatarImg.style.display = 'block';
    if (emojiEl) emojiEl.style.display = 'none';
  } else if (avatarImg) {
    avatarImg.style.display = 'none';
    if (emojiEl) emojiEl.style.display = '';
  }
}

/* ==========================================
   CUSTOM MODALS
   ========================================== */
function showConfirmModal({ icon = '⚠️', title, body, okLabel = 'Confirm', okDanger = true }) {
  return new Promise((resolve) => {
    const modal = document.getElementById('custom-confirm-modal');
    document.getElementById('confirm-modal-icon').textContent = icon;
    document.getElementById('confirm-modal-title').textContent = title;
    document.getElementById('confirm-modal-body').textContent = body;
    const okBtn = document.getElementById('confirm-modal-ok');
    const cancelBtn = document.getElementById('confirm-modal-cancel');
    okBtn.textContent = okLabel;
    okBtn.className = `btn ${okDanger ? 'btn-danger-solid' : 'btn-primary'}`;

    modal.style.display = 'flex';

    const cleanup = (result) => {
      modal.style.display = 'none';
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    };

    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);

    okBtn.addEventListener('click', onOk, { once: true });
    cancelBtn.addEventListener('click', onCancel, { once: true });
  });
}

function showNicknameModal({ realName, currentNickname = '' }) {
  return new Promise((resolve) => {
    const modal = document.getElementById('nickname-modal');
    document.getElementById('nickname-modal-body').textContent =
      `Give "${realName}" a nickname only you can see. Leave empty to use their real name.`;
    const input = document.getElementById('nickname-modal-input');
    input.value = currentNickname;

    modal.style.display = 'flex';
    setTimeout(() => input.focus(), 100);

    const cleanup = (result) => {
      modal.style.display = 'none';
      resolve(result);
    };

    const saveBtn = document.getElementById('nickname-modal-save');
    const cancelBtn = document.getElementById('nickname-modal-cancel');

    const onSave = () => {
      saveBtn.removeEventListener('click', onSave);
      cancelBtn.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
      cleanup(input.value);
    };
    const onCancel = () => {
      saveBtn.removeEventListener('click', onSave);
      cancelBtn.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
      cleanup(null);
    };
    const onKey = (e) => {
      if (e.key === 'Enter') onSave();
      if (e.key === 'Escape') onCancel();
    };

    saveBtn.addEventListener('click', onSave);
    cancelBtn.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
  });
}

/* ==========================================
   iOS POLLING FALLBACK
   ========================================== */
let _visibilityListenerAdded = false;

function startPollingFallback() {
  if (state.pollInterval) clearInterval(state.pollInterval);

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  state.pollInterval = setInterval(async () => {
    const channelStatus = state.realtimeChannel?.state;
    if (channelStatus !== 'joined') {
      invalidateCache(); // fallback poll must always fetch fresh data
      await loadDashboardData();
      // Realtime is down — keep the open chat live too (incoming messages +
      // the ✓/✓✓/read receipt ticks) without resetting the user's scroll.
      if (currentChatFriend) {
        loadChatMessages(currentChatFriend.friendId, chatMessageLimit, true).catch(() => {});
      }
    }
  }, isIOS ? 20000 : 45000);

  if (!_visibilityListenerAdded) {
    _visibilityListenerAdded = true;
    let _lastVisibleCheck = 0;
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible' && state.userProfile) {
        const now = Date.now();
        if (!_lastVisibleCheck || now - _lastVisibleCheck > 30000) {
          invalidateCache();
          await loadDashboardData();
        }
        _lastVisibleCheck = now;
      } else {
        _lastVisibleCheck = Date.now();
      }
    });
  }
}

/* ==========================================
   SECURITY HELPER
   ========================================== */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function isVideoUrl(url, mediaType) {
  if (!url) return false;
  if (mediaType === 'video') return true;
  // Check URL for video extensions (Supabase URLs contain the original filename)
  const lower = url.toLowerCase().split('?')[0]; // strip query params
  return lower.endsWith('.mp4') || lower.endsWith('.webm') ||
         lower.endsWith('.mov') || lower.endsWith('.ogg') ||
         lower.includes('.mp4') || lower.includes('.webm');
}


/* ==========================================
   LIVE LOCATION SHARING
   ========================================== */

async function resumeLocationSharing() {
  try {
    const activeShares = await fetchMyActiveShares();
    if (!activeShares || activeShares.length === 0) return;
    state.sharingLocationWith = activeShares;
    updateLocationIndicator();
    showToast('📍 Resuming location sharing.');
    navigator.geolocation?.getCurrentPosition(async (p) => {
      await _sendPosition(p.coords.latitude, p.coords.longitude, true);
    }, () => {}, { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 });
    _startLocationInterval();
  } catch (e) {
    // Table doesn't exist yet or network error — ignore silently
  }
}

// Track last sent position to avoid sending if barely moved
let _lastSentLat = null;
let _lastSentLng = null;

function _haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000; // metres
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

async function _sendPosition(latitude, longitude, force = false) {
  if (!force && _lastSentLat !== null) {
    const dist = _haversineDistance(_lastSentLat, _lastSentLng, latitude, longitude);
    if (dist < 15) return; // less than 15m change — don't bother sending
  }
  _lastSentLat = latitude;
  _lastSentLng = longitude;
  await updateLocationShare(latitude, longitude);
}

async function startSharingLocation(friendIds) {
  if (!navigator.geolocation) {
    showToast('Location not supported on this device.', 'error');
    return;
  }

  return new Promise((resolve) => {
    // Try high accuracy first, fall back to network/IP if it times out
    const opts = { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 };

    navigator.geolocation.getCurrentPosition(async (pos) => {
      const { latitude, longitude } = pos.coords;
      try {
        await startLocationShare(friendIds, latitude, longitude);
        _lastSentLat = latitude;
        _lastSentLng = longitude;
        state.sharingLocationWith = [...new Set([...state.sharingLocationWith, ...friendIds])];
        showToast('📍 Location shared!');
        updateLocationIndicator();
        _startLocationInterval();
        resolve();
      } catch (err) {
        showToast(err.message || 'Failed to share location.', 'error');
        resolve();
      }
    }, (err) => {
      // Fall back to low accuracy if high accuracy timed out
      navigator.geolocation.getCurrentPosition(async (pos) => {
        const { latitude, longitude } = pos.coords;
        try {
          await startLocationShare(friendIds, latitude, longitude);
          _lastSentLat = latitude;
          _lastSentLng = longitude;
          state.sharingLocationWith = [...new Set([...state.sharingLocationWith, ...friendIds])];
          showToast('📍 Location shared (approximate).');
          updateLocationIndicator();
          _startLocationInterval();
        } catch (e) {
          showToast(e.message || 'Failed to share location.', 'error');
        }
        resolve();
      }, () => {
        showToast('Could not get your location. Check permissions.', 'error');
        resolve();
      }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 30000 });
    }, opts);
  });
}

function _startLocationInterval() {
  if (state.locationInterval) clearInterval(state.locationInterval);
  state.locationInterval = setInterval(() => {
    if (state.sharingLocationWith.length === 0) {
      clearInterval(state.locationInterval);
      state.locationInterval = null;
      return;
    }
    navigator.geolocation?.getCurrentPosition(async (p) => {
      await _sendPosition(p.coords.latitude, p.coords.longitude);
    }, () => {}, { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 });
  }, 30000); // every 30 seconds — accurate but low bandwidth
}

async function stopSharingLocation(friendIds = null) {
  await stopLocationShare(friendIds);
  if (friendIds) {
    state.sharingLocationWith = state.sharingLocationWith.filter(id => !friendIds.includes(id));
  } else {
    state.sharingLocationWith = [];
  }
  if (state.sharingLocationWith.length === 0) {
    clearInterval(state.locationInterval);
    state.locationInterval = null;
  }
  updateLocationIndicator();
  showToast('📍 Location sharing stopped.');
}

function updateLocationIndicator() {
  // Show green glow on the 📍 button when sharing is active — no text bar
  const btn = document.getElementById('btn-location');
  if (!btn) return;
  if (state.sharingLocationWith.length > 0) {
    btn.style.background = 'rgba(34, 197, 94, 0.2)';
    btn.style.borderColor = 'rgba(34, 197, 94, 0.5)';
    btn.style.color = '#4ade80';
    btn.title = `📍 Sharing with ${state.sharingLocationWith.length} friend(s) — tap to manage`;
  } else {
    btn.style.background = '';
    btn.style.borderColor = '';
    btn.style.color = '';
    btn.title = 'Share live location';
  }
}

function openLocationModal() {
  const connected = state.connections.filter(c => c.status === 'connected');
  if (connected.length === 0) {
    showToast('Connect with friends first to share your location.', 'error');
    return;
  }

  const modal = document.getElementById('location-modal');
  const list = document.getElementById('location-friend-list');
  if (!modal || !list) return;

  list.innerHTML = connected.map(friend => `
    <label class="location-friend-option">
      <input type="checkbox" class="location-friend-check" value="${escapeHtml(friend.friendId)}"
        ${state.sharingLocationWith.includes(friend.friendId) ? 'checked' : ''}>
      <span class="location-friend-avatar">${friend.statusEmoji || '😊'}</span>
      <span class="location-friend-name">${escapeHtml(friend.nickname?.trim() || friend.name)}</span>
      ${state.sharingLocationWith.includes(friend.friendId)
        ? '<span class="loc-active-badge">📍 Active</span>' : ''}
    </label>
  `).join('');

  modal.style.display = 'flex';
}

function renderFriendLocations() {
  // Show a location pin on friend cards when they're sharing with us
  state.connections.filter(c => c.status === 'connected').forEach(friend => {
    const loc = state.friendLocations[friend.friendId];
    const card = document.querySelector(`[data-friend-id="${friend.friendId}"]`);
    if (!card) return;

    let locEl = card.querySelector('.friend-location-pin');
    if (loc) {
      if (!locEl) {
        locEl = document.createElement('a');
        locEl.className = 'friend-location-pin';
        locEl.target = '_blank';
        locEl.rel = 'noopener noreferrer';
        card.querySelector('.status-details')?.appendChild(locEl);
      }
      locEl.href = `https://www.google.com/maps?q=${loc.latitude},${loc.longitude}`;
      locEl.innerHTML = `📍 <span>Live location · ${formatTimeAgo(loc.updatedAt)}</span>`;
    } else if (locEl) {
      locEl.remove();
    }
  });
}
function openFullImage(url) {
  openFullMedia(url, false);
}

function openFullMedia(url, isVideo = false) {
  if (!url) return;
  document.getElementById('full-image-viewer')?.remove();

  const viewer = document.createElement('div');
  viewer.id = 'full-image-viewer';
  viewer.style.cssText = `
    position: fixed; inset: 0; z-index: 9999;
    background: rgba(0,0,0,0.95);
    display: flex; align-items: center; justify-content: center;
    cursor: ${isVideo ? 'default' : 'zoom-out'};
    animation: fadeIn 0.2s ease;
    backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  `;

  let media;
  if (isVideo || isVideoUrl(url, null)) {
    media = document.createElement('video');
    media.controls = true;
    media.autoplay = true;
    media.playsInline = true;
    media.style.cssText = `max-width:96vw;max-height:88vh;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,0.8);`;
    const src1 = document.createElement('source');
    src1.src = url;
    src1.type = url.toLowerCase().includes('.webm') ? 'video/webm' : 'video/mp4';
    const src2 = document.createElement('source');
    src2.src = url;
    src2.type = 'video/webm';
    media.appendChild(src1);
    media.appendChild(src2);
  } else {
    media = document.createElement('img');
    media.src = url;
    media.style.cssText = `max-width:96vw;max-height:90vh;object-fit:contain;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,0.8);`;
  }

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = `
    position:absolute;top:20px;right:20px;
    background:rgba(255,255,255,0.15);border:none;
    color:white;font-size:20px;width:40px;height:40px;
    border-radius:50%;cursor:pointer;display:flex;
    align-items:center;justify-content:center;
  `;

  viewer.appendChild(media);
  viewer.appendChild(closeBtn);
  document.body.appendChild(viewer);

  const close = () => {
    if (media instanceof HTMLVideoElement) media.pause();
    viewer.remove();
  };

  if (!isVideo) viewer.addEventListener('click', (e) => { if (e.target === viewer) close(); });
  closeBtn.addEventListener('click', close);
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
  });
}

window.openFullImage = openFullImage;
window.openFullMedia = openFullMedia;
window.clearReply    = clearReply;

/* ==========================================
   PWA — SERVICE WORKER & NOTIFICATIONS
   ========================================== */
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js')
        .then(reg => console.log('[Pulse] SW registered:', reg.scope))
        .catch(err => console.warn('[Pulse] SW registration failed:', err));
    });
  }
}

async function registerFCMToken() {
  if (!window.Capacitor?.isNativePlatform()) return;

  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');

    // Check current permission status first — don't ask if already granted/denied
    const { receive } = await PushNotifications.checkPermissions();

    if (receive === 'granted') {
      // Already allowed — just register silently
      await PushNotifications.register();
    } else if (receive === 'prompt' || receive === 'prompt-with-rationale') {
      // Show our own explanation first, then ask
      const shouldAsk = await showConfirmModal({
        icon: '🔔',
        title: 'Enable notifications',
        body: 'Get notified instantly when friends update their status — even when the app is closed.',
        okLabel: 'Enable',
        okDanger: false
      });
      if (!shouldAsk) return;

      const { receive: newStatus } = await PushNotifications.requestPermissions();
      if (newStatus !== 'granted') return;
      await PushNotifications.register();
    } else {
      // 'denied' — don't ask again
      return;
    }

    PushNotifications.addListener('registration', async (token) => {
      console.log('[Pulse] FCM token:', token.value);
      try {
        await saveFcmToken(token.value);
        console.log('[Pulse] FCM token saved');
      } catch (e) {
        console.warn('[Pulse] FCM token save failed:', e.message);
      }
    });

    PushNotifications.addListener('pushNotificationReceived', (notification) => {
      console.log('[Pulse] Push received:', notification);
      if (state.userProfile) {
        invalidateCache();
        loadDashboardData();
      }
    });

    PushNotifications.addListener('pushNotificationActionPerformed', () => {
      navigateTo('dashboard');
    });

  } catch (e) {
    console.warn('[Pulse] FCM registration failed:', e.message);
  }
}

function requestNotificationPermission(force = false) {
  if (!('Notification' in window) || Notification.permission !== 'default') return;
  // Retain the user's choice — don't nag on every launch
  if (!force && localStorage.getItem('pulse_notif_choice')) return;

  const dashboard = document.getElementById('dashboard-view');
  if (!dashboard) return;

  // Remove any existing banner
  document.getElementById('notif-banner')?.remove();

  const banner = document.createElement('div');
  banner.id = 'notif-banner';
  banner.className = 'notif-banner';
  banner.innerHTML = `
    <div class="notif-banner-icon">🔔</div>
    <div class="notif-banner-text">
      <div class="notif-banner-title">Stay in the loop</div>
      <div class="notif-banner-sub">Get notified instantly when friends update their status</div>
    </div>
    <div class="notif-banner-actions">
      <button class="notif-banner-allow btn btn-primary btn-small">Allow</button>
      <button class="notif-banner-dismiss btn btn-secondary btn-small">Later</button>
    </div>
  `;

  banner.querySelector('.notif-banner-allow').addEventListener('click', async (e) => {
    e.stopPropagation();
    const permission = await Notification.requestPermission();
    banner.remove();
    localStorage.setItem('pulse_notif_choice', permission === 'granted' ? 'granted' : 'denied');
    if (permission === 'granted') {
      showToast('Notifications enabled! 🔔');
      await subscribeToPushNotifications();
      // Welcome notification via SW (not direct — avoids double-fire)
      if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
        setTimeout(() => {
          navigator.serviceWorker.controller.postMessage({
            type: 'FRIEND_STATUS_UPDATE',
            friendName: 'Pulse',
            emoji: '💫',
            statusText: "You'll be notified when friends update their status.",
            url: '/'
          });
        }, 600);
      }
    }
  });

  banner.querySelector('.notif-banner-dismiss').addEventListener('click', (e) => {
    e.stopPropagation();
    localStorage.setItem('pulse_notif_choice', 'dismissed');
    banner.remove();
  });

  const header = dashboard.querySelector('.header');
  if (header) header.insertAdjacentElement('afterend', banner);
}

async function subscribeToPushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.warn('[Pulse] Push not supported on this browser');
    return;
  }

  try {
    const reg = await navigator.serviceWorker.ready;
    let subscription = await reg.pushManager.getSubscription();

    if (!subscription) {
      const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY;
      if (!VAPID_PUBLIC_KEY) {
        console.warn('[Pulse] VAPID_PUBLIC_KEY not set in env');
        showToast('Notifications enabled (in-app only — VAPID key missing)', 'info');
        return;
      }

      const keyBytes = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes
      });
    }

    await savePushSubscription(subscription);
    console.log('[Pulse] Push subscription saved to Supabase ✓');
  } catch (err) {
    console.error('[Pulse] Push subscription error:', err.message, err);
    showToast('Could not enable background notifications: ' + err.message, 'error');
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

/* ==========================================
   NOTIFICATIONS — single source via SW only
   ========================================== */

// Dedup: track last notification time per friend to avoid repeated alerts
const _notifDedup = {};

function notifyFriendStatusUpdate(friendName, emoji, statusText, userId = '') {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  // Use userId as dedup key — same name users no longer collide
  const key = userId || friendName;
  const now = Date.now();
  if (_notifDedup[key] && now - _notifDedup[key] < 10000) return;
  _notifDedup[key] = now;

  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: 'FRIEND_STATUS_UPDATE',
      friendName,
      emoji,
      statusText,
      userId,
      url: '/'
    });
  }
}

/* ==========================================
   EVENT LISTENERS
   ========================================== */
/* ==========================================
   USERNAME ONBOARDING + SHARED VALIDATION
   ========================================== */

// Live username validation + availability hint — shared by the status modal
// and the onboarding modal. Uses the fast username_taken RPC.
function attachUsernameLiveHint(usernameInput, usernameHint) {
  if (!usernameInput || !usernameHint) return;
  // Guard against double-attaching when the modal is opened repeatedly
  // (onboarding auto-show + rename button) — each attach adds a new listener.
  if (usernameInput.dataset.hintAttached) return;
  usernameInput.dataset.hintAttached = '1';
  let unameTimer = null;
  const updateUsernameHint = async () => {
    const raw = usernameInput.value.trim().replace(/^@/, '').toLowerCase();
    if (!raw) {
      usernameHint.textContent = '5-32 chars · letters, numbers, underscores · unique';
      usernameHint.className = 'char-counter';
      return;
    }
    if (!/^[a-z0-9_]{5,32}$/.test(raw)) {
      usernameHint.textContent = '5-32 chars · lowercase letters, numbers, underscores only';
      usernameHint.className = 'char-counter warn';
      return;
    }
    if (raw === state.userProfile?.username) {
      usernameHint.textContent = '✓ Your current username';
      usernameHint.className = 'char-counter success';
      return;
    }
    usernameHint.textContent = 'Checking availability…';
    usernameHint.className = 'char-counter';
    try {
      const taken = await isUsernameTaken(raw);
      if (taken) {
        usernameHint.textContent = '✕ Username already taken';
        usernameHint.className = 'char-counter over';
      } else {
        usernameHint.textContent = '✓ Available';
        usernameHint.className = 'char-counter success';
      }
    } catch {
      usernameHint.textContent = 'Could not check — will validate on save';
      usernameHint.className = 'char-counter';
    }
  };
  usernameInput.addEventListener('input', () => {
    clearTimeout(unameTimer);
    unameTimer = setTimeout(updateUsernameHint, 350);
  });
}

// After login, prompt new users to pick their @username until they do.
// The username modal is mandatory for new users (no skip) and doubles as the
// rename dialog (max 2 changes/week, enforced server-side).
let _usernameOnboarded = false;
let _usernameModalMode = 'onboarding'; // 'onboarding' | 'rename'

function openUsernameModal(mode = 'onboarding') {
  const modal = document.getElementById('username-onboarding-modal');
  const input = document.getElementById('username-onboarding-input');
  const hint = document.getElementById('username-onboarding-hint');
  const title = document.getElementById('username-modal-title');
  const body = document.getElementById('username-modal-body');
  if (!modal || !input || !hint) return;

  _usernameModalMode = mode;
  // Cancel is only offered when renaming — onboarding is mandatory (no skip),
  // so it stays hidden there.
  const cancelBtn = document.getElementById('username-onboarding-cancel');
  if (cancelBtn) cancelBtn.style.display = mode === 'rename' ? 'block' : 'none';
  input.value = state.userProfile?.username || '';
  hint.textContent = mode === 'rename'
    ? `Current: @${state.userProfile?.username || ''} · max 2 changes/week`
    : 'Pick a unique username — this is how friends find you.';
  hint.className = 'char-counter';
  if (title) title.textContent = mode === 'rename' ? 'Rename your @username' : 'Choose your @username';
  if (body) {
    body.textContent = mode === 'rename'
      ? 'You can rename your username up to twice a week. Pick something friends will recognize.'
      : 'This is how friends find and connect with you. Usernames are unique — no two people can share one.';
  }
  attachUsernameLiveHint(input, hint);
  modal.style.display = 'flex';
}

function maybeShowUsernameOnboarding() {
  if (_usernameOnboarded) return;
  if (!state.userProfile) return;
  // Mandatory: once a handle is chosen (username_chosen) we never ask again.
  if (state.userProfile.username_chosen) return;
  _usernameOnboarded = true;
  openUsernameModal('onboarding');
}

/* ==========================================
   DESKTOP SIDEBAR — wide-screen chat rail
   ==========================================
   Renders the friend list into #desktop-chat-list (only visible ≥900px).
   Live-synced with the dashboard feed: unread badges, online dots,
   active-chat highlight, and a name filter all update in place. */
function renderDesktopSidebar() {
  const listEl = document.getElementById('desktop-chat-list');
  if (!listEl) return;

  // Me row (bottom of the rail)
  const meAvatar = document.getElementById('sidebar-me-avatar');
  const meName = document.getElementById('sidebar-me-name');
  const meUsername = document.getElementById('sidebar-me-username');
  if (state.userProfile) {
    if (meAvatar) meAvatar.textContent = state.userProfile.status_emoji || '👋';
    if (meName) meName.textContent = state.userProfile.name || 'Me';
    if (meUsername) meUsername.textContent = state.userProfile.username ? `@${state.userProfile.username}` : '';
  }

  const connected = state.connections.filter(c => c.status === 'connected');
  if (connected.length === 0) {
    listEl.innerHTML = `<div class="desktop-sidebar-empty">No connected friends yet.<br>Invite someone with your @username!</div>`;
    return;
  }

  const q = (document.getElementById('sidebar-search-input')?.value || '').trim().toLowerCase();
  const filtered = connected.filter(f =>
    !q ||
    (f.displayName || '').toLowerCase().includes(q) ||
    (f.name || '').toLowerCase().includes(q) ||
    (f.username || '').toLowerCase().includes(q)
  );

  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="desktop-sidebar-empty">No friends match “${escapeHtml(q)}”.</div>`;
    return;
  }

  const activeId = currentChatFriend?.friendId;

  listEl.innerHTML = filtered.map(f => {
    const active = f.friendId === activeId;
    const unread = f.unreadCount > 0 ? `<span class="desktop-chat-unread">${f.unreadCount}</span>` : '';
    const online = isOnline(f.lastSeen);
    const name = escapeHtml(f.displayName || f.name);
    const preview = escapeHtml(f.statusText || 'Available');
    const emoji = escapeHtml(f.statusEmoji || '😊');
    const dot = online
      ? '<span class="online-pulse-dot" style="width:10px;height:10px;bottom:-1px;right:-1px;"></span>'
      : '';
    return `
      <button class="desktop-chat-row${active ? ' active' : ''}" data-friend-id="${escapeHtml(f.friendId)}">
        <span class="desktop-chat-avatar">${emoji}${dot}</span>
        <span class="desktop-chat-row-body">
          <span class="desktop-chat-row-name">${name}</span>
          <span class="desktop-chat-row-preview">${preview}</span>
        </span>
        ${unread}
      </button>`;
  }).join('');
}

function initEventListeners() {

  // ---- Desktop sidebar (wide screens; element absent on phones so all
  //      these optional-chain no-ops) ----
  document.getElementById('desktop-chat-list')?.addEventListener('click', (e) => {
    const row = e.target.closest('.desktop-chat-row');
    if (!row) return;
    const friend = state.connections.find(c => c.friendId === row.dataset.friendId && c.status === 'connected');
    if (friend) openChat(friend);
  });

  document.getElementById('sidebar-search-input')?.addEventListener('input', renderDesktopSidebar);

  // Settings gear in the sidebar head + clicking your profile row both open
  // the account modal (the header keeps its own Update button)
  document.getElementById('sidebar-settings-btn')?.addEventListener('click', openAccountModal);

  document.getElementById('desktop-sidebar-me')?.addEventListener('click', openAccountModal);

  // Tap a DM notification toast → open that chat
  document.getElementById('global-toast')?.addEventListener('click', () => {
    if (!toastChatFriend) return;
    const friend = (state.connections || []).find(c => c.friendId === toastChatFriend);
    toastChatFriend = null;
    const toast = document.getElementById('global-toast');
    if (toast) { toast.className = 'toast'; toast.style.cursor = ''; toast.style.pointerEvents = 'none'; }
    if (friend) openChat(friend);
  });

  document.getElementById('btn-save-config')?.addEventListener('click', () => {
    const url = document.getElementById('config-url')?.value.trim();
    const key = document.getElementById('config-key')?.value.trim();

    if (!url || !key) {
      showToast('Please enter both the project URL and anon key.', 'error');
      return;
    }

    if (initSupabase(url, key)) {
      showToast('Supabase connected!');
      checkNavigationState();
    } else {
      showToast('Failed to connect. Check the URL format.', 'error');
    }
  });

  document.getElementById('btn-toggle-key-visibility')?.addEventListener('click', () => {
    const keyInput = document.getElementById('config-key');
    const btn = document.getElementById('btn-toggle-key-visibility');
    if (!keyInput) return;
    const isHidden = keyInput.type === 'password';
    keyInput.type = isHidden ? 'text' : 'password';
    if (btn) btn.innerHTML = isHidden ? ICON_EYE_OFF : ICON_EYE;
  });

  ['config-url', 'config-key'].forEach(id => {
    document.getElementById(id)?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('btn-save-config')?.click();
    });
  });

  document.getElementById('btn-show-config')?.addEventListener('click', () => {
    navigateTo('config');
  });

  document.getElementById('tab-signin')?.addEventListener('click', () => setAuthMode('signin'));
  document.getElementById('tab-signup')?.addEventListener('click', () => setAuthMode('signup'));

  document.getElementById('btn-toggle-password')?.addEventListener('click', () => {
    const inp = document.getElementById('auth-password');
    const btn = document.getElementById('btn-toggle-password');
    if (!inp) return;
    inp.type = inp.type === 'password' ? 'text' : 'password';
    if (btn) btn.innerHTML = inp.type === 'password' ? ICON_EYE : ICON_EYE_OFF;
  });

  document.getElementById('btn-toggle-confirm')?.addEventListener('click', () => {
    const inp = document.getElementById('auth-password-confirm');
    const btn = document.getElementById('btn-toggle-confirm');
    if (!inp) return;
    inp.type = inp.type === 'password' ? 'text' : 'password';
    if (btn) btn.innerHTML = inp.type === 'password' ? ICON_EYE : ICON_EYE_OFF;
  });

  document.getElementById('btn-google-auth')?.addEventListener('click', async () => {
    try {
      await signInWithGoogle();
      // Native: OAuth completed and returned to the app — resume the session now.
      // Web: the page navigated to Google and back, session is picked up on load.
      if (window.Capacitor?.isNativePlatform()) {
        await checkNavigationState();
      }
    } catch (err) {
      showAuthError(err.message);
    }
  });

  document.getElementById('btn-auth-submit')?.addEventListener('click', async (e) => {
    e.preventDefault();
    clearAuthError();

    const email = document.getElementById('auth-email')?.value.trim();
    const password = document.getElementById('auth-password')?.value;
    const name = document.getElementById('auth-name')?.value.trim();
    const confirm = document.getElementById('auth-password-confirm')?.value;

    if (!email || !password) {
      showAuthError('Please enter email and password.');
      return;
    }

    try {
      if (state.authMode === 'signup') {
        if (!name) {
          showAuthError('Please enter your name.');
          return;
        }
        if (password !== confirm) {
          showAuthError('Passwords do not match.');
          return;
        }
        if (password.length < 6) {
          showAuthError('Password must be at least 6 characters.');
          return;
        }
        const signUpResult = await signUpWithPassword(email, password, name);
        // If session is returned immediately, email confirmation is disabled — go to dashboard
        if (signUpResult?.session) {
          showToast('Account created! Welcome to Pulse 💫');
          await checkNavigationState();
        } else {
          // Email confirmation required
          showToast('Account created! Check your email to confirm, then sign in.');
          setAuthMode('signin');
        }
      } else {
        await signInWithPassword(email, password);
        showToast('Welcome back! 💫');
      }
    } catch (err) {
      showAuthError(err.message);
    }
  });

  document.getElementById('btn-forgot-password')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const email = document.getElementById('auth-email')?.value.trim();
    if (!email) {
      showAuthError('Enter your email above first.');
      return;
    }
    try {
      await sendPasswordReset(email);
      showToast('Password reset link sent! Check your email.');
    } catch (err) {
      showAuthError(err.message);
    }
  });

  document.getElementById('btn-signout')?.addEventListener('click', async () => {
    const confirmed = await showConfirmModal({
      icon: '👋',
      title: 'Sign out?',
      body: 'You will stop receiving real-time updates until you sign back in.',
      okLabel: 'Sign Out',
      okDanger: true
    });
    if (!confirmed) return;

    try {
      await signOutUser();
      clearUserCache(state.userProfile?.id); // don't leak this account's cached chats/dashboard
      clearOpenChat(); // never restore someone else's chat on the next login
      // Stop location sharing on sign out
      if (state.sharingLocationWith.length > 0) {
        await stopLocationShare(null).catch(() => {});
      }
      if (state.locationInterval) {
        clearInterval(state.locationInterval);
        state.locationInterval = null;
      }
      state.userProfile = null;
      state.connections = [];
      state.sharingLocationWith = [];
      state.friendLocations = {};
      if (state.realtimeChannel) {
        state.realtimeChannel.unsubscribe();
        state.realtimeChannel = null;
      }
      invalidateCache();
      navigateTo('auth');
      setAuthMode('signin');
      showToast('Signed out successfully.');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Status Modal
  document.getElementById('btn-open-status-modal')?.addEventListener('click', () => {
    const modal = document.getElementById('status-modal');
    const nameInput = document.getElementById('status-name-input');
    const textInput = document.getElementById('status-text-input');
    if (nameInput) nameInput.value = state.userProfile?.name || '';
    // Pre-fill current status text so user can edit rather than retype
    if (textInput) {
      textInput.value = state.userProfile?.status_text || '';
      // Update char counter immediately to reflect pre-filled text
      const charCounter = document.getElementById('status-char-counter');
      if (charCounter) {
        const len = textInput.value.length;
        charCounter.textContent = `${len}/60`;
        charCounter.className = 'char-counter' + (len > 50 ? (len >= 60 ? ' over' : ' warn') : '');
      }
    }

    // Reset image state
    isStatusImageRemoved = false;
    currentStatusImage = null;
    if (state.userProfile?.status_image_url) {
      const preview = document.getElementById('status-image-preview');
      const img = document.getElementById('status-preview-img');
      if (img) img.src = state.userProfile.status_image_url;
      if (preview) preview.style.display = 'block';
    } else {
      removeStatusImage();
    }

    // Reset recipient to "all"
    const radioAll = document.querySelector('input[name="recipient"][value="all"]');
    if (radioAll) radioAll.checked = true;
    const directSelect = document.getElementById('direct-friend-select');
    if (directSelect) directSelect.style.display = 'none';

    // Always re-enable emoji picker on modal open
    _setEmojiPickerDisabled(false);
    // Reset the emoji to the user's CURRENT status emoji — never carry over a
    // stale "last used" emoji into the saved status (and its history entry)
    selectEmoji(state.userProfile?.status_emoji || '😊');
    // If user already has an image set, disable emoji picker
    if (state.userProfile?.status_image_url && !isStatusImageRemoved) {
      _setEmojiPickerDisabled(true);
    }

    // Belt-and-braces: never leave the save button stuck disabled from a
    // previous failed attempt — reset it every time the modal opens.
    const saveBtn = document.getElementById('btn-save-status');
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.innerHTML = '<span>Save & Pulse Out!</span>';
    }

    updateStatusLivePreview();
    if (modal) modal.style.display = 'flex';
  });

  document.getElementById('btn-close-status-modal')?.addEventListener('click', () => {
    document.getElementById('status-modal').style.display = 'none';
  });

  // Username onboarding modal — cancel (rename mode only)
  document.getElementById('username-onboarding-cancel')?.addEventListener('click', () => {
    document.getElementById('username-onboarding-modal').style.display = 'none';
  });

  // Username onboarding modal — save / skip
  document.getElementById('username-onboarding-save')?.addEventListener('click', async () => {
    const modal = document.getElementById('username-onboarding-modal');
    const input = document.getElementById('username-onboarding-input');
    const hint = document.getElementById('username-onboarding-hint');
    if (!modal || !input || !hint) return;

    const raw = input.value.trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9_]{5,32}$/.test(raw)) {
      hint.textContent = 'Username must be 5-32 chars: letters, numbers, underscores only';
      hint.className = 'char-counter over';
      return;
    }
    try {
      // Always claim via the RPC — it's idempotent, atomically enforces
      // uniqueness, persists username_chosen, and enforces the 2x/week cooldown.
      await setMyUsername(raw);
      state.userProfile = { ...state.userProfile, username: raw, username_chosen: true, skip_username: false };
      updateMyStatusUI();
      modal.style.display = 'none';
      showToast(_usernameModalMode === 'rename' ? `Username updated to @${raw}! ✨` : `Welcome, @${raw}! ✨`);
    } catch (err) {
      const msg = err.message || 'Could not set username.';
      // Cooldown message comes straight from the RPC ("...twice a week...after <date>")
      hint.textContent = msg.toLowerCase().includes('taken')
        ? '✕ Username already taken'
        : msg;
      hint.className = 'char-counter over';
    }
  });

  // Account modal — deactivate / delete (Instagram-style). Shared so the
  // sidebar settings gear + profile row can open it without a header button.
  function openAccountModal() {
    const modal = document.getElementById('account-modal');
    const status = document.getElementById('account-modal-status');
    const cancelBtn = document.getElementById('btn-cancel-deletion');
    const deleting = state.userProfile?.deletion_requested_at;
    if (status) {
      if (deleting) {
        const d = new Date(deleting);
        const until = new Date(d.getTime() + 30 * 24 * 60 * 60 * 1000);
        status.textContent = `Deletion requested ${d.toLocaleDateString()} — your account and all data will be permanently removed on ${until.toLocaleDateString()} unless you cancel.`;
      } else {
        status.textContent = 'Deactivating hides your profile and stops status updates — you can log back in anytime to reactivate. Deleting is permanent after a 30-day grace period.';
      }
    }
    if (cancelBtn) cancelBtn.style.display = deleting ? 'block' : 'none';
    modal.style.display = 'flex';
  }
  window.openAccountModal = openAccountModal;
  document.getElementById('btn-account-close')?.addEventListener('click', () => {
    document.getElementById('account-modal').style.display = 'none';
  });
  document.getElementById('btn-deactivate-account')?.addEventListener('click', async () => {
    const ok = await showConfirmModal({
      icon: '😴',
      title: 'Temporarily deactivate?',
      body: 'Your profile and status will be hidden from friends until you log back in. This is reversible.',
      okLabel: 'Deactivate'
    });
    if (!ok) return;
    try {
      await deactivateAccount();
      // Close the account modal automatically — no manual Close needed
      document.getElementById('account-modal').style.display = 'none';
      showToast('Account deactivated. See you soon! 👋');
      await signOutUser();
      clearUserCache(state.userProfile?.id);
      clearOpenChat();
      state.userProfile = null;
      state.connections = [];
      if (state.realtimeChannel) { state.realtimeChannel.unsubscribe(); state.realtimeChannel = null; }
      navigateTo('auth');
      setAuthMode('signin');
    } catch (err) {
      showToast(err.message || 'Could not deactivate account.', 'error');
    }
  });
  document.getElementById('btn-delete-account')?.addEventListener('click', async () => {
    const ok = await showConfirmModal({
      icon: '🗑️',
      title: 'Delete your account?',
      body: 'Your profile, connections, messages and uploaded media will be permanently deleted after a 30-day grace period. You can cancel anytime before then. This cannot be undone.',
      okLabel: 'Delete'
    });
    if (!ok) return;
    try {
      await requestAccountDeletion();
      const status = document.getElementById('account-modal-status');
      const cancelBtn = document.getElementById('btn-cancel-deletion');
      if (status) status.textContent = `Deletion requested ${new Date().toLocaleDateString()} — your account will be permanently removed in 30 days unless you cancel.`;
      if (cancelBtn) cancelBtn.style.display = 'block';
      // Close the account modal automatically — the toast confirms the action
      document.getElementById('account-modal').style.display = 'none';
      showToast('Deletion scheduled. You can cancel anytime within 30 days.');
    } catch (err) {
      showToast(err.message || 'Could not schedule deletion.', 'error');
    }
  });
  document.getElementById('btn-cancel-deletion')?.addEventListener('click', async () => {
    try {
      await cancelAccountDeletion();
      const status = document.getElementById('account-modal-status');
      const cancelBtn = document.getElementById('btn-cancel-deletion');
      if (status) status.textContent = 'Deletion cancelled — your account is safe. 🎉';
      if (cancelBtn) cancelBtn.style.display = 'none';
      state.userProfile = { ...state.userProfile, deletion_requested_at: null };
      // Close the account modal automatically — the toast confirms the action
      document.getElementById('account-modal').style.display = 'none';
      showToast('Deletion cancelled.');
    } catch (err) {
      showToast(err.message || 'Could not cancel deletion.', 'error');
    }
  });

  document.getElementById('btn-save-status')?.addEventListener('click', async () => {
    if (!state.userProfile) return;

    // Validate FIRST — never disable the button on a validation error,
    // otherwise it gets stuck showing "Saving..." forever.
    const recipientRadio = document.querySelector('input[name="recipient"]:checked');
    const recipientMode = recipientRadio?.value || 'all';
    const directFriendId = document.getElementById('direct-friend-select')?.value;

    if (recipientMode === 'direct' && !directFriendId) {
      showToast('Please select a friend to send to.', 'error');
      return;
    }

    const saveBtn = document.getElementById('btn-save-status');
    if (saveBtn.disabled) return;
    saveBtn.disabled = true;
    const origText = saveBtn.innerHTML;
    saveBtn.innerHTML = '<span>Saving...</span>';

    const nameInput = document.getElementById('status-name-input');
    const textInput = document.getElementById('status-text-input');
    const name = nameInput?.value.trim() || state.userProfile.name;
    const text = textInput?.value.trim() || '';

    try {
      let imageUrl = null;

      if (currentStatusImage) {
        showToast('Uploading image...');
        imageUrl = await uploadStatusImage(currentStatusImage);
        currentStatusImageUrl = imageUrl;
      } else if (isStatusImageRemoved) {
        imageUrl = null;
      } else {
        imageUrl = state.userProfile?.status_image_url || null;
      }

      if (recipientMode === 'direct' && directFriendId) {
        // Private status: write to private_statuses table only
        // The target friend sees this as their status card; everyone else keeps seeing the public profile
        await upsertPrivateStatus(directFriendId, state.selectedEmoji, text, imageUrl);
        showToast('Status sent privately! 🔒');
        document.getElementById('status-modal').style.display = 'none';
        if (textInput) textInput.value = '';
        invalidateCache();
        await loadDashboardData();
      } else {
        // All friends: update public profile
        const mediaType = currentStatusImage?.type?.startsWith('video/') ? 'video' : 'image';
        await updateStatus(name, state.selectedEmoji, text, imageUrl, mediaType);
        showToast('Status updated! 💫');
        if (textInput) textInput.value = '';
        document.getElementById('status-modal').style.display = 'none';
        // Delete all outgoing private statuses — everyone now sees the public update
        state.privateSentByMe = {};
        state.privateStatuses = {};
        await clearOutgoingPrivateStatuses();
        await notifyFriendsOfUpdate(state.userProfile.id, name, state.selectedEmoji, text);
        // Free-tier bucket hygiene: remove the replaced image ONLY if it's not
        // still referenced by the user's recent status history (last 15 rows)
        const oldImageUrl = state.userProfile?.status_image_url;
        if (oldImageUrl && oldImageUrl !== imageUrl) {
          try {
            const { data: historyRows } = await client()
              .from('status_history')
              .select('status_image_url')
              .eq('user_id', state.userProfile.id)
              .not('status_image_url', 'is', null)
              .order('created_at', { ascending: false })
              .limit(15);
            const stillReferenced = (historyRows || []).some(h => h.status_image_url === oldImageUrl);
            if (!stillReferenced) deleteStatusImage(oldImageUrl);
          } catch (e) {
            // On error, keep the old image — never risk breaking history
          }
        }
        invalidateCache();
        await loadDashboardData();
      }
    } catch (err) {
      showToast(err.message || 'Failed to update status', 'error');
    } finally {
      saveBtn.disabled = false;
      saveBtn.innerHTML = origText;
    }
  });

  document.getElementById('status-file-input')?.addEventListener('change', (e) => {
    if (e.target.files?.[0]) handleStatusMedia(e.target.files[0], false);
  });

  document.getElementById('status-camera-input')?.addEventListener('change', (e) => {
    if (e.target.files?.[0]) handleStatusMedia(e.target.files[0], false);
  });

  document.getElementById('status-remove-image')?.addEventListener('click', () => {
    removeStatusImage();
  });

  document.getElementById('status-camera-btn')?.addEventListener('click', async () => {
    const { openCamera } = await import('./camera.js');
    openCamera(
      (file) => {
        if (file.type.startsWith('video/')) {
          handleStatusVideo(file);
        } else {
          handleStatusImage(file, false);
        }
      },
      (reason) => {
        // Fall back to OS native camera input
        document.getElementById('status-camera-input')?.click();
      }
    );
  });

  document.getElementById('status-file-btn')?.addEventListener('click', () => {
    // Gallery button opens file picker (no capture)
    document.getElementById('status-file-input')?.click();
  });

  // Recipient radio buttons
  document.querySelectorAll('input[name="recipient"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      const select = document.getElementById('direct-friend-select');
      if (select) select.style.display = e.target.value === 'direct' ? 'block' : 'none';
    });
  });

  // Status text char counter
  const statusTextInput = document.getElementById('status-text-input');
  const charCounter = document.getElementById('status-char-counter');
  if (statusTextInput && charCounter) {
    statusTextInput.setAttribute('maxlength', '60');
    const updateCounter = () => {
      const len = statusTextInput.value.length;
      charCounter.textContent = `${len}/60`;
      charCounter.className = 'char-counter' + (len > 50 ? (len >= 60 ? ' over' : ' warn') : '');
      updateStatusLivePreview();
    };
    statusTextInput.addEventListener('input', updateCounter);
    updateCounter();
  }

  // Keep the live preview name in sync while typing
  document.getElementById('status-name-input')?.addEventListener('input', updateStatusLivePreview);

  // Username live validation + availability hint lives on the username modal
  // (onboarding + rename) — see openUsernameModal().

  // Connections
  document.getElementById('btn-send-invite')?.addEventListener('click', async () => {
    const input = document.getElementById('friend-id-input');
    const btn = document.getElementById('btn-send-invite');
    const id = input?.value.trim();

    if (!id) {
      showToast('Please enter a @username.', 'error');
      return;
    }
    if (btn.disabled) return;
    btn.disabled = true;

    try {
      await sendConnectionRequest(id);
      showToast('Connection request sent! ✉️');
      if (input) input.value = '';
      invalidateCache();
      await loadDashboardData();
    } catch (err) {
      showToast(err.message || 'Failed to send request', 'error');
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('btn-refresh')?.addEventListener('click', async () => {
    const icon = document.getElementById('refresh-icon');
    if (icon) icon.classList.add('spinning');
    invalidateCache();
    await loadDashboardData();
    if (icon) setTimeout(() => icon.classList.remove('spinning'), 800);
    showToast('Refreshed!');
  });

  const myHandle = () => (state.userProfile?.username ? `@${state.userProfile.username}` : '');

  // Rename username — opens the shared username modal in rename mode (2x/week limit)
  document.getElementById('btn-rename-username')?.addEventListener('click', () => {
    openUsernameModal('rename');
  });

  document.getElementById('my-id-display')?.addEventListener('click', async () => {
    const handle = myHandle();
    if (!handle) return;
    try {
      await navigator.clipboard.writeText(handle);
      _flashCopyFeedback('my-id-display');
      showToast('Username copied to clipboard! 📋');
    } catch (err) {
      showToast('Failed to copy username', 'error');
    }
  });

  // Share invite deep link — Web Share API on mobile, clipboard fallback
  document.getElementById('btn-share-id')?.addEventListener('click', async () => {
    const handle = myHandle();
    if (!handle) return;
    const link = `${window.location.origin}/?invite=${handle}`;
    const text = `Join me on Pulse! My username is ${handle} — tap to connect: ${link}`;

    if (navigator.share) {
      try {
        await navigator.share({ title: 'Pulse — connect with me', text, url: link });
        return;
      } catch (err) {
        // User cancelled — fall through to clipboard
      }
    }
    try {
      await navigator.clipboard.writeText(link);
      _flashCopyFeedback('btn-share-id');
      showToast('Invite link copied! 📋');
    } catch (err) {
      showToast('Failed to copy invite link', 'error');
    }
  });

  function _flashCopyFeedback(id) {
    const el = document.getElementById(id);
    if (!el) return;
    const original = el.innerHTML;
    el.innerHTML = '✓ Copied';
    setTimeout(() => { if (el.innerHTML === '✓ Copied') el.innerHTML = original; }, 1500);
  }

  // Chat
  document.getElementById('chat-send-btn')?.addEventListener('click', sendChatMessage);

  // Chat search — toggle bar, Enter to search, close
  document.getElementById('chat-search-btn')?.addEventListener('click', () => {
    if (chatSearchMode) closeChatSearch();
    else openChatSearch();
  });
  document.getElementById('chat-search-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); runChatSearch(); }
  });
  document.getElementById('chat-search-close')?.addEventListener('click', closeChatSearch);
  document.getElementById('chat-search-results')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.chat-search-result');
    if (btn) jumpToMessage(btn.dataset.msgId);
  });

  // Delegated chat bubble interactions — survives re-renders (reply + reactions)
  const chatMessagesEl = document.getElementById('chat-messages');
  chatMessagesEl?.addEventListener('click', (e) => {
    // Reaction picker emoji
    const pickerBtn = e.target.closest('.chat-react-picker button');
    if (pickerBtn) {
      e.stopPropagation();
      const msgId = pickerBtn.closest('.chat-react-picker')?.dataset.msgId;
      closeReactPicker();
      if (msgId) toggleReaction(msgId, pickerBtn.dataset.emoji);
      return;
    }
    // Existing reaction pill → toggle it
    const pill = e.target.closest('.chat-reaction-pill');
    if (pill) {
      e.stopPropagation();
      toggleReaction(pill.dataset.msgId, pill.dataset.emoji);
      return;
    }
    // Action sheet buttons → Reply / Copy / Delete
    const actionBtn = e.target.closest('.chat-action-btn');
    if (actionBtn) {
      e.stopPropagation();
      const msgId = actionBtn.dataset.msgId;
      const action = actionBtn.dataset.action;
      closeChatActionSheet();
      if (action === 'reply') {
        const bubble = e.currentTarget.querySelector(`.chat-bubble[data-msg-id="${CSS.escape(msgId)}"]`);
        if (bubble) {
          setReply({
            id: msgId,
            content_text: bubble.dataset.content,
            image_url: bubble.dataset.image,
            sender_id: bubble.dataset.sender
          });
        }
      } else if (action === 'copy') {
        copyMessageText(msgId);
      } else if (action === 'delete') {
        confirmDeleteMessage(msgId);
      }
      return;
    }
    // Tap on a bubble (not on image/video/link) → open the action sheet
    const bubble = e.target.closest('.chat-bubble');
    if (bubble && !e.target.closest('img, video, a')) {
      e.stopPropagation();
      if (longPressFired) { longPressFired = false; return; } // long-press just handled it
      showChatActionSheet(bubble.dataset.msgId, bubble);
      return;
    }
    // Any other click inside the message list closes popovers
    closeReactPicker();
  });

  // Long-press a bubble → quick reaction picker (touch + mouse)
  chatMessagesEl?.addEventListener('pointerdown', (e) => {
    longPressFired = false; // clear any stale suppression from a missed click
    const bubble = e.target.closest('.chat-bubble');
    if (!bubble || e.target.closest('button, a, img, video, .chat-reaction-pill, .chat-action-sheet, .chat-react-picker')) return;
    longPressTarget = bubble;
    longPressTimer = setTimeout(() => {
      longPressFired = true;
      toggleReactPicker(bubble.dataset.msgId, bubble);
      clearChatLongPress();
    }, 450);
  });
  chatMessagesEl?.addEventListener('pointerup', clearChatLongPress);
  chatMessagesEl?.addEventListener('pointercancel', clearChatLongPress);
  chatMessagesEl?.addEventListener('pointermove', (e) => {
    if (longPressTimer && longPressTarget && !e.target.closest('.chat-bubble')) clearChatLongPress();
  });
  chatMessagesEl?.addEventListener('pointerleave', clearChatLongPress);

  // Clicking anywhere outside an open popover closes it
  document.addEventListener('click', (e) => {
    if (openReactPicker && !e.target.closest('.chat-react-picker') && !e.target.closest('.chat-bubble')) {
      closeReactPicker();
    }
    if (openActionSheet && !e.target.closest('.chat-action-sheet') && !e.target.closest('.chat-bubble')) {
      closeReactPicker();
    }
  });

  document.getElementById('chat-input')?.addEventListener('keydown', (e) => {
    // Enter = send, Shift+Enter = newline
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  // Broadcast typing indicator while the user types (throttled)
  document.getElementById('chat-input')?.addEventListener('input', () => {
    if (!currentChatFriend) return;
    const input = document.getElementById('chat-input');
    const text = input?.value.trim() || '';
    const now = Date.now();
    if (text && now - chatTypingSentAt > 2500) {
      chatTypingSentAt = now;
      setTypingStatus(currentChatFriend.friendId, true);
    } else if (!text) {
      chatTypingSentAt = 0;
      setTypingStatus(currentChatFriend.friendId, false);
    }
  });

  // Chat emoji picker
  let chatEmojiCategory = 'mood';

  function renderChatEmojiGrid(category) {
    const grid = document.getElementById('chat-emoji-grid');
    if (!grid) return;
    const emojis = EMOJI_CATEGORIES[category] || EMOJI_CATEGORIES.mood;
    grid.innerHTML = emojis.map(e =>
      `<button type="button" data-emoji="${e}">${e}</button>`
    ).join('');
    grid.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const input = document.getElementById('chat-input');
        if (!input) return;
        const pos = input.selectionStart ?? input.value.length;
        input.value = input.value.slice(0, pos) + btn.dataset.emoji + input.value.slice(pos);
        // Move cursor after inserted emoji
        const newPos = pos + btn.dataset.emoji.length;
        input.setSelectionRange(newPos, newPos);
        input.focus();
      });
    });
  }

  document.getElementById('chat-emoji-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const picker = document.getElementById('chat-emoji-picker');
    if (!picker) return;
    const isOpen = picker.style.display !== 'none';
    picker.style.display = isOpen ? 'none' : 'block';
    if (!isOpen) renderChatEmojiGrid(chatEmojiCategory);
  });

  document.getElementById('chat-emoji-tabs')?.querySelectorAll('.chat-emoji-tab').forEach(tab => {
    tab.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.chat-emoji-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      chatEmojiCategory = tab.dataset.cat;
      renderChatEmojiGrid(chatEmojiCategory);
    });
  });

  // Close picker when clicking outside
  document.addEventListener('click', (e) => {
    const picker = document.getElementById('chat-emoji-picker');
    const btn = document.getElementById('chat-emoji-btn');
    if (picker && !picker.contains(/** @type {Node} */ (e.target)) && e.target !== btn) {
      picker.style.display = 'none';
    }
  });

  document.getElementById('chat-file-input')?.addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.type.startsWith('video/')) handleChatVideo(f);
    else handleChatImage(f, false);
  });

  document.getElementById('chat-camera-input')?.addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.type.startsWith('video/')) handleChatVideo(f);
    else handleChatImage(f, false);
  });

  document.getElementById('chat-remove-image')?.addEventListener('click', () => {
    removeChatImage();
  });

  document.getElementById('chat-camera-btn')?.addEventListener('click', async () => {
    const { openCamera } = await import('./camera.js');
    openCamera(
      (file) => {
        if (file.type.startsWith('video/')) {
          handleChatVideo(file);
        } else {
          handleChatImage(file, false);
        }
      },
      () => {
        // Fall back to OS native camera input
        document.getElementById('chat-camera-input')?.click();
      }
    );
  });

  document.getElementById('chat-file-btn')?.addEventListener('click', () => {
    // Gallery button opens file picker (no capture)
    document.getElementById('chat-file-input')?.click();
  });

  document.getElementById('chat-back-btn')?.addEventListener('click', () => {
    // Stop broadcasting typing for this chat
    if (currentChatFriend?.friendId) setTypingStatus(currentChatFriend.friendId, false);
    clearTimeout(friendTypingTimer);
    hideTypingIndicator();
    closeReactPicker();
    closeChatSearch();
    chatMessagesCache = {};
    clearOpenChat(); // leaving the chat — a refresh should land on the dashboard
    currentChatFriend = null;
    clearReply();
    const picker = document.getElementById('chat-emoji-picker');
    if (picker) picker.style.display = 'none';
    invalidateCache();
    navigateTo('dashboard');
    loadDashboardData();
  });

  // Chat background from gallery
  document.getElementById('chat-bg-btn')?.addEventListener('click', () => {
    document.getElementById('chat-bg-input')?.click();
  });

  document.getElementById('chat-bg-input')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      // Downscale first — full-res data URLs blow the ~5MB localStorage quota
      const thumb = await compressImageToDataUrl(file, 900, 0.72);
      const msgs = document.getElementById('chat-messages');
      if (msgs) {
        msgs.style.backgroundImage = `url(${thumb})`;
        msgs.style.backgroundSize = 'cover';
        msgs.style.backgroundPosition = 'center';
        msgs.style.backgroundAttachment = 'local';
      }
      // Show the remove button whenever the preview is applied, even if
      // persisting to localStorage fails — removal just clears the styles.
      const bgRemoveBtn = document.getElementById('chat-bg-remove-btn');
      if (bgRemoveBtn) bgRemoveBtn.style.display = '';
      // Store per-friend background
      if (currentChatFriend?.friendId) {
        try {
          localStorage.setItem(`pulse-chat-bg-${currentChatFriend.friendId}`, thumb);
          showToast('Chat background updated!');
        } catch (qErr) {
          showToast('Background preview only — too large to save locally.', 'error');
        }
      }
    } catch (bgErr) {
      showToast('Could not process that image.', 'error');
    }
  });

  // Remove chat background
  document.getElementById('chat-bg-remove-btn')?.addEventListener('click', () => {
    if (!currentChatFriend?.friendId) return;
    localStorage.removeItem(`pulse-chat-bg-${currentChatFriend.friendId}`);
    const msgs = document.getElementById('chat-messages');
    if (msgs) {
      msgs.style.backgroundImage = '';
      msgs.style.backgroundSize = '';
      msgs.style.backgroundPosition = '';
      msgs.style.backgroundAttachment = '';
    }
    const btn = document.getElementById('chat-bg-remove-btn');
    if (btn) btn.style.display = 'none';
    showToast('Chat background removed.');
  });

  // Reset config
  document.getElementById('btn-reset-config')?.addEventListener('click', async () => {
    const confirmed = await showConfirmModal({
      icon: '⚙️',
      title: 'Reset configuration?',
      body: 'This will clear your Supabase settings and sign you out.',
      okLabel: 'Reset',
      okDanger: true
    });
    if (!confirmed) return;

    clearUserCache(state.userProfile?.id);
    resetSupabaseConfig();
    state.userProfile = null;
    state.connections = [];
    if (state.realtimeChannel) {
      state.realtimeChannel.unsubscribe();
      state.realtimeChannel = null;
    }
    invalidateCache();
    navigateTo('config');
    showToast('Configuration reset.');
  });

  // Location sharing — Save-based flow
  document.getElementById('btn-location')?.addEventListener('click', () => {
    openLocationModal();
  });

  // Notification bell — re-open the permission request / show status
  document.getElementById('btn-notif')?.addEventListener('click', () => {
    if (!('Notification' in window)) {
      showToast('Notifications not supported in this browser.', 'error');
      return;
    }
    if (Notification.permission === 'granted') {
      showToast('Notifications are on 🔔');
    } else if (Notification.permission === 'denied') {
      showToast('Notifications are blocked by the browser. Enable them in site settings.', 'error');
    } else {
      requestNotificationPermission(true);
    }
  });

  document.getElementById('btn-close-location-modal')?.addEventListener('click', () => {
    document.getElementById('location-modal').style.display = 'none';
  });

  // Save: checked = share, unchecked = stop
  document.getElementById('btn-save-location')?.addEventListener('click', async () => {
    const saveBtn = document.getElementById('btn-save-location');
    if (saveBtn.disabled) return;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    try {
      const allChecks = [...document.querySelectorAll('.location-friend-check')];
      const nowChecked  = allChecks.filter(c => c.checked).map(c => c.value);
      const nowUnchecked = allChecks.filter(c => !c.checked).map(c => c.value);

      const toStart = nowChecked.filter(id => !state.sharingLocationWith.includes(id));
      const toStop  = nowUnchecked.filter(id => state.sharingLocationWith.includes(id));

      document.getElementById('location-modal').style.display = 'none';

      if (toStop.length > 0)  await stopSharingLocation(toStop);
      if (toStart.length > 0) await startSharingLocation(toStart);
    } catch (err) {
      showToast(err.message || 'Failed to update location sharing.', 'error');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
  });
}

/* ==========================================
   ANDROID HARDWARE BACK BUTTON
   ========================================== */
function setupAndroidBackButton() {
  if (!window.Capacitor?.isNativePlatform()) return;

  import('@capacitor/app').then(({ App }) => {
    App.addListener('backButton', () => {
      // 1) Never interrupt an in-flight video compression
      const vp = document.getElementById('video-progress-overlay');
      if (vp && vp.style.display !== 'none') return;

      // 2) Close confirm / nickname modals first (they hold a pending promise)
      const confirmModal = document.getElementById('custom-confirm-modal');
      if (confirmModal && confirmModal.style.display === 'flex') {
        document.getElementById('confirm-modal-cancel')?.click();
        return;
      }
      const nickModal = document.getElementById('nickname-modal');
      if (nickModal && nickModal.style.display === 'flex') {
        document.getElementById('nickname-modal-cancel')?.click();
        return;
      }

      // 3) Close username modal — only in rename mode. Onboarding is mandatory
      //    (username cannot be skipped), so back never dismisses it.
      const onboardModal = document.getElementById('username-onboarding-modal');
      if (onboardModal && onboardModal.style.display === 'flex' && _usernameModalMode === 'rename') {
        onboardModal.style.display = 'none';
        return;
      }
      if (onboardModal && onboardModal.style.display === 'flex') return; // mandatory — block back

      // 4) Close status / location modals
      const statusModal = document.getElementById('status-modal');
      if (statusModal && statusModal.style.display === 'flex') {
        statusModal.style.display = 'none';
        return;
      }
      const locationModal = document.getElementById('location-modal');
      if (locationModal && locationModal.style.display === 'flex') {
        locationModal.style.display = 'none';
        return;
      }
      const accountModal = document.getElementById('account-modal');
      if (accountModal && accountModal.style.display === 'flex') {
        accountModal.style.display = 'none';
        return;
      }

      // 4) Close chat popovers: action sheet, reaction picker, emoji picker, search
      if (openActionSheet || openReactPicker) {
        closeReactPicker();
        return;
      }
      const emojiPicker = document.getElementById('chat-emoji-picker');
      if (emojiPicker && emojiPicker.style.display !== 'none') {
        emojiPicker.style.display = 'none';
        return;
      }
      if (chatSearchMode) {
        closeChatSearch();
        return;
      }

      // 5) Inside a chat → step back to the dashboard (reuse the header back button)
      if (currentChatFriend) {
        document.getElementById('chat-back-btn')?.click();
        return;
      }

      // 6) Otherwise exit the app
      App.exitApp();
    });
  }).catch((err) => console.warn('[Pulse] Back-button setup failed:', err));
}

/* ==========================================
   INIT
   ========================================== */
document.addEventListener('DOMContentLoaded', () => {
  initEmojiPicker();
  initEventListeners();
  registerServiceWorker();
  setupAndroidBackButton();
  checkNavigationState();

  // Stop broadcasting typing when the tab/app is hidden or closed
  window.addEventListener('pagehide', () => {
    if (currentChatFriend?.friendId) setTypingStatus(currentChatFriend.friendId, false);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && currentChatFriend?.friendId) {
      setTypingStatus(currentChatFriend.friendId, false);
    }
  });

  // Network status feedback
  window.addEventListener('online', () => {
    showToast('Back online! ✅');
    if (state.userProfile) {
      invalidateCache();
      loadDashboardData();
    }
  });
  window.addEventListener('offline', () => {
    showToast('You\'re offline. The app will sync when reconnected.', 'error');
  });
});

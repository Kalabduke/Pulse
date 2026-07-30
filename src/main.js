import './style.css';
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
  updateLastSeen,
  upsertPrivateStatus,
  fetchPrivateStatusesForMe,
  clearOutgoingPrivateStatuses,
  startLocationShare,
  updateLocationShare,
  stopLocationShare,
  fetchActiveLocationShares,
  fetchMyActiveShares,
  client
} from './supabase.js';

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
  clockInterval: null,
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

const cache = {
  connections: null,
  connectionsAt: 0,
  TTL: 30000
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
    // Validate file type
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif'];
    if (!allowed.includes(file.type) && !file.type.startsWith('image/')) {
      return reject(new Error('Only image files are allowed.'));
    }
    // Validate file size — 10MB max before compression
    if (file.size > 10 * 1024 * 1024) {
      return reject(new Error('Image is too large. Max 10MB.'));
    }
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
      img.src = e.target.result;
    };
    reader.onerror = reject;
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
  toastTimer = setTimeout(() => {
    toast.className = 'toast';
  }, 4000);
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
      navigateTo('dashboard');
      setupRealtimeSync();
      await loadDashboardData();
      startSimulatorClock();
      startPollingFallback();
      setTimeout(requestNotificationPermission, 3000);
      setTimeout(registerFCMToken, 4000);
      startHeartbeat();
      resumeLocationSharing();
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
function setupRealtimeSync() {
  if (state.realtimeChannel) {
    state.realtimeChannel.unsubscribe();
    state.realtimeChannel = null;
  }

  if (!state.userProfile) return;

  state.realtimeChannel = subscribeToPulseSync(state.userProfile.id, async (change) => {
    if (change.type === 'profile_updated') {
      const updatedId = change.record.id;

      if (updatedId === state.userProfile.id) {
        state.userProfile = { ...state.userProfile, ...change.record };
        updateMyStatusUI();
        updateSimulatorUI();
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

          notifyFriendStatusUpdate(displayName, emoji, text);
          showToast(`${emoji} ${displayName} updated their status!`);
          await loadDashboardData();
        }
      }
    } else if (change.type === 'connection_changed') {
      invalidateCache();
      await loadDashboardData();
    } else if (change.type === 'new_message') {
      const msg = change.record;
      if (currentChatFriend && msg.sender_id === currentChatFriend.friendId) {
        await loadChatMessages(currentChatFriend.friendId);
        await markMessagesAsRead(currentChatFriend.friendId);
      } else {
        showToast('New message! 💬');
        invalidateCache();
        await loadDashboardData();
      }
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
  });
}

/* ==========================================
   DASHBOARD DATA
   ========================================== */
async function loadDashboardData() {
  try {
    const cachedConns = getCachedConnections();

    // fetchPrivateStatusesForMe is safe — if the table doesn't exist yet it returns empty
    const [profile, connections, privateStatuses] = await Promise.all([
      getSessionAndProfile(_savedHash, _savedSearch),
      cachedConns ? Promise.resolve(cachedConns) : fetchConnections(),
      fetchPrivateStatusesForMe().catch(() => ({ received: [], sent: [] }))
    ]);

    if (profile) {
      state.userProfile = profile;
      updateMyStatusUI();
      updateSimulatorUI();
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
      }
    } else {
      renderStatusHistory([], connections);
    }

  } catch (err) {
    console.error('[Pulse] Dashboard load error:', err);
    showToast('Failed to sync. Check your connection.', 'error');
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
      myAvatarContainer.classList.add('has-photo');
      myAvatarContainer.style.cursor = 'zoom-in';
      myAvatarContainer.onclick = () => openFullImage(state.userProfile.status_image_url);
      if (myAvatar) {
        myAvatar.innerHTML = `<img src="${escapeHtml(state.userProfile.status_image_url)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block;">`;
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
    idDisplay.textContent = state.userProfile.id;
    idDisplay.title = 'Click to copy your Pulse ID';
  }
  if (myDot) {
    myDot.className = 'online-pulse-dot';
  }
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

  const connected = state.connections.filter(c => c.status === 'connected');
  if (counterEl) counterEl.textContent = `${connected.length}/5`;

  if (connected.length === 0) {
    container.innerHTML = `
      <div class="glass-card empty-state-card">
        <span class="empty-icon">👥</span>
        No connected friends yet. Share your Pulse ID below to start syncing lockscreens in real-time!
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

    const avatarInner = hasImage
      ? `<img src="${escapeHtml(displayImage)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block;">`
      : `<span>${escapeHtml(displayEmoji || '😊')}</span>`;

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
        <div class="status-time">${formatTimeAgo(displayTime)}</div>
        ${sentPreview}
      </div>
      <div style="display:flex;flex-direction:row;gap:4px;align-self:flex-start;flex-shrink:0;margin-left:auto;">
        <button class="btn btn-secondary btn-small nickname-btn" data-conn-id="${escapeHtml(friend.connectionId)}" data-friend-id="${escapeHtml(friend.friendId)}" data-current-nickname="${escapeHtml(friend.nickname || '')}" data-real-name="${escapeHtml(friend.name)}" title="${friend.nickname ? 'Edit nickname' : 'Add nickname'}" style="padding:5px 8px;font-size:13px;line-height:1;">${friend.nickname ? '✏️' : '🏷️'}</button>
        <button class="btn btn-secondary btn-small btn-small-danger remove-connection-btn" data-conn-id="${escapeHtml(friend.connectionId)}" style="padding:5px 8px;font-size:13px;line-height:1;">✕</button>
      </div>
    `;
    container.appendChild(card);
  });

  container.querySelectorAll('.user-status-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.btn')) return;
      // If clicking the avatar that has a photo, open the image viewer
      const avatarEl = e.target.closest('.avatar-container.has-photo');
      if (avatarEl) {
        const img = avatarEl.querySelector('img');
        if (img) { openFullImage(img.src); return; }
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
            <span class="friend-email">Wants to connect with you!</span>
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
      <div class="history-item" ${hasImage ? `onclick="openFullImage('${escapeHtml(entry.status_image_url)}')" style="cursor:pointer;"` : ''}>
        <div class="history-emoji">${escapeHtml(entry.status_emoji)}</div>
        <div class="history-details">
          <span class="history-name">${escapeHtml(displayName)}</span>
          <span class="history-text">"${escapeHtml(entry.status_text || '')}"</span>
          ${hasImage ? `<img src="${escapeHtml(entry.status_image_url)}" class="history-image" alt="Status image" loading="lazy" onclick="event.stopPropagation();openFullImage('${escapeHtml(entry.status_image_url)}')">` : ''}
          <span class="history-time">${formatTimeAgo(entry.created_at)}</span>
        </div>
      </div>
    `;
  }).join('')}</div>`;
}

/* ==========================================
   CHAT / DM VIEW
   ========================================== */
async function openChat(friend) {
  currentChatFriend = friend;

  document.getElementById('chat-friend-emoji').textContent = friend.statusEmoji;
  document.getElementById('chat-friend-name').textContent = friend.displayName;

  document.querySelectorAll('.view-container').forEach(v => v.style.display = 'none');
  const chatView = document.getElementById('chat-view');
  if (chatView) chatView.style.display = 'flex';

  await loadChatMessages(friend.friendId);
  await markMessagesAsRead(friend.friendId);

  friend.unreadCount = 0;
  renderFriendsFeed();

  const container = document.getElementById('chat-messages');
  if (container) container.scrollTop = container.scrollHeight;
}

async function loadChatMessages(friendId) {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  container.innerHTML = '<div class="spinner" style="margin:auto;"></div>';

  try {
    const messages = await fetchDirectMessages(friendId);
    const myId = state.userProfile?.id;

    if (messages.length === 0) {
      container.innerHTML = '<div style="text-align:center;color:hsl(var(--text-muted));padding:40px 0;">No messages yet. Say hello! 👋</div>';
      return;
    }

    container.innerHTML = messages.map(msg => {
      const isSent = msg.sender_id === myId;
      const time = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      return `
        <div class="chat-bubble ${isSent ? 'sent' : 'received'}">
          ${msg.content_text ? `<div>${escapeHtml(msg.content_text)}</div>` : ''}
          ${msg.image_url ? `<img src="${escapeHtml(msg.image_url)}" alt="Shared image" loading="lazy" onclick="window.open('${escapeHtml(msg.image_url)}', '_blank')">` : ''}
          <span class="chat-bubble-time">${time}</span>
        </div>
      `;
    }).join('');

    container.scrollTop = container.scrollHeight;
  } catch (err) {
    container.innerHTML = '<div style="text-align:center;color:hsl(var(--text-muted));">Failed to load messages</div>';
  }
}

async function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const text = input?.value.trim() || '';
  const sendBtn = document.getElementById('chat-send-btn');

  if (!text && !currentChatImage) return;
  if (!currentChatFriend) return;

  sendBtn.disabled = true;

  try {
    let imageUrl = null;
    if (currentChatImage) {
      showToast('Uploading image...');
      imageUrl = await uploadStatusImage(currentChatImage);
    }

    await sendDirectMessage(currentChatFriend.friendId, text, imageUrl);
    if (input) input.value = '';
    removeChatImage();
    await loadChatMessages(currentChatFriend.friendId);
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
   STATUS IMAGE HANDLERS
   ========================================== */
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
      await loadDashboardData();
    }
  }, isIOS ? 20000 : 45000);

  if (!_visibilityListenerAdded) {
    _visibilityListenerAdded = true;
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible' && state.userProfile) {
        const now = Date.now();
        if (!startPollingFallback._lastVisible || now - startPollingFallback._lastVisible > 30000) {
          invalidateCache();
          await loadDashboardData();
        }
        startPollingFallback._lastVisible = now;
      } else {
        startPollingFallback._lastVisible = Date.now();
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

/* ==========================================
   LIVE LOCATION SHARING
   ========================================== */

async function resumeLocationSharing() {
  // Called on login — if user was sharing before, resume the GPS interval
  try {
    const activeShares = await fetchMyActiveShares();
    if (!activeShares || activeShares.length === 0) return;

    state.sharingLocationWith = activeShares;
    updateLocationIndicator();
    showToast('📍 Resuming location sharing.');

    // Restart the GPS update interval
    if (state.locationInterval) clearInterval(state.locationInterval);
    state.locationInterval = setInterval(() => {
      if (state.sharingLocationWith.length === 0) {
        clearInterval(state.locationInterval);
        state.locationInterval = null;
        return;
      }
      navigator.geolocation?.getCurrentPosition(async (p) => {
        await updateLocationShare(p.coords.latitude, p.coords.longitude);
      }, () => {});
    }, 15000);

    // Send current position immediately
    navigator.geolocation?.getCurrentPosition(async (p) => {
      await updateLocationShare(p.coords.latitude, p.coords.longitude);
    }, () => {});
  } catch (e) {
    // Location table doesn't exist yet or other error — ignore silently
  }
}

async function startSharingLocation(friendIds) {
  if (!navigator.geolocation) {
    showToast('Location not supported on this device.', 'error');
    return;
  }

  navigator.geolocation.getCurrentPosition(async (pos) => {
    const { latitude, longitude } = pos.coords;
    try {
      await startLocationShare(friendIds, latitude, longitude);
      state.sharingLocationWith = friendIds;
      showToast('📍 Location shared!');
      updateLocationIndicator();

      // Update every 15 seconds while sharing
      if (state.locationInterval) clearInterval(state.locationInterval);
      state.locationInterval = setInterval(() => {
        if (state.sharingLocationWith.length === 0) {
          clearInterval(state.locationInterval);
          state.locationInterval = null;
          return;
        }
        navigator.geolocation.getCurrentPosition(async (p) => {
          await updateLocationShare(p.coords.latitude, p.coords.longitude);
        }, () => {});
      }, 15000);
    } catch (err) {
      showToast(err.message || 'Failed to share location.', 'error');
    }
  }, (err) => {
    if (err.code === 1) showToast('Location permission denied.', 'error');
    else showToast('Could not get your location.', 'error');
  }, { enableHighAccuracy: true, timeout: 10000 });
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
  const indicator = document.getElementById('location-share-indicator');
  if (!indicator) return;
  if (state.sharingLocationWith.length > 0) {
    const names = state.sharingLocationWith.map(id => {
      const c = state.connections.find(c => c.friendId === id);
      return c?.nickname?.trim() || c?.name || id;
    }).join(', ');
    indicator.style.display = 'flex';
    indicator.querySelector('.loc-names').textContent = names;
  } else {
    indicator.style.display = 'none';
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
  if (!url) return;
  // Remove any existing viewer
  document.getElementById('full-image-viewer')?.remove();

  const viewer = document.createElement('div');
  viewer.id = 'full-image-viewer';
  viewer.style.cssText = `
    position: fixed; inset: 0; z-index: 9999;
    background: rgba(0,0,0,0.92);
    display: flex; align-items: center; justify-content: center;
    cursor: zoom-out; animation: fadeIn 0.2s ease;
    backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  `;

  const img = document.createElement('img');
  img.src = url;
  img.style.cssText = `
    max-width: 96vw; max-height: 90vh;
    object-fit: contain; border-radius: 12px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.8);
  `;

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = `
    position: absolute; top: 20px; right: 20px;
    background: rgba(255,255,255,0.15); border: none;
    color: white; font-size: 20px; width: 40px; height: 40px;
    border-radius: 50%; cursor: pointer; display: flex;
    align-items: center; justify-content: center;
  `;

  viewer.appendChild(img);
  viewer.appendChild(closeBtn);
  document.body.appendChild(viewer);

  const close = () => viewer.remove();
  viewer.addEventListener('click', close);
  closeBtn.addEventListener('click', (e) => { e.stopPropagation(); close(); });
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
  });
}

// Expose globally so inline onclick can call it
window.openFullImage = openFullImage;

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
        const { saveFcmToken } = await import('./supabase.js');
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

function requestNotificationPermission() {
  if (!('Notification' in window) || Notification.permission !== 'default') return;

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

function notifyFriendStatusUpdate(friendName, emoji, statusText) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  const key = friendName;
  const now = Date.now();
  // Suppress if we already notified for this friend within 10 seconds
  if (_notifDedup[key] && now - _notifDedup[key] < 10000) return;
  _notifDedup[key] = now;

  // Delegate entirely to the service worker — it handles both popup + persistent
  // Do NOT call new Notification() here; that would double-fire
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: 'FRIEND_STATUS_UPDATE',
      friendName,
      emoji,
      statusText,
      url: '/'
    });
  }
}

/* ==========================================
   EVENT LISTENERS
   ========================================== */
function initEventListeners() {

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
    if (btn) btn.textContent = isHidden ? '🙈' : '👁';
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
    if (btn) btn.textContent = inp.type === 'password' ? '👁' : '🙈';
  });

  document.getElementById('btn-toggle-confirm')?.addEventListener('click', () => {
    const inp = document.getElementById('auth-password-confirm');
    const btn = document.getElementById('btn-toggle-confirm');
    if (!inp) return;
    inp.type = inp.type === 'password' ? 'text' : 'password';
    if (btn) btn.textContent = inp.type === 'password' ? '👁' : '🙈';
  });

  document.getElementById('btn-google-auth')?.addEventListener('click', async () => {
    try {
      await signInWithGoogle();
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
        await signUpWithPassword(email, password, name);
        showToast('Account created! Check your email to confirm.');
        setAuthMode('signin');
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
    if (textInput) textInput.value = state.userProfile?.status_text || '';

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
    // If user already has an image set, disable emoji picker
    if (state.userProfile?.status_image_url && !isStatusImageRemoved) {
      _setEmojiPickerDisabled(true);
    }

    if (modal) modal.style.display = 'flex';
  });

  document.getElementById('btn-close-status-modal')?.addEventListener('click', () => {
    document.getElementById('status-modal').style.display = 'none';
  });

  document.getElementById('btn-save-status')?.addEventListener('click', async () => {
    if (!state.userProfile) return;

    const saveBtn = document.getElementById('btn-save-status');
    if (saveBtn.disabled) return;
    saveBtn.disabled = true;
    const origText = saveBtn.innerHTML;
    saveBtn.innerHTML = '<span>Saving...</span>';

    const nameInput = document.getElementById('status-name-input');
    const textInput = document.getElementById('status-text-input');
    const name = nameInput?.value.trim() || state.userProfile.name;
    const text = textInput?.value.trim() || '';

    // Check recipient mode
    const recipientRadio = document.querySelector('input[name="recipient"]:checked');
    const recipientMode = recipientRadio?.value || 'all';
    const directFriendId = document.getElementById('direct-friend-select')?.value;

    if (recipientMode === 'direct' && !directFriendId) {
      showToast('Please select a friend to send to.', 'error');
      return;
    }

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
        await updateStatus(name, state.selectedEmoji, text, imageUrl);
        showToast('Status updated! 💫');
        if (textInput) textInput.value = '';
        document.getElementById('status-modal').style.display = 'none';
        // Delete all outgoing private statuses — everyone now sees the public update
        state.privateSentByMe = {};
        state.privateStatuses = {};
        await clearOutgoingPrivateStatuses();
        await notifyFriendsOfUpdate(state.userProfile.id, name, state.selectedEmoji, text);
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
    if (e.target.files?.[0]) handleStatusImage(e.target.files[0], false);
  });

  document.getElementById('status-camera-input')?.addEventListener('change', (e) => {
    if (e.target.files?.[0]) handleStatusImage(e.target.files[0], false);
  });

  document.getElementById('status-remove-image')?.addEventListener('click', () => {
    removeStatusImage();
  });

  document.getElementById('status-camera-btn')?.addEventListener('click', () => {
    document.getElementById('status-camera-input')?.click();
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
    };
    statusTextInput.addEventListener('input', updateCounter);
    updateCounter();
  }

  // Connections
  document.getElementById('btn-send-invite')?.addEventListener('click', async () => {
    const input = document.getElementById('friend-id-input');
    const btn = document.getElementById('btn-send-invite');
    const id = input?.value.trim();

    if (!id) {
      showToast('Please enter a Pulse ID.', 'error');
      return;
    }
    if (btn.disabled) return;
    btn.disabled = true;

    try {
      await sendConnectionRequest(id);
      showToast('Connection request sent! ✉️');
      if (input) input.value = '';
      await loadDashboardData();
    } catch (err) {
      showToast(err.message || 'Failed to send request', 'error');
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('btn-refresh')?.addEventListener('click', async () => {
    invalidateCache();
    await loadDashboardData();
    showToast('Refreshed! 🔄');
  });

  document.getElementById('btn-copy-id')?.addEventListener('click', async () => {
    if (!state.userProfile?.id) return;
    try {
      await navigator.clipboard.writeText(state.userProfile.id);
      showToast('Pulse ID copied to clipboard! 📋');
    } catch (err) {
      showToast('Failed to copy ID', 'error');
    }
  });

  document.getElementById('my-id-display')?.addEventListener('click', async () => {
    if (!state.userProfile?.id) return;
    try {
      await navigator.clipboard.writeText(state.userProfile.id);
      showToast('Pulse ID copied to clipboard! 📋');
    } catch (err) {
      showToast('Failed to copy ID', 'error');
    }
  });

  // Chat
  document.getElementById('chat-send-btn')?.addEventListener('click', sendChatMessage);

  document.getElementById('chat-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
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
    if (picker && !picker.contains(e.target) && e.target !== btn) {
      picker.style.display = 'none';
    }
  });

  document.getElementById('chat-file-input')?.addEventListener('change', (e) => {
    if (e.target.files?.[0]) handleChatImage(e.target.files[0], false);
  });

  document.getElementById('chat-camera-input')?.addEventListener('change', (e) => {
    if (e.target.files?.[0]) handleChatImage(e.target.files[0], false);
  });

  document.getElementById('chat-remove-image')?.addEventListener('click', () => {
    removeChatImage();
  });

  document.getElementById('chat-camera-btn')?.addEventListener('click', () => {
    document.getElementById('chat-camera-input')?.click();
  });

  document.getElementById('chat-file-btn')?.addEventListener('click', () => {
    // Gallery button opens file picker (no capture)
    document.getElementById('chat-file-input')?.click();
  });

  document.getElementById('chat-back-btn')?.addEventListener('click', () => {
    currentChatFriend = null;
    // Close emoji picker if open
    const picker = document.getElementById('chat-emoji-picker');
    if (picker) picker.style.display = 'none';
    navigateTo('dashboard');
    loadDashboardData();
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

  // Location sharing
  document.getElementById('btn-location')?.addEventListener('click', () => {
    openLocationModal();
  });

  document.getElementById('btn-close-location-modal')?.addEventListener('click', () => {
    document.getElementById('location-modal').style.display = 'none';
  });

  document.getElementById('btn-start-location')?.addEventListener('click', async () => {
    const modal = document.getElementById('location-modal');
    const checked = [...document.querySelectorAll('.location-friend-check:checked')].map(c => c.value);
    if (checked.length === 0) {
      showToast('Select at least one friend.', 'error');
      return;
    }
    modal.style.display = 'none';
    await startSharingLocation(checked);
  });

  document.getElementById('btn-stop-selected-location')?.addEventListener('click', async () => {
    const checked = [...document.querySelectorAll('.location-friend-check:checked')].map(c => c.value);
    document.getElementById('location-modal').style.display = 'none';
    await stopSharingLocation(checked.length > 0 ? checked : null);
  });

  document.getElementById('btn-stop-location')?.addEventListener('click', async () => {
    await stopSharingLocation(null); // stop all
  });

  // Show/hide stop button based on selection in location modal
  document.getElementById('location-friend-list')?.addEventListener('change', () => {
    const anyChecked = document.querySelectorAll('.location-friend-check:checked').length > 0;
    const anyActive = [...document.querySelectorAll('.location-friend-check:checked')]
      .some(c => state.sharingLocationWith.includes(c.value));
    document.getElementById('btn-stop-selected-location').style.display =
      anyActive ? 'flex' : 'none';
  });
}

/* ==========================================
   LOCKSCREEN SIMULATOR
   ========================================== */
function startSimulatorClock() {
  if (state.clockInterval) clearInterval(state.clockInterval);

  const updateClock = () => {
    const now = new Date();
    const timeEl = document.getElementById('sim-time');
    const dateEl = document.getElementById('sim-date');
    if (timeEl) {
      timeEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    if (dateEl) {
      dateEl.textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    }
  };

  updateClock();
  state.clockInterval = setInterval(updateClock, 1000);
}

function updateSimulatorUI() {
  const simEmoji = document.getElementById('sim-emoji');
  const simText = document.getElementById('sim-text');
  const simImage = document.getElementById('sim-image');

  if (simEmoji) simEmoji.textContent = state.userProfile?.status_emoji || '😊';
  if (simText) simText.textContent = state.userProfile?.status_text || 'Available';
  if (simImage) {
    if (state.userProfile?.status_image_url) {
      simImage.src = state.userProfile.status_image_url;
      simImage.style.display = 'block';
    } else {
      simImage.style.display = 'none';
    }
  }
}

/* ==========================================
   INIT
   ========================================== */
document.addEventListener('DOMContentLoaded', () => {
  initEmojiPicker();
  initEventListeners();
  registerServiceWorker();
  checkNavigationState();
});

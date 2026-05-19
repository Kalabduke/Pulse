const CACHE_NAME = 'pulse-v5';

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/notification-icon.png'
];

// ==========================================
// INSTALL
// ==========================================
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.allSettled(
        SHELL_ASSETS.map(url => cache.add(url).catch(() => {}))
      ))
      .then(() => self.skipWaiting())
  );
});

// ==========================================
// ACTIVATE
// ==========================================
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(
        names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

// ==========================================
// FETCH — Stale-while-revalidate for static, network-first for dynamic
// ==========================================
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (request.url.includes('supabase.co')) return;
  if (!request.url.startsWith('http')) return;

  // Static assets (JS, CSS, fonts, images) — serve from cache instantly, update in background
  const isStatic = request.destination === 'script' ||
    request.destination === 'style' ||
    request.destination === 'font' ||
    request.destination === 'image' ||
    request.url.includes('/assets/');

  if (isStatic) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async cache => {
        const cached = await cache.match(request);
        const fetchPromise = fetch(request).then(res => {
          if (res.ok) cache.put(request, res.clone());
          return res;
        }).catch(() => cached);

        // Return cached immediately, update in background
        return cached || fetchPromise;
      })
    );
    return;
  }

  // Navigation and other requests — network first, cache fallback
  event.respondWith(
    fetch(request)
      .then(res => {
        if (res.ok && res.type === 'basic' && !request.url.includes('hot-update')) {
          caches.open(CACHE_NAME).then(c => c.put(request, res.clone()));
        }
        return res;
      })
      .catch(() => caches.match(request).then(cached => {
        if (cached) return cached;
        if (request.mode === 'navigate') return caches.match('/index.html');
        return new Response('Offline', { status: 503 });
      }))
  );
});

// ==========================================
// CORE NOTIFICATION HELPER
// Shows TWO notifications:
//   1. Pop-up alert (unique tag per friend) — appears as heads-up banner
//   2. Persistent summary (fixed tag) — stays in tray like a live widget
// ==========================================
function showStatusNotification({ friendName, emoji, statusText, url = '/' }) {
  const popupTitle = `${emoji} ${friendName}`;
  const popupBody  = `"${statusText}"`;
  const summaryBody = `${emoji} ${friendName}: "${statusText}"`;

  // 1. Pop-up heads-up notification (unique tag so it doesn't replace others)
  const popupPromise = self.registration.showNotification(popupTitle, {
    body: popupBody,
    icon: '/icon-192.png',
    badge: '/notification-icon.png',
    tag: `pulse-popup-${friendName}-${Date.now()}`,
    renotify: true,
    requireInteraction: false,
    silent: false,
    vibrate: [200, 100, 200],
    data: { url },
    actions: [
      { action: 'open',    title: '👀 View' },
      { action: 'dismiss', title: '✕' }
    ]
  });

  // 2. Persistent summary notification (fixed tag — replaces itself, stays on lockscreen)
  const persistentPromise = self.registration.showNotification('Pulse — Live Status', {
    body: summaryBody,
    icon: '/icon-192.png',
    badge: '/notification-icon.png',
    tag: 'pulse-live-widget',
    renotify: false,       // silent update — no second buzz
    requireInteraction: false,
    silent: true,          // no sound for the persistent one
    data: { url },
    actions: [
      { action: 'open', title: '👀 Open Pulse' }
    ]
  });

  return Promise.all([popupPromise, persistentPromise]);
}

// ==========================================
// PUSH — from server (future web push)
// ==========================================
self.addEventListener('push', (event) => {
  let friendName = 'A friend';
  let emoji = '💫';
  let statusText = 'Updated their status';
  let url = '/';

  if (event.data) {
    try {
      const d = event.data.json();
      friendName  = d.friendName  || friendName;
      emoji       = d.emoji       || emoji;
      statusText  = d.statusText  || statusText;
      url         = d.url         || url;
    } catch {
      statusText = event.data.text() || statusText;
    }
  }

  event.waitUntil(showStatusNotification({ friendName, emoji, statusText, url }));
});

// ==========================================
// NOTIFICATION CLICK
// ==========================================
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'dismiss') return;

  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        for (const client of clientList) {
          if (client.url.includes(self.location.origin) && 'focus' in client) {
            return client.focus();
          }
        }
        return clients.openWindow(targetUrl);
      })
  );
});

// ==========================================
// BACKGROUND SYNC
// ==========================================
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-status') {
    event.waitUntil(
      clients.matchAll().then(list =>
        list.forEach(c => c.postMessage({ type: 'SYNC_REQUESTED' }))
      )
    );
  }
});

// ==========================================
// MESSAGE — from app to SW
// ==========================================
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  // Triggered by realtime subscription when a friend updates
  if (event.data?.type === 'FRIEND_STATUS_UPDATE') {
    const { friendName, emoji, statusText, url } = event.data;
    event.waitUntil(showStatusNotification({ friendName, emoji, statusText, url }));
  }
});

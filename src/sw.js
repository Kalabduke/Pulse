const CACHE_NAME = 'pulse-v2';

// Core shell assets to pre-cache on install
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/logo.svg',
  '/notification-icon.png'
];

// ==========================================
// INSTALL — Pre-cache the app shell
// ==========================================
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[SW] Pre-caching app shell');
        // Use individual adds so one failure doesn't block the rest
        return Promise.allSettled(
          SHELL_ASSETS.map(url => cache.add(url).catch(err => {
            console.warn('[SW] Failed to cache:', url, err);
          }))
        );
      })
      .then(() => self.skipWaiting())
  );
});

// ==========================================
// ACTIVATE — Clean up old caches
// ==========================================
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => {
            console.log('[SW] Deleting old cache:', name);
            return caches.delete(name);
          })
      ))
      .then(() => self.clients.claim())
  );
});

// ==========================================
// FETCH — Network-first with cache fallback
// ==========================================
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET requests
  if (request.method !== 'GET') return;

  // Skip Supabase API calls — always go to network
  if (request.url.includes('supabase.co')) return;

  // Skip chrome-extension and non-http(s) requests
  if (!request.url.startsWith('http')) return;

  event.respondWith(
    fetch(request)
      .then((networkResponse) => {
        // Cache successful same-origin responses
        if (
          networkResponse.ok &&
          networkResponse.type === 'basic' &&
          !request.url.includes('hot-update')
        ) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, responseClone));
        }
        return networkResponse;
      })
      .catch(() => {
        // Network failed — try cache
        return caches.match(request).then((cachedResponse) => {
          if (cachedResponse) return cachedResponse;

          // For navigation requests, return the app shell
          if (request.mode === 'navigate') {
            return caches.match('/index.html');
          }

          // Nothing available
          return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
        });
      })
  );
});

// ==========================================
// PUSH — Handle incoming push notifications
// ==========================================
self.addEventListener('push', (event) => {
  let title = 'Pulse';
  let body = 'Someone updated their status!';
  let icon = '/logo.svg';
  let badge = '/notification-icon.png';

  if (event.data) {
    try {
      const data = event.data.json();
      title = data.title || title;
      body = data.body || body;
      icon = data.icon || icon;
    } catch {
      body = event.data.text() || body;
    }
  }

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon,
      badge,
      vibrate: [100, 50, 100],
      tag: 'pulse-status',
      renotify: true,
      data: { url: '/' }
    })
  );
});

// ==========================================
// NOTIFICATION CLICK — Focus or open app
// ==========================================
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        // Focus existing window if open
        for (const client of clientList) {
          if ('focus' in client) return client.focus();
        }
        // Otherwise open a new window
        return clients.openWindow('/');
      })
  );
});

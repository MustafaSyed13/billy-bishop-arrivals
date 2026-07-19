"use strict";
/* Service worker: stale-while-revalidate for the app shell.
   Same-origin GETs are served from cache instantly, then refreshed in the
   background, so the app opens in milliseconds and works offline.
   Cross-origin requests (data feeds, map tiles, CDN) pass straight through.

   CacheStorage is shared across the whole GitHub Pages origin, so this app
   uses its own "bba-" prefix and only ever deletes its own old caches. */

const CACHE = "bba-shell-v11";
const LEGACY_CACHES = ["ytz-shell-v8"]; // pre-prefix cache from earlier versions
const SHELL = ["./", "manifest.json", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .catch(() => {}) // partial precache failure must not block install
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((k) => (k.startsWith("bba-") && k !== CACHE) || LEGACY_CACHES.includes(k))
          .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (c) => {
      const cached = await c.match(e.request);
      const fresh = fetch(e.request)
        .then((res) => {
          if (res && res.ok) c.put(e.request, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((tabs) => {
      if (tabs.length) return tabs[0].focus();
      return self.clients.openWindow(".");
    })
  );
});

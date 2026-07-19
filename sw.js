"use strict";
/* Service worker.
   - Navigations (opening/refreshing the page): network-first, so one refresh
     always gets the newest version; falls back to cache offline.
   - Assets: stale-while-revalidate for instant loads.
   - Cross-origin (data feeds, map tiles): passed straight through.
   CacheStorage is shared across the whole GitHub Pages origin, so this app
   uses its own "bba-" prefix and only ever deletes its own old caches. */

const CACHE = "bba-shell-v12";
const LEGACY_CACHES = ["ytz-shell-v8"];
const SHELL = ["./", "manifest.json", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .catch(() => {})
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
  if (url.searchParams.has("upd")) return; // self-update version checks bypass all caching

  if (e.request.mode === "navigate") {
    e.respondWith(
      caches.open(CACHE).then(async (c) => {
        try {
          const fresh = await fetch(e.request);
          if (fresh && fresh.ok) c.put(e.request, fresh.clone());
          return fresh;
        } catch {
          return (await c.match(e.request)) || (await c.match("./")) || Response.error();
        }
      })
    );
    return;
  }

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

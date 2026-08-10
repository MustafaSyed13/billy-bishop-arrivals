"use strict";
/* Service worker.
   - Navigations (opening/refreshing the page): network-first, so one refresh
     always gets the newest version; falls back to cache offline.
   - Assets: stale-while-revalidate for instant loads.
   - Cross-origin (data feeds, map tiles): passed straight through.
   CacheStorage is shared across the whole GitHub Pages origin, so this app
   uses its own "bba-" prefix and only ever deletes its own old caches. */

/* BUMP THIS on every release that changes app code. On activate we delete every
   other "bba-" cache, so one reload wipes stale copies. Bumping the ?v= on the
   script tag alone is NOT enough: it only helps once the browser has a fresh
   index.html to read the new URL from. */
const CACHE = "bba-shell-v14";
const LEGACY_CACHES = ["ytz-shell-v8"];
const SHELL = ["index.html", "manifest.json", "icon-192.png", "icon-512.png"];

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
        // Some managed browsers (CBSA Edge) permanently cached a 301 for the
        // bare scope root during the brief custom-domain attempt. Two defences:
        // 1) rewrite root navigations to index.html — same page, but a URL the
        //    poisoned cache entry can never match; 2) fetch with redirect:
        //    "manual" so a stale redirect is treated as a failure instead of
        //    being followed into caching a foreign site as our app. Net effect:
        //    one successful visit anywhere in scope immunizes the machine.
        const target = url.pathname.endsWith("/")
          ? new URL("index.html" + url.search, url).href
          : e.request;
        try {
          const fresh = await fetch(target, { redirect: "manual" });
          if (fresh && fresh.type === "opaqueredirect") throw new Error("stale cached redirect");
          if (fresh && fresh.ok) {
            c.put(target, fresh.clone());
            return fresh;
          }
          throw new Error("nav fetch " + (fresh && fresh.status));
        } catch {
          return (await c.match(target)) || (await c.match("index.html")) ||
                 (await c.match(e.request)) || (await c.match("./")) || Response.error();
        }
      })
    );
    return;
  }

  // Our own code is network-first. Stale-while-revalidate served the cached
  // copy and only refreshed it in the background, so a release did not reach
  // anyone until their SECOND reload - which is why fixes appeared to not ship.
  // Icons and the manifest stay cache-first; they rarely change and are the
  // ones worth having instantly offline.
  const isAppCode = /\.(?:js|css|html)$/.test(url.pathname);

  e.respondWith(
    caches.open(CACHE).then(async (c) => {
      if (isAppCode) {
        try {
          const fresh = await fetch(e.request);
          if (fresh && fresh.ok) { c.put(e.request, fresh.clone()); return fresh; }
          throw new Error("asset " + (fresh && fresh.status));
        } catch {
          return (await c.match(e.request)) || Response.error();
        }
      }
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
      return self.clients.openWindow("index.html");
    })
  );
});

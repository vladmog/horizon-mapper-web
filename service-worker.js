"use strict";

const CACHE = "horizon-mapper-shell-v1";
const SHELL = [
  "./", "./index.html", "./manifest.webmanifest", "./privacy.html",
  "./browser-profile.js", "./terrain-worker.js", "./horizon-core.js", "./pwa.js",
  "./diagnostics.js", "./log-sanitize.js", "./photo-location.js",
  "./satellite-map.js", "./terrain-game.js", "./terrain-view.js",
  "./photo-viewer.js", "./named-peaks.js", "./project-assets.js",
  "./vendor/exifr-7.1.3.js", "./icons/icon-192.png", "./icons/icon-512.png",
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== location.origin) return;
  event.respondWith(caches.match(event.request).then(async cached => {
    if (cached) {
      event.waitUntil(fetch(event.request).then(response => {
        if (response.ok) return caches.open(CACHE).then(cache => cache.put(event.request, response));
      }).catch(() => {}));
      return cached;
    }
    try {
      const response = await fetch(event.request);
      if (response.ok) caches.open(CACHE).then(cache => cache.put(event.request, response.clone()));
      return response;
    } catch (error) {
      if (event.request.mode === "navigate") return caches.match("./index.html");
      throw error;
    }
  }));
});

"use strict";

const CACHE = "horizon-mapper-workspace-v58";
const SHELL = [
  "./", "./index.html", "./workspace.css", "./welcome-ridgeline.webp", "./workspace.js", "./manifest.webmanifest", "./privacy.html",
  "./browser-profile.js", "./terrain-worker.js", "./horizon-core.js", "./pwa.js",
  "./diagnostics.js", "./log-sanitize.js", "./photo-location.js",
  "./satellite-map.js", "./terrain-game.js", "./terrain-view.js",
  "./photo-viewer.js", "./named-peaks.js", "./place-search.js", "./project-assets.js",
  "./vendor/exifr-7.1.3.js", "./icons/icon-192.png", "./icons/icon-512.png",
];

// A release is installed as one complete shell. Never replace individual
// cached files in the background: a new page with old scripts can break uploads.
const shellURLs=new Map(SHELL.map(path=>{
  const url=new URL(path,self.registration.scope);
  return [url.pathname,url.href];
}));
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE)
    .then(cache => cache.addAll(SHELL.map(path=>new Request(new URL(path,self.registration.scope),{cache:"reload"}))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys
    .filter(key => key.startsWith("horizon-mapper-") && key !== CACHE)
    .map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

// The large desktop artwork is cached only on displays that request it.
const wideHero = new URL("./welcome-ridgeline-wide.webp", self.registration.scope).href;
async function desktopHero() {
  const cache = await caches.open(CACHE);
  const saved = await cache.match(wideHero);
  if (saved) return saved;
  try {
    const response = await fetch(wideHero);
    if (response.ok) {
      try { await cache.put(wideHero, response.clone()); } catch { /* Still display the online image if storage is full. */ }
      return response;
    }
  } catch { /* Offline: the standard artwork is in the shell. */ }
  return await cache.match(new URL("./welcome-ridgeline.webp", self.registration.scope).href) || Response.error();
}

self.addEventListener("fetch", event => {
  const url=new URL(event.request.url),asset=shellURLs.get(url.pathname);
  if(event.request.method==="GET" && url.href===wideHero) {
    event.respondWith(desktopHero());
    return;
  }
  if(event.request.method!=="GET" || url.origin!==location.origin || !asset)return;
  event.respondWith(caches.match(asset,{cacheName:CACHE}).then(cached=>{
    if(cached)return cached;
    // Cache eviction can remove a shell. Avoid stale HTTP-cache responses on
    // recovery, and leave the next service-worker installation to cache it fully.
    return fetch(new Request(event.request,{cache:"reload"}));
  }));
});

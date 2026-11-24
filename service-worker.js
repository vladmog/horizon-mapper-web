"use strict";

const CACHE = "horizon-mapper-workspace-v46";
const SHELL = [
  "./", "./index.html", "./workspace.css", "./workspace.js", "./manifest.webmanifest", "./privacy.html",
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

self.addEventListener("fetch", event => {
  const url=new URL(event.request.url),asset=shellURLs.get(url.pathname);
  if(event.request.method!=="GET" || url.origin!==location.origin || !asset)return;
  event.respondWith(caches.match(asset,{cacheName:CACHE}).then(cached=>{
    if(cached)return cached;
    // Cache eviction can remove a shell. Avoid stale HTTP-cache responses on
    // recovery, and leave the next service-worker installation to cache it fully.
    return fetch(new Request(event.request,{cache:"reload"}));
  }));
});

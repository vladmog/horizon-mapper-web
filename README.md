# Horizon Mapper Web

Horizon Mapper Web is the browser-only, installable version of Horizon Mapper. It maps a photographed or live GPS viewpoint against real terrain, supports 2D, 3D, perspective, and game views, loads GPX tracks, and saves multi-photo projects locally.

## Run locally

Serve this directory over HTTPS or from `localhost`; opening `index.html` directly will not give Web Workers, location, and motion sensors the required browser security context.

```sh
python3 -m http.server 8080
```

Then open `http://localhost:8080/`. GitHub Pages supplies HTTPS in production. On iPhone or Android, use the browser's **Add to Home Screen** command to install it.

## Architecture

There is no application server and no build step. `terrain-worker.js` fetches public Terrarium elevation tiles from AWS Open Data, caches them in IndexedDB, computes the horizon off the main thread, and sends the profile and terrain mesh directly to the UI. The app requests Esri imagery tiles and OpenStreetMap peak names directly from their public endpoints.

## Privacy

Photos, GPX files, project files, diagnostics, and saved projects stay in the browser unless the user explicitly downloads or exports them. The repository contains no certificates, credentials, server logs, machine names, personal paths, or user data.

Mapping still requires third-party data requests. AWS, Esri, and the OpenStreetMap Overpass service receive tile coordinates or a search area and can therefore infer the approximate viewed location. See [privacy.html](privacy.html) for the user-facing disclosure.

## Deployment

The Pages workflow publishes the repository root after every push to `main`. The workflow needs GitHub Pages configured to use **GitHub Actions** as its source.

# Horizon Mapper Web

Horizon Mapper Web is the browser-only, installable version of Horizon Mapper. It maps a photographed or live GPS viewpoint against real terrain, supports 2D, 3D, perspective, and game views, loads GPX tracks, and saves multi-photo projects locally.

**Live app:** https://vladmog.github.io/horizon-mapper-web/

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

## Expanded map views and external maps

Use **Full screen** beside the map-view selector to expand 2D, 3D, or Perspective to fill the browser viewport. Switch views while expanded; **Exit full screen** or Escape restores the page. Game keeps its existing full-screen layout. Exiting Game returns to the previous map view, including its expanded state.

In Game, mark a target with the laser or use an existing selected map target, then choose **Open in Apple Maps**, **Google Maps**, or **Gaia GPS**. This uses the same provider selected on the main page and the same target coordinates. When no target is selected, Nav opens the avatar’s current location.

### Search for a location

Choose **Search** on the startup screen or in the Location panel. Enter a street
address or place name such as **Mount Fuji** or **Mount Everest**, then submit
the search. Photon returns OpenStreetMap matches. A single match opens directly.
When several places match, choose the one in the intended region.

You can also enter a latitude/longitude pair such as `37.7749, -122.4194`.
Use decimal degrees, latitude first, with negative values for south or west.
Latitude must be between -80 and 80 degrees (the terrain engine's coverage),
and longitude between -180 and 180. A comma or whitespace separates the values.

The horizon maps automatically at ground plus eye level, initially facing north.
Drag the profile to change bearing; range changes remap automatically. The map,
3D, Perspective, and Open in Maps use the entered location. No photo or sensor
permission is required. Invalid input leaves the current mapped location intact.
Use **Upload photo** or **Use device GPS** to switch back. Entered coordinates
are a temporary viewpoint, not an asset saved in a photo/GPX project.

## UI redesign branch

The `redesign/terrain-workspace` branch reorganizes the app into a map and horizon workspace with Location, Project, and Settings panels. Phone controls open in a panel; desktop controls stay in a sidebar. Labels are direct and the interface is grayscale, with color retained for map data and meaningful status.

All existing map modes and project operations remain available. Selecting device GPS now maps its first fix automatically; coordinates and photos still map immediately. GPS permissions are requested only after an explicit location action.

See `docs/ui-redesign.md` for the acceptance criteria, browser checks, and device-testing limits. Run `npm ci` and `npm test` for the UI suite (install Playwright Chromium first on Linux).

## Walk starting height

From an orbited Terrain view, Walk inherits the camera’s position, altitude, and aim.
From the initial top-down view, Walk looks straight down at the same center and
fits the visible ground footprint using the fullscreen Walk lens.
If the camera is outside the loaded mesh, Walk loads a temporary terrain square
centered there (up to 6 km from center to edge). Cancel keeps the Terrain view.
Terrain entry preserves altitude until the avatar’s feet meet the ground and
allows flight above the usual ceiling. Exiting the temporary area restores the
original model and Terrain view. Movement stays inside the session’s loaded square. Fly to Start returns to the
active source (Search, photo, or GPS) with the avatar’s eyes 30 m above local ground. If
the marker is outside the temporary square, Walk switches back to the original
terrain and flies the remaining covered distance.

Map and Viewpoint entries retain a minimum eye height of 30 m and the usual
5,000 m flight ceiling. Fly to Target arrives with the avatar’s eyes 30 m
above the terrain at the marked point, regardless of the departure altitude.

## Walk laser search

Tap **Search** beside **Mark laser** to identify the laser’s current terrain hit.
This is independent of marker placement and never searches while moving or aiming.
The compact card keeps the searched point fixed until the next search or dismissal.
It shows an OpenStreetMap name/category or address when available, otherwise only
coordinates, with a Google search link. A nearby match is labeled with its distance;
it is not a claim that the laser identified a particular shop or building wall.
The terrain model has no building geometry. Mountain matches are limited to nearby
summits with compatible elevations; unknown slopes can remain unnamed.

The client sends one bounded query to https://photon.komoot.io/reverse
per explicit search, with a two-second minimum interval, one request in flight,
a 15-second timeout, cancellation on close/exit, and a 64-entry, ten-minute memory
cache. No key or backend is required. Service availability and OSM coverage vary.
Provider terms: https://photon.komoot.io/ . No public Nominatim service is used.

Validation: `tests/place-search.test.cjs` covers ranking, address fallback, and response normalization;
`tests/workspace.test.cjs` covers explicit-only requests, captured coordinates,
caching, failures, dismissal races, and mobile layout. Those tests use controlled
API responses; live service checks are separate.

## Publishing an app update

Increment the integer `HORIZON_RELEASE` in `pwa.js` whenever preparing a changed
app for preview or publication. The same value identifies the installed offline
cache and appears at the bottom of Settings. Publish the tested preview with its
existing number. The Pages workflow checks for an increase when app assets change.

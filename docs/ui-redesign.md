# UI redesign

Branch: `redesign/terrain-workspace`. Base: `bfc9998` on `main`.

## Acceptance criteria

- Coordinates, photos, GPS, GPX, project storage, named peaks, profile selection, and external-map links remain available.
- Map, Terrain, Viewpoint, Walk, and full-screen modes remain usable.
- The location, project, and settings panels are discoverable at desktop and phone widths; no horizontal document overflow from 320 px upward.
- GPS and motion permissions are requested only after the user selects device location.
- Mobile panels isolate background controls, contain keyboard focus, close with Escape, and restore focus.
- Grayscale interface, literal labels, and color reserved for status, geographic imagery, selected targets, and distinguishing project/map data.
- Terrain and photo engines retain their existing calculations and data formats.

## Implementation

`workspace.css` replaces the previous inline stylesheet. `workspace.js` manages sidebar selection, mobile panels, keyboard focus, source indicators, and empty/loading states. `index.html` groups controls into a sidebar and map/horizon workspace. `project-assets.js` keeps the same storage format and item operations in the new Project panel.

The first GPS fix maps automatically after an explicit location request. Viewpoint and Walk disable synchronously when terrain reloads, preventing fast taps from appearing to do nothing. The service worker includes both new workspace assets under a new cache name.

## Validation

- Five headless Chrome browser suites pass. They cover eight sizes: 320×568, 390×844, 430×932, 667×375, 844×390, 768×1024, 1024×768, and 1440×900.
- Browser checks cover startup, every tool panel, invalid coordinates, focus containment and Escape, location submission, all four map modes, full screen, point selection, custom observer height, photo upload, saving and reopening projects, GPX, map-provider preferences, and explicit GPS access.
- Deterministic UI tests replay recorded terrain output from a public Paris sample location. Photo metadata and geolocation are simulated. These tests do not establish terrain-computation accuracy, EXIF decoding accuracy, or physical device sensor behavior.
- A separate real browser smoke test loaded terrain and imagery at 46.7865, -121.7367 and exercised Terrain, Viewpoint, and Walk. No mocked elevation or imagery was used in that smoke test.
- All existing HTML element IDs are retained without duplicates. Nine terrain, mapping, and photo engine modules are byte-identical to main.
- 117 inherited parent-app checks pass against the browser-only UI. Two peak-service tests expect the Mac server's API response format; they also fail against the unmodified browser-only main branch. The peak lookup implementation is unchanged.
- Actual iPhone/Safari touch, sensor permissions, installed-PWA updates, and device performance remain unverified. Headless mobile viewport checks are not device tests.

## Running the browser checks

```sh
npm ci
npx playwright install chromium
npm test
```

On macOS, the tests use the installed Google Chrome by default. Set `CHROME_PATH` to override it. `PLAYWRIGHT_MODULE` can point to an existing Playwright installation. The test server binds only to loopback and closes when tests finish.

`tests/fixtures/paris-terrain.json.gz` contains recorded terrain output at 48.8584, 2.2945, for deterministic UI transitions. It contains no personal location or photo data.

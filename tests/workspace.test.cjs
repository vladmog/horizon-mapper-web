"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http"),
  zlib = require("node:zlib");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(__dirname, "..");
const fixture = JSON.parse(
  zlib.gunzipSync(
    fs.readFileSync(path.join(__dirname, "fixtures/paris-terrain.json.gz")),
  ),
);
let server, browser, url;
before(async () => {
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname.includes("..") || pathname.includes("/.")) {
      res.writeHead(404);
      res.end();
      return;
    }
    const file = path.join(root, pathname === "/" ? "index.html" : pathname);
    try {
      res.setHeader(
        "Content-Type",
        {
          ".html": "text/html",
          ".js": "application/javascript",
          ".css": "text/css",
          ".json": "application/json",
        }[path.extname(file)] || "application/octet-stream",
      );
      res.end(fs.readFileSync(file));
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      (process.platform === "darwin"
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : undefined),
    args: ["--enable-unsafe-swiftshader"],
  });
});
after(async () => {
  await browser?.close();
  await new Promise((r) => server?.close(r));
});
async function pageFor(size = { width: 1440, height: 900 }, mapped = false, colorScheme = "light") {
  const context = await browser.newContext({
    viewport: size,
    colorScheme,
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  // All UI checks are deterministic; external imagery/peak services are not prerequisites.
  await page.route(/https:\/\//, (route) => route.abort());
  await page.addInitScript(
    ({ fixture, mapped }) => {
      window.__gpsRequests = 0;
      Object.defineProperty(navigator, "geolocation", {
        value: {
          watchPosition(success) {
            window.__gpsRequests++;
            window.__gpsSuccess = success;
            return 1;
          },
          clearWatch() {},
        },
      });
      if (mapped) {
        // Recorded server output exercises UI state and view transitions, not terrain accuracy.
        window.Worker = class {
          constructor() {
            this.closed = false;
          }
          postMessage(message) {
            window.__lastRequest = message.options;
            window.__terrainRequests=(window.__terrainRequests || 0)+1;
            setTimeout(() => {
              if (this.closed) return;
              for (const type of ["result", "terrain"])
                this.onmessage?.({
                  data: { type, data: structuredClone(fixture[type]) },
                });
              this.onmessage?.({ data: { type: "complete" } });
            }, 20);
          }
          terminate() {
            this.closed = true;
          }
        };
      }
    },
    { fixture, mapped },
  );
  await page.goto(url);
  await page.waitForFunction(() => !!window.HorizonUI);
  return page;
}
async function close(page) {
  assert.deepEqual(page.errors, []);
  await page.context().close();
}
async function noOverflow(page) {
  const overflow = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  assert.ok(overflow.scroll <= overflow.width + 1, JSON.stringify(overflow));
}
async function openSettings(page) {
  await page.locator(page.viewportSize().width<=900?'[data-mobile-panel="settings"]':'[data-panel="settings"]').click();
}
async function assertDefaultStart(page) {
  const state=await page.evaluate(()=>{
    const g=terrainView.game, model=g.view.model;
    g.step(1/60);
    const eye=g.aimCamera().eye, point=walkGeographicPoint(model,eye);
    return {point,lat:S.pos.coords.latitude,lon:S.pos.coords.longitude,
      clearance:point.elev-gameGround(g.view,eye[0],eye[2]),flying:g.flying};
  });
  assert.ok(Math.abs(state.point.lat-state.lat)<1e-8 && Math.abs(state.point.lon-state.lon)<1e-8);
  assert.ok(Math.abs(state.clearance-30)<1e-6);
  assert.equal(state.flying,true);
}
async function mapCoordinates(page) {
  await page.locator("#gate-coordinates").click();
  await page.locator("#coordinate-input").fill("48.8584, 2.2945");
  await page.locator("#coordinate-submit").click();
  await page.waitForFunction(
    () =>
      HZ.P &&
      terrainData &&
      !HZ.loading &&
      !document.getElementById("card-horizon").hidden,
  );
}
test("responsive startup and every tools panel fit 320px through desktop, without sensor prompts", async () => {
  for (const [width, height] of [
    [320, 568],
    [390, 844],
    [430, 932],
    [667, 375],
    [844, 390],
    [768, 1024],
    [1024, 768],
    [1440, 900],
  ]) {
    const page = await pageFor({ width, height });
    await noOverflow(page);
    assert.equal(await page.evaluate(() => window.__gpsRequests), 0);
    assert.equal(await page.locator("#gate").isVisible(), true);
    assert.equal(await page.locator("#card-horizon").isVisible(), false);
    for (const panel of ["location", "project", "settings"]) {
      if (width <= 900)
        await page.locator(`[data-mobile-panel="${panel}"]`).click();
      else await page.locator(`[data-panel="${panel}"]`).click();
      assert.equal(await page.locator(`#panel-${panel}`).isVisible(), true);
      await noOverflow(page);
      const panelBounds = await page.locator("#sidebar").boundingBox();
      assert.ok(
        panelBounds.x >= 0 && panelBounds.x + panelBounds.width <= width + 1,
      );
      if (width <= 900) {
        await page.locator("#panel-close").click();
        assert.equal(await page.locator("#sidebar").isVisible(), false);
      }
    }
    await close(page);
  }
});
test("mobile location panel validates input, traps keyboard focus and restores access to the map", async () => {
  const page = await pageFor({ width: 390, height: 844 });
  await page.locator("#gate-coordinates").click();
  assert.equal(
    await page.locator("#sidebar").getAttribute("aria-modal"),
    "true",
  );
  await page.locator("#coordinate-input").fill("91, 2");
  await page.locator("#coordinate-submit").click();
  assert.match(
    await page.locator("#coordinate-error").innerText(),
    /between -80 and 80/,
  );
  assert.equal(
    await page.locator("#coordinate-input").getAttribute("aria-invalid"),
    "true",
  );
  const first = page.locator("#panel-close");
  await first.focus();
  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await page.evaluate(() =>
      document.getElementById("sidebar").contains(document.activeElement),
    ),
    true,
  );
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#sidebar").isVisible(), false);
  assert.equal(
    await page.locator("#workspace").evaluate((el) => el.inert),
    false,
  );
  assert.equal(await page.locator("#gate").isVisible(), true);
  await close(page);
});
test("coordinates drive mapping, all four views, fullscreen, point selection, and observer settings", async () => {
  const page = await pageFor({ width: 1440, height: 900 }, true);
  await mapCoordinates(page);
  const origin = await page.evaluate(() => ({
    lat: window.__lastRequest.lat,
    lon: window.__lastRequest.lon,
    source: S.locationSource,
  }));
  assert.deepEqual(origin, {
    lat: 48.8584,
    lon: 2.2945,
    source: "coordinates",
  });
  assert.equal(await page.locator("#card-horizon").isVisible(), true);
  assert.equal(await page.locator("#gate").isVisible(), false);
  const canvas = page.locator("#hz");
  await canvas.scrollIntoViewIfNeeded();
  await canvas.click({ position: { x: 120, y: 80 } });
  await page.waitForFunction(
    () =>
      HZ.selAz !== null &&
      document.getElementById("readout-title").textContent === "Selected point",
  );
  await page.locator("#r-clear").click();
  await page.waitForFunction(() => HZ.selAz === null);
  for (const [id, expected] of [
    ['[data-v="3d"]', "3d"],
    ["#map-perspective", "perspective"],
    ["#map-game", "game"],
  ]) {
    await page.locator(id).click();
    await page
      .waitForFunction((view) => mapView === view, expected, { timeout: 5000 })
      .catch(async (e) => {
        throw new Error(
          JSON.stringify({
            expected,
            state: await page.evaluate(() => ({
              view: mapView,
              error: terrainError,
              status: HZ.status,
            })),
            errors: page.errors,
          }),
        );
      });
    assert.equal(await page.evaluate(() => terrainError), "");
  }
  assert.equal(await page.evaluate(() => terrainView.game.active), true);
  await page.locator("#game-exit").click();
  await page.waitForFunction(() => mapView !== "game");
  await page.locator("#map-fullscreen").click();
  assert.equal(
    await page
      .locator("body")
      .evaluate((el) => el.classList.contains("map-fullscreen")),
    true,
  );
  await page.keyboard.press("Escape");
  assert.equal(
    await page
      .locator("body")
      .evaluate((el) => el.classList.contains("map-fullscreen")),
    false,
  );
  await openSettings(page);
  await page.locator("#terrain-controls>summary").click();
  await page.locator('[data-height="custom"]').click();
  await page.locator("#custom-height").fill("50");
  await page.locator("#custom-height-row button").click();
  await page.waitForFunction(() => Math.abs(terrainView.photoCamera.altitude-terrainView.photoSource.ground-50)<1e-6);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(()=>HorizonUI.showExplore());
  await noOverflow(page);
  await page.locator("#map-game").click();
  await page.waitForFunction(() => mapView === "game");
  for (const selector of ["#game-exit", "#game-stick", ".game-actions"]) {
    const r = await page.locator(selector).boundingBox();
    assert.ok(
      r.x >= 0 && r.y >= 0 && r.x + r.width <= 391 && r.y + r.height <= 845,
      selector,
    );
  }
  await page.locator("#game-exit").click();
  await close(page);
});
test("photo upload, project saving, reopening, GPX and map provider controls remain available", async () => {
  const page = await pageFor({ width: 390, height: 844 }, true);
  // Exif parsing has independent coverage in the parent app; emulate metadata for this UI test.
  await page.evaluate(() => {
    window.exifr.gps = async () => ({ latitude: 48.8584, longitude: 2.2945 });
    window.exifr.parse = async () => ({
      GPSLatitude: 48.8584,
      GPSLongitude: 2.2945,
      GPSLatitudeRef: "N",
      GPSLongitudeRef: "E",
      latitude: 48.8584,
      longitude: 2.2945,
    });
  });
  await page
    .locator("#photo-file")
    .setInputFiles({
      name: "test-photo.jpg",
      mimeType: "image/jpeg",
      buffer: Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2Q==", "base64"),
    });
  await page.waitForFunction(
    () => S.locationSource === "photo" && HZ.P && !HZ.loading && mapView === "perspective",
  );
  await page.waitForFunction(
    () => !document.getElementById("asset-add").disabled,
  );
  await page.locator('[data-mobile-panel="project"]').click();
  assert.equal(await page.locator("#asset-list .asset-row").count(), 1);
  await page.locator("#project-name").fill("UI test project");
  await page.locator("#project-save").click();
  await page.waitForFunction(() =>
    document.getElementById("project-message").textContent.includes("saved"),
  );
  await page
    .locator("#asset-files")
    .setInputFiles({
      name: "test-track.gpx",
      mimeType: "application/gpx+xml",
      buffer: Buffer.from(
        '<gpx version="1.1"><trk><trkseg><trkpt lat="48.8584" lon="2.2945"><ele>40</ele></trkpt><trkpt lat="48.8585" lon="2.2946"><ele>42</ele></trkpt></trkseg></trk></gpx>',
      ),
    });
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#asset-list .asset-row").length === 2 &&
      !document.getElementById("asset-add").disabled,
  );
  await page
    .locator(".asset-select")
    .filter({ hasText: "test-track.gpx" })
    .click();
  await page.waitForFunction(
    () =>
      S.locationSource === "track" &&
      !document.getElementById("asset-add").disabled,
  );
  await page.locator('[data-mobile-panel="project"]').click();
  assert.equal(await page.locator("#asset-list .asset-row").count(), 2);
  await page.locator("#project-save").click();
  await page.locator("#project-new").click();
  await page.waitForFunction(
    () => document.querySelectorAll("#asset-list .asset-row").length === 0,
  );
  await page.locator(".project-file-actions>summary").click();
  const saved = await page.locator("#project-saved option").allTextContents();
  assert.ok(saved.some((x) => x.includes("UI test project")));
  const value = await page
    .locator("#project-saved option")
    .filter({ hasText: "UI test project" })
    .first()
    .getAttribute("value");
  await page.locator("#project-saved").selectOption(value);
  await page.locator("#project-open").click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#asset-list .asset-row").length === 2 &&
      !document.getElementById("asset-add").disabled,
  );
  if (!(await page.locator("#sidebar").isVisible()))
    await page.locator('[data-mobile-panel="settings"]').click();
  else await page.locator('[data-panel="settings"]').click();
  await page.locator('[data-a="google"]').click();
  assert.equal(
    await page.locator("#r-maps").textContent(),
    "Open in Google Maps",
  );
  await close(page);
});
test("GPS is requested only by the explicit location action and maps its first fix", async () => {
  const page = await pageFor({ width: 390, height: 844 }, true);
  assert.equal(await page.evaluate(() => window.__gpsRequests), 0);
  await page.locator("#gate-btn").click();
  await page.waitForFunction(() => window.__gpsRequests === 1);
  await page.evaluate(() =>
    window.__gpsSuccess({
      coords: { latitude: 48.8584, longitude: 2.2945, accuracy: 5 },
      timestamp: Date.now(),
    }),
  );
  await page.waitForFunction(
    () =>
      HZ.P &&
      !HZ.loading &&
      document.getElementById("gate").classList.contains("hidden"),
  );
  assert.equal(await page.evaluate(() => S.locationSource), "gps");
  assert.equal(await page.locator("#gate").isVisible(), false);
  await close(page);
});

test("mobile selection clears beside either view and details precede compact peaks", async () => {
  for (const size of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    const page = await pageFor(size, true);
    await mapCoordinates(page);
    assert.equal(await page.locator("#hz-readout").isVisible(), false);
    assert.equal(await page.locator(".selection-tools:visible").count(), 0);
    await page.locator("#hz").click({ position: { x: 120, y: 80 } });
    await page.waitForFunction(() => HZ.selAz !== null && document.querySelector("#hz-readout.on"));
    assert.equal(await page.locator(".selection-tools:visible").count(), 2);
    assert.match(await page.locator("#r-ll").innerText(), /^-?\d+\.\d+, -?\d+\.\d+$/);
    const order = await page.evaluate(() => ({
      details: document.querySelector("#hz-readout").getBoundingClientRect().bottom,
      peaks: document.querySelector("#peak-panel").getBoundingClientRect().top,
    }));
    assert.ok(order.details <= order.peaks);
    await page.locator("#hz-wrap [data-selection-clear]").click();
    assert.equal(await page.evaluate(() => HZ.selAz), null);
    assert.equal(await page.locator("#hz-readout").isVisible(), false);
    await page.locator("#mp").click({ position: { x: 140, y: 120 } });
    await page.waitForFunction(() => HZ.selAz !== null && !document.querySelector("#mp-wrap .selection-tools").hidden);
    await page.locator("#mp-wrap [data-selection-clear]").click();
    assert.equal(await page.evaluate(() => HZ.selAz), null);
    await page.locator("#map-fullscreen").click();
    await page.locator("#mp").click({ position: { x: 140, y: 120 } });
    await page.locator("#mp-wrap [data-selection-details]").click();
    await page.waitForFunction(() => !mapFullscreen && document.activeElement.id === "hz-readout");
    await page.locator("#peak-panel summary").click();
    await page.evaluate(() => {
      document.querySelector("#peak-status").textContent = "";
      document.querySelector("#peak-retry").hidden = true;
      document.querySelector("#peak-list").replaceChildren(...Array.from({ length: 20 }, (_, i) => {
        const b = document.createElement("button"); b.textContent = `Peak ${i + 1} · 2 mi`; return b;
      }));
    });
    assert.ok((await page.locator("#peak-list").boundingBox()).height <= 132);
    await noOverflow(page);
    await page.locator("#card-horizon").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/tmp/horizon-selection-${size.width}.png` });
    await close(page);
  }
});

test("live horizon metrics follow aiming while selected values stay fixed and clearing preserves map framing", async () => {
  const page = await pageFor({ width: 844, height: 390 }, true);
  await mapCoordinates(page);
  await page.waitForFunction(() => !document.getElementById("live-readout").hidden);
  assert.equal(await page.locator("#map-tap-hint").isVisible(), true);
  assert.equal(await page.locator("#horizon-tap-hint").isVisible(), true);
  await page.locator("#hz").click({ position: { x: 150, y: 85 } });
  await page.waitForFunction(() => HZ.selAz !== null && document.querySelector("#hz-readout.on"));
  const selected = await page.locator("#hz-readout").innerText();
  const liveBefore = await page.locator("#live-az").innerText();
  const canvas = await page.locator("#hz").boundingBox();
  await page.mouse.move(canvas.x + 180, canvas.y + 85);
  await page.mouse.down(); await page.mouse.move(canvas.x + 240, canvas.y + 85, { steps: 8 }); await page.mouse.up();
  await page.waitForFunction(before => document.getElementById("live-az").textContent !== before, liveBefore);
  assert.equal(await page.locator("#hz-readout").innerText(), selected);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: "/tmp/horizon-live-landscape.png" });
  await openSettings(page);
  await page.locator('#mp-zoom [data-k="4"]').click();
  await page.locator("#panel-close").click();
  await page.locator("#mp").scrollIntoViewIfNeeded();
  const map = await page.locator("#mp").boundingBox();
  await page.mouse.move(map.x + 140, map.y + 100);
  await page.mouse.down(); await page.mouse.move(map.x + 170, map.y + 110, { steps: 6 }); await page.mouse.up();
  const framing = () => page.evaluate(() => ({ zoom: MP.zoom, k: MP.k, cx: MP.cx, cy: MP.cy }));
  const before = await framing();
  await page.locator("#mp-wrap [data-selection-clear]").click();
  await page.waitForFunction(() => HZ.selAz === null);
  assert.deepEqual(await framing(), before);
  assert.equal(await page.locator("#live-readout").isVisible(), true);
  assert.equal(await page.locator("#hz-readout").isVisible(), false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#hz").evaluate(el => el.scrollIntoView({ block: "center" }));
  await page.screenshot({ path: "/tmp/horizon-live-portrait.png" });
  await noOverflow(page);
  await close(page);
});
test("a photo without GPS reports the error visibly and preserves the existing terrain", async () => {
  const page = await pageFor({ width: 390, height: 844 }, true);
  await mapCoordinates(page);
  const origin = await page.evaluate(() => ({ lat: HZ.P.lat0, lon: HZ.P.lon0 }));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6n2sAAAAASUVORK5CYII=", "base64");
  await page.locator("#photo-file").setInputFiles({ name: "no-location.png", mimeType: "image/png", buffer: png });
  await page.waitForFunction(() => document.getElementById("photo-status").textContent.includes("No GPS coordinates"));
  assert.equal(await page.locator("#photo-status").isVisible(), true);
  assert.equal(await page.locator("#sidebar").getAttribute("aria-modal"), "true");
  assert.deepEqual(await page.evaluate(() => ({ lat: HZ.P.lat0, lon: HZ.P.lon0 })), origin);
  assert.equal(await page.evaluate(() => S.locationSource), "coordinates");
  await page.screenshot({ path: "/tmp/horizon-photo-error.png" });
  await close(page);
});

test("Viewpoint taps select the visible terrain without treating drags or sky as a point", async () => {
  const page = await pageFor({ width: 844, height: 390 }, true);
  await mapCoordinates(page);
  await page.locator('#map-perspective').click();
  await page.waitForFunction(() => mapView === 'perspective' && terrainView.photoCamera);
  const geometry = await page.evaluate(() => {
    const view = {
      model: { radius: 1000, n: 2 },
      mesh: { n: 2, vertices: new Float32Array(20) },
      photoSource: { ground: 0, eye: 10, bearing: 0 }, photoPitch: 0, photoFov: 60,
    };
    return { ground: terrainViewpointHit(view, 300, 150, 400, 200), sky: terrainViewpointHit(view, 300, 50, 400, 200) };
  });
  assert.ok(Math.abs(geometry.ground[0] - .02) < 1e-8);
  assert.ok(Math.abs(geometry.ground[1]) < 1e-8);
  assert.ok(Math.abs(geometry.ground[2] + .04 * Math.sqrt(3)) < 1e-8);
  assert.equal(geometry.sky, null);
  await page.locator('#mp3d').scrollIntoViewIfNeeded();
  let rect = await page.locator('#mp3d').boundingBox();
  await page.locator('#mp3d').click({ position: { x: rect.width / 2, y: rect.height * .8 } });
  await page.waitForFunction(() => HZ.pinnedTarget !== null && document.querySelector('#hz-readout.on'));
  const hit = await page.evaluate(() => {
    const point = terrainPoint(terrainData, HZ.pinnedTarget.point), camera = terrainView.photoCamera;
    const offset = point.map((v, i) => v - camera.eye[i]);
    const dot = axis => offset.reduce((sum, v, i) => sum + v * camera[axis][i], 0);
    return {
      x: .5 + dot('right') * camera.focal / dot('forward') / 2 / (terrainView.canvas.clientWidth / terrainView.canvas.clientHeight),
      y: .5 - dot('up') * camera.focal / dot('forward') / 2,
      error: point[1] * terrainData.radius - gameGround(terrainView, point[0], point[2]),
    };
  });
  assert.ok(Math.abs(hit.x - .5) < .01);
  assert.ok(Math.abs(hit.y - .8) < .01);
  assert.ok(Math.abs(hit.error) < .001);
  const selected = await page.evaluate(() => JSON.stringify(HZ.pinnedTarget));
  rect = await page.locator('#mp3d').boundingBox();
  await page.mouse.move(rect.x + rect.width * .6, rect.y + rect.height * .7);
  await page.mouse.down(); await page.mouse.move(rect.x + rect.width * .7, rect.y + rect.height * .6, { steps: 8 }); await page.mouse.up();
  assert.equal(await page.evaluate(() => JSON.stringify(HZ.pinnedTarget)), selected);
  await page.evaluate(() => { terrainView.photoPitch = 80; terrainView.dirty = true; });
  await page.locator('#mp3d').click({ position: { x: rect.width / 2, y: rect.height / 2 } });
  assert.equal(await page.evaluate(() => JSON.stringify(HZ.pinnedTarget)), selected);
  await page.locator('#mp-wrap [data-selection-clear]').click();
  assert.equal(await page.evaluate(() => HZ.selAz), null);
  await close(page);
});


test("Walk keeps a wide horizontal view on portrait phones and its original landscape lens", async () => {
  const page = await pageFor({ width: 390, height: 844 }, true);
  await mapCoordinates(page);
  await page.locator('#map-game').click();
  await page.waitForFunction(() => mapView === 'game' && terrainView.game.active);
  const camera = () => page.evaluate(() => {
    const camera = terrainView.game.camera(), canvas = terrainView.canvas;
    return { focal: camera.focal, aspect: canvas.clientWidth / canvas.clientHeight,
      eye: camera.eye, forward: camera.forward };
  });
  const portrait = await camera();
  const degrees = radians => radians * 180 / Math.PI;
  assert.ok(Math.abs(degrees(2 * Math.atan(portrait.aspect / portrait.focal)) - 60) < .01);
  await page.screenshot({ path: '/tmp/horizon-walk-portrait-wide.png' });
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForFunction(() => terrainView.canvas.clientWidth > terrainView.canvas.clientHeight);
  const landscape = await camera();
  assert.ok(Math.abs(landscape.focal - 1 / Math.tan(Math.PI / 6)) < 1e-9);
  assert.deepEqual(landscape.eye, portrait.eye);
  assert.deepEqual(landscape.forward, portrait.forward);
  await page.screenshot({ path: '/tmp/horizon-walk-landscape.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => terrainView.canvas.clientWidth < terrainView.canvas.clientHeight);
  assert.equal((await camera()).focal, portrait.focal);
  await close(page);
});



test("first-person Walk exposes every action and both joysticks at phone sizes", async () => {
  const page = await pageFor({ width: 390, height: 844 }, true);
  await mapCoordinates(page);
  await page.locator('#map-game').click();
  await page.waitForFunction(() => terrainView?.game?.active && !document.getElementById('game-target').disabled);
  const geometry = await page.evaluate(() => {
    const game=terrainView.game,camera=game.camera(),laser=game.laser();
    return {eye:camera.eye,position:game.position,radius:terrainData.radius,hit:laser.hit,
      tool:Array.from(gameLaserTool(game,terrainData.radius))};
  });
  assert.equal(geometry.eye[0],geometry.position[0]);
  assert.equal(geometry.eye[2],geometry.position[2]);
  assert.ok(Math.abs((geometry.eye[1]-geometry.position[1])*geometry.radius-1.65)<1e-6);
  assert.ok(geometry.tool.length>0 && geometry.tool.every(Number.isFinite));
  await page.locator('#game-target').click();
  for(const id of ['game-goto-target','game-maps']) {
    assert.equal(await page.locator('#'+id).isEnabled(),true);
    assert.equal(await page.locator('#'+id).evaluate(el=>el.getAnimations().some(a=>a.playState==='running')),true);
  }
  assert.equal(await page.locator('#game-respawn').evaluate(el=>el.getAnimations().length),0);
  const marked = await page.evaluate(() => terrainPoint(terrainData,HZ.pinnedTarget.point));
  assert.ok(marked.every((v,i)=>Math.abs(v-geometry.hit[i])<1e-8));
  for (const size of [{width:390,height:844},{width:320,height:568},{width:568,height:320},{width:844,height:390}]) {
    await page.setViewportSize(size);
    for(const selector of ['#game-stick','#game-look','#game-target','#game-goto-target','#game-maps','#game-speed','#game-respawn','[data-game-key="e"]','[data-game-key="q"]']) {
      assert.equal(await page.locator(selector).isVisible(),true,selector);
      const r=await page.locator(selector).boundingBox();
      assert.ok(r.x>=0 && r.y>=0 && r.x+r.width<=size.width+1 && r.y+r.height<=size.height+1,selector);
    }
    assert.ok((await page.locator('.game-header').boundingBox()).height<=65);
    const controls=await page.locator('.game-actions').boundingBox(),look=await page.locator('#game-look').boundingBox();
    const targets=await page.locator('#game-target').boundingBox();
    assert.ok(targets.y+targets.height<=look.y);
    const interactive=['#game-stick','#game-look','#game-target','#game-respawn','#game-goto-target','#game-maps','.game-speed','[data-game-key="e"]','[data-game-key="q"]'];
    const boxes=await Promise.all(interactive.map(selector=>page.locator(selector).boundingBox()));
    for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++) {
      const a=boxes[i],b=boxes[j];
      assert.ok(a.x+a.width<=b.x+.5 || b.x+b.width<=a.x+.5 || a.y+a.height<=b.y+.5 || b.y+b.height<=a.y+.5,`Overlapping ${interactive[i]} and ${interactive[j]}`);
    }
    const up=await page.locator('[data-game-key="e"]').boundingBox(),down=await page.locator('[data-game-key="q"]').boundingBox();
    assert.equal(up.x,down.x);assert.ok(up.y+up.height<=down.y);
    assert.equal(await page.locator('[data-game-key="shift"]').count(),0);
    await page.locator('#game-speed').evaluate(el=>{el.value='25';el.dispatchEvent(new Event('input',{bubbles:true}));});
    assert.equal(await page.evaluate(()=>terrainView.game.speedMultiplier),25);
    await page.waitForTimeout(150);
    await page.screenshot({path:`/tmp/horizon-first-person-${size.width}.png`});
    await noOverflow(page);
  }
  const from=await page.evaluate(()=>[...terrainView.game.position]);
  await page.locator('#game-goto-target').click();
  assert.equal(await page.evaluate(()=>!!terrainView.game.flight),true);
  await page.waitForFunction(()=>!terrainView.game.flight);
  assert.notDeepEqual(await page.evaluate(()=>terrainView.game.position),from);
  await page.locator('#game-respawn').click();
  await page.waitForFunction(()=>!terrainView.game.flight);
  await assertDefaultStart(page);
  await page.evaluate(()=>{terrainView.game.tilt=-1.2;terrainView.dirty=true;});
  await page.waitForFunction(()=>document.getElementById('game-target').disabled);
  assert.match(await page.locator('#game-laser-status').innerText(),/No terrain hit/);
  assert.equal(await page.locator('#game-goto-target').isEnabled(),true);
  await close(page);
});

test("movement stick and swipe aiming work simultaneously without continuous turning", async () => {
  const page = await pageFor({width:390,height:844},true);
  await mapCoordinates(page);await page.locator('#map-game').click();
  await page.waitForFunction(()=>terrainView?.game?.active);
  const client=await page.context().newCDPSession(page);
  await client.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
  const move=await page.locator('#game-stick').boundingBox(),look=await page.locator('#game-look').boundingBox();
  const a={x:move.x+move.width/2,y:move.y+move.height/2,id:1};
  const b={x:look.x+look.width/2,y:look.y+look.height/2,id:2};
  const before=await page.evaluate(()=>({position:[...terrainView.game.position],yaw:terrainView.game.yaw}));
  await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[a]});
  await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[a,b]});
  await client.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{...a,y:a.y-25},{...b,x:b.x+25}]});
  await page.waitForFunction(before=>Math.abs(terrainView.game.yaw-before.yaw)>.05 && Math.hypot(...terrainView.game.position.map((v,i)=>v-before.position[i]))>1e-5,before);
  const heldYaw=await page.evaluate(()=>terrainView.game.yaw);
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(()=>terrainView.game.yaw),heldYaw);
  await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  assert.deepEqual(await page.evaluate(()=>terrainView.game.stick),{x:0,y:0});
  assert.equal(await page.locator('#game-look').evaluate(el=>el.classList.contains('is-dragging')),false);
  const yaw=await page.evaluate(()=>terrainView.game.yaw);
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(()=>terrainView.game.yaw),yaw);
  await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...b,x:b.x+25}]});
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
  assert.equal(await page.locator('#game-look').evaluate(el=>el.classList.contains('is-dragging')),false);
  await client.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
  for(const key of ['e','q']) {
    const button=page.locator('[data-game-key="'+key+'"]'),rect=await button.boundingBox();
    await page.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2);await page.mouse.down();
    assert.equal(await page.evaluate(key=>terrainView.game.keys.has(key),key),true);
    await page.mouse.up();
    assert.equal(await page.evaluate(key=>terrainView.game.keys.has(key),key),false);
  }
  await close(page);
});

test("Viewpoint selection uses the horizon fit when returning to Map", async () => {
  const page=await pageFor({width:844,height:390},true);
  await mapCoordinates(page);
  await openSettings(page);
  await page.locator('#mp-zoom [data-k="4"]').click();
  await page.locator("#panel-close").click();
  await page.locator('#map-perspective').click();
  await page.waitForFunction(()=>mapView==='perspective' && terrainView.photoCamera);
  const rect=await page.locator('#mp3d').boundingBox();
  await page.locator('#mp3d').click({position:{x:rect.width/2,y:rect.height*.8}});
  await page.waitForFunction(()=>HZ.pinnedTarget!==null);
  await page.locator('[data-v="2d"]').click();
  await page.waitForFunction(()=>mapView==='2d' && MP.zoom===0);
  const actual=await page.evaluate(()=>({k:MP.k,cx:MP.cx,cy:MP.cy,zoom:MP.zoom}));
  const expected=await page.evaluate(()=>{
    mpFitSelection();
    return {k:MP.k,cx:MP.cx,cy:MP.cy,zoom:MP.zoom};
  });
  assert.deepEqual(actual,expected);
  const bounds=await page.evaluate(()=>{
    const p=readoutTarget().point;
    return {a:[mpX(MP.lon0),mpY(MP.lat0)],b:[mpX(p.lon),mpY(p.lat)],w:mw,h:mh};
  });
  for(const point of [bounds.a,bounds.b])assert.ok(point[0]>=0 && point[0]<=bounds.w && point[1]>=0 && point[1]<=bounds.h);
  assert.ok(Math.hypot(bounds.a[0]-bounds.b[0],bounds.a[1]-bounds.b[1])>Math.min(bounds.w,bounds.h)*.5);
  await close(page);
});

test("direct Viewpoint to Terrain fits the selected path exactly like going through Map", async () => {
  for(const [start,end] of [[{width:844,height:390},{width:390,height:844}],[{width:390,height:844},{width:844,height:390}]]) {
    const page=await pageFor(start,true);await mapCoordinates(page);
    await page.locator('[data-v="3d"]').click();
    await page.waitForFunction(()=>!HZ.loading && terrainView?.model);
    await page.evaluate(()=>{terrainView.orbit(.4,-.3);terrainView.zoom(.5);});
    await page.locator('#map-perspective').click();
    await page.waitForFunction(()=>!HZ.loading && terrainView.photoCamera);
    const rect=await page.locator('#mp3d').boundingBox();
    await page.locator('#mp3d').click({position:{x:rect.width/2,y:rect.height*.8}});
    await page.waitForFunction(()=>HZ.pinnedTarget!==null);
    await page.setViewportSize(end);
    await page.locator('[data-v="3d"]').click();
    await page.waitForFunction(()=>mapView==='3d' && !HZ.loading && HZ.selAz!==null && terrainView.model);
    const camera=()=>page.evaluate(()=>({focus:[...terrainView.focus],distance:terrainView.distance,yaw:terrainView.yaw,tilt:terrainView.tilt,orthographic:terrainView.orthographic}));
    const direct=await camera();
    await page.locator('[data-v="2d"]').click();
    await page.waitForFunction(()=>mapView==='2d' && document.getElementById('mp').width>0);
    await page.locator('[data-v="3d"]').click();
    await page.waitForFunction(()=>mapView==='3d' && !HZ.loading);
    const viaMap=await camera();
    assert.deepEqual(direct,viaMap);
    assert.equal(direct.orthographic,true);
    await close(page);
  }
});

test("exiting Walk to Terrain fits a marked target exactly like going through Map", async () => {
  for(const size of [{width:390,height:844},{width:844,height:390}]) {
    const page=await pageFor(size,true);await mapCoordinates(page);
    await page.locator('[data-v="3d"]').click();
    await page.waitForFunction(()=>!HZ.loading && terrainView?.model);
    await page.evaluate(()=>{terrainView.orbit(.4,-.3);terrainView.zoom(.5);});
    await page.locator('#map-game').click();
    await page.waitForFunction(()=>terrainView.game?.active && !document.getElementById('game-target').disabled);
    await page.locator('#game-target').click();
    await page.locator('#game-exit').click();
    await page.waitForFunction(()=>mapView==='3d' && !HZ.loading && HZ.selAz!==null);
    const camera=()=>page.evaluate(()=>({focus:[...terrainView.focus],distance:terrainView.distance,yaw:terrainView.yaw,tilt:terrainView.tilt,orthographic:terrainView.orthographic}));
    const direct=await camera();
    await page.locator('[data-v="2d"]').click();
    await page.locator('[data-v="3d"]').click();
    await page.waitForFunction(()=>mapView==='3d' && !HZ.loading);
    assert.deepEqual(direct,await camera());
    assert.equal(direct.orthographic,true);
    await close(page);
  }
});

test("look circle matches scene drag sensitivity and does not rotate on an off-center press", async () => {
  const page=await pageFor({width:390,height:844},true);await mapCoordinates(page);
  await page.locator('#map-game').click();await page.waitForFunction(()=>terrainView.game?.active);
  const state=()=>page.evaluate(()=>({yaw:terrainView.game.yaw,tilt:terrainView.game.tilt}));
  const start=await state(),rect=await page.locator('#game-look').boundingBox();
  const x=rect.x+rect.width*.65,y=rect.y+rect.height*.5;
  await page.mouse.move(x,y);await page.mouse.down();await page.waitForTimeout(200);
  assert.deepEqual(await state(),start);
  await page.mouse.move(x+20,y-10,{steps:4});
  const pad=await state();await page.waitForTimeout(200);assert.deepEqual(await state(),pad);
  await page.mouse.up();
  await page.evaluate(start=>{terrainView.game.yaw=start.yaw;terrainView.game.tilt=start.tilt;},start);
  const canvas=await page.locator('#mp3d').boundingBox();
  const cx=canvas.x+canvas.width*.4,cy=canvas.y+canvas.height*.3;
  await page.mouse.move(cx,cy);await page.mouse.down();await page.mouse.move(cx+20,cy-10,{steps:4});await page.mouse.up();
  assert.deepEqual(await state(),pad);
  assert.equal(await page.locator('#game-look .game-stick-thumb').count(),0);
  await close(page);
});

test("horizontal Walk speed control supports dragging, keyboard and one-step nudges", async()=>{
  const page=await pageFor({width:390,height:844},true);await mapCoordinates(page);
  await page.locator('#map-game').click();await page.waitForFunction(()=>terrainView.game?.active);
  const slider=page.locator('#game-speed'),less=page.locator('#game-speed-less'),more=page.locator('#game-speed-more');
  async function expectSpeed(value) {
    assert.equal(await slider.inputValue(),String(value));
    assert.equal(await page.evaluate(()=>terrainView.game.speedMultiplier),value);
    assert.equal(await page.locator('#game-speed-value').innerText(),value+'×');
    assert.equal(await slider.getAttribute('aria-valuetext'),value+' times normal speed');
  }
  await expectSpeed(25);
  const pose=()=>page.evaluate(()=>{const g=terrainView.game;return [[...g.position],g.yaw,g.tilt,[...g.keys]];});
  const before=await pose();
  await more.click();await expectSpeed(26);await less.click();await expectSpeed(25);
  await slider.focus();await page.keyboard.press('ArrowRight');await expectSpeed(26);
  await page.keyboard.press('ArrowLeft');await expectSpeed(25);
  await page.keyboard.press('End');await expectSpeed(100);assert.ok(await more.isDisabled());
  await page.keyboard.press('Home');await expectSpeed(1);assert.ok(await less.isDisabled());
  const r=await slider.boundingBox(),y=r.y+r.height/2;
  assert.ok(r.height>=44 && r.width>=120);
  await page.mouse.move(r.x+2,y);await page.mouse.down();await page.mouse.move(r.x+r.width-2,y,{steps:10});
  await expectSpeed(100);await page.mouse.up();
  const touch=await page.context().newCDPSession(page);
  for(const [type,x] of [['touchStart',r.x+r.width-2],['touchMove',r.x+r.width/2],['touchMove',r.x+2],['touchEnd',0]]) {
    await touch.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x,y}]});
  }
  await expectSpeed(1);assert.deepEqual(await pose(),before);
  await more.click();await expectSpeed(2);
  const travel=await page.evaluate(()=>{
    const g=terrainView.game,pos=[...g.position];g.keys.add('w');g.step(.05);g.keys.clear();
    return Math.hypot(g.position[0]-pos[0],g.position[2]-pos[2])*g.view.model.radius;
  });
  assert.ok(Math.abs(travel-12*2*.05)<1e-6);
  await close(page);
});

test("top-right camera toggle restores third person without moving the player or laser target", async()=>{
  const page=await pageFor({width:390,height:844},true);await mapCoordinates(page);
  await page.locator('#map-game').click();await page.waitForFunction(()=>terrainView.game?.active);
  const snapshot=()=>page.evaluate(()=>({position:[...terrainView.game.position],eye:terrainView.game.camera().eye,hit:terrainView.game.laser().hit}));
  const first=await snapshot(),button=page.locator('#game-camera');
  await button.click();
  assert.equal(await page.evaluate(()=>terrainView.game.thirdPerson),true);
  assert.equal(await button.innerText(),'1st person');
  const third=await snapshot();
  assert.deepEqual(third.position,first.position);assert.ok(third.hit.every((v,i)=>Math.abs(v-first.hit[i])<1e-8));
  assert.notDeepEqual(third.eye,first.eye);
  await page.waitForTimeout(150);await page.screenshot({path:'/tmp/horizon-third-person.png'});
  for(const size of [{width:320,height:568},{width:844,height:390}]) {
    await page.setViewportSize(size);
    const b=await button.boundingBox(),header=await page.locator('.game-header').boundingBox();
    assert.ok(b.x+b.width<=size.width && b.y+b.height<=size.height);
    assert.ok(b.x>=size.width-110 && b.y<30);
    assert.ok(header.x+header.width<=b.x);
  }
  await button.click();
  assert.equal(await page.evaluate(()=>terrainView.game.thirdPerson),false);
  assert.deepEqual((await snapshot()).eye,first.eye);
  assert.equal(await button.innerText(),'3rd person');
  await close(page);
});


test("Walk status reports position from start independently of aim and target",async()=>{
  const page=await pageFor({width:320,height:568},true);await mapCoordinates(page);
  await page.locator('#map-game').click();await page.waitForFunction(()=>terrainView.game?.active);
  assert.equal(await page.locator('#game-start-distance').innerText(),'0 m');
  assert.equal(await page.locator('#game-start-height').innerText(),'Same elevation');
  await page.evaluate(()=>{
    const game=terrainView.game,r=terrainView.model.radius;
    game.position=[game.spawn[0]+1000/r,game.spawn[1]+100/r,game.spawn[2]-1000/r];
    game.flying=true;game.velocityY=0;game.yaw=2;game.targetPlaced=true;MP.dirty=true;
  });
  await page.waitForFunction(()=>document.getElementById('game-start-distance').textContent==='0.88 mi NE');
  assert.equal(await page.locator('#game-start-height').innerText(),'100 m above');
  assert.ok((await page.locator('.game-header').boundingBox()).height<=65);
  assert.doesNotMatch(await page.locator('#game-status').innerText(),/Flying|On foot|m\/s|above ground|Target placed/);
  await page.waitForTimeout(150);await page.screenshot({path:'/tmp/horizon-relative-status.png'});
  await page.evaluate(()=>{
    const game=terrainView.game;game.position=[...game.spawn];game.yaw=-1;game.flying=false;MP.dirty=true;
  });
  await page.waitForFunction(()=>document.getElementById('game-start-distance').textContent==='0 m');
  assert.equal(await page.locator('#game-start-height').innerText(),'Same elevation');
  await close(page);
});


test('third-person reticle tracks the laser impact instead of the character head',async()=>{
  const page=await pageFor({width:390,height:844},true);await mapCoordinates(page);
  await page.locator('#map-game').click();await page.locator('#game-camera').click();
  for(const size of [{width:390,height:844},{width:844,height:390}]) {
    await page.setViewportSize(size);
    for(const yaw of [0,.7]) {
      await page.evaluate(yaw=>{terrainView.game.yaw=yaw;MP.dirty=true;},yaw);
      await page.waitForTimeout(100);
      const projected=await page.evaluate(()=>{
        const g=terrainView.game,c=g.camera(),p=g.laser().hit;
        const rect=terrainView.canvas.getBoundingClientRect();
        const delta=p.map((v,i)=>v-c.eye[i]),dot=v=>delta.reduce((sum,x,i)=>sum+x*v[i],0);
        const depth=dot(c.forward),scale=rect.height*c.focal/(2*depth);
        return {x:rect.x+rect.width/2+dot(c.right)*scale,y:rect.y+rect.height/2-dot(c.up)*scale};
      });
      const reticle=await page.locator('#game-reticle').boundingBox();
      assert.ok(Math.abs(reticle.x+reticle.width/2-projected.x)<1);
      assert.ok(Math.abs(reticle.y+reticle.height/2-projected.y)<1);
    }
    await page.waitForTimeout(150);await page.screenshot({path:`/tmp/horizon-third-person-${size.width}.png`});
  }
  await page.locator('#game-target').click();
  const marked=await page.evaluate(()=>({point:terrainPoint(terrainData,HZ.pinnedTarget.point),hit:terrainView.game.laser().hit}));
  assert.ok(marked.point.every((v,i)=>Math.abs(v-marked.hit[i])<1e-8));
  await close(page);
});


async function assertSplit(page,photo=false) {
  const a=await page.locator(photo?'#mp3d':'#mp').boundingBox();
  const b=await page.locator(photo?'#photo-viewport':'#hz').boundingBox();
  const viewport=page.viewportSize(),landscape=viewport.width>viewport.height;
  const bottom=viewport.width<=900?(await page.locator('.mobile-dock').boundingBox()).y:viewport.height;
  for(const rect of [a,b]) {
    assert.ok(rect.x>=0 && rect.y>=0 && rect.x+rect.width<=viewport.width+1 && rect.y+rect.height<=bottom+1,JSON.stringify({a,b,bottom}));
  }
  assert.ok(Math.abs(a.width*a.height-b.width*b.height)<Math.max(a.width,b.width)*2,JSON.stringify({a,b}));
  if(landscape){assert.ok(Math.abs(a.y-b.y)<1);assert.ok(Math.abs(a.x+a.width+2-b.x)<1);}
  else{assert.ok(Math.abs(a.x-b.x)<1);assert.ok(Math.abs(a.y+a.height+2-b.y)<1);}
  await noOverflow(page);
}
test('loaded location uses two equal visible panes with accessible overlay controls',async()=>{
  for(const size of [{width:320,height:568},{width:390,height:844},{width:768,height:1024},{width:844,height:390},{width:901,height:600},{width:1024,height:768},{width:1440,height:900}]) {
    const page=await pageFor(size,true);await mapCoordinates(page);
    await assertSplit(page);
    for(const selector of ['[data-v="2d"]','[data-v="3d"]','#map-perspective','#map-game','#map-fullscreen','#map-fit']) {
      assert.equal(await page.locator(selector).evaluate(el=>{
        const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
      }),true,selector);
    }
    await page.waitForTimeout(150);await page.screenshot({path:`/tmp/horizon-split-location-${size.width}.png`});
    await openSettings(page);
    assert.equal(await page.locator('#hz-range').isVisible(),true);
    await page.locator('#mp-zoom [data-k="4"]').click();
    if(size.width<=900)await page.locator('#panel-close').click();
    await page.locator('#map-fit').click();assert.equal(await page.evaluate(()=>MP.zoom),0);
    await page.locator('#map-fullscreen').click();
    const full=await page.locator('#mp').boundingBox();assert.ok(full.height>=size.height-1);
    await page.locator('#map-fullscreen').click();await assertSplit(page);
    await close(page);
  }
});

test('photo opens beside an equal Viewpoint pane, with optional horizon and photo fit',async()=>{
  const page=await pageFor({width:390,height:844},true);
  const png=await page.evaluate(()=>{
    window.exifr.gps=async()=>({latitude:48.8584,longitude:2.2945});
    window.exifr.parse=async()=>({GPSLatitude:48.8584,GPSLongitude:2.2945,GPSLatitudeRef:'N',GPSLongitudeRef:'E',latitude:48.8584,longitude:2.2945});
    const c=document.createElement('canvas');c.width=1200;c.height=800;
    const ctx=c.getContext('2d');ctx.fillStyle='#b8c5ca';ctx.fillRect(0,0,1200,800);
    ctx.fillStyle='#677776';ctx.beginPath();ctx.moveTo(0,650);ctx.lineTo(350,200);ctx.lineTo(600,490);ctx.lineTo(900,270);ctx.lineTo(1200,600);ctx.lineTo(1200,800);ctx.lineTo(0,800);ctx.fill();
    return c.toDataURL('image/png').split(',')[1];
  });
  await page.locator('#photo-file').setInputFiles({name:'comparison-test.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
  await page.waitForFunction(()=>S.locationSource==='photo' && HZ.P && !HZ.loading && mapView==='perspective' && document.getElementById('photo-preview').naturalWidth>0);
  for(const size of [{width:390,height:844},{width:844,height:390},{width:320,height:568}]) {
    await page.setViewportSize(size);await assertSplit(page,true);
    assert.equal(await page.locator('#hz').isVisible(),false);
    await page.waitForTimeout(150);await page.screenshot({path:`/tmp/horizon-split-photo-${size.width}.png`});
    await page.locator('#comparison-horizon').click();assert.equal(await page.locator('#hz').isVisible(),true);
    assert.equal(await page.locator('#photo-viewport').isVisible(),false);
    await page.locator('#comparison-photo').click();await assertSplit(page,true);
  }
  await page.locator('#photo-viewport').hover();await page.keyboard.down('Control');await page.mouse.wheel(0,-150);await page.keyboard.up('Control');
  await page.waitForFunction(()=>photoViewer.scale>1);
  await page.locator('#photo-fit').click();assert.equal(await page.evaluate(()=>photoViewer.scale),1);
  await page.locator('[data-mobile-panel="location"]').click();await page.locator('#coordinate-pick').click();
  await page.locator('#coordinate-input').fill('48.8584, 2.2945');await page.locator('#coordinate-submit').click();
  await page.waitForFunction(()=>S.locationSource==='coordinates' && HZ.P && !HZ.loading);
  await assertSplit(page);assert.equal(await page.locator('#comparison-photo').isVisible(),false);
  await close(page);
});


test('GPS view switching preserves observer height and horizon without another terrain request',async()=>{
  const page=await pageFor({width:390,height:844},true);
  await page.evaluate(()=>localStorage.setItem('terrain.observerStates.v3',JSON.stringify({'3d':{height:'custom',customHeight:400},perspective:{height:'custom',customHeight:900}})));
  await page.reload();await page.waitForFunction(()=>!!window.HorizonUI);
  await page.locator('#gate-btn').click();await page.waitForFunction(()=>window.__gpsRequests===1);
  await page.evaluate(()=>window.__gpsSuccess({coords:{latitude:48.8584,longitude:2.2945,accuracy:5},timestamp:Date.now()}));
  await page.waitForFunction(()=>HZ.P && terrainData && !HZ.loading);
  const snapshot=()=>page.evaluate(()=>({requests:window.__terrainRequests,eye:window.__lastRequest.eye,
    height:photoObserverHeight,custom:photoCustomHeight,heading:curCenter(),fov:HZ.fov,mode:HZ.mode,
    elevation:HZ.P.hObs,profile:HZ.P.ang.reduce((sum,v,i)=>sum+v*(i+1),0)}));
  const before=await snapshot();assert.equal(before.height,'ground');assert.equal(before.eye,0);
  for(const view of ['perspective','2d','3d','perspective','2d']) {
    await page.locator(`[data-v="${view}"]`).click();
    await page.waitForFunction(view=>mapView===view && terrainData && !HZ.loading,view);
    assert.deepEqual(await snapshot(),before,view+' must only change the visual representation');
  }
  await page.locator('[data-v="3d"]').click();await openSettings(page);
  await page.locator('#terrain-controls>summary').click();await page.locator('[data-height="custom"]').click();
  await page.waitForFunction(()=>!HZ.loading && terrainData);
  // Reopen Settings after the explicit height change completes.
  await openSettings(page);await page.locator('#custom-height').fill('50');
  await page.locator('#custom-height-row button').click();
  await page.waitForFunction(()=>window.__lastRequest.eye===50 && !HZ.loading && terrainData);
  const custom=await snapshot();assert.equal(custom.height,'custom');
  for(const view of ['2d','3d','perspective']) {
    await page.locator(`[data-v="${view}"]`).click();
    await page.waitForFunction(view=>mapView===view && terrainData && !HZ.loading,view);
    assert.deepEqual(await snapshot(),custom,'explicit custom height is shared across views');
  }
  await close(page);
});


test('raised location Viewpoint camera and its height controls leave the horizon unchanged',async()=>{
  const page=await pageFor({width:390,height:844},true);
  await page.locator('#gate-btn').click();await page.waitForFunction(()=>window.__gpsRequests===1);
  await page.evaluate(()=>window.__gpsSuccess({coords:{latitude:48.8584,longitude:2.2945,accuracy:5},timestamp:Date.now()}));
  await page.waitForFunction(()=>HZ.P && terrainData && !HZ.loading);
  await page.evaluate(()=>{window.__originalProfile=HZ.P;window.__originalRequests=window.__terrainRequests;});
  const unchanged=async()=>assert.equal(await page.evaluate(()=>HZ.P===window.__originalProfile && window.__terrainRequests===window.__originalRequests && !HZ.loading),true);
  const cameraHeight=()=>page.evaluate(()=>terrainView.photoCamera.altitude-gameGround(terrainView,0,0));
  await page.locator('#map-perspective').click();
  await page.waitForFunction(()=>terrainView.photoCamera && !HZ.loading);
  assert.ok(await cameraHeight()>=30);await unchanged();
  assert.equal(await page.evaluate(()=>locationCamera.customHeight),30);
  await page.waitForTimeout(150);await page.screenshot({path:'/tmp/horizon-raised-viewpoint.png'});
  await openSettings(page);await page.locator('#terrain-controls>summary').click();
  assert.match(await page.locator('#observer-scope').innerText(),/camera only/);
  await page.locator('#custom-height').fill('50');await page.locator('#custom-height-row button').click();
  await page.waitForFunction(()=>locationCamera.customHeight===50 && terrainView.photoCamera.altitude-terrainView.photoSource.ground===50);
  await unchanged();
  await page.locator('[data-height="ground"]').click();
  await page.waitForFunction(()=>locationCamera.height==='ground');await unchanged();
  await page.locator('[data-height="custom"]').click();await page.locator('#panel-close').click();
  for(const view of ['2d','3d','perspective']) {
    await page.locator(`[data-v="${view}"]`).click();await page.waitForFunction(view=>mapView===view,view);await unchanged();
  }
  await page.waitForFunction(()=>terrainView.photoCamera);
  assert.ok(await cameraHeight()>=50);
  assert.equal(await page.evaluate(()=>photoObserverHeight),'ground');
  await close(page);
});


test('selected map paths stay clear of overlay controls in every direction and fullscreen',async()=>{
  const page=await pageFor({width:390,height:844},true);await mapCoordinates(page);
  assert.equal(await page.locator('#map-settings-open').count(),0);
  assert.equal(await page.locator('#map-fit').isVisible(),true);
  async function unobstructed() {
    const scene=await page.evaluate(()=>{
      const r=document.getElementById('mp').getBoundingClientRect(),p=readoutTarget().point;
      return {points:[[mpX(MP.lon0)+r.x,mpY(MP.lat0)+r.y],[mpX(p.lon)+r.x,mpY(p.lat)+r.y]],
        map:{x:r.x,y:r.y,width:r.width,height:r.height},
        controls:[...document.querySelectorAll('#map-view button,#map-fullscreen,#map-fit,#mp-wrap .selection-tools button,#sat-retry,#mp-attribution,#view-compass')]
          .map(el=>{const b=el.getBoundingClientRect();return {id:el.id||el.textContent,x:b.x,y:b.y,width:b.width,height:b.height};})
          .filter(b=>b.width && b.height)};
    });
    const [a,b]=scene.points;
    for(const point of scene.points)assert.ok(point[0]>scene.map.x+6 && point[0]<scene.map.x+scene.map.width-6 && point[1]>scene.map.y+6 && point[1]<scene.map.y+scene.map.height-6,JSON.stringify(scene));
    // Independent segment/rectangle clipping: the whole source-target line,
    // including marker padding, must miss every visible overlay.
    for(const rect of scene.controls) {
      let enter=0,leave=1,intersects=true;
      for(const [axis,lo,hi] of [[0,rect.x-6,rect.x+rect.width+6],[1,rect.y-6,rect.y+rect.height+6]]) {
        const delta=b[axis]-a[axis];
        if(Math.abs(delta)<1e-8){if(a[axis]<lo || a[axis]>hi)intersects=false;continue;}
        const t1=(lo-a[axis])/delta,t2=(hi-a[axis])/delta;
        enter=Math.max(enter,Math.min(t1,t2));leave=Math.min(leave,Math.max(t1,t2));
      }
      assert.ok(!intersects || enter>leave,rect.id+' overlaps selected path '+JSON.stringify(scene.points));
    }
  }
  await page.locator('#hz').click({position:{x:190,y:130}});
  await page.waitForFunction(()=>HZ.selAz!==null);await unobstructed();
  for(const size of [{width:320,height:568},{width:390,height:844},{width:844,height:390},{width:1440,height:900}]) {
    await page.setViewportSize(size);await page.waitForTimeout(100);
    for(const bearing of [0,45,90,135,180,225,270,315]) {
      await page.evaluate(bearing=>{
        const [lat,lon]=destination(MP.lat0,MP.lon0,bearing,800);
        HZ.selAz=bearing;HZ.selLayer=0;HZ.pinnedTarget={bearing,point:{lat,lon,elev:HZ.P.ground,dist:800,ang:0}};
        mpFitSelection();updateReadout();
      },bearing);
      await unobstructed();
    }
    await page.waitForTimeout(100);await page.screenshot({path:`/tmp/horizon-safe-fit-${size.width}.png`});
    await page.locator('#map-fullscreen').click();await page.waitForTimeout(100);await unobstructed();
    await page.locator('#map-fit').click();await unobstructed();
    await page.locator('#map-fullscreen').click();await page.waitForTimeout(100);await unobstructed();
  }
  await close(page);
});


test('photo upload tolerates an older cached UI without updateComparison',async()=>{
  const page=await pageFor({width:390,height:844},true);
  await page.evaluate(()=>{
    delete window.HorizonUI.updateComparison;
    window.exifr.parse=async()=>({GPSLatitude:48.8584,GPSLongitude:2.2945,GPSLatitudeRef:'N',GPSLongitudeRef:'E',latitude:48.8584,longitude:2.2945});
  });
  await page.locator('#photo-file').setInputFiles({name:'cached-ui-photo.jpg',mimeType:'image/jpeg',buffer:Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2Q==','base64')});
  await page.waitForFunction(()=>S.locationSource==='photo' && HZ.P && !HZ.loading && mapView==='perspective');
  assert.equal(await page.locator('#photo-status').innerText(),'');
  assert.equal(await page.locator('#photo-reference').isVisible(),true);
  await page.waitForFunction(()=>!document.getElementById('photo-pick').disabled);
  await close(page);
});

test('mobile Details stays below the mode bar and accepts touch with phone safe areas',async()=>{
  const page=await pageFor({width:390,height:844},true);await mapCoordinates(page);
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
  await page.locator('#hz').click({position:{x:190,y:130}});
  await page.waitForFunction(()=>HZ.selAz!==null);
  for(const device of [
    {width:390,height:844,insets:{top:47,bottom:34,left:0,right:0}},
    {width:430,height:932,insets:{top:59,bottom:34,left:0,right:0}},
    {width:320,height:568,insets:{top:20,bottom:0,left:0,right:0}},
    {width:844,height:390,insets:{top:0,bottom:21,left:47,right:47}},
  ]) {
    await page.setViewportSize({width:device.width,height:device.height});
    await cdp.send('Emulation.setSafeAreaInsetsOverride',{insets:device.insets});
    for(const view of ['2d','3d','perspective'])for(const fullscreen of [false,true]) {
      await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));
      await page.locator(`[data-v="${view}"]`).click();
      if(fullscreen)await page.locator('#map-fullscreen').click();
      await page.waitForTimeout(120);
      const button=page.locator('#mp-wrap [data-selection-details]');
      const box=await button.boundingBox(),bar=await page.locator('#map-view-row').boundingBox();
      await page.screenshot({path:`/tmp/horizon-details-${device.width}-${view}-${fullscreen}.png`});
      assert.ok(box.y>=bar.y+bar.height+6,JSON.stringify({device,view,fullscreen,box,bar}));
      assert.equal(await button.evaluate(el=>{
        const b=el.getBoundingClientRect();
        return [[.1,.1],[.9,.1],[.5,.5],[.1,.9],[.9,.9]].every(([x,y])=>el.contains(document.elementFromPoint(b.x+x*b.width,b.y+y*b.height)));
      }),true,'Details must be uncovered across its full touch target');
      const x=box.x+box.width/2,y=box.y+box.height/2;
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:0,radiusX:2,radiusY:2,force:1}]});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      await page.waitForFunction(()=>{
        const r=document.getElementById('hz-readout').getBoundingClientRect();
        return !mapFullscreen && document.activeElement.id==='hz-readout' && r.top<innerHeight && r.bottom>0;
      });
    }
  }
  await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));
  await page.addStyleTag({content:'#map-view button { font-size:20px !important; padding-block:22px !important; }'});
  await page.waitForTimeout(150);
  const largeBar=await page.locator('#map-view-row').boundingBox();
  const details=await page.locator('#mp-wrap [data-selection-details]').boundingBox();
  assert.ok(details.y>=largeBar.y+largeBar.height+6,'Details follows a taller toolbar too');
  await close(page);
});

test('Walk blocks text selection and callouts, then restores selectable app coordinates',async()=>{
  const page=await pageFor({width:390,height:844},true);
  await mapCoordinates(page);
  await page.locator('#hz').click({position:{x:120,y:80}});
  await page.waitForFunction(()=>HZ.selAz!==null);
  const selectCoordinates=async()=>{
    await page.locator('#r-ll').scrollIntoViewIfNeeded();
    await page.locator('#r-ll').click({clickCount:3});
    assert.match(await page.evaluate(()=>getSelection().toString()),/\d+\.\d+/);
    assert.equal(await page.locator('#r-ll').evaluate(el=>el.dispatchEvent(new Event('selectstart',{bubbles:true,cancelable:true}))),true);
  };
  await selectCoordinates();
  await page.locator('#map-game').click();
  await page.waitForFunction(()=>terrainView?.game?.active);
  assert.equal(await page.evaluate(()=>getSelection().toString()),'');
  for(const selector of ['#game-status span','#game-laser-status','.game-speed span','#game-speed-value','#game-look','#game-stick','#game-target']) {
    const el=page.locator(selector).first();
    assert.equal(await el.evaluate(el=>getComputedStyle(el).userSelect),'none',selector);
    for(const type of ['selectstart','contextmenu'])
      assert.equal(await el.evaluate((el,type)=>el.dispatchEvent(new Event(type,{bubbles:true,cancelable:true})),type),false,selector+' '+type);
  }
  assert.equal(await page.evaluate(()=>[document.body,...document.querySelectorAll('body *')]
    .every(el=>getComputedStyle(el).userSelect==='none')),true);
  await page.keyboard.press(process.platform==='darwin'?'Meta+a':'Control+a');
  assert.equal(await page.evaluate(()=>getSelection().toString()),'');
  assert.equal(await page.locator('body').evaluate(el=>el.dispatchEvent(new Event('selectstart',{bubbles:true,cancelable:true}))),false);
  const client=await page.context().newCDPSession(page);
  await client.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
  const r=await page.locator('#game-look').boundingBox();
  await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:r.x+r.width/2,y:r.y+r.height/2,id:1}]});
  await page.waitForTimeout(800);
  await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  assert.equal(await page.evaluate(()=>getSelection().toString()),'');
  await page.locator('#game-exit').click();
  await selectCoordinates();
  assert.equal(await page.locator('#r-ll').evaluate(el=>el.dispatchEvent(new Event('contextmenu',{bubbles:true,cancelable:true}))),true);
  await close(page);
});

test('first-person GPU draw keeps hands stable during movement and restores the terrain camera',async()=>{
  const page=await pageFor({width:390,height:844},true);
  await mapCoordinates(page);await page.locator('#map-game').click();
  await page.waitForFunction(()=>terrainView?.game?.active);
  const result=await page.evaluate(()=>{
    const view=terrainView,game=view.game,gl=view.gl,draw=gl.drawArrays.bind(gl),samples=[];
    gl.drawArrays=(mode,first,count)=>{
      if(mode===gl.TRIANGLES && gl.getUniform(view.program,view.uniforms.mode)===3) {
        const data=new Float32Array(count*9);gl.getBufferSubData(gl.ARRAY_BUFFER,0,data);
        const eye=gl.getUniform(view.program,view.uniforms.eye),camera=game.camera();
        const points=[];
        for(let i=0;i<data.length;i+=9) {
          const p=eye.map((v,j)=>Math.fround(data[i+j]-v));
          const dot=axis=>p.reduce((sum,v,j)=>sum+v*axis[j],0),z=dot(camera.forward);
          points.push(dot(camera.right)*camera.focal/z*view.canvas.clientHeight/2,
            dot(camera.up)*camera.focal/z*view.canvas.clientHeight/2);
        }
        samples.push({points,eye:[...eye]});
      }
      return draw(mode,first,count);
    };
    game.yaw=.3;game.tilt=-.2;
    for(let i=0;i<30;i++) {
      game.position=[.8+i*.0000125,.1,.7+i*.000007];
      view.dirty=true;view.render(null,HZ.P.hObs);
    }
    gl.drawArrays=draw;
    let drift=0;
    for(const sample of samples)sample.points.forEach((v,i)=>drift=Math.max(drift,Math.abs(v-samples[0].points[i])));
    return {drift,count:samples.length,eyes:samples.map(s=>s.eye),
      restored:[...gl.getUniform(view.program,view.uniforms.eye)],expected:game.camera().eye.map(Math.fround),error:gl.getError()};
  });
  assert.equal(result.count,30);
  assert.ok(result.drift<.01,`hand vertices moved ${result.drift}px`);
  assert.ok(result.eyes.every(eye=>eye.every(v=>v===0)));
  assert.deepEqual(result.restored,result.expected);
  assert.equal(result.error,0);
  await page.screenshot({path:'/tmp/horizon-stable-hands.png'});
  await close(page);
});

test('system dark mode keeps controls readable and changes live without losing the mapped location',async()=>{
  for(const size of [{width:390,height:844},{width:1440,height:900}]) {
    const page=await pageFor(size,true,'dark');
    const checkContrast=async selectors=>{
      const results=await page.evaluate(selectors=>{
        const rgb=s=>(s.match(/[\d.]+/g)||[]).map(Number);
        const over=(fg,bg)=>fg.slice(0,3).map((v,i)=>v*(fg[3]??1)+bg[i]*(1-(fg[3]??1)));
        const lum=c=>c.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
        return selectors.map(selector=>{
          const el=document.querySelector(selector),chain=[];
          for(let n=el;n;n=n.parentElement)chain.unshift(n);
          let bg=[255,255,255];
          for(const n of chain)bg=over(rgb(getComputedStyle(n).backgroundColor),bg);
          const fg=over(rgb(getComputedStyle(el).color),bg),a=lum(fg),b=lum(bg);
          return {selector,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
        });
      },selectors);
      for(const r of results)assert.ok(r.ratio>=4.5,`${r.selector} has ${r.ratio.toFixed(2)} contrast`);
    };
    assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).colorScheme),'dark');
    await checkContrast(['#gate h2','#gate-msg','#gate-btn','#gate-photo','#gate-coordinates']);
    await page.screenshot({path:`/tmp/horizon-dark-welcome-${size.width}.png`});
    await mapCoordinates(page);
    await page.locator('#hz').click({position:{x:120,y:80}});
    await page.waitForFunction(()=>HZ.selAz!==null);
    const state=await page.evaluate(()=>({az:HZ.selAz,requests:window.__terrainRequests,lat:S.pos.coords.latitude}));
    await checkContrast(['#map-view button.on','#map-fullscreen','#map-fit','#mp-wrap [data-selection-details]','#mp-attribution']);
    await page.screenshot({path:`/tmp/horizon-dark-map-${size.width}.png`});
    await page.locator('#map-fullscreen').click();
    await checkContrast(['#map-view button.on','#map-fullscreen','#map-fit']);
    await page.locator('#map-fullscreen').click();
    for(const panel of ['location','project','settings']) {
      await page.locator(size.width<=900?`[data-mobile-panel="${panel}"]`:`[data-panel="${panel}"]`).click();
      await checkContrast(['.panel-tabs button.active',`#panel-${panel} .section-heading h2`]);
      if(panel==='settings')await page.screenshot({path:`/tmp/horizon-dark-settings-${size.width}.png`});
      if(size.width<=900)await page.locator('#panel-close').click();
    }
    for(const scheme of ['light','dark','light']) {
      await page.emulateMedia({colorScheme:scheme});
      assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).colorScheme),scheme);
      await page.waitForTimeout(180);
      await checkContrast(['#map-view button.on','#map-fullscreen','#map-fit','#mp-attribution']);
      assert.deepEqual(await page.evaluate(()=>({az:HZ.selAz,requests:window.__terrainRequests,lat:S.pos.coords.latitude})),state);
    }
    await page.screenshot({path:`/tmp/horizon-light-map-${size.width}.png`});
    await noOverflow(page);
    await page.emulateMedia({colorScheme:'dark'});
    const png=await page.evaluate(()=>{
      window.exifr.gps=async()=>({latitude:48.8584,longitude:2.2945});
      window.exifr.parse=async()=>({GPSLatitude:48.8584,GPSLongitude:2.2945,GPSLatitudeRef:'N',GPSLongitudeRef:'E',latitude:48.8584,longitude:2.2945});
      const canvas=document.createElement('canvas');canvas.width=600;canvas.height=400;
      const ctx=canvas.getContext('2d');ctx.fillStyle='#b8c5ca';ctx.fillRect(0,0,600,400);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    await page.locator('#photo-file').setInputFiles({name:'dark-photo.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
    await page.waitForFunction(()=>S.locationSource==='photo' && !HZ.loading && mapView==='perspective' && document.getElementById('photo-preview').naturalWidth>0);
    await page.waitForTimeout(180);
    await checkContrast(['#comparison-photo','#comparison-horizon','#photo-fit','#map-view button.on']);
    assert.equal(await page.locator('#photo-preview').evaluate(el=>getComputedStyle(el).filter),'none');
    await page.screenshot({path:`/tmp/horizon-dark-photo-${size.width}.png`});
    await page.locator('#map-game').click();
    await checkContrast(['#game-exit','#game-camera','#game-speed-value','#game-respawn']);
    await page.locator('#game-exit').click();
    await page.goto(url+'/privacy.html');await page.emulateMedia({colorScheme:'dark'});
    await checkContrast(['h1','p','a']);
    assert.equal(await page.locator('meta[name="theme-color"]').evaluateAll(metas=>metas.filter(m=>matchMedia(m.media).matches).length),1);
    await close(page);
  }
});

test('Viewpoint enters Walk airborne, preserving higher cameras and aim without inheriting zoom',async()=>{
  for(const size of [{width:390,height:844},{width:844,height:390}])for(const source of ['coordinates','photo'])for(const zoom of [.35,3]) {
    const page=await pageFor(size,true);
    if(source==='coordinates') {
      await mapCoordinates(page);await page.locator('[data-v="perspective"]').click();
    } else {
      const png=await page.evaluate(()=>{
        window.exifr.gps=async()=>({latitude:48.8584,longitude:2.2945});
        window.exifr.parse=async()=>({GPSLatitude:48.8584,GPSLongitude:2.2945,GPSLatitudeRef:'N',GPSLongitudeRef:'E',latitude:48.8584,longitude:2.2945});
        const c=document.createElement('canvas');c.width=600;c.height=400;
        return c.toDataURL('image/png').split(',')[1];
      });
      await page.locator('#photo-file').setInputFiles({name:'walk-start.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
      await page.waitForFunction(()=>S.locationSource==='photo' && !HZ.loading && mapView==='perspective');
    }
    await page.waitForFunction(()=>terrainView?.photoView && terrainView?.photoCamera);
    await page.evaluate(zoom=>{
      terrainView.lookPhoto(43,-27);terrainView.zoom(zoom);
      // A previous third-person session must not offset this camera handoff.
      terrainView.game ||= new TerrainGame(terrainView);terrainView.game.thirdPerson=true;
      window.__handoffProfile=HZ.P;
    },zoom);
    await page.waitForTimeout(150);
    const before=await page.evaluate(()=>{
      const camera=terrainView.photoCamera;
      return {eye:camera.eye,forward:camera.forward,fov:terrainView.photoFov,
        radius:terrainData.radius,ground:gameGround(terrainView,camera.eye[0],camera.eye[2]),
        requests:window.__terrainRequests};
    });
    await page.locator('#map-game').click();
    await page.waitForFunction(()=>terrainView.game.active && mapView==='game');
    const after=await page.evaluate(()=>{
      const game=terrainView.game,camera=game.camera();
      return {eye:camera.eye,forward:camera.forward,fov:360/Math.PI*Math.atan((terrainView.canvas.clientWidth/terrainView.canvas.clientHeight)/camera.focal),
        flying:game.flying,thirdPerson:game.thirdPerson,requests:window.__terrainRequests,sameProfile:HZ.P===window.__handoffProfile};
    });
    assert.equal(after.thirdPerson,false);
    for(let i=0;i<3;i++) {
      const expected=i===1?Math.max(before.eye[i],(before.ground+30)/before.radius):before.eye[i];
      assert.ok(Math.abs(after.eye[i]-expected)<1e-9,`${source} camera eye axis ${i}`);
      assert.ok(Math.abs(after.forward[i]-before.forward[i])<1e-9,`${source} aim axis ${i}`);
    }
    const normalFov=size.height>size.width ? 60 : 360/Math.PI*Math.atan(size.width/size.height*Math.tan(Math.PI/6));
    assert.ok(Math.abs(after.fov-normalFov)<1e-8,'Walk uses its standard lens');
    assert.ok(Math.abs(after.fov-before.fov)>1,'test must exercise a different Viewpoint zoom');
    assert.equal(after.flying,true);
    assert.equal(after.requests,before.requests);assert.equal(after.sameProfile,true);
    await page.waitForTimeout(200);
    assert.ok(await page.evaluate(eye=>Math.abs(terrainView.game.camera().eye[1]-eye[1])<1e-9,after.eye),'elevated camera must not fall');
    await page.evaluate(()=>{
      const game=terrainView.game;game.position[0]+=10/terrainData.radius;
      game.reset();for(let i=0;i<1000 && game.flight;i++)game.advanceFlight(1/120);
    });
    await assertDefaultStart(page);
    assert.equal(await page.evaluate(()=>terrainView.game.flying),after.flying);
    await page.locator('#game-exit').click();
    await page.waitForFunction(()=>mapView==='perspective');
    assert.equal(await page.evaluate(()=>terrainView.photoFov),before.fov,'Viewpoint retains its own zoom');
    await close(page);
  }
});

test('first-person gun surfaces occlude correctly regardless of triangle submission order',async()=>{
  const page=await pageFor({width:390,height:844},true);await mapCoordinates(page);
  await page.locator('#map-game').click();
  await page.waitForFunction(()=>terrainView.game?.active);
  for(const size of [{width:390,height:844},{width:844,height:390}])for(const selected of [false,true]) {
    await page.setViewportSize(size);await page.waitForTimeout(150);
    const difference=await page.evaluate(selected=>{
      const view=terrainView,gl=view.gl,original=gameLaserTool;
      const read=()=>{
        view.dirty=true;view.render(selected ? {...readoutTarget(),selected:true} : null,HZ.P.hObs);
        const pixels=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);
        gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
        return pixels;
      };
      const normal=read();
      let reversed;
      try {
        gameLaserTool=(...args)=>{
          const mesh=original(...args),reverse=new Float32Array(mesh.length);
          for(let i=0;i<mesh.length;i+=27)reverse.set(mesh.subarray(i,i+27),mesh.length-i-27);
          return reverse;
        };
        reversed=read();
      } finally {gameLaserTool=original;read();}
      let changed=0;
      for(let i=0;i<normal.length;i+=4)
        if(Math.max(...[0,1,2].map(c=>Math.abs(normal[i+c]-reversed[i+c])))>12)changed++;
      return {changed,total:normal.length/4,fraction:changed/(normal.length/4),error:gl.getError()};
    },selected);
    assert.equal(difference.error,0);
    assert.ok(difference.fraction<.001,`${size.width}px: triangle order changed ${difference.changed} pixels (${(difference.fraction*100).toFixed(2)}%)`);
    await page.screenshot({path:`/tmp/horizon-ray-depth-${size.width}.png`});
  }
  await close(page);
});

test('Fly to Target arrives at default height across hills and Start returns to the source at default height',async()=>{
  const page=await pageFor({width:390,height:844},true);await mapCoordinates(page);
  await page.locator('[data-v="perspective"]').click();await page.locator('#map-game').click();
  await page.waitForFunction(()=>terrainView.game?.active && !document.getElementById('game-target').disabled);
  const initial=await page.evaluate(()=>{
    const g=terrainView.game,r=g.view.model.radius,floor=gameGround(g.view,g.position[0],g.position[2]);
    return {eyeHeight:g.camera().eye[1]*r-floor,ground:floor};
  });
  assert.ok(initial.eyeHeight>20);
  await page.locator('#game-target').click();
  const target=await page.evaluate(()=>({...HZ.pinnedTarget.point}));
  // Ascending after initialization must not replace the target arrival height.
  await page.evaluate(()=>{const g=terrainView.game;g.keys.add('e');g.step(.1);g.keys.clear();});
  await page.locator('#game-goto-target').click();
  await page.waitForFunction(()=>!terrainView.game.flight);
  const height=()=>page.evaluate(()=>{
    const g=terrainView.game,r=g.view.model.radius;
    return g.camera().eye[1]*r-gameGround(g.view,g.position[0],g.position[2]);
  });
  assert.ok(Math.abs(await height()-30)<1e-6);
  assert.equal(await page.evaluate(()=>terrainView.game.flying),true);
  assert.deepEqual(await page.evaluate(()=>HZ.pinnedTarget.point),target);
  await page.waitForTimeout(200);assert.ok(Math.abs(await height()-30)<1e-6);
  const hills=await page.evaluate(()=>{
    const g=terrainView.game,r=g.view.model.radius,points=[];
    for(let x=-.8;x<=.8;x+=.2)for(let z=-.8;z<=.8;z+=.2)
      points.push([x,gameGround(g.view,x,z)/r,z]);
    points.sort((a,b)=>a[1]-b[1]);
    return [points[0],points.at(-1)].map(p=>{
      const target=gameTarget(g,HZ.P.hObs,HZ.P.k,p).point;
      const started=g.goToTarget(target);let clearance=Infinity,count=0;
      while(g.flight && count++<1000) {
        g.advanceFlight(1/120);
        clearance=Math.min(clearance,g.position[1]*r-gameGround(g.view,g.position[0],g.position[2]));
      }
      g.step(1/60);
      return {started,finished:!g.flight,clearance,ground:gameGround(g.view,g.position[0],g.position[2]),
        eyeHeight:g.camera().eye[1]*r-gameGround(g.view,g.position[0],g.position[2]),flying:g.flying,
        horizontalError:Math.hypot(g.position[0]-p[0],g.position[2]-p[2])*r};
    });
  });
  assert.ok(hills[0].ground<initial.ground && hills[1].ground>initial.ground,'exercise lower and higher terrain');
  for(const result of hills) {
    assert.ok(result.started && result.finished && result.flying);
    assert.ok(result.clearance>=-1e-6,'flight clears terrain');
    assert.ok(result.horizontalError<.001);
    assert.ok(Math.abs(result.eyeHeight-30)<1e-6);
  }
  await page.evaluate(()=>{const g=terrainView.game;g.keys.add('e');g.step(.1);g.keys.clear();});
  await page.locator('#game-respawn').click();await page.waitForFunction(()=>!terrainView.game.flight);
  assert.ok(Math.abs(await height()-30)<1e-6);
  await assertDefaultStart(page);
  assert.equal(await page.evaluate(()=>terrainView.game.flying),true);
  // A fresh session started from Map must also start and arrive airborne.
  await page.locator('#game-exit').click();await page.locator('[data-v="2d"]').click();await page.locator('#map-game').click();
  await page.waitForFunction(()=>terrainView.game.active && !document.getElementById('game-target').disabled);
  await page.locator('#game-target').click();await page.locator('#game-goto-target').click();
  await page.waitForFunction(()=>!terrainView.game.flight);
  assert.ok(Math.abs(await height()-30)<1e-6);
  assert.equal(await page.evaluate(()=>terrainView.game.flying),true);
  await close(page);
});

test('left-handed Ray Gun retains live directional lighting',async()=>{
  const page=await pageFor({width:844,height:390},true);await mapCoordinates(page);await page.locator('#map-game').click();
  await page.waitForFunction(()=>terrainView.game?.active);
  const result=await page.evaluate(()=>{
    const v=terrainView,g=v.game,gl=v.gl,drawElements=gl.drawElements.bind(gl),drawArrays=gl.drawArrays.bind(gl),clearColor=gl.clearColor.bind(gl);
    // Render only the real weapon pass against black, so terrain cannot make
    // a static image seem to respond to lighting in this comparison.
    gl.drawElements=()=>{};
    gl.drawArrays=(mode,first,count)=>{if(gl.getUniform(v.program,v.uniforms.mode)===3)drawArrays(mode,first,count);};
    gl.clearColor=()=>clearColor(0,0,0,1);
    const samples=[];
    try {
      for(const yaw of [0,Math.PI]) {
        g.yaw=yaw;g.tilt=-.2;v.dirty=true;v.render(null,HZ.P.hObs);
        const pixels=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);
        gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
        samples.push(pixels);
      }
    } finally {gl.drawElements=drawElements;gl.drawArrays=drawArrays;gl.clearColor=clearColor;v.dirty=true;}
    let visible=0,changed=0;
    for(let i=0;i<samples[0].length;i+=4) {
      if(Math.max(...samples[0].subarray(i,i+3))>15) {
        visible++;
        if(Math.max(...[0,1,2].map(c=>Math.abs(samples[0][i+c]-samples[1][i+c])))>8)changed++;
      }
    }
    const laser=g.laser(),camera=g.camera();
    const side=laser.origin.reduce((sum,x,i)=>sum+(x-camera.eye[i])*camera.right[i],0)*v.model.radius;
    return {visible,changed,side,error:gl.getError(),vertices:gameRayGunMesh(false).length/9};
  });
  assert.equal(result.error,0);
  assert.ok(result.visible>1000);
  assert.ok(result.changed/result.visible>.15,`${result.changed}/${result.visible} weapon pixels react to turning`);
  assert.ok(result.side<0,'muzzle and model sit to the left');
  assert.ok(result.vertices<100000,'keep the model suitable for mobile rendering');
  await close(page);
});

test('Walk Nav opens the current avatar location until a target is marked, then falls back after clearing',async()=>{
  const page=await pageFor({width:390,height:844},true);await mapCoordinates(page);
  await page.evaluate(()=>{mapApp='google';labelMapApp();window.__navUrls=[];window.open=url=>window.__navUrls.push(url);});
  await page.locator('#map-game').click();
  await page.waitForFunction(()=>terrainView.game?.active && !document.getElementById('game-maps').disabled);
  assert.match(await page.locator('#game-maps').getAttribute('aria-label'),/avatar location in Google Maps/);
  assert.equal(await page.locator('#game-goto-target').isDisabled(),true);
  await page.evaluate(()=>{
    const game=terrainView.game;game.position=terrainPoint(terrainData,{lat:48.859,lon:2.296,elev:200});
    game.flying=true;game.tilt=-1.2;terrainView.dirty=true;
  });
  await page.waitForFunction(()=>document.getElementById('game-target').disabled);
  await page.locator('#game-maps').click();
  assert.equal(await page.evaluate(()=>window.__navUrls.at(-1)),'https://www.google.com/maps/search/?api=1&query=48.859000,2.296000');
  await page.evaluate(()=>{terrainView.game.tilt=.6;terrainView.dirty=true;});
  await page.waitForFunction(()=>!document.getElementById('game-target').disabled);
  await page.locator('#game-target').click();
  const target=await page.evaluate(()=>({lat:HZ.pinnedTarget.point.lat.toFixed(6),lon:HZ.pinnedTarget.point.lon.toFixed(6)}));
  assert.match(await page.locator('#game-maps').getAttribute('aria-label'),/marked target/);
  await page.evaluate(()=>{
    const game=terrainView.game;game.position=terrainPoint(terrainData,{lat:48.8601,lon:2.2972,elev:200});
    game.flying=true;terrainView.dirty=true;
  });
  await page.locator('#game-maps').click();
  assert.equal(await page.evaluate(()=>window.__navUrls.at(-1)),`https://www.google.com/maps/search/?api=1&query=${target.lat},${target.lon}`);
  await page.evaluate(()=>clearSelection());
  await page.waitForFunction(()=>document.getElementById('game-maps').title.includes('avatar location'));
  await page.locator('#game-maps').click();
  assert.equal(await page.evaluate(()=>window.__navUrls.at(-1)),'https://www.google.com/maps/search/?api=1&query=48.860100,2.297200');
  await page.evaluate(()=>{mapApp='gaia';labelMapApp();});
  await page.locator('#game-maps').click();
  assert.equal(await page.evaluate(()=>window.__navUrls.at(-1)),'https://www.gaiagps.com/map/?loc=14/2.297200/48.860100');
  assert.match(await page.locator('#game-maps').getAttribute('aria-label'),/avatar location in Gaia GPS/);
  await close(page);
});

test('marked laser targets render a sky beam anchored through movement and flight, and clear cleanly',async()=>{
  const page=await pageFor({width:390,height:844},true);await mapCoordinates(page);await page.locator('#map-game').click();
  await page.waitForFunction(()=>terrainView.game?.active && !document.getElementById('game-target').disabled);
  const capture=()=>page.evaluate(()=>{
    const v=terrainView,gl=v.gl,draw=gl.drawArrays.bind(gl),calls=[];
    gl.drawArrays=(mode,first,count)=>{
      if(gl.getUniform(v.program,v.uniforms.mode)===5) {
        const vertices=new Float32Array(count*5);gl.getBufferSubData(gl.ARRAY_BUFFER,0,vertices);
        calls.push({base:[(vertices[0]+vertices[5])/2,vertices[1],(vertices[2]+vertices[7])/2],
          height:vertices[11]-vertices[1],depth:gl.isEnabled(gl.DEPTH_TEST),blend:gl.isEnabled(gl.BLEND)});
      }
      draw(mode,first,count);
    };
    try {
      v.dirty=true;v.render(readoutTarget(),HZ.P.hObs);
      const pixels=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);
      gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
      let beamPixels=0;
      for(let i=0;i<pixels.length;i+=4)if(pixels[i+2]>210 && pixels[i+1]>140 && pixels[i+2]-pixels[i]>90)beamPixels++;
      return {calls,beamPixels,error:gl.getError(),depthMask:gl.getParameter(gl.DEPTH_WRITEMASK),blending:gl.isEnabled(gl.BLEND),
        expected:HZ.pinnedTarget?terrainPoint(v.model,HZ.pinnedTarget.point):null};
    } finally {gl.drawArrays=draw;v.dirty=true;}
  });
  assert.equal((await capture()).calls.length,0,'aiming alone does not place a beacon');
  await page.locator('#game-target').click();
  const marked=await capture();
  assert.equal(marked.calls.length,1);assert.ok(marked.beamPixels>100,'GPU renders the bright blue beam');
  const verify=result=>{
    assert.equal(result.error,0);assert.equal(result.calls.length,1);
    assert.ok(Math.hypot(...result.calls[0].base.map((x,i)=>x-result.expected[i]))<1e-6,'beam foot matches marked terrain point');
    assert.ok(result.calls[0].height>=2-1e-6);assert.ok(result.calls[0].depth && result.calls[0].blend);
    assert.ok(result.depthMask);assert.equal(result.blending,false,'restore render state');
  };
  verify(marked);
  await page.screenshot({path:'/tmp/horizon-target-beacon-portrait.png'});
  await page.evaluate(()=>{const g=terrainView.game;g.position[0]+=.003;g.position[1]+=.01;g.flying=true;});
  verify(await capture());
  await page.locator('#game-goto-target').click();
  await page.waitForFunction(()=>!!terrainView.game.flight);verify(await capture());
  await page.waitForFunction(()=>!terrainView.game.flight);verify(await capture());
  await page.evaluate(()=>{terrainView.game.thirdPerson=true;});verify(await capture());
  await page.setViewportSize({width:844,height:390});await page.waitForTimeout(150);
  await page.evaluate(()=>{const g=terrainView.game;g.thirdPerson=false;g.position[1]+=.03;g.tilt=.6;});
  await page.waitForFunction(()=>!document.getElementById('game-target').disabled);
  await page.locator('#game-target').click();
  const replaced=await capture();verify(replaced);
  assert.notDeepEqual(replaced.expected,marked.expected,'new mark replaces old beam');
  await page.screenshot({path:'/tmp/horizon-target-beacon-landscape.png'});
  await page.locator('#game-exit').click();await page.locator('[data-v="perspective"]').click();
  verify(await capture());
  await page.evaluate(()=>clearSelection());assert.equal((await capture()).calls.length,0);
  await close(page);
});

test('Walk search is explicit, snapshots the aimed point, caches repeats, and fits phone controls',async()=>{
  const page=await pageFor({width:390,height:844},true);let requests=0,release;
  await page.route('https://photon.komoot.io/**',async route=>{
    requests++;await new Promise(resolve=>release=resolve);
    const q=new URL(route.request().url()).searchParams;
    await route.fulfill({json:{features:[{type:'Feature',geometry:{type:'Point',coordinates:[Number(q.get('lon')),Number(q.get('lat'))]},properties:{osm_type:'N',osm_id:123,type:'house',osm_key:'amenity',osm_value:'cafe',name:'Test Coffee',housenumber:'12',street:'Main Street'}}]}});
  });
  await mapCoordinates(page);await page.locator('#map-game').click();
  await page.waitForFunction(()=>!document.getElementById('game-search').disabled);
  await page.locator('#game-target').click();assert.equal(requests,0,'marking a target does not search');
  const pin=await page.evaluate(()=>JSON.stringify(HZ.pinnedTarget));
  await page.locator('#game-search').click();await page.waitForFunction(()=>document.getElementById('game-search-content').textContent.includes('Searching'));
  while(!release)await page.waitForTimeout(10);
  assert.equal(await page.locator('#game-search').isDisabled(),true);
  const aimed=await page.locator('#game-search-content p').textContent();
  await page.evaluate(()=>{terrainView.game.yaw+=.5;terrainView.game.position[0]+=.0001;});
  release();await page.waitForFunction(()=>document.getElementById('game-search-content').textContent.includes('Test Coffee'));
  assert.ok((await page.locator('#game-search-content').textContent()).includes(aimed),'result stays tied to the searched point');
  assert.equal(await page.evaluate(()=>JSON.stringify(HZ.pinnedTarget)),pin,'search does not move marker');
  assert.match(await page.locator('#game-search-google').getAttribute('href'),/^https:\/\/www.google.com\/search\?q=Test/);
  for(const [width,height] of [[390,844],[320,568],[568,320],[844,390]]) {
    await page.setViewportSize({width,height});await page.waitForTimeout(100);
    const result=await page.evaluate(()=>{
      const rect=id=>{const r=document.getElementById(id).getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom};};
      const ids=['game-search','game-target','game-goto-target','game-maps','game-look','game-stick','game-camera','game-exit'];
      const boxes=ids.map(id=>({id,...rect(id)}));
      return {card:rect('game-search-card'),boxes,overlaps:boxes.flatMap((a,i)=>boxes.slice(i+1).filter(b=>Math.min(a.right,b.right)-Math.max(a.x,b.x)>1 && Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)>1).map(b=>[a.id,b.id]))};
    });
    assert.deepEqual(result.overlaps,[]);assert.ok(result.card.x>=0 && result.card.right<=width && result.card.bottom<=height);
    for(const b of result.boxes)assert.ok(b.x>=0 && b.right<=width && b.y>=0 && b.bottom<=height,JSON.stringify(b));
    await page.screenshot({path:`/tmp/horizon-search-${width}.png`});
  }
  assert.equal(requests,1,'movement, rendering and resizing do not search');
  await page.locator('#game-search-close').click();assert.equal(await page.locator('#game-search-card').isVisible(),false);
  // Aim back at the original point, including the original camera position.
  await page.evaluate(()=>{terrainView.game.yaw-=.5;terrainView.game.position[0]-=.0001;});
  await page.locator('#game-search').click();
  await page.waitForFunction(()=>document.getElementById('game-search-content').textContent.includes('Test Coffee'));
  assert.equal(requests,1,'repeat point uses cached response');
  await page.locator('#game-exit').click();assert.equal(await page.locator('#game-search-card').isVisible(),false);
  await close(page);
});

test('Walk search handles empty results, network failures, sky aiming and late responses after close',async()=>{
  const page=await pageFor({width:390,height:844},true);let mode='empty',release,requests=0;
  await page.route('https://photon.komoot.io/**',async route=>{
    requests++;
    if(mode==='late')await new Promise(resolve=>release=resolve);
    if(mode==='failure')return route.abort('internetdisconnected');
    await route.fulfill({json:{features:[]}}).catch(()=>{});
  });
  await mapCoordinates(page);await page.locator('#map-game').click();
  await page.waitForFunction(()=>!document.getElementById('game-search').disabled);
  await page.locator('#game-search').click();
  await page.waitForFunction(()=>!gameSearchRequest);
  assert.match(await page.locator('#game-search-content').textContent(),/^[-\d.]+, [-\d.]+$/,'no match shows only coordinates');
  await page.locator('#game-search-close').click();
  await page.evaluate(()=>{terrainView.game.tilt=-1;});
  await page.waitForFunction(()=>document.getElementById('game-search').disabled);assert.equal(requests,1,'sky cannot be searched');
  await page.evaluate(()=>{terrainView.game.tilt=.6;});await page.waitForTimeout(2100);
  mode='failure';await page.locator('#game-search').click();await page.waitForFunction(()=>!gameSearchRequest);
  assert.match(await page.locator('#game-search-content').textContent(),/connection/);
  assert.match(await page.locator('#game-search-google').getAttribute('href'),/google.com\/search/);
  await page.locator('#game-search-close').click();await page.waitForTimeout(2100);
  mode='late';await page.locator('#game-search').click();while(!release)await page.waitForTimeout(10);
  await page.locator('#game-search-close').click();release();await page.waitForTimeout(100);
  assert.equal(await page.locator('#game-search-card').isVisible(),false,'stale response cannot reopen card');
  assert.equal(await page.locator('#game-search').isDisabled(),false);
  await close(page);
});

test('Walk entry preserves camera height, Target arrives at 30 m, and Start also arrives at 30 m',async()=>{
  for(const [view,source,height] of [['2d','gps',30],['2d','coordinates',30],['3d','coordinates',30],['perspective','coordinates',1.6],['perspective','coordinates',120],['perspective','photo',1.6]]) {
    const page=await pageFor({width:390,height:844},true);
    if(source==='photo') {
      const png=await page.evaluate(()=>{
        window.exifr.parse=async()=>({GPSLatitude:48.8584,GPSLongitude:2.2945,GPSLatitudeRef:'N',GPSLongitudeRef:'E',latitude:48.8584,longitude:2.2945});
        const c=document.createElement('canvas');c.width=600;c.height=400;return c.toDataURL().split(',')[1];
      });
      await page.locator('#photo-file').setInputFiles({name:'airborne.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
      await page.waitForFunction(()=>S.locationSource==='photo' && !HZ.loading && terrainData && mapView==='perspective');
    } else {
      if(source==='gps') {
        await page.locator('#gate-btn').click();await page.waitForFunction(()=>window.__gpsRequests===1);
        await page.evaluate(()=>window.__gpsSuccess({coords:{latitude:48.8584,longitude:2.2945,accuracy:5},timestamp:Date.now()}));
        await page.waitForFunction(()=>HZ.P && terrainData && !HZ.loading);
      } else await mapCoordinates(page);
      if(view==='perspective')await page.evaluate(height=>{locationCamera.height=height===1.6?'ground':'custom';locationCamera.customHeight=height;},height);
      if(view!=='2d')await page.locator(`[data-v="${view}"]`).click();
    }
    await page.locator('#map-game').click();
    await page.waitForFunction(()=>terrainView.game?.active);
    const state=()=>page.evaluate(()=>{
      const g=terrainView.game,r=g.view.model.radius;
      return {height:g.aimCamera().eye[1]*r-gameGround(g.view,g.position[0],g.position[2]),flying:g.flying,position:[...g.position]};
    });
    const start=await state();
    assert.ok(start.height>=Math.max(30,height)-1e-6,`${source}/${view}: started at ${start.height} m instead of airborne`);
    assert.equal(start.flying,true);
    await page.waitForTimeout(150);assert.ok(Math.abs((await state()).height-start.height)<1e-6,'spawn holds altitude');
    // Aim almost straight down from the overhead Terrain camera on the 2 km fixture.
    await page.evaluate(view=>{terrainView.game.tilt=view==='3d' ? Math.PI/2-.01 : .4;},view);
    await page.waitForFunction(()=>!document.getElementById('game-target').disabled);
    await page.locator('#game-target').click();
    const selected=await page.evaluate(()=>terrainPoint(terrainData,HZ.pinnedTarget.point));
    // Land first to exercise Target arrival independently of current height.
    await page.evaluate(()=>{
      const g=terrainView.game;g.position[1]=gameGround(g.view,g.position[0],g.position[2])/g.view.model.radius;
      g.flying=false;g.velocityY=0;
    });
    await page.locator('#game-goto-target').click();await page.waitForFunction(()=>!terrainView.game.flight);
    const arrival=await state();assert.equal(arrival.flying,true);
    assert.ok(Math.abs(arrival.height-30)<1e-6,'Target restores normal Walk eye height after landing');
    assert.ok(Math.hypot(arrival.position[0]-selected[0],arrival.position[2]-selected[2])<1e-9);
    await page.locator('#game-respawn').click();await page.waitForFunction(()=>!terrainView.game.flight);
    const returned=await state();assert.equal(returned.flying,true);
    await assertDefaultStart(page);
    await page.waitForTimeout(150);assert.ok(Math.abs((await state()).height-30)<1e-6,'return holds default height');
    if(view==='2d')await page.screenshot({path:'/tmp/horizon-airborne-map-start.png'});
    await close(page);
  }
});

test("location search maps addresses and disambiguates mountain names", async () => {
  const page = await pageFor({width: 390, height: 844}, true);
  const cases = [
    ["Mount Fuji", "Mount Fuji", "Japan", 35.3628384, 138.7307677],
    ["Mount Everest", "Mount Everest", "Nepal", 27.9880614, 86.92521],
    ["1600 Pennsylvania Avenue NW Washington DC", "White House", "United States", 38.8976387, -77.0365525],
  ];
  let calls = 0;
  await page.route("https://photon.komoot.io/api/**", async route => {
    const query = new URL(route.request().url()).searchParams.get("q");
    calls++;
    if (query === "Error") return route.fulfill({status: 503, body: ""});
    const match = cases.find(row => row[0] === query);
    const features = match ? [{geometry: {type: "Point", coordinates: [match[4], match[3]]},
      properties: {name: match[1], country: match[2]}}] : [];
    if (query.startsWith("Mount ")) features.push({geometry: {type: "Point", coordinates: [-91, 44]},
      properties: {name: query, country: "United States"}});
    await route.fulfill({json: {features}});
  });
  await page.locator("#gate-coordinates").click();
  async function submit(query) {
    await page.locator("#coordinate-input").fill(query);
    await page.locator("#coordinate-input").press("Enter");
  }
  for (const [query, name, country, lat, lon] of cases) {
    await submit(query);
    if (query.startsWith("Mount ")) {
      await page.getByRole("button", {name: name + " · " + country, exact: true}).click();
    }
    await page.waitForFunction(([lat, lon]) => window.__lastRequest?.lat === Number(lat.toFixed(6)) &&
      window.__lastRequest.lon === Number(lon.toFixed(6)) && !HZ.loading, [lat, lon]);
    await page.locator('[data-mobile-panel="location"]').click();
  }
  for (const [query, message] of [["No matches", "No matching"], ["Error", "unavailable"]]) {
    await submit(query);
    await page.waitForFunction(text => document.getElementById("coordinate-error").textContent.includes(text), message);
    assert.equal(await page.evaluate(() => S.pos.destinationName), "White House");
  }
  await submit("35.1 139.2");
  await page.waitForFunction(() => window.__lastRequest?.lat === 35.1 && window.__lastRequest.lon === 139.2);
  assert.equal(calls, 5);
  await close(page);
});

test('Terrain hands its rendered orbit eye and direction to Walk after navigating', async () => {
  const page = await pageFor({width: 1200, height: 800}, true);
  await mapCoordinates(page);
  await page.locator('[data-v="3d"]').click();
  for (const scenario of ['inside', 'near ground']) {
    const expected = await page.evaluate(scenario => {
      const v = terrainView;
      v.resetCamera();
      v.zoom(.012);
      v.orbit(.8, -.24);
      v.pan(-140, 65);
      if (scenario === 'near ground') {
        v.zoom(.0001);
        v.focus[1] = gameGround(v, v.focus[0], v.focus[2]) / v.model.radius;
      }
      v.dirty = true;
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
        const {eye, forward} = v.activeCamera;
        const x = Math.max(-1, Math.min(1, eye[0])), z = Math.max(-1, Math.min(1, eye[2]));
        const ground = gameGround(v, x, z), r = v.model.radius;
        resolve({eye, focus: v.focus, forward, x, z, ground, r});
      })));
    }, scenario);
    const {eye, focus, forward, x, z, ground, r} = expected;
    if (scenario === 'inside') {
      assert.ok(Math.hypot(x,z) > .005 && Math.hypot(x-focus[0],z-focus[2]) > .005);
      assert.ok(eye[1]*r > ground+30 && eye[1]*r < ground+5000);
    }
    if (scenario === 'near ground') assert.ok(eye[1]*r < ground+30);
    await page.locator('#map-game').click();
    const actual = await page.evaluate(() => terrainView.game.aimCamera());
    const height = Math.max(ground+1.65, eye[1]*r);
    for (const [i, coordinate] of [x, height/r, z].entries()) {
      assert.ok(Math.abs(actual.eye[i]-coordinate) < 1e-8, scenario+' eye '+i);
      assert.ok(Math.abs(actual.forward[i]-forward[i]) < 1e-8, scenario+' direction '+i);
    }
    await page.locator('#game-exit').click();
  }
  await close(page);
});

test('Walk loads each outside edge around the geographic eye and restores the observer terrain', async () => {
  const page = await pageFor({width:1200,height:800}, true);
  await mapCoordinates(page);
  await page.locator('[data-v="3d"]').click();
  await page.evaluate(() => {
    // A 12 km observer patch requests a separate 6 km Walk patch.
    terrainData={...terrainData,radius:12000,half:terrainData.half*6,patches:[]};
    terrainView.setModel(terrainData);
    window.originalTerrain=terrainData;
    window.originalObserver=S.pos;
    window.originalProfile=HZ.P;
    HZ.selAz=12; HZ.pinnedTarget={bearing:12,point:{lat:48.86,lon:2.29,elev:80,dist:300,ang:1}};
    window.originalTarget=HZ.pinnedTarget;
    window.Worker=class {
      postMessage({options}) { window.patchOptions=options; window.patchWorker=this; }
      terminate() {this.terminated=true;}
    };
  });
  for (const [x,z] of [[1.25,.2],[-1.25,.1],[.25,-1.35],[-.3,1.4],[1.2,-1.3]]) {
    const elevated=x>1 && z<0;
    const expected=await page.evaluate(([x,z])=>{
      const v=terrainView;
      v.resetCamera();v.orthographic=false;v.distance=.2;v.tilt=.25;v.yaw=.7;
      const eye=terrainOrbitCamera(v).eye;
      v.focus=[x-eye[0],8200/terrainData.radius+v.focus[1]-eye[1],z-eye[2]];
      const size=256*2**terrainData.z;
      const lon=(terrainData.cx+x*terrainData.half)/size*360-180;
      const lat=Math.atan(Math.sinh(Math.PI*(1-2*(terrainData.cy+z*terrainData.half)/size)))*180/Math.PI;
      return {lat,lon,forward:terrainOrbitCamera(v).forward,view:v.captureView()};
    },[x,z]);
    await page.locator('#map-game').click();
    assert.equal(await page.locator('#walk-patch-cancel').isVisible(),true);
    const options=await page.evaluate(()=>patchOptions);
    assert.ok(Math.abs(options.lat-expected.lat)<1e-10 && Math.abs(options.lon-expected.lon)<1e-10);
    assert.equal(options.radius,6000);
    await page.evaluate(elevated=>{
      const {lat,lon,radius}=patchOptions,model={...terrainData,lat0:lat,lon0:lon,radius};
      model.half=terrainData.half*(radius/terrainData.radius)*Math.cos(terrainData.lat0*Math.PI/180)/Math.cos(lat*Math.PI/180);
      model.heights=terrainData.heights.map(()=>900);
      model.patches=[{radius:radius/2,heights:model.heights.map(()=>elevated?8500:1200)}];
      const size=256*2**model.z;
      model.cx=(lon+180)/360*size;
      model.cy=(1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)*size/2;
      patchWorker.onmessage({data:{type:'terrain',data:model}});
    },elevated);
    const result=await page.evaluate(()=>{
      const g=terrainView.game;
      const before=walkGeographicPoint(g.view.model,g.aimCamera().eye);
      const aim=g.aimCamera().forward;
      const elevation=gameGround(g.view,g.position[0],g.position[2]);
      g.keys.add('w');g.step(.05);g.keys.clear();
      const after=walkGeographicPoint(g.view.model,g.aimCamera().eye);
      const hit=gameTarget(g,HZ.P.hObs,HZ.P.k,[0,0,0]);
      return {before,after,aim,elevation,dist:hit.point.dist};
    });
    assert.ok(Math.abs(result.before.lat-expected.lat)<1e-8 && Math.abs(result.before.lon-expected.lon)<1e-8);
    const altitude=elevated ? result.elevation+1.65 : 8200;
    assert.ok(Math.abs(result.elevation-(elevated?8500:1200))<.01);
    assert.ok(Math.abs(result.before.elev-altitude)<1e-6 && Math.abs(result.after.elev-altitude)<1e-6);
    assert.notEqual(result.before.lat,result.after.lat);
    assert.ok(result.dist>1000,'marked coordinates measure from original observer');
    result.aim.forEach((v,i)=>assert.ok(Math.abs(v-expected.forward[i])<1e-9));
    if (elevated) {
      await page.locator('#game-respawn').click();
      await page.waitForFunction(()=>terrainView.model===originalTerrain && !terrainView.game.flight);
      const landed=await page.evaluate(()=>walkGeographicPoint(terrainView.model,terrainView.game.position));
      assert.ok(Math.abs(landed.lat-48.8584)<1e-8 && Math.abs(landed.lon-2.2945)<1e-8);
      assert.equal(await page.evaluate(()=>terrainView.game.relativeToStart().distance),0);
      await assertDefaultStart(page);
    }
    await page.locator('#game-exit').click();
    assert.deepEqual(await page.evaluate(()=>terrainView.captureView()),expected.view);
    assert.ok(await page.evaluate(()=>mapView==='3d' && terrainView.model===originalTerrain &&
      terrainData===originalTerrain && S.pos===originalObserver && HZ.P===originalProfile && HZ.pinnedTarget===originalTarget));
  }
  await page.evaluate(()=>{terrainView.focus[0]=3;});
  await page.locator('#map-game').click();
  await page.locator('#walk-patch-cancel').click();
  assert.ok(await page.evaluate(()=>patchWorker.terminated));
  await page.evaluate(()=>patchWorker.onmessage({data:{type:'terrain',data:terrainData}}));
  assert.equal(await page.evaluate(()=>mapView),'3d');
  await page.locator('#map-game').click();
  await page.evaluate(()=>patchWorker.onmessage({data:{type:'failed',data:{error:'Tiles unavailable'}}}));
  assert.match(await page.locator('#walk-patch-status').innerText(),/unavailable/);
  assert.ok(await page.evaluate(()=>terrainView.model===originalTerrain && mapView==='3d'));
  await page.evaluate(()=>{terrainView.focus[2]=1e7;window.patchWorker=null;});
  await page.locator('#map-game').click();
  assert.match(await page.locator('#walk-patch-status').innerText(),/80°/);
  assert.equal(await page.evaluate(()=>window.patchWorker),null);
  await close(page);
});

test('Terrain Walk keeps the active Search marker as Start across new searches', async()=>{
  const page=await pageFor({width:1200,height:800},true);
  await mapCoordinates(page);
  for(const [lat,lon] of [[48.8584,2.2945],[48.86,2.30]]) {
    if(lat===48.86) {
      await page.locator('#coordinate-pick').click();
      await page.locator('#coordinate-input').fill(lat+', '+lon);
      await page.locator('#coordinate-input').press('Enter');
      await page.waitForFunction(()=>S.pos.coords.latitude===48.86 && !HZ.loading);
    }
    await page.locator('[data-v="3d"]').click();
    await page.evaluate(()=>{
      terrainView.resetCamera();terrainView.zoom(.05);terrainView.orbit(.7,-.2);terrainView.pan(-80,55);
      HZ.selAz=42;HZ.pinnedTarget={bearing:42,point:{lat:48.861,lon:2.291,elev:65,dist:200,ang:1}};
    });
    await page.locator('#map-game').click();
    assert.ok(await page.evaluate(()=>terrainView.game.relativeToStart().distance>50));
    await page.locator('#game-respawn').click();
    await page.waitForFunction(()=>!terrainView.game.flight);
    const arrival=await page.evaluate(()=>walkGeographicPoint(terrainView.model,terrainView.game.position));
    assert.ok(Math.abs(arrival.lat-lat)<1e-8 && Math.abs(arrival.lon-lon)<1e-8);
    assert.equal(await page.evaluate(()=>HZ.pinnedTarget.bearing),42);
    await assertDefaultStart(page);
    await page.locator('#game-exit').click();
  }
  await page.locator('#use-gps').click();
  await page.waitForFunction(()=>window.__gpsRequests>0);
  await page.evaluate(()=>window.__gpsSuccess({coords:{latitude:48.859,longitude:2.295,accuracy:5},timestamp:Date.now()}));
  await page.waitForFunction(()=>S.locationSource==='gps' && terrainData && !HZ.loading);
  await page.locator('[data-v="3d"]').click();
  await page.locator('#map-game').click();
  assert.equal(await page.evaluate(()=>terrainView.game.startMarker.lat),48.859);
  await page.locator('#game-respawn').click();await page.waitForFunction(()=>!terrainView.game.flight);
  await assertDefaultStart(page);
  await close(page);
});

test('top-down Terrain enters Walk over the same footprint before the first orbit', async()=>{
  for (const viewport of [{width:390,height:844},{width:1440,height:900}]) {
    const page=await pageFor(viewport,true);await mapCoordinates(page);
    for (const moved of [false,true]) {
      await page.locator('[data-v="3d"]').click();
      const frame=await page.evaluate(moved=>{
        const v=terrainView;
        if (moved) {v.zoom(.45);v.pan(-45,30);}
        const c=terrainOrbitCamera(v),h=c.halfHeight*v.model.radius;
        return {ortho:v.orthographic,x:v.focus[0],z:v.focus[2],h,w:h*v.canvas.clientWidth/v.canvas.clientHeight};
      },moved);
      assert.equal(frame.ortho,true);
      await page.locator('#map-game').click();
      const pose=await page.evaluate(()=>{
        const v=terrainView,g=v.game,r=v.model.radius;
        g.step(.016);g.lookBy(3,0);
        const c=g.aimCamera(),ground=gameGround(v,c.eye[0],c.eye[2]);
        const h=(c.eye[1]*r-ground)/c.focal;
        return {x:c.eye[0],z:c.eye[2],h,w:h*v.canvas.clientWidth/v.canvas.clientHeight,
          forward:c.forward,up:c.up,right:c.right,ortho:c.halfHeight};
      });
      assert.equal(pose.ortho,0);
      assert.ok(Math.hypot(pose.x-frame.x,pose.z-frame.z)<1e-10);
      assert.ok(Math.hypot(pose.forward[0],pose.forward[2])<1e-9 && pose.forward[1]<-.999999);
      assert.ok(Math.abs(Math.hypot(...pose.up)-1)<1e-9 && Math.abs(Math.hypot(...pose.right)-1)<1e-9);
      assert.ok(pose.w/frame.w>=.99999 && pose.h/frame.h>=.99999);
      assert.ok(Math.abs(Math.min(pose.w/frame.w,pose.h/frame.h)-1)<1e-5);
      await page.locator('#game-respawn').click();await page.waitForFunction(()=>!terrainView.game.flight);
      await assertDefaultStart(page);
      await page.locator('#game-exit').click();
      await page.locator('[data-v="2d"]').click();
    }
    await close(page);
  }
});

test('a photo selected after Search becomes Start for an elevated, displaced Terrain walk',async()=>{
  const page=await pageFor({width:1200,height:800},true);
  await mapCoordinates(page);
  const png=await page.evaluate(()=>{
    window.exifr.parse=async()=>({GPSLatitude:48.863,GPSLongitude:2.30,GPSLatitudeRef:'N',GPSLongitudeRef:'E',latitude:48.863,longitude:2.30});
    const c=document.createElement('canvas');return c.toDataURL().split(',')[1];
  });
  await page.locator('#photo-file').setInputFiles({name:'source-marker.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
  await page.waitForFunction(()=>S.locationSource==='photo' && mapView==='perspective' && !HZ.loading);
  await page.locator('[data-v="3d"]').click();
  await page.waitForFunction(()=>mapView==='3d' && terrainView?.model && !HZ.loading);
  await page.evaluate(()=>{
    const v=terrainView;v.resetCamera();v.zoom(.1);v.orbit(.4,-.25);v.pan(-60,40);
    v.focus[1]+=7000/v.model.radius;
  });
  await page.locator('#map-game').click();
  assert.ok(await page.evaluate(()=>terrainView.game.aimCamera().eye[1]*terrainData.radius>7000));
  await page.locator('#game-respawn').click();await page.waitForFunction(()=>!terrainView.game.flight);
  await assertDefaultStart(page);
  assert.equal(await page.evaluate(()=>S.pos.coords.latitude),48.863);
  assert.equal(await page.evaluate(()=>S.photoName),'source-marker.png');
  await close(page);
});

test('Walk allocates bounded imagery to the visible mesh and keeps useful Terrain layers',async()=>{
  const page=await pageFor({width:390,height:844},true);
  await mapCoordinates(page);
  await page.locator('[data-v="3d"]').click();
  const result=await page.evaluate(()=>{
    const v=terrainView,r=v.model.radius;
    v.resetCamera();v.focus=[.1,gameGround(v,.1,-.2)/r,-.2];v.distance=.22;v.yaw=.5;v.tilt=.3;
    const c=terrainOrbitCamera(v),w=780,h=1688;
    v.detailPlans=terrainImageryPlans(v.model,v,h);
    const first=walkImageryPlans(v,c,w,h);
    const hit=walkImageryHit(v,c,w/h,0,0).hit;
    function coverage(plans,point) {
      return plans.filter(p=>Math.abs(v.model.cx+point[0]*v.model.half-p.cx)<=p.half &&
        Math.abs(v.model.cy+point[2]*v.model.half-p.cy)<=p.half).at(-1)?.level || 0;
    }
    const old=terrainPerspectiveImageryPlans(v.model,c,h);
    const retained=first.filter(p=>v.detailPlans.includes(p)).length;
    v.detailPlans=first;
    const nudge={...c,eye:c.eye.map((n,i)=>n+(i===0?.000001:0))};
    const near=walkImageryPlans(v,nudge,w,h);
    const ground=gameGround(v,0,0)/r;
    const horizon={...c,eye:[0,ground+.06,0],forward:[0,.15,-Math.sqrt(1-.15**2)],right:[1,0,0],up:[0,Math.sqrt(1-.15**2),.15],focal:1.73};
    const horizonMiss=walkImageryHit(v,horizon,w/h,0,0)===null;
    const lower=walkImageryHit(v,horizon,w/h,0,-.65);
    const grazing=walkImageryPlans(v,horizon,w,h);
    const sky={...horizon,eye:[0,2,0],forward:[0,1,0],up:[0,0,1]};
    return {count:first.length,retained,newLevel:coverage(first,hit),oldLevel:coverage(old,hit),
      steady:near.every((p,i)=>p===first[i]),horizonMiss,lowerLevel:lower&&coverage(grazing,lower.hit),
      sky:walkImageryPlans(v,sky,w,h).length};
  });
  assert.ok(result.count>0 && result.count<=8);
  assert.ok(result.newLevel>result.oldLevel && result.retained>0,JSON.stringify(result));
  assert.ok(result.steady && result.horizonMiss && result.lowerLevel>0,JSON.stringify(result));
  assert.equal(result.sky,0);
  await close(page);
});

test('Walk bounds tile requests through repeated handoffs and horizon look changes while imagery loads',async()=>{
  const page=await pageFor({width:390,height:844},true);
  const held=[];
  await page.route('**/World_Imagery/MapServer/tile/**',route=>{held.push(route);});
  await mapCoordinates(page);
  await page.locator('[data-v="3d"]').click();
  await page.evaluate(()=>{
    const v=terrainView;v.resetCamera();v.zoom(.025);v.orbit(.7,-.42);
  });
  for(let i=0;i<3;i++){
    await page.locator('#map-game').click();
    if(i===1)await page.locator('#game-camera').click();
    const state=await page.evaluate(async()=>{
      const v=terrainView,g=v.game;
      g.tilt=.03;await new Promise(r=>setTimeout(r,290));v.dirty=true;drawTerrainView();
      const plan=v.walkImagery;g.lookBy(0,-1);v.dirty=true;drawTerrainView();
      return {rateLimited:v.walkImagery===plan || v.walkImagery.time-plan.time>=250,active:v.imagery.active,layers:v.detailPlans.length,
        views:v.imagery.views.size,cache:v.imagery.cache.size,finite:v.activeCamera.forward.every(Number.isFinite)};
    });
    assert.ok(state.rateLimited && state.finite && state.active<=6 && state.layers<=8 && state.views<=9 && state.cache<=6,JSON.stringify(state));
    await page.locator('#game-exit').click();
  }
  assert.ok(held.length>0);
  await Promise.all(held.map(route=>route.abort()));
  await close(page);
});

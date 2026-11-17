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
async function pageFor(size = { width: 1440, height: 900 }, mapped = false) {
  const context = await browser.newContext({
    viewport: size,
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
  await page.locator("#terrain-controls>summary").click();
  await page.locator('[data-height="custom"]').click();
  await page.locator("#custom-height").fill("50");
  await page.locator("#custom-height-row button").click();
  await page.waitForFunction(() => window.__lastRequest.eye === 50);
  await page.setViewportSize({ width: 390, height: 844 });
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
  await page.locator('#mp-zoom [data-k="4"]').click();
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

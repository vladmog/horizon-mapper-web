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
    () => S.locationSource === "photo" && HZ.P && !HZ.loading,
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

"use strict";

// Shared by the loaded Settings page and the service worker that installs its shell.
const HORIZON_RELEASE = 63;

if (typeof document !== "undefined") {
  document.getElementById("settings-version").textContent = "Version " + HORIZON_RELEASE;
}

if (typeof window !== "undefined" && "serviceWorker" in navigator) {
  // On a first visit the hero loads before the worker controls the page.
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    const image = document.querySelector(".welcome-landscape img");
    if (image?.currentSrc.endsWith("/welcome-ridgeline-wide.webp"))
      fetch(image.currentSrc).catch(() => {});
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js", { scope: "./", updateViaCache: "none" })
      .catch(error => appDiagnostics.record("service_worker.failed", { message: error.message }, "warn"));
  });
}

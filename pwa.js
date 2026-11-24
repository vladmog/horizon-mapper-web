"use strict";

if ("serviceWorker" in navigator) {
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

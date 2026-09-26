"use strict";

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js", { scope: "./" })
      .catch(error => appDiagnostics.record("service_worker.failed", { message: error.message }, "warn"));
  });
}

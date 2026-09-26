"use strict";
const appDiagnostics = (() => {
  const sessionId = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)), records = [], seen = new Map();
  let context = () => ({});
  function record(event, fields = {}, level = "info") {
    let state = {};
    try { state = context(); } catch {}
    const entry = cleanClientEvent({ ...state, ...fields, event, level, sessionId });
    const key = JSON.stringify(entry), now = Date.now();
    // A render failure can repeat 60 times a second; keep one per 30 seconds.
    if (now - (seen.get(key) || 0) < 30000) return;
    seen.set(key, now);
    if (seen.size > 200) seen.delete(seen.keys().next().value);
    const local = { time: new Date().toISOString(), ...entry };
    records.push(local); if (records.length > 200) records.shift();
  }
  window.addEventListener("error", e => record("uncaught", {
    message: e.message || "Resource failed to load", stack: e.error?.stack,
    source: e.filename || e.target?.src, line: e.lineno, column: e.colno,
  }, "error"), true);
  window.addEventListener("unhandledrejection", e => record("unhandled_rejection", {
    message: e.reason?.message || String(e.reason), stack: e.reason?.stack,
  }, "error"));
  function download() {
    const blob = new Blob([JSON.stringify({ sessionId, events: records }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = "horizon-diagnostics.json"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  record("session_start");
  return { record, download, sessionId, setContext: fn => { context = fn; } };
})();

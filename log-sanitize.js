"use strict";
// Shared by browser export and server ingestion. Never accept arbitrary fields.
function cleanLogText(value, limit = 1500) {
  return String(value ?? "").slice(0, 6000)
    .replace(/https?:\/\/[^\s)]+/g, url => {
      try { const u = new URL(url); return u.origin + (u.pathname.includes("/tile/") ? "/tile/[redacted]" : u.pathname); }
      catch { return "[url]"; }
    })
    .replace(/(?:blob|data):[^\s)]+/g, "[image]")
    .replace(/(?:lat(?:itude)?|lon(?:gitude)?|token|key|password|authorization)\s*[=:]\s*[^\s&,]+/gi, "[redacted]")
    .replace(/-?\d{1,3}\.\d{4,}/g, "[coordinate]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, limit);
}
function cleanClientEvent(input) {
  const out = {
    event: /^[a-z][a-z0-9_.]{0,63}$/.test(input?.event) ? input.event : "client.unknown",
    level: ["info", "warn", "error"].includes(input?.level) ? input.level : "info",
  };
  for (const key of ["message", "stack", "source", "mode", "phase", "code"])
    if (typeof input?.[key] === "string") out[key] = cleanLogText(input[key], key === "stack" ? 2000 : 500);
  for (const key of ["line", "column", "durationMs", "count", "failed", "radius", "fov"])
    if (Number.isFinite(input?.[key])) out[key] = input[key];
  for (const key of ["requestId", "sessionId"])
    if (/^[a-zA-Z0-9-]{1,64}$/.test(input?.[key] || "")) out[key] = input[key];
  return out;
}
if (typeof module !== "undefined") module.exports = { cleanLogText, cleanClientEvent };

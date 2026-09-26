"use strict";

// The original app consumed horizon calculations as server-sent events. This
// small compatible stream keeps that UI contract while running the same work
// in a Web Worker. No app server receives the photo or device coordinates.
class BrowserProfileStream {
  constructor(input) {
    this.listeners = new Map();
    this.closed = false;
    this.onerror = null;
    const url = new URL(input, document.baseURI);
    const number = (name, fallback) => {
      const value = Number(url.searchParams.get(name));
      return Number.isFinite(value) ? value : fallback;
    };
    this.options = {
      lat: number("lat"), lon: number("lon"), radius: number("radius", 50000),
      eye: number("eye", 1.6), rays: number("rays", 1440),
      k: number("k", 0.13), prom: number("prom", 0.15),
      photoAltitude: url.searchParams.has("photoalt") ? number("photoalt") : undefined,
      groundOverride: url.searchParams.has("ground") ? number("ground") : undefined,
    };
    this.worker = new Worker(new URL("./terrain-worker.js", document.baseURI));
    this.worker.onmessage = event => this.handle(event.data);
    this.worker.onerror = event => {
      if (this.closed) return;
      this.emit("failed", { error: event.message || "Terrain worker failed." });
      this.close();
    };
    setTimeout(() => {
      if (this.closed) return;
      this.emit("request", { requestId: crypto.randomUUID?.() || Math.random().toString(36).slice(2) });
      this.worker.postMessage({ type: "compute", options: this.options });
    });
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type, data) {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) || []) listener.call(this, event);
  }

  handle(message) {
    if (this.closed || !message?.type) return;
    if (["progress", "result", "terrain", "failed"].includes(message.type))
      this.emit(message.type, message.data);
    if (message.type === "complete") {
      const callback = this.onerror;
      this.close();
      callback?.call(this, new Event("error"));
    } else if (message.type === "failed") {
      this.close();
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
  }
}

window.EventSource = BrowserProfileStream;

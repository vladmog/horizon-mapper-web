"use strict";
class PhotoViewer {
  constructor(viewport, image, resetButton) {
    this.viewport = viewport; this.image = image; this.button = resetButton;
    this.points = new Map(); this.scale = 1; this.x = 0; this.y = 0;
    this.anchor = null;
    viewport.addEventListener("pointerdown", e => {
      if (!image.naturalWidth || image.hidden || (e.pointerType === "mouse" && e.button !== 0)) return;
      e.preventDefault(); viewport.setPointerCapture(e.pointerId);
      this.points.set(e.pointerId, this.local(e)); this.reanchor();
    });
    viewport.addEventListener("pointermove", e => {
      if (!this.points.has(e.pointerId)) return;
      e.preventDefault(); this.points.set(e.pointerId, this.local(e));
      const p = this.gesture(), a = this.anchor;
      if (!a) return;
      const scale = Math.max(1, Math.min(8, a.scale * p.distance / a.distance));
      this.x = p.x - (a.x - a.tx) * scale / a.scale;
      this.y = p.y - (a.y - a.ty) * scale / a.scale;
      this.scale = scale; this.render();
    });
    const end = e => {
      if (!this.points.delete(e.pointerId)) return;
      if (viewport.hasPointerCapture(e.pointerId)) viewport.releasePointerCapture(e.pointerId);
      this.reanchor();
    };
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) viewport.addEventListener(name, end);
    viewport.addEventListener("wheel", e => {
      if (!e.ctrlKey || !image.naturalWidth) return;
      e.preventDefault();
      const p = this.local(e), scale = Math.max(1, Math.min(8, this.scale * Math.exp(-e.deltaY / 180)));
      this.x = p.x - (p.x - this.x) * scale / this.scale;
      this.y = p.y - (p.y - this.y) * scale / this.scale;
      this.scale = scale; this.render(); this.reanchor();
    }, { passive: false });
    if (resetButton) resetButton.onclick = () => this.reset();
    this.resize = new ResizeObserver(() => { this.render(); this.reanchor(); });
    this.resize.observe(viewport);
    this.render();
  }
  local(e) {
    const r = this.viewport.getBoundingClientRect();
    return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
  }
  gesture() {
    const [a, b] = [...this.points.values()];
    if (!a) return null;
    return b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2,
      distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) } : { ...a, distance: 1 };
  }
  reanchor() {
    const p = this.gesture();
    this.anchor = p ? { ...p, scale: this.scale, tx: this.x, ty: this.y } : null;
  }
  reset() {
    const ids = [...this.points.keys()]; this.points.clear(); this.anchor = null;
    for (const id of ids) if (this.viewport.hasPointerCapture(id)) this.viewport.releasePointerCapture(id);
    this.scale = 1; this.x = this.y = 0; this.render();
  }
  render() {
    const r = this.viewport.getBoundingClientRect(), im = this.image;
    const fit = im.naturalWidth ? Math.min(r.width / im.naturalWidth, r.height / im.naturalHeight) : 0;
    const maxX = Math.max(0, (im.naturalWidth * fit * this.scale - r.width) / 2);
    const maxY = Math.max(0, (im.naturalHeight * fit * this.scale - r.height) / 2);
    this.x = Math.max(-maxX, Math.min(maxX, this.x));
    this.y = Math.max(-maxY, Math.min(maxY, this.y));
    im.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.scale})`;
    if (this.button) this.button.textContent = `Fit photo · ${this.scale.toFixed(1)}×`;
  }
}

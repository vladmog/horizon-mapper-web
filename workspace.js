"use strict";
// Presentation only: geographic state and all map operations stay in the app.
(() => {
  const mobile = matchMedia("(max-width: 900px)");
  const sidebar = $("sidebar");
  let currentPanel = "location",
    returnFocus = null,
    lastStatus = "";
  function focusable() {
    return [
      ...sidebar.querySelectorAll(
        "button:not(:disabled),input:not(:disabled),select:not(:disabled),summary,a[href]",
      ),
    ].filter((el) => el.getClientRects().length && !el.closest("[hidden]"));
  }
  function setOverlay(open) {
    const active = open && mobile.matches;
    document.body.classList.toggle("panel-open", active);
    $("panel-backdrop").hidden = !active;
    $("workspace").inert = active;
    $("app-header").inert = active;
    document.querySelector(".mobile-dock").inert = active;
    if (active) {
      sidebar.setAttribute("role", "dialog");
      sidebar.setAttribute("aria-modal", "true");
    } else {
      sidebar.removeAttribute("role");
      sidebar.removeAttribute("aria-modal");
    }
    for (const b of document.querySelectorAll("[data-mobile-panel]"))
      b.setAttribute(
        "aria-pressed",
        String(b.dataset.mobilePanel === (active ? currentPanel : "explore")),
      );
  }
  function showPanel(name) {
    if (!["location", "project", "settings"].includes(name)) return;
    if (!document.body.classList.contains("panel-open"))
      returnFocus = document.activeElement;
    currentPanel = name;
    for (const el of document.querySelectorAll("[data-tool-panel]"))
      el.hidden = el.dataset.toolPanel !== name;
    for (const b of document.querySelectorAll("[data-panel]")) {
      b.classList.toggle("active", b.dataset.panel === name);
      b.setAttribute("aria-pressed", String(b.dataset.panel === name));
    }
    setOverlay(true);
    if (mobile.matches) {
      sidebar.scrollTop = 0;
      sidebar.querySelector(`[data-panel="${name}"]`).focus();
    }
  }
  function showExplore() {
    const wasOpen = document.body.classList.contains("panel-open");
    setOverlay(false);
    if (wasOpen && returnFocus?.isConnected)
      returnFocus.focus({ preventScroll: true });
    if(S.pos)window.scrollTo({top:0,behavior:'instant'});
    MP.dirty = true;
  }
  for (const b of document.querySelectorAll("[data-panel]"))
    b.addEventListener("click", () => showPanel(b.dataset.panel));
  for (const b of document.querySelectorAll("[data-mobile-panel]"))
    b.addEventListener("click", () =>
      b.dataset.mobilePanel === "explore"
        ? showExplore()
        : showPanel(b.dataset.mobilePanel),
    );
  $("panel-close").onclick = showExplore;
  $("panel-backdrop").onclick = showExplore;
  $("header-location").onclick = () => showPanel("location");
  document.addEventListener("keydown", (event) => {
    if (!mobile.matches || !document.body.classList.contains("panel-open"))
      return;
    if (event.key === "Escape") {
      event.preventDefault();
      showExplore();
    }
    if (event.key === "Tab") {
      const all = focusable(),
        first = all[0],
        last = all.at(-1);
      if (!first) return;
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !sidebar.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !sidebar.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    }
  });
  mobile.addEventListener("change", () => setOverlay(false));
  function updateComparison() {
    const photo=document.body.classList.contains('photo-mode');
    const showPhoto=photo && !document.body.classList.contains('compare-horizon');
    $('comparison-photo').hidden=!photo;
    $('comparison-horizon').hidden=!photo;
    $('comparison-label').hidden=photo;
    $('photo-fit').hidden=!showPhoto;
    for(const [id,active] of [['comparison-photo',showPhoto],['comparison-horizon',!showPhoto]]) {
      $(id).classList.toggle('on',active);$(id).setAttribute('aria-pressed',String(active));
    }
    MP.dirty=true;
  }
  $('comparison-photo').onclick=()=>{document.body.classList.remove('compare-horizon');updateComparison();};
  $('comparison-horizon').onclick=()=>{document.body.classList.add('compare-horizon');updateComparison();};
  $('photo-fit').onclick=()=>photoViewer.reset();
  $('map-fit').onclick=()=>{
    if(mapView==='2d')$('mp-zoom').querySelector('[data-k="0"]').click();
    else $('terrain-reset').click();
  };
  // Keep the selected source visually distinct from the act of opening its form.
  function update() {
    const status = HZ.loading
      ? "Loading terrain…"
      : HZ.err
        ? "Mapping needs attention"
        : HZ.P
          ? "Terrain loaded"
          : S.pos
            ? "Location ready"
            : "No location selected";
    if (status !== lastStatus) {
      $("workspace-state").textContent = status;
      lastStatus = status;
    }
    $("pill-gps").hidden = !S.pos && !S.posErr;
    $("pill-motion").hidden = S.locationSource !== "gps" || !S.pos;
    $("btn-hold").hidden = S.locationSource !== "gps" || !S.pos;
    $("btn-copy").disabled = $("btn-maps").disabled = !S.pos;
    $("readout-title").textContent =
      HZ.selAz == null ? "Center of view" : "Selected point";
    $("project-empty").hidden = !!$("asset-list").children.length;
    for (const [id, source] of [
      ["coordinate-pick", "coordinates"],
      ["photo-pick", "photo"],
      ["use-gps", "gps"],
    ]) {
      const active = !!S.pos && S.locationSource === source;
      $(id).classList.toggle("on", active);
      $(id).setAttribute("aria-pressed", String(active));
    }
    $("card-pos").hidden = !S.pos && !S.posErr;
    $("card-horizon").hidden = !S.pos && !HZ.loading;
    $("gate").classList.toggle("hidden", !!S.pos || HZ.loading);
    document.body.classList.toggle("has-location", !!S.pos);
    // The core controls update their state with .on; mirror it for screen readers.
    for (const b of document.querySelectorAll(".seg button"))
      b.setAttribute("aria-pressed", String(b.classList.contains("on")));
  }
  window.HorizonUI = { showPanel, showExplore, update, updateComparison };
  updateComparison();
  update();
})();

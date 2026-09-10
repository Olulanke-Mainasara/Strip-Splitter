/* Shared UI: DOM helpers, the segmented control, theme, service worker.
   Loaded by both pages. Exposes window.UI; no build step, no modules, so
   the app still runs when opened straight off the filesystem. */
(function (global) {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  /* =========================================================
     Segmented control
     ========================================================= */
  const segs = [];

  function initSeg(seg, onChange) {
    const thumb = $(".seg-thumb", seg);
    const btns = $$("button[data-val]", seg);

    function place(btn, animate) {
      if (!animate) thumb.style.transition = "none";
      const sr = seg.getBoundingClientRect();
      const br = btn.getBoundingClientRect();
      thumb.style.width = br.width + "px";
      thumb.style.height = br.height + "px";
      thumb.style.transform =
        "translate(" + (br.left - sr.left) + "px," + (br.top - sr.top) + "px)";
      if (!animate) {
        void thumb.offsetWidth;
        thumb.style.transition = "";
      }
    }

    function select(val, animate = true, fire = true) {
      const btn = btns.find((b) => b.dataset.val === String(val)) || btns[0];
      btns.forEach((b) =>
        b.setAttribute("aria-checked", b === btn ? "true" : "false"),
      );
      place(btn, animate);
      seg._current = btn;
      if (fire && onChange) onChange(btn.dataset.val);
    }

    btns.forEach((b) => b.addEventListener("click", () => select(b.dataset.val)));

    seg._select = select;
    // A control measured while hidden lands at zero; _sync re-measures it.
    seg._sync = () => seg._current && place(seg._current, false);

    select(
      (btns.find((b) => b.getAttribute("aria-checked") === "true") || btns[0])
        .dataset.val,
      false,
      false,
    );

    segs.push(seg);
    return seg;
  }

  // One listener for every control on the page.
  global.addEventListener("resize", () =>
    segs.forEach((s) => s._sync && s._sync()),
  );

  /* =========================================================
     Theme
     ========================================================= */
  const THEME_KEY = "strip-splitter-theme";
  const THEME_COLOR = { dark: "#0a0a0b", light: "#f1f1ee" };

  function applyTheme(mode) {
    document.documentElement.setAttribute("data-theme", mode);
    const meta = $("#themeColorMeta");
    if (meta) meta.setAttribute("content", THEME_COLOR[mode] || THEME_COLOR.dark);
    try {
      localStorage.setItem(THEME_KEY, mode);
    } catch (e) {}
  }

  function initTheme() {
    const seg = $("#themeSeg");
    if (!seg) return;
    initSeg(seg, applyTheme);
    let saved = null;
    try {
      saved = localStorage.getItem(THEME_KEY);
    } catch (e) {}
    const prefersLight =
      global.matchMedia && global.matchMedia("(prefers-color-scheme: light)").matches;
    seg._select(saved || (prefersLight ? "light" : "dark"), false);
  }

  /* =========================================================
     Service worker
     ========================================================= */
  function registerSW() {
    if (
      "serviceWorker" in navigator &&
      (location.protocol === "https:" || location.hostname === "localhost")
    ) {
      global.addEventListener("load", () =>
        navigator.serviceWorker.register("./sw.js").catch(() => {}),
      );
    }
  }

  initTheme();
  registerSW();

  global.UI = { $, $$, clamp, initSeg };
})(window);

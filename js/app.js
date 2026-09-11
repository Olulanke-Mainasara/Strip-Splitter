/* Spliteet — slice, columns and grid.
   Depends on js/ui.js for DOM helpers and the segmented control. */
(function () {
  "use strict";

  const { $, $$, clamp, initSeg } = UI;

  /* =========================================================
     State
     ========================================================= */
  const state = {
    file: null,
    name: "",
    w: 0,
    h: 0,
    small: null, // downscaled canvas, drives preview + thumbnails
    smallURL: "",
    mode: "slice",
    slice: 3,
    columns: 3,
    gridCols: 3,
    gridRows: 3,
    autoRows: true,
    fitMode: "crop",
    padColor: "#ffffff",
    format: "png",
    tiles: [],
    busy: false,
  };

  const LIMITS = {
    slice: [2, 12],
    columns: [2, 10],
    gridCols: [2, 8],
    gridRows: [1, 80],
  };

  /* =========================================================
     Tile maths
     =========================================================
     One engine. Modes are presets over cols × rows.
     ========================================================= */
  function dims() {
    if (state.mode === "slice")
      return { cols: 1, rows: state.slice, fit: "none" };
    if (state.mode === "columns")
      return { cols: state.columns, rows: 1, fit: "none" };

    const cols = state.gridCols;
    if (state.autoRows) {
      // Rows that make each tile as close to square as the image allows,
      // without discarding a single pixel.
      const cell = state.w / cols;
      const rows = clamp(Math.round(state.h / cell), 1, LIMITS.gridRows[1]);
      return { cols, rows, fit: "none" };
    }
    return { cols, rows: state.gridRows, fit: state.fitMode };
  }

  /* Region of the source actually used. */
  function sourceRect(d) {
    const { w, h } = state;
    if (d.fit !== "crop") return { sx: 0, sy: 0, sw: w, sh: h };
    const target = d.cols / d.rows;
    let sw, sh;
    if (w / h > target) {
      sh = h;
      sw = h * target;
    } else {
      sw = w;
      sh = w / target;
    }
    return { sx: (w - sw) / 2, sy: (h - sh) / 2, sw, sh };
  }

  /* Integer boundaries so tiles tile exactly — no seams, no overlap. */
  function edges(start, size, n) {
    const out = [];
    for (let i = 0; i <= n; i++) out.push(Math.round(start + (size * i) / n));
    return out;
  }

  function computeTiles() {
    if (!state.w) return [];
    const d = dims();
    const src = sourceRect(d);
    const xs = edges(src.sx, src.sw, d.cols);
    const ys = edges(src.sy, src.sh, d.rows);

    // Pad mode squares every tile off against the larger cell edge.
    const pad = d.fit === "pad";
    const side = pad
      ? Math.round(Math.max(src.sw / d.cols, src.sh / d.rows))
      : 0;

    const tiles = [];
    for (let r = 0; r < d.rows; r++) {
      for (let c = 0; c < d.cols; c++) {
        const sx = xs[c];
        const sy = ys[r];
        const sw = xs[c + 1] - sx;
        const sh = ys[r + 1] - sy;
        tiles.push({
          i: tiles.length,
          r,
          c,
          sx,
          sy,
          sw,
          sh,
          outW: pad ? side : sw,
          outH: pad ? side : sh,
          dx: pad ? Math.round((side - sw) / 2) : 0,
          dy: pad ? Math.round((side - sh) / 2) : 0,
          pad,
        });
      }
    }
    tiles.cols = d.cols;
    tiles.rows = d.rows;
    tiles.fit = d.fit;
    tiles.src = src;
    return tiles;
  }

  /* =========================================================
     Loading
     ========================================================= */
  const stage = $("#stage");
  const drop = $("#drop");
  const imgbox = $("#imgbox");
  const preview = $("#preview");
  const guides = $("#guides");
  const cropshade = $("#cropshade");
  const fileInput = $("#fileInput");

  async function decode(file) {
    if (window.createImageBitmap) {
      try {
        return await createImageBitmap(file);
      } catch (e) {
        /* fall through */
      }
    }
    return await new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        res(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        rej(new Error("Could not decode that image."));
      };
      img.src = url;
    });
  }

  async function loadFile(file) {
    if (!file || !file.type.startsWith("image/")) return;

    let src;
    try {
      src = await decode(file);
    } catch (e) {
      setFlag(e.message, true);
      return;
    }

    state.file = file;
    state.name = file.name || "image";
    state.w = src.width;
    state.h = src.height;

    // Downscale once. Everything on screen is drawn from this, so a
    // 74-megapixel screenshot never sits decoded in the DOM.
    const AREA = 2.2e6;
    let k = Math.min(1, Math.sqrt(AREA / (state.w * state.h)));
    k = Math.min(k, 8000 / state.w, 8000 / state.h);
    const sw = Math.max(1, Math.round(state.w * k));
    const sh = Math.max(1, Math.round(state.h * k));

    const c = document.createElement("canvas");
    c.width = sw;
    c.height = sh;
    c.getContext("2d").drawImage(src, 0, 0, sw, sh);
    state.small = c;
    state.smallURL = c.toDataURL("image/jpeg", 0.86);
    if (src.close) src.close();

    preview.src = state.smallURL;
    imgbox.hidden = false;
    drop.hidden = true;
    $("#fileName").textContent = state.name;
    $("#fileDims").textContent = state.w + " × " + state.h;
    $("#fitSeg").hidden = false;
    $("#replaceBtn").hidden = false;
    $("#fitSeg")._sync();

    // A tall image defaults to filling the width; it is unreadable otherwise.
    fitSeg._select(state.h / state.w > 2.2 ? "width" : "contain", false);

    if (state.mode === "grid" && !state.autoRows) syncGridRowsDefault();
    update();
  }

  drop.addEventListener("click", () => fileInput.click());
  drop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });
  $("#replaceBtn").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", (e) => {
    if (e.target.files[0]) loadFile(e.target.files[0]);
    fileInput.value = "";
  });

  // Depth counter: dragging over a child fires dragleave on the parent,
  // which makes a naive toggle flicker.
  let dragDepth = 0;
  function setDrag(on) {
    stage.classList.toggle("drag", on);
    drop.classList.toggle("drag", on);
  }

  stage.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragDepth++;
    setDrag(true);
  });
  stage.addEventListener("dragover", (e) => e.preventDefault());
  stage.addEventListener("dragleave", (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) setDrag(false);
  });
  stage.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    setDrag(false);
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  document.addEventListener("paste", (e) => {
    const f = e.clipboardData && Array.from(e.clipboardData.files)[0];
    if (f) loadFile(f);
  });

  /* =========================================================
     Preview overlay
     ========================================================= */
  function renderGuides(tiles) {
    const total = tiles.cols - 1 + (tiles.rows - 1);
    guides.dataset.dense = total > 24 ? "true" : "false";

    // Reuse nodes so position changes transition instead of snapping.
    const want = [];
    for (let c = 1; c < tiles.cols; c++)
      want.push({ axis: "v", p: (c / tiles.cols) * 100 });
    for (let r = 1; r < tiles.rows; r++)
      want.push({ axis: "h", p: (r / tiles.rows) * 100 });

    while (guides.children.length < want.length)
      guides.appendChild(document.createElement("div"));
    while (guides.children.length > want.length) guides.lastChild.remove();

    Array.from(guides.children).forEach((el, i) => {
      const w = want[i];
      el.className = "guide " + (w.axis === "v" ? "guide-v" : "guide-h");
      el.style.transform =
        w.axis === "v"
          ? "translateX(" + w.p + "%)"
          : "translateY(" + w.p + "%)";
    });

    // Crop shading, in percentages of the rendered image.
    if (tiles.fit === "crop") {
      const s = tiles.src;
      cropshade.hidden = false;
      cropshade.style.left = (s.sx / state.w) * 100 + "%";
      cropshade.style.top = (s.sy / state.h) * 100 + "%";
      cropshade.style.width = (s.sw / state.w) * 100 + "%";
      cropshade.style.height = (s.sh / state.h) * 100 + "%";
    } else {
      cropshade.hidden = true;
    }
  }

  /* =========================================================
     Readout
     ========================================================= */
  function setFlag(text, warn) {
    const el = $("#outFlag");
    el.hidden = !text;
    el.textContent = text || "";
    el.classList.toggle("warn", !!warn);
  }

  function bump(el) {
    el.classList.remove("bump");
    void el.offsetWidth;
    el.classList.add("bump");
  }

  function renderReadout(tiles) {
    const countEl = $("#outCount");
    const specEl = $("#outSpec");

    if (!tiles.length) {
      countEl.textContent = "—";
      specEl.textContent = "Load an image to begin";
      setFlag("");
      return;
    }

    const n = tiles.length;
    const t = tiles[0];
    if (countEl.textContent !== String(n)) bump(countEl);
    countEl.textContent = n;
    specEl.textContent =
      tiles.cols +
      " × " +
      tiles.rows +
      "  ·  " +
      t.outW +
      " × " +
      t.outH +
      " px each";

    // Only ever one flag, most important first.
    if (tiles.fit === "crop") {
      const kept = (tiles.src.sw * tiles.src.sh) / (state.w * state.h);
      const lost = Math.round((1 - kept) * 100);
      setFlag(
        lost > 0
          ? "Cropping to " +
              tiles.cols +
              "×" +
              tiles.rows +
              " discards " +
              lost +
              "% of the image — shaded in the preview."
          : "",
        lost >= 25,
      );
    } else if (tiles.fit === "pad") {
      setFlag(
        "Tiles are padded to squares, so the mosaic will show bands between rows.",
      );
    } else if (n > 60) {
      setFlag(
        n + " pieces is a lot to save — JPEG will be much lighter than PNG.",
      );
    } else if (state.mode === "grid") {
      setFlag(
        "In Photos, pinch until the grid is " +
          tiles.cols +
          " columns wide so the mosaic lines up.",
      );
    } else if (state.mode === "columns") {
      setFlag("Post panel 1 first — carousels read left to right.");
    } else {
      setFlag("Piece 1 is the top of the page.");
    }
  }

  /* =========================================================
     Results
     ========================================================= */
  const tilegrid = $("#tilegrid");

  function thumbCap(n) {
    return n > 40 ? 170 : n > 12 ? 280 : 700;
  }

  let resultsRun = 0;

  function buildTile(t, cap, k, scratch, sctx) {
    const ratio = t.outH / t.outW;
    let tw = cap;
    let th = Math.round(cap * ratio);
    if (th > cap) {
      th = cap;
      tw = Math.round(cap / ratio);
    }
    tw = Math.max(1, tw);
    th = Math.max(1, th);

    scratch.width = tw;
    scratch.height = th;
    sctx.clearRect(0, 0, tw, th);
    if (t.pad && state.padColor !== "transparent") {
      sctx.fillStyle = state.padColor;
      sctx.fillRect(0, 0, tw, th);
    }

    // Clamp into the downscaled canvas — rounding can push the last
    // tile a fraction past its edge.
    const sx = Math.min(t.sx * k, state.small.width - 1);
    const sy = Math.min(t.sy * k, state.small.height - 1);
    const sw = Math.max(1, Math.min(t.sw * k, state.small.width - sx));
    const sh = Math.max(1, Math.min(t.sh * k, state.small.height - sy));
    const s = tw / t.outW;
    sctx.drawImage(
      state.small,
      sx,
      sy,
      sw,
      sh,
      t.dx * s,
      t.dy * s,
      t.sw * s,
      t.sh * s,
    );

    const el = document.createElement("div");
    el.className = "tile";
    el.style.setProperty("--delay", Math.min(t.i * 40, 320) + "ms");

    const img = document.createElement("img");
    img.src = scratch.toDataURL("image/jpeg", 0.82);
    img.alt = "Piece " + (t.i + 1);
    img.style.aspectRatio = t.outW + " / " + t.outH;
    el.appendChild(img);

    const no = document.createElement("span");
    no.className = "tile-no";
    no.textContent = t.i + 1;
    el.appendChild(no);

    const acts = document.createElement("div");
    acts.className = "tile-acts";
    [
      ["Save", () => saveOne(t, "share")],
      ["Download", () => saveOne(t, "download")],
    ].forEach(([label, fn]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.addEventListener("click", fn);
      acts.appendChild(b);
    });
    el.appendChild(acts);
    return el;
  }

  function renderResults(tiles) {
    const run = ++resultsRun;
    tilegrid.innerHTML = "";
    $("#results").hidden = !tiles.length;
    if (!tiles.length) return;

    $("#resultsCount").textContent =
      tiles.length + " · " + tiles.cols + "×" + tiles.rows;

    // Cap the grid so a 3-wide mosaic doesn't stretch to 1100px, and so a
    // 200-tile mosaic still reads as a mosaic.
    const card = tiles.length > 24 ? 132 : 220;
    tilegrid.style.gridTemplateColumns =
      "repeat(" + tiles.cols + ", minmax(0, 1fr))";
    tilegrid.style.maxWidth = tiles.cols * card + "px";
    gapSeg._sync();

    const k = state.small.width / state.w;
    const cap = thumbCap(tiles.length);
    const scratch = document.createElement("canvas");
    const sctx = scratch.getContext("2d");

    // Encoding 200+ thumbnails in one go locks the tab, so go a frame at
    // a time and bail the moment the settings change underneath us.
    const CHUNK = 24;
    let i = 0;
    (function chunk() {
      if (run !== resultsRun) return;
      const frag = document.createDocumentFragment();
      const end = Math.min(i + CHUNK, tiles.length);
      for (; i < end; i++)
        frag.appendChild(buildTile(tiles[i], cap, k, scratch, sctx));
      tilegrid.appendChild(frag);
      if (i < tiles.length) requestAnimationFrame(chunk);
      else scratch.width = scratch.height = 0;
    })();

    const n = tiles.length;
    $("#note").innerHTML =
      state.mode === "grid"
        ? "<strong>Save in order.</strong> Photos fills its grid oldest first, left to right, so piece 1 lands top-left. Set the Photos grid to " +
          tiles.cols +
          " columns and the " +
          n +
          " tiles rebuild the whole page."
        : state.mode === "columns"
          ? "<strong>Post in order.</strong> Panel 1 first, then 2, and so on — a carousel reads left to right, which is what makes the image line back up."
          : "<strong>Top to bottom.</strong> Piece 1 is the top of the page and piece " +
            n +
            " is the bottom.";
  }

  /* =========================================================
     Export
     ========================================================= */
  const zipBtn = $("#zipBtn");
  const saveBtn = $("#saveBtn");
  const seqBtn = $("#seqBtn");
  const progressWrap = $("#progressWrap");
  const progressBar = $("#progressBar");
  const progressText = $("#progressText");

  function ext() {
    return state.format === "jpeg" ? "jpg" : "png";
  }
  function mime() {
    return state.format === "jpeg" ? "image/jpeg" : "image/png";
  }

  function stem() {
    return (state.name.replace(/\.[^.]+$/, "") || "image")
      .replace(/[^a-z0-9-_]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24)
      .toLowerCase();
  }

  function tileName(t, total) {
    const width = String(total).length;
    const n = String(t.i + 1).padStart(width, "0");
    const base = stem();
    if (state.mode === "grid") {
      return (
        base +
        "-" +
        n +
        "-r" +
        String(t.r + 1).padStart(2, "0") +
        "c" +
        String(t.c + 1).padStart(2, "0") +
        "." +
        ext()
      );
    }
    const kind = state.mode === "columns" ? "panel" : "part";
    return base + "-" + kind + "-" + n + "." + ext();
  }

  function drawTile(canvas, src, t) {
    canvas.width = t.outW;
    canvas.height = t.outH;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, t.outW, t.outH);
    // JPEG has no alpha; transparent padding would render black.
    const fill =
      t.pad && state.padColor !== "transparent"
        ? state.padColor
        : state.format === "jpeg"
          ? "#ffffff"
          : null;
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fillRect(0, 0, t.outW, t.outH);
    }
    ctx.drawImage(src, t.sx, t.sy, t.sw, t.sh, t.dx, t.dy, t.sw, t.sh);
  }

  function toBlob(canvas) {
    return new Promise((res) =>
      canvas.toBlob(res, mime(), state.format === "jpeg" ? 0.92 : undefined),
    );
  }

  function setProgress(done, total, verb) {
    progressWrap.hidden = false;
    progressBar.style.width = (done / total) * 100 + "%";
    progressText.textContent = verb + " " + done + " / " + total;
  }

  function setBusy(on) {
    state.busy = on;
    [zipBtn, saveBtn, seqBtn].forEach(
      (b) => (b.disabled = on || !state.tiles.length),
    );
    if (!on) {
      setTimeout(() => {
        progressWrap.hidden = true;
        progressBar.style.width = "0%";
      }, 500);
    }
  }

  /* Full-resolution blobs are only ever made here, on demand. */
  async function renderBlobs(tiles, onProgress) {
    const src = await decode(state.file);
    const canvas = document.createElement("canvas");
    const out = [];
    try {
      for (let i = 0; i < tiles.length; i++) {
        drawTile(canvas, src, tiles[i]);
        out.push(await toBlob(canvas));
        if (onProgress) onProgress(i + 1, tiles.length);
        // Yield so the bar actually paints and the tab stays alive.
        await new Promise((r) => setTimeout(r, 0));
      }
    } finally {
      if (src.close) src.close();
      canvas.width = canvas.height = 0;
    }
    return out;
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }

  async function shareFiles(files) {
    if (navigator.canShare && navigator.share) {
      const data = { files };
      if (navigator.canShare(data)) {
        await navigator.share(data);
        return true;
      }
    }
    return false;
  }

  function flashDone(btn) {
    btn.classList.add("done");
    setTimeout(() => btn.classList.remove("done"), 1600);
  }

  async function saveOne(t, how) {
    if (state.busy) return;
    const src = await decode(state.file);
    const canvas = document.createElement("canvas");
    drawTile(canvas, src, t);
    const blob = await toBlob(canvas);
    if (src.close) src.close();
    const name = tileName(t, state.tiles.length);
    if (how === "share") {
      const file = new File([blob], name, { type: mime() });
      if (await shareFiles([file])) return;
    }
    download(blob, name);
  }

  zipBtn.addEventListener("click", async () => {
    if (!state.tiles.length || state.busy) return;
    setBusy(true);
    try {
      const tiles = state.tiles;
      const blobs = await renderBlobs(tiles, (d, n) =>
        setProgress(d, n, "Encoding"),
      );
      progressText.textContent = "Zipping…";
      const zip = new JSZip();
      blobs.forEach((b, i) => zip.file(tileName(tiles[i], tiles.length), b));
      const out = await zip.generateAsync({ type: "blob" }, (m) => {
        progressBar.style.width = m.percent + "%";
      });
      download(out, stem() + "-" + state.mode + ".zip");
      flashDone(zipBtn);
    } catch (e) {
      setFlag("Export failed: " + e.message, true);
    } finally {
      setBusy(false);
    }
  });

  saveBtn.addEventListener("click", async () => {
    if (!state.tiles.length || state.busy) return;
    setBusy(true);
    try {
      const tiles = state.tiles;
      const blobs = await renderBlobs(tiles, (d, n) =>
        setProgress(d, n, "Encoding"),
      );
      const files = blobs.map(
        (b, i) =>
          new File([b], tileName(tiles[i], tiles.length), { type: mime() }),
      );
      if (await shareFiles(files)) {
        flashDone(saveBtn);
      } else {
        // No share sheet — fall back to a zip rather than N downloads.
        const zip = new JSZip();
        blobs.forEach((b, i) => zip.file(tileName(tiles[i], tiles.length), b));
        download(await zip.generateAsync({ type: "blob" }), stem() + ".zip");
        flashDone(saveBtn);
      }
    } catch (e) {
      if (e.name !== "AbortError") setFlag("Save failed: " + e.message, true);
    } finally {
      setBusy(false);
    }
  });

  seqBtn.addEventListener("click", async () => {
    if (!state.tiles.length || state.busy) return;
    setBusy(true);
    try {
      const tiles = state.tiles;
      const src = await decode(state.file);
      const canvas = document.createElement("canvas");
      for (let i = 0; i < tiles.length; i++) {
        drawTile(canvas, src, tiles[i]);
        const blob = await toBlob(canvas);
        const name = tileName(tiles[i], tiles.length);
        setProgress(i + 1, tiles.length, "Saving");
        const file = new File([blob], name, { type: mime() });
        if (!(await shareFiles([file]))) download(blob, name);
        await new Promise((r) => setTimeout(r, 260));
      }
      if (src.close) src.close();
      canvas.width = canvas.height = 0;
      flashDone(seqBtn);
    } catch (e) {
      if (e.name !== "AbortError") setFlag("Save stopped: " + e.message, true);
    } finally {
      setBusy(false);
    }
  });

  /* =========================================================
     Update cycle
     ========================================================= */
  let rafId = 0;
  let resultsTimer = 0;

  function update() {
    // Guides and the readout are cheap: they track the controls instantly.
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      const tiles = computeTiles();
      state.tiles = tiles;
      if (tiles.length) renderGuides(tiles);
      renderReadout(tiles);
      [zipBtn, saveBtn, seqBtn].forEach(
        (b) => (b.disabled = state.busy || !tiles.length),
      );
      seqBtn.hidden = tiles.length < 2;
    });

    // Thumbnails are not: let a run of stepper taps settle first.
    clearTimeout(resultsTimer);
    resultsTimer = setTimeout(() => renderResults(state.tiles), 150);
  }

  /* =========================================================
     Controls
     ========================================================= */
  const fitSeg = initSeg($("#fitSeg"), (v) =>
    stage.classList.toggle("is-width", v === "width"),
  );
  const gapSeg = initSeg($("#gapSeg"), (v) =>
    tilegrid.style.setProperty("--tile-gap", v + "px"),
  );
  const fitModeSeg = initSeg($("#fitModeSeg"), (v) => {
    state.fitMode = v;
    $("#padRow").hidden = v !== "pad";
    update();
  });

  const modeSeg = initSeg($("#modeSeg"), (v) => {
    state.mode = v;
    $("#panel-slice").hidden = v !== "slice";
    $("#panel-columns").hidden = v !== "columns";
    $("#panel-grid").hidden = v !== "grid";
    if (v === "grid") {
      fitModeSeg._sync();
      if (!state.autoRows) syncGridRowsDefault();
    }
    update();
  });

  /* Chip groups stay in step with their stepper. */
  function initChips(el, key) {
    $$(".chip", el).forEach((chip) =>
      chip.addEventListener("click", () =>
        setVal(key, Number(chip.dataset.val)),
      ),
    );
  }

  function syncChips(el, val) {
    if (!el) return;
    $$(".chip", el).forEach((c) =>
      c.setAttribute(
        "aria-pressed",
        Number(c.dataset.val) === val ? "true" : "false",
      ),
    );
  }

  const CHIPS = {
    slice: $("#sliceChips"),
    columns: $("#colsChips"),
    gridCols: $("#gridColsChips"),
  };

  function setVal(key, val) {
    const [lo, hi] = LIMITS[key];
    const next = clamp(val, lo, hi);
    if (next === state[key]) return;
    state[key] = next;

    const valEl = $("#" + key + "Val");
    valEl.textContent = next;
    bump(valEl);
    syncChips(CHIPS[key], next);

    $$('[data-stepper="' + key + '"] button').forEach((b) => {
      b.disabled = b.dataset.step === "-1" ? next <= lo : next >= hi;
    });

    update();
  }

  Object.keys(CHIPS).forEach((k) => initChips(CHIPS[k], k));

  $$("[data-stepper]").forEach((st) => {
    const key = st.dataset.stepper;
    $$("button", st).forEach((b) =>
      b.addEventListener("click", () =>
        setVal(key, state[key] + Number(b.dataset.step)),
      ),
    );
  });

  /* When the user takes over the rows, start from what auto would have picked. */
  function syncGridRowsDefault() {
    if (!state.w) return;
    const cell = state.w / state.gridCols;
    setVal(
      "gridRows",
      clamp(Math.round(state.h / cell), 1, LIMITS.gridRows[1]),
    );
    $("#gridRowsVal").textContent = state.gridRows;
  }

  $("#autoRows").addEventListener("change", (e) => {
    state.autoRows = e.target.checked;
    $("#manualRows").hidden = state.autoRows;
    if (!state.autoRows) {
      syncGridRowsDefault();
      fitModeSeg._sync();
    }
    update();
  });

  $("#padColor").addEventListener("change", (e) => {
    state.padColor = e.target.value;
    update();
  });

  $("#format").addEventListener("change", (e) => {
    state.format = e.target.value;
  });

  /* =========================================================
     Boot
     ========================================================= */
  tilegrid.style.setProperty("--tile-gap", "4px");

  // Steppers start at their real limits rather than waiting for a click.
  Object.keys(LIMITS).forEach((key) => {
    const [lo, hi] = LIMITS[key];
    $$('[data-stepper="' + key + '"] button').forEach((b) => {
      b.disabled =
        b.dataset.step === "-1" ? state[key] <= lo : state[key] >= hi;
    });
    syncChips(CHIPS[key], state[key]);
  });

  update();
})();

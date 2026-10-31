/* Tools Website — Passport Size Photo Maker
   Works on any page that contains an element with [data-passport-maker].

   Pipeline: upload a photo → crop with a frame locked to the chosen
   passport size (with a face guide) → optionally replace a plain
   background with white / light blue / light grey (edge flood-fill —
   honest, simple, and labelled as such) → encode at the exact pixel
   size under a KB ceiling → optionally lay the finished photo out on
   a print sheet (4×6 inch, 5×7 inch or A4 at 300 DPI) with cut guides.

   Crop math comes from the tested Tool 2 core (window.TWFormResizer in
   assets/form-resizer.js, which must be loaded before this file). The
   encoding here works on the background-processed canvas, so it has its
   own small quality search. All processing happens locally in the
   browser — the file never uploads. No external libraries. */
(function (global) {
  "use strict";

  var SIZES = [
    { id: "35x45",  slug: "35x45mm", label: "35 × 45 mm", w: 413, h: 531, maxKB: 200 },
    { id: "2x2",    slug: "2x2in",   label: "2 × 2 inch", w: 600, h: 600, maxKB: 200 },
    { id: "3x4",    slug: "3x4cm",   label: "3 × 4 cm",   w: 354, h: 472, maxKB: 200 },
    { id: "custom", slug: "custom",  label: "Custom size…" }
  ];
  var BACKGROUNDS = [
    { id: "white",    label: "White",       color: "#ffffff" },
    { id: "blue",     label: "Light blue",  color: "#d6eaf8" },
    { id: "grey",     label: "Light grey",  color: "#ededed" },
    { id: "original", label: "Keep original", color: null }
  ];
  var SHEETS = [
    { id: "4x6", label: "4 × 6 inch", w: 1200, h: 1800 },
    { id: "5x7", label: "5 × 7 inch", w: 1500, h: 2100 },
    { id: "a4",  label: "A4",         w: 2480, h: 3508 }
  ];

  function findById(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  /* ---- Background replacement (pure — unit-testable) -------------
     Samples the background colour from the four corners of the image,
     then flood-fills inward from every border pixel whose colour is
     close to that sample, replacing filled pixels with the target
     colour. A second pass half-blends unfilled pixels that sit next to
     the filled region and are somewhat close to the background, which
     softens the edge. Mutates imgData.data. Returns the number of
     replaced pixels. Tolerance is a max per-channel difference. */
  function floodFillReplace(imgData, width, height, target, tolerance) {
    var data = imgData.data;
    var total = width * height;
    if (!total || !data || data.length < total * 4) return 0;

    function px(i) { var o = i * 4; return [data[o], data[o + 1], data[o + 2]]; }
    function close(c, ref, tol) {
      return Math.abs(c[0] - ref[0]) <= tol &&
             Math.abs(c[1] - ref[1]) <= tol &&
             Math.abs(c[2] - ref[2]) <= tol;
    }
    // Average a small patch around a corner point.
    function patchAvg(cx, cy) {
      var r = 0, g = 0, b = 0, n = 0, R = 4;
      for (var y = Math.max(0, cy - R); y <= Math.min(height - 1, cy + R); y++) {
        for (var x = Math.max(0, cx - R); x <= Math.min(width - 1, cx + R); x++) {
          var c = px(y * width + x); r += c[0]; g += c[1]; b += c[2]; n++;
        }
      }
      return n ? [r / n, g / n, b / n] : [255, 255, 255];
    }
    var corners = [
      patchAvg(0, 0), patchAvg(width - 1, 0),
      patchAvg(0, height - 1), patchAvg(width - 1, height - 1)
    ];
    // The background reference is the majority cluster among the four
    // corners — averaging all four blindly breaks when the subject
    // touches a corner (hair, a shoulder), which would drag the
    // reference colour away from the real background.
    var bestCorner = 0, bestSupport = -1;
    corners.forEach(function (c, ci) {
      var support = 0;
      corners.forEach(function (o) { if (close(c, o, tolerance)) support++; });
      if (support > bestSupport) { bestSupport = support; bestCorner = ci; }
    });
    var bg = [0, 0, 0], bgN = 0;
    corners.forEach(function (c) {
      if (close(c, corners[bestCorner], tolerance)) {
        bg[0] += c[0]; bg[1] += c[1]; bg[2] += c[2]; bgN++;
      }
    });
    if (bgN) { bg[0] /= bgN; bg[1] /= bgN; bg[2] /= bgN; }

    // Region growing, not just a single-colour flood: a pixel joins the
    // background when it is close to the reference colour, OR when it is
    // a small step from an already-accepted neighbour while still within
    // a capped distance of the reference. The step rule walks across
    // gradients and uneven lighting (the common real-world background).
    // It is disabled at high tolerances (> 50): there the tolerance box
    // is already wide, and a step walk could creep from a skin-toned
    // wall into the face itself, whose colour can sit inside the cap.
    var stepTol = tolerance > 50 ? 0 : Math.max(8, Math.round(tolerance * 0.22));
    var capTol = tolerance + 40;
    var filled = new Uint8Array(total);
    var stack = [];
    function accept(i, from) {
      if (filled[i]) return;
      var c = px(i);
      if (close(c, bg, tolerance) ||
          (from && stepTol > 0 && close(c, from, stepTol) && close(c, bg, capTol))) {
        filled[i] = 1;
        stack.push(i);
      }
    }
    function seed(i) { accept(i, null); }
    var x, y, i;
    for (x = 0; x < width; x++) { seed(x); seed((height - 1) * width + x); }
    for (y = 0; y < height; y++) { seed(y * width); seed(y * width + width - 1); }
    while (stack.length) {
      i = stack.pop();
      var from = px(i);
      var ix = i % width, iy = (i / width) | 0;
      if (ix > 0) accept(i - 1, from);
      if (ix < width - 1) accept(i + 1, from);
      if (iy > 0) accept(i - width, from);
      if (iy < height - 1) accept(i + width, from);
    }
    var tr = target[0], tg = target[1], tb = target[2];
    var count = 0, o;
    for (i = 0; i < total; i++) {
      if (filled[i]) {
        o = i * 4;
        data[o] = tr; data[o + 1] = tg; data[o + 2] = tb; data[o + 3] = 255;
        count++;
      }
    }
    if (!count) return 0;
    // Feather pass: unfilled neighbours of the filled region that are
    // still fairly close to the background get a 50% blend to target.
    var wide = tolerance * 2;
    for (i = 0; i < total; i++) {
      if (filled[i]) continue;
      var fx = i % width, fy = (i / width) | 0;
      var touches = (fx > 0 && filled[i - 1]) || (fx < width - 1 && filled[i + 1]) ||
                    (fy > 0 && filled[i - width]) || (fy < height - 1 && filled[i + width]);
      if (!touches) continue;
      var c2 = px(i);
      if (close(c2, bg, wide)) {
        o = i * 4;
        data[o]     = Math.round((c2[0] + tr) / 2);
        data[o + 1] = Math.round((c2[1] + tg) / 2);
        data[o + 2] = Math.round((c2[2] + tb) / 2);
      }
    }
    return count;
  }

  function hexToRgb(hex) {
    var n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  /* ---- Print-sheet layout (pure — unit-testable) ------------------
     How many photos of photoW × photoH fit on a sheetW × sheetH sheet
     with `gap` px between copies, centred as a block. */
  function sheetLayout(sheetW, sheetH, photoW, photoH, gap) {
    var cols = Math.max(0, Math.floor((sheetW + gap) / (photoW + gap)));
    var rows = Math.max(0, Math.floor((sheetH + gap) / (photoH + gap)));
    var usedW = cols * photoW + Math.max(0, cols - 1) * gap;
    var usedH = rows * photoH + Math.max(0, rows - 1) * gap;
    return {
      cols: cols, rows: rows, count: cols * rows,
      offsetX: Math.floor((sheetW - usedW) / 2),
      offsetY: Math.floor((sheetH - usedH) / 2),
      gap: gap
    };
  }

  var PassportCore = {
    SIZES: SIZES, BACKGROUNDS: BACKGROUNDS, SHEETS: SHEETS,
    findById: findById, floodFillReplace: floodFillReplace,
    hexToRgb: hexToRgb, sheetLayout: sheetLayout
  };
  if (typeof module !== "undefined" && module.exports) module.exports = PassportCore;
  if (global) global.TWPassportMaker = PassportCore;

  /* ================================================================
     UI — runs only in a browser page that contains the tool markup,
     and only when the Tool 2 core is available.
     ================================================================ */
  if (typeof document === "undefined" || !document.querySelector) return;
  var Core = global && global.TWFormResizer;
  if (!Core || !Core.largestCenteredCrop) return;
  var container = document.querySelector("[data-passport-maker]");
  if (!container) return;

  function track(action, params) {
    if (typeof window !== "undefined" && typeof window.gtag === "function") {
      try { window.gtag("event", action, params || {}); } catch (e) {}
    }
  }
  function fmtBytes(bytes) { return bytes.toLocaleString("en-US") + " bytes"; }
  function fmtKB(bytes) { return (bytes / 1024).toFixed(1) + " KB"; }
  function fmtSize(bytes) { return fmtKB(bytes) + " (" + fmtBytes(bytes) + ")"; }

  /* ---------- Image loading (same approach as form-resizer.js) ---------- */
  function loadViaImageElement(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { resolve({ source: img, url: url }); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("decode")); };
      img.src = url;
    });
  }
  function loadSource(file) {
    if (typeof window !== "undefined" && typeof window.createImageBitmap === "function") {
      return window.createImageBitmap(file, { imageOrientation: "from-image" })
        .then(function (bmp) { return { source: bmp, url: null }; })
        .catch(function () {
          return window.createImageBitmap(file)
            .then(function (bmp) { return { source: bmp, url: null }; })
            .catch(function () { return loadViaImageElement(file); });
        });
    }
    return loadViaImageElement(file);
  }
  function sourceDims(src) {
    return { w: src.naturalWidth || src.width || 0, h: src.naturalHeight || src.height || 0 };
  }

  /* ---------- Elements ---------- */
  function qs(sel) { return container.querySelector(sel); }
  var dropzone     = qs("[data-dropzone]");
  var fileInput    = qs("[data-file-input]");
  var stage        = qs("[data-stage]");
  var origMeta     = qs("[data-original-meta]");
  var cropStage    = qs("[data-crop-stage]");
  var cropImg      = qs("[data-crop-img]");
  var cropBox      = qs("[data-crop-box]");
  var cropHandle   = qs("[data-crop-handle]");
  var sizeChips    = qs("[data-size-chips]");
  var customWrap   = qs("[data-custom-fields]");
  var inW          = qs("[data-custom-w]");
  var inH          = qs("[data-custom-h]");
  var inMaxKB      = qs("[data-custom-maxkb]");
  var bgChips      = qs("[data-bg-chips]");
  var bgNote       = qs("[data-bg-note]");
  var specText     = qs("[data-size-spec]");
  var autoBtn      = qs("[data-autocrop]");
  var makeBtn      = qs("[data-make-btn]");
  var statusEl     = qs("[data-status]");
  var resultPanel  = qs("[data-result]");
  var resultImg    = qs("[data-result-img]");
  var resultMeta   = qs("[data-result-meta]");
  var statDims     = qs("[data-stat-dims]");
  var statSize     = qs("[data-stat-size]");
  var statBand     = qs("[data-stat-band]");
  var bandStatus   = qs("[data-band-status]");
  var bgResultNote = qs("[data-bg-result-note]");
  var downloadBtn  = qs("[data-download]");
  var sheetChips   = qs("[data-sheet-chips]");
  var sheetInfo    = qs("[data-sheet-info]");
  var sheetBtn     = qs("[data-sheet-download]");
  var printBtn     = qs("[data-sheet-print]");
  var resetBtn     = qs("[data-reset]");

  if (!dropzone || !fileInput || !cropStage || !cropBox || !makeBtn) return;

  var state = {
    file: null, bitmap: null, natW: 0, natH: 0,
    previewURL: null, resultURL: null, sheetURL: null,
    crop: null,
    sizeId: SIZES[0].id,
    bgId: "white",
    sheetId: SHEETS[0].id,
    processedCanvas: null,
    busy: false
  };

  /* ---------- Chips (size / background / sheet) ---------- */
  function buildChips(wrap, list, attr, render) {
    if (!wrap) return;
    list.forEach(function (item) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "chip preset-chip";
      b.setAttribute(attr, item.id);
      if (render) render(b, item); else b.textContent = item.label;
      wrap.appendChild(b);
    });
    wrap.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest("[" + attr + "]") : null;
      if (!btn) return;
      var id = btn.getAttribute(attr);
      if (attr === "data-size-id") selectSize(id);
      else if (attr === "data-bg-id") selectBg(id);
      else if (attr === "data-sheet-id") selectSheet(id);
    });
  }
  function paintChips(wrap, attr, activeId) {
    if (!wrap) return;
    var btns = wrap.querySelectorAll("[" + attr + "]");
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle("is-active", btns[i].getAttribute(attr) === activeId);
    }
  }
  buildChips(sizeChips, SIZES, "data-size-id");
  buildChips(bgChips, BACKGROUNDS, "data-bg-id", function (b, item) {
    if (item.color) {
      var dot = document.createElement("span");
      dot.className = "bg-dot";
      dot.style.background = item.color;
      dot.setAttribute("aria-hidden", "true");
      b.appendChild(dot);
    }
    b.appendChild(document.createTextNode(item.label));
  });
  buildChips(sheetChips, SHEETS, "data-sheet-id");

  [inW, inH, inMaxKB].forEach(function (inp) {
    if (inp) inp.addEventListener("input", function () { paintSpec(); if (state.crop) refitCrop(); });
  });

  function currentSpec() {
    var s = findById(SIZES, state.sizeId);
    if (!s) return null;
    if (s.id !== "custom") return s;
    var w = parseInt(inW && inW.value, 10);
    var h = parseInt(inH && inH.value, 10);
    var maxKB = parseInt(inMaxKB && inMaxKB.value, 10);
    return { id: "custom", slug: "custom", label: "Custom", w: w, h: h, maxKB: maxKB };
  }
  function specValid(spec) {
    return spec && spec.w >= 10 && spec.w <= 8000 && spec.h >= 10 && spec.h <= 8000 &&
           spec.maxKB >= 1 && spec.maxKB <= 10000;
  }
  function sizeName(spec) {
    var s = findById(SIZES, spec.id);
    return s && s.id !== "custom" ? s.label : spec.w + " × " + spec.h + " px";
  }
  function paintSpec() {
    var spec = currentSpec();
    paintChips(sizeChips, "data-size-id", state.sizeId);
    if (customWrap) customWrap.hidden = state.sizeId !== "custom";
    if (specText) {
      specText.textContent = spec && spec.w > 0 && spec.h > 0 && spec.maxKB > 0
        ? "Output: " + spec.w + " × " + spec.h + " px (300 DPI) • max " + spec.maxKB + " KB • JPG"
        : "Enter the width, height and maximum KB you need.";
    }
  }
  function selectSize(id) {
    if (!findById(SIZES, id)) id = SIZES[0].id;
    state.sizeId = id;
    paintSpec();
    if (state.crop) refitCrop();
    track("tool_preset_selected", { tool: "passport_photo_maker", preset: id });
  }
  function selectBg(id) {
    if (!findById(BACKGROUNDS, id)) id = "white";
    state.bgId = id;
    paintChips(bgChips, "data-bg-id", state.bgId);
    if (bgNote) {
      bgNote.hidden = state.bgId === "original";
      if (state.bgId !== "original") {
        bgNote.textContent = "Background replacement works best when the photo's background is plain and evenly lit — it fills in from the edges. A busy background is left as it is where it cannot be separated cleanly.";
      }
    }
    track("tool_option_selected", { tool: "passport_photo_maker", background: id });
  }
  function selectSheet(id) {
    if (!findById(SHEETS, id)) id = SHEETS[0].id;
    state.sheetId = id;
    paintChips(sheetChips, "data-sheet-id", state.sheetId);
    paintSheetInfo();
  }
  function paintSheetInfo() {
    if (!sheetInfo) return;
    var spec = currentSpec();
    var sheet = findById(SHEETS, state.sheetId);
    if (!spec || !specValid(spec) || !sheet || !state.processedCanvas) {
      sheetInfo.textContent = state.processedCanvas
        ? "" : "Your print sheet is prepared after you make the photo.";
      return;
    }
    var lay = sheetLayout(sheet.w, sheet.h, spec.w, spec.h, 30);
    sheetInfo.textContent = lay.count > 0
      ? sheet.label + " sheet at 300 DPI (" + sheet.w + " × " + sheet.h + " px) fits " +
        lay.count + (lay.count === 1 ? " copy" : " copies") + " of " + sizeName(spec) +
        ", with light cut guides. Print at 100% scale — do not use “fit to page”."
      : "This photo size does not fit on a " + sheet.label + " sheet.";
  }

  /* ---------- Crop (aspect locked to the selected size) ---------- */
  function aspect() {
    var spec = currentSpec();
    if (spec && spec.w > 0 && spec.h > 0) return spec.w / spec.h;
    return 413 / 531;
  }
  function refitCrop() {
    if (!state.natW) return;
    var a = aspect();
    var c = state.crop;
    if (!c) { state.crop = Core.largestCenteredCrop(state.natW, state.natH, a); renderCrop(); return; }
    var cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    var w = c.w, h = w / a;
    if (h > state.natH) { h = state.natH; w = h * a; }
    if (w > state.natW) { w = state.natW; h = w / a; }
    state.crop = {
      x: Math.min(Math.max(cx - w / 2, 0), state.natW - w),
      y: Math.min(Math.max(cy - h / 2, 0), state.natH - h),
      w: w, h: h
    };
    renderCrop();
  }
  function autoCenter() {
    if (!state.natW) return;
    state.crop = Core.largestCenteredCrop(state.natW, state.natH, aspect());
    renderCrop();
  }
  function renderCrop() {
    if (!state.crop || !state.natW) return;
    var dispW = cropStage.clientWidth;
    if (!dispW) return;
    var s = dispW / state.natW;
    cropBox.style.left = (state.crop.x * s) + "px";
    cropBox.style.top = (state.crop.y * s) + "px";
    cropBox.style.width = (state.crop.w * s) + "px";
    cropBox.style.height = (state.crop.h * s) + "px";
  }

  var drag = null;
  function onPointerDown(e) {
    if (!state.crop) return;
    var isHandle = e.target === cropHandle || (e.target.closest && e.target.closest("[data-crop-handle]"));
    drag = {
      mode: isHandle ? "resize" : "move",
      startX: e.clientX, startY: e.clientY,
      crop: { x: state.crop.x, y: state.crop.y, w: state.crop.w, h: state.crop.h }
    };
    cropBox.setPointerCapture && cropBox.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function onPointerMove(e) {
    if (!drag || !state.crop) return;
    var dispW = cropStage.clientWidth;
    if (!dispW) return;
    var s = dispW / state.natW;
    var dx = (e.clientX - drag.startX) / s;
    var dy = (e.clientY - drag.startY) / s;
    var a = aspect();
    if (drag.mode === "move") {
      state.crop.x = Math.min(Math.max(drag.crop.x + dx, 0), state.natW - state.crop.w);
      state.crop.y = Math.min(Math.max(drag.crop.y + dy, 0), state.natH - state.crop.h);
    } else {
      var minW = Math.min(40, state.natW);
      var maxW = Math.min(state.natW - drag.crop.x, (state.natH - drag.crop.y) * a);
      var w = Math.min(Math.max(drag.crop.w + dx, minW), Math.max(maxW, minW));
      state.crop.w = w;
      state.crop.h = w / a;
    }
    renderCrop();
  }
  function onPointerUp() { drag = null; }
  cropBox.addEventListener("pointerdown", onPointerDown);
  cropBox.addEventListener("pointermove", onPointerMove);
  cropBox.addEventListener("pointerup", onPointerUp);
  cropBox.addEventListener("pointercancel", onPointerUp);
  window.addEventListener("resize", renderCrop);
  if (autoBtn) autoBtn.addEventListener("click", autoCenter);

  /* ---------- File handling ---------- */
  function setStatus(msg) { if (statusEl) statusEl.textContent = msg || ""; }

  function handleFile(file) {
    if (!file) return;
    if (file.type && file.type.indexOf("image/") !== 0) {
      setStatus("That file is not an image. Please choose a JPG, PNG or WebP photo.");
      return;
    }
    resetResult();
    loadSource(file).then(function (loaded) {
      state.file = file;
      state.bitmap = loaded.source;
      var d = sourceDims(loaded.source);
      state.natW = d.w; state.natH = d.h;
      if (state.previewURL) URL.revokeObjectURL(state.previewURL);
      state.previewURL = loaded.url || URL.createObjectURL(file);
      cropImg.src = state.previewURL;
      if (origMeta) {
        origMeta.textContent = "Original: " + file.name + " — " + fmtSize(file.size) +
          " • " + state.natW + " × " + state.natH + " px. Drag the frame so your head and shoulders sit inside the oval guide.";
      }
      dropzone.hidden = true;
      if (stage) stage.hidden = false;
      state.crop = null;
      autoCenter();
      setTimeout(renderCrop, 30);
      setTimeout(renderCrop, 250);
      setStatus("");
      track("tool_file_selected", { tool: "passport_photo_maker", file_type: file.type || "" });
    }).catch(function () {
      setStatus("Sorry — this image could not be read. Try a JPG or PNG instead.");
    });
  }

  /* ---------- Rendering & encoding ---------- */
  function renderProcessedCanvas(spec) {
    var canvas = document.createElement("canvas");
    canvas.width = spec.w;
    canvas.height = spec.h;
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, spec.w, spec.h);
    ctx.drawImage(state.bitmap, state.crop.x, state.crop.y, state.crop.w, state.crop.h, 0, 0, spec.w, spec.h);
    var replaced = 0;
    var bg = findById(BACKGROUNDS, state.bgId);
    if (bg && bg.color) {
      try {
        var imgData = ctx.getImageData(0, 0, spec.w, spec.h);
        replaced = floodFillReplace(imgData, spec.w, spec.h, hexToRgb(bg.color), 40);
        if (replaced > 0) ctx.putImageData(imgData, 0, 0);
      } catch (e) { replaced = 0; }
    }
    return { canvas: canvas, replaced: replaced };
  }

  function canvasToBlob(canvas, quality) {
    return new Promise(function (resolve, reject) {
      if (canvas.toBlob) {
        canvas.toBlob(function (blob) {
          if (blob) resolve(blob); else reject(new Error("encode-failed"));
        }, "image/jpeg", quality);
      } else {
        try {
          var dataUrl = canvas.toDataURL("image/jpeg", quality);
          var bin = atob(dataUrl.split(",")[1]);
          var arr = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          resolve(new Blob([arr], { type: "image/jpeg" }));
        } catch (err) { reject(err); }
      }
    });
  }

  /* Highest quality whose JPEG fits maxBytes (same search shape as the
     Tool 2 core, but over an already-processed canvas). */
  function encodeCanvasToFit(canvas, maxBytes) {
    var lo = 0.05, hi = 0.92, best = null, smallest = null, step = 0;
    function next() {
      if (step >= 8) {
        if (best) return Promise.resolve({ blob: best, over: false });
        return Promise.resolve({ blob: smallest, over: true });
      }
      step++;
      var q = step === 1 ? 0.92 : (lo + hi) / 2;
      return canvasToBlob(canvas, q).then(function (blob) {
        if (!smallest || blob.size < smallest.size) smallest = blob;
        if (blob.size <= maxBytes) { best = blob; lo = q; } else { hi = q; }
        return next();
      });
    }
    return next();
  }

  function buildSheetBlob(spec) {
    var sheet = findById(SHEETS, state.sheetId);
    if (!sheet || !state.processedCanvas) return Promise.resolve(null);
    var lay = sheetLayout(sheet.w, sheet.h, spec.w, spec.h, 30);
    if (!lay.count) return Promise.resolve(null);
    var canvas = document.createElement("canvas");
    canvas.width = sheet.w;
    canvas.height = sheet.h;
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, sheet.w, sheet.h);
    for (var r = 0; r < lay.rows; r++) {
      for (var c = 0; c < lay.cols; c++) {
        var dx = lay.offsetX + c * (spec.w + lay.gap);
        var dy = lay.offsetY + r * (spec.h + lay.gap);
        ctx.drawImage(state.processedCanvas, dx, dy, spec.w, spec.h);
        ctx.strokeStyle = "#c9ced6";
        ctx.lineWidth = 2;
        ctx.strokeRect(dx + 1, dy + 1, spec.w - 2, spec.h - 2);
      }
    }
    return canvasToBlob(canvas, 0.92).then(function (blob) {
      return { blob: blob, sheet: sheet, layout: lay };
    });
  }

  /* ---------- Make the photo ---------- */
  function runMake() {
    if (state.busy || !state.file || !state.bitmap || !state.crop) return;
    var spec = currentSpec();
    if (!specValid(spec)) {
      setStatus("Please check your custom size: width and height between 10 and 8000 px, and a maximum of at least 1 KB.");
      return;
    }
    state.busy = true;
    makeBtn.disabled = true;
    var label = makeBtn.textContent;
    makeBtn.textContent = "Working…";
    setStatus("Working in your browser — making your " + spec.w + " × " + spec.h + " px photo…");
    resetResult(true);

    var rendered = renderProcessedCanvas(spec);
    state.processedCanvas = rendered.canvas;
    encodeCanvasToFit(rendered.canvas, spec.maxKB * 1024).then(function (res) {
      state.busy = false;
      makeBtn.disabled = false;
      makeBtn.textContent = label;
      showResult(res, spec, rendered.replaced);
      track("tool_resize_success", {
        tool: "passport_photo_maker", preset: spec.id, background: state.bgId,
        output_kb: Math.round(res.blob.size / 1024), bg_replaced: rendered.replaced > 0 ? 1 : 0
      });
    }).catch(function () {
      state.busy = false;
      makeBtn.disabled = false;
      makeBtn.textContent = label;
      setStatus("Something went wrong while preparing your photo. Please try again with a different image.");
    });
  }

  function showResult(res, spec, replaced) {
    if (state.resultURL) URL.revokeObjectURL(state.resultURL);
    state.resultURL = URL.createObjectURL(res.blob);
    if (resultImg) resultImg.src = state.resultURL;
    if (resultMeta) {
      resultMeta.textContent = "Your passport photo — " + fmtSize(res.blob.size) +
        " • " + spec.w + " × " + spec.h + " px";
    }
    if (statDims) statDims.textContent = spec.w + " × " + spec.h + " px (exact)";
    if (statSize) statSize.textContent = fmtSize(res.blob.size);
    if (statBand) statBand.textContent = "max " + spec.maxKB + " KB";
    if (bandStatus) {
      bandStatus.classList.remove("is-ok", "is-warn");
      if (res.over) {
        bandStatus.classList.add("is-warn");
        bandStatus.textContent = "⚠ " + fmtKB(res.blob.size) + " — still above the " + spec.maxKB +
          " KB limit even at the lowest quality. Try a simpler, plainer photo.";
      } else {
        bandStatus.classList.add("is-ok");
        bandStatus.textContent = "✓ " + fmtKB(res.blob.size) + " — under the " + spec.maxKB + " KB limit, at exactly " +
          spec.w + " × " + spec.h + " px.";
      }
    }
    if (bgResultNote) {
      var bg = findById(BACKGROUNDS, state.bgId);
      if (bg && bg.color) {
        bgResultNote.hidden = false;
        bgResultNote.textContent = replaced > 0
          ? "Background set to " + bg.label.toLowerCase() + " — the plain areas around you were replaced; anything the tool could not separate cleanly was left untouched."
          : "No plain background area was detected to replace, so the original background was kept. A photo taken against a plain wall works best.";
      } else {
        bgResultNote.hidden = true;
      }
    }
    if (downloadBtn) {
      downloadBtn.href = state.resultURL;
      downloadBtn.setAttribute("download",
        "passport-photo-" + spec.slug + "-" + spec.w + "x" + spec.h + ".jpg");
    }
    paintSheetInfo();
    if (resultPanel) {
      resultPanel.hidden = false;
      resultPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    setStatus("");
  }

  function resetResult(keepPanel) {
    if (state.resultURL) { URL.revokeObjectURL(state.resultURL); state.resultURL = null; }
    if (state.sheetURL) { URL.revokeObjectURL(state.sheetURL); state.sheetURL = null; }
    state.processedCanvas = null;
    if (!keepPanel && resultPanel) resultPanel.hidden = true;
  }
  function resetAll() {
    resetResult(false);
    state.file = null; state.bitmap = null;
    state.natW = 0; state.natH = 0; state.crop = null;
    if (state.previewURL) { URL.revokeObjectURL(state.previewURL); state.previewURL = null; }
    if (cropImg) cropImg.removeAttribute("src");
    fileInput.value = "";
    if (stage) stage.hidden = true;
    dropzone.hidden = false;
    setStatus("");
    dropzone.focus();
  }

  /* ---------- Print sheet actions ---------- */
  function withSheet(fn) {
    var spec = currentSpec();
    if (!state.processedCanvas || !specValid(spec)) {
      setStatus("Make your passport photo first — the print sheet is built from it.");
      return;
    }
    buildSheetBlob(spec).then(function (res) {
      if (!res) { setStatus("This photo size does not fit on the selected sheet."); return; }
      fn(res, spec);
    }).catch(function () {
      setStatus("The print sheet could not be prepared. Please try again.");
    });
  }
  if (sheetBtn) {
    sheetBtn.addEventListener("click", function () {
      withSheet(function (res, spec) {
        if (state.sheetURL) URL.revokeObjectURL(state.sheetURL);
        state.sheetURL = URL.createObjectURL(res.blob);
        var a = document.createElement("a");
        a.href = state.sheetURL;
        a.setAttribute("download", "passport-print-sheet-" + res.sheet.id + "-" + spec.slug + ".jpg");
        document.body.appendChild(a);
        a.click();
        a.remove();
        track("tool_download", { tool: "passport_photo_maker", kind: "print_sheet", sheet: res.sheet.id, copies: res.layout.count });
      });
    });
  }
  if (printBtn) {
    printBtn.addEventListener("click", function () {
      withSheet(function (res) {
        if (state.sheetURL) URL.revokeObjectURL(state.sheetURL);
        state.sheetURL = URL.createObjectURL(res.blob);
        var win = window.open("", "_blank");
        if (!win) {
          setStatus("Your browser blocked the print window — download the sheet instead and print it at 100% scale.");
          return;
        }
        var inchesW = res.sheet.w / 300, inchesH = res.sheet.h / 300;
        win.document.write(
          "<!DOCTYPE html><html><head><title>Passport photo print sheet</title>" +
          "<style>@page{size:" + inchesW + "in " + inchesH + "in;margin:0}" +
          "body{margin:0}img{display:block;width:" + inchesW + "in;height:" + inchesH + "in}</style></head>" +
          "<body><img src=\"" + state.sheetURL + "\" onload=\"setTimeout(function(){window.print()},150)\"></body></html>"
        );
        win.document.close();
        track("tool_download", { tool: "passport_photo_maker", kind: "print_sheet_print", sheet: res.sheet.id, copies: res.layout.count });
      });
    });
  }

  /* ---------- Wiring ---------- */
  dropzone.addEventListener("click", function () { fileInput.click(); });
  dropzone.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener("change", function () {
    if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0]);
  });
  ["dragenter", "dragover"].forEach(function (evt) {
    dropzone.addEventListener(evt, function (e) {
      e.preventDefault();
      dropzone.classList.add("is-dragover");
    });
  });
  ["dragleave", "drop"].forEach(function (evt) {
    dropzone.addEventListener(evt, function (e) {
      e.preventDefault();
      dropzone.classList.remove("is-dragover");
    });
  });
  dropzone.addEventListener("drop", function (e) {
    var files = e.dataTransfer && e.dataTransfer.files;
    if (files && files[0]) handleFile(files[0]);
  });
  document.addEventListener("paste", function (e) {
    if (!state.file && e.clipboardData && e.clipboardData.files && e.clipboardData.files[0]) {
      handleFile(e.clipboardData.files[0]);
    }
  });
  makeBtn.addEventListener("click", runMake);
  if (downloadBtn) {
    downloadBtn.addEventListener("click", function () {
      track("tool_download", { tool: "passport_photo_maker", kind: "photo" });
    });
  }
  if (resetBtn) resetBtn.addEventListener("click", resetAll);

  /* ---------- Initial state ---------- */
  paintSpec();
  selectBg("white");
  paintChips(sheetChips, "data-sheet-id", state.sheetId);
  paintSheetInfo();
})(typeof window !== "undefined" ? window : null);

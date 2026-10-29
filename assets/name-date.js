/* Tools Website — Add Name & Date on Photo
   Works on any page that contains an element with [data-name-date-tool].

   Several exam authorities (SSC in its notifications; NEET in recent
   bulletins — always check the current one) require the candidate's
   NAME and the DATE the photograph was taken printed on the photo
   itself. This tool crops the photo, prints name + date on a white
   strip at the bottom INSIDE the required total dimensions, and fits
   the file into the required KB band.

   Crop math and JPEG COM padding come from the tested Tool 2 core
   (window.TWFormResizer in assets/form-resizer.js, loaded before this
   file). The encoding works on the composed canvas (photo + printed
   strip), so it has its own small quality search, then reuses the
   core's padding to reach a KB minimum. All processing happens
   locally in the browser — the file never uploads. */
(function (global) {
  "use strict";

  var PRESETS = [
    { id: "ssc",      slug: "ssc",      label: "SSC Photo",   w: 200, h: 230, minKB: 20, maxKB: 50 },
    { id: "neet",     slug: "neet",     label: "NEET Photo",  w: 200, h: 230, minKB: 10, maxKB: 200 },
    { id: "passport", slug: "passport", label: "Passport 35×45mm", w: 413, h: 531, minKB: 0, maxKB: 200 },
    { id: "custom",   slug: "custom",   label: "Custom size…" }
  ];

  function findPreset(id) {
    for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === id) return PRESETS[i];
    return null;
  }

  /* Strip layout (pure — unit-testable). The strip lives inside the
     total height: photo area on top, strip below it. */
  function layout(spec) {
    var stripH = Math.round(spec.h * 0.22);
    var maxStrip = Math.floor(spec.h * 0.35);
    if (stripH < 28) stripH = Math.min(28, maxStrip);
    if (stripH > maxStrip) stripH = maxStrip;
    return {
      stripH: stripH,
      photoH: spec.h - stripH,
      nameFontPx: Math.max(9, Math.round(stripH * 0.34)),
      dateFontPx: Math.max(8, Math.round(stripH * 0.27))
    };
  }

  /* "2026-08-12" (from an <input type="date">) → "12-08-2026".
     Pure — unit-testable. Returns "" for unparseable input. */
  function formatDate(iso) {
    if (!iso || typeof iso !== "string") return "";
    var m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return "";
    return m[3] + "-" + m[2] + "-" + m[1];
  }

  var NDCore = { PRESETS: PRESETS, findPreset: findPreset, layout: layout, formatDate: formatDate };
  if (typeof module !== "undefined" && module.exports) module.exports = NDCore;
  if (global) global.TWNameDate = NDCore;

  /* ================================================================
     UI — runs only in a browser page that contains the tool markup,
     and only when the Tool 2 core is available.
     ================================================================ */
  if (typeof document === "undefined" || !document.querySelector) return;
  var Core = global && global.TWFormResizer;
  if (!Core || !Core.largestCenteredCrop || !Core.padJPEGBytes) return;
  var container = document.querySelector("[data-name-date-tool]");
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
  var dropzone      = qs("[data-dropzone]");
  var fileInput     = qs("[data-file-input]");
  var stage         = qs("[data-stage]");
  var origMeta      = qs("[data-original-meta]");
  var cropStage     = qs("[data-crop-stage]");
  var cropImg       = qs("[data-crop-img]");
  var cropBox       = qs("[data-crop-box]");
  var cropHandle    = qs("[data-crop-handle]");
  var chipsWrap     = qs("[data-preset-chips]");
  var customWrap    = qs("[data-custom-fields]");
  var inW           = qs("[data-custom-w]");
  var inH           = qs("[data-custom-h]");
  var inMaxKB       = qs("[data-custom-maxkb]");
  var inMinKB       = qs("[data-custom-minkb]");
  var specText      = qs("[data-preset-spec]");
  var nameInput     = qs("[data-name-input]");
  var dateInput     = qs("[data-date-input]");
  var stripPreview  = qs("[data-strip-preview]");
  var autoBtn       = qs("[data-autocrop]");
  var makeBtn       = qs("[data-make-btn]");
  var statusEl      = qs("[data-status]");
  var resultPanel   = qs("[data-result]");
  var resultImg     = qs("[data-result-img]");
  var resultMeta    = qs("[data-result-meta]");
  var statDims      = qs("[data-stat-dims]");
  var statSize      = qs("[data-stat-size]");
  var statBand      = qs("[data-stat-band]");
  var bandStatus    = qs("[data-band-status]");
  var padNote       = qs("[data-pad-note]");
  var downloadBtn   = qs("[data-download]");
  var resetBtn      = qs("[data-reset]");

  if (!dropzone || !fileInput || !cropStage || !cropBox || !makeBtn) return;

  var state = {
    file: null, bitmap: null, natW: 0, natH: 0,
    previewURL: null, resultURL: null,
    crop: null,
    presetId: PRESETS[0].id,
    busy: false
  };

  /* ---------- Preset chips ---------- */
  PRESETS.forEach(function (p) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "chip preset-chip";
    b.setAttribute("data-preset-id", p.id);
    b.textContent = p.label;
    chipsWrap.appendChild(b);
  });
  chipsWrap.addEventListener("click", function (e) {
    var btn = e.target.closest ? e.target.closest("[data-preset-id]") : null;
    if (!btn) return;
    selectPreset(btn.getAttribute("data-preset-id"));
  });
  [inW, inH, inMaxKB, inMinKB].forEach(function (inp) {
    if (inp) inp.addEventListener("input", function () { paintSpec(); if (state.crop) refitCrop(); drawStripPreview(); });
  });
  if (nameInput) nameInput.addEventListener("input", drawStripPreview);
  if (dateInput) dateInput.addEventListener("input", drawStripPreview);

  function currentSpec() {
    var p = findPreset(state.presetId);
    if (!p) return null;
    if (p.id !== "custom") return p;
    var w = parseInt(inW && inW.value, 10);
    var h = parseInt(inH && inH.value, 10);
    var maxKB = parseInt(inMaxKB && inMaxKB.value, 10);
    var minKB = parseInt(inMinKB && inMinKB.value, 10);
    if (!(minKB > 0)) minKB = 0;
    return { id: "custom", slug: "custom", label: "Custom", w: w, h: h, minKB: minKB, maxKB: maxKB };
  }
  function specValid(spec) {
    return spec && spec.w >= 40 && spec.w <= 8000 && spec.h >= 60 && spec.h <= 8000 &&
           spec.maxKB >= 1 && spec.maxKB <= 10000 && spec.minKB >= 0 && spec.minKB < spec.maxKB;
  }
  function bandText(spec) {
    if (!spec || !(spec.maxKB > 0)) return "";
    return spec.minKB > 0 ? spec.minKB + "–" + spec.maxKB + " KB" : "max " + spec.maxKB + " KB";
  }
  function paintSpec() {
    var spec = currentSpec();
    var btns = chipsWrap.querySelectorAll("[data-preset-id]");
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle("is-active", btns[i].getAttribute("data-preset-id") === state.presetId);
    }
    if (customWrap) customWrap.hidden = state.presetId !== "custom";
    if (specText) {
      if (spec && spec.w > 0 && spec.h > 0 && spec.maxKB > 0) {
        var lay = layout(spec);
        specText.textContent = "Output: " + spec.w + " × " + spec.h + " px total — photo " +
          spec.w + " × " + lay.photoH + " px + name & date strip " + lay.stripH +
          " px • " + bandText(spec) + " • JPG";
      } else {
        specText.textContent = "Enter the total width, height and KB limits your notification asks for.";
      }
    }
  }
  function selectPreset(id) {
    if (!findPreset(id)) id = PRESETS[0].id;
    state.presetId = id;
    paintSpec();
    if (state.crop) refitCrop();
    drawStripPreview();
    track("tool_preset_selected", { tool: "name_date_on_photo", preset: id });
  }

  /* ---------- Crop (aspect locked to the PHOTO area of the preset) ---------- */
  function aspect() {
    var spec = currentSpec();
    if (spec && spec.w > 0 && spec.h > 0) return spec.w / layout(spec).photoH;
    return 200 / 179;
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

  /* ---------- The printed strip ---------- */
  function candidateName() {
    return (nameInput && nameInput.value ? nameInput.value : "").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
  }
  function printedDate() {
    return formatDate(dateInput && dateInput.value);
  }
  // Shrink the font until the text fits maxW (never below 8px).
  function fitFontPx(ctx, text, weight, basePx, maxW) {
    var px = basePx;
    ctx.font = weight + " " + px + "px Arial, Helvetica, sans-serif";
    while (px > 8 && ctx.measureText(text).width > maxW) {
      px -= 1;
      ctx.font = weight + " " + px + "px Arial, Helvetica, sans-serif";
    }
    return px;
  }
  function drawStrip(ctx, spec, topY) {
    var lay = layout(spec);
    var W = spec.w;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, topY, W, lay.stripH);
    ctx.fillStyle = "#d9dde3";
    ctx.fillRect(0, topY, W, 1);
    ctx.fillStyle = "#111111";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    var name = candidateName();
    var namePx = fitFontPx(ctx, name || "YOUR NAME", "bold", lay.nameFontPx, W * 0.94);
    ctx.font = "bold " + namePx + "px Arial, Helvetica, sans-serif";
    ctx.fillText(name || "YOUR NAME", W / 2, topY + lay.stripH * 0.30);
    var dateTxt = printedDate();
    var datePx = fitFontPx(ctx, dateTxt || "DD-MM-YYYY", "", lay.dateFontPx, W * 0.94);
    ctx.font = datePx + "px Arial, Helvetica, sans-serif";
    ctx.fillText(dateTxt || "DD-MM-YYYY", W / 2, topY + lay.stripH * 0.70);
  }
  function drawStripPreview() {
    if (!stripPreview) return;
    var spec = currentSpec();
    if (!spec || !(spec.w > 0) || !(spec.h > 0)) return;
    var lay = layout(spec);
    var scale = stripPreview.clientWidth ? stripPreview.clientWidth / spec.w : 260 / spec.w;
    stripPreview.width = Math.round(spec.w * scale);
    stripPreview.height = Math.round(lay.stripH * scale);
    var ctx = stripPreview.getContext("2d");
    if (!ctx) return;
    ctx.save();
    ctx.scale(scale, scale);
    // drawStrip works in output pixels with the strip at top 0 here.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, spec.w, lay.stripH);
    ctx.fillStyle = "#111111";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    var name = candidateName();
    var namePx = fitFontPx(ctx, name || "YOUR NAME", "bold", lay.nameFontPx, spec.w * 0.94);
    ctx.font = "bold " + namePx + "px Arial, Helvetica, sans-serif";
    ctx.fillText(name || "YOUR NAME", spec.w / 2, lay.stripH * 0.30);
    var dateTxt = printedDate();
    var datePx = fitFontPx(ctx, dateTxt || "DD-MM-YYYY", "", lay.dateFontPx, spec.w * 0.94);
    ctx.font = datePx + "px Arial, Helvetica, sans-serif";
    ctx.fillText(dateTxt || "DD-MM-YYYY", spec.w / 2, lay.stripH * 0.70);
    ctx.restore();
  }

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
          " • " + state.natW + " × " + state.natH + " px. Frame your face and shoulders — the name & date strip is added below this area.";
      }
      dropzone.hidden = true;
      if (stage) stage.hidden = false;
      state.crop = null;
      autoCenter();
      setTimeout(renderCrop, 30);
      setTimeout(renderCrop, 250);
      setStatus("");
      track("tool_file_selected", { tool: "name_date_on_photo", file_type: file.type || "" });
    }).catch(function () {
      setStatus("Sorry — this image could not be read. Try a JPG or PNG instead.");
    });
  }

  /* ---------- Compose + encode ---------- */
  function composeCanvas(spec) {
    var lay = layout(spec);
    var canvas = document.createElement("canvas");
    canvas.width = spec.w;
    canvas.height = spec.h;
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, spec.w, spec.h);
    ctx.drawImage(state.bitmap, state.crop.x, state.crop.y, state.crop.w, state.crop.h, 0, 0, spec.w, lay.photoH);
    drawStrip(ctx, spec, lay.photoH);
    return canvas;
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
  function blobToBytes(blob) {
    if (blob.arrayBuffer) return blob.arrayBuffer().then(function (b) { return new Uint8Array(b); });
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(new Uint8Array(r.result)); };
      r.onerror = reject;
      r.readAsArrayBuffer(blob);
    });
  }

  function runMake() {
    if (state.busy || !state.file || !state.bitmap || !state.crop) return;
    var spec = currentSpec();
    if (!specValid(spec)) {
      setStatus("Please check your custom size: total width at least 40 px, total height at least 60 px, maximum at least 1 KB, and minimum (if set) below the maximum.");
      return;
    }
    if (!candidateName()) {
      setStatus("Type the candidate's name exactly as it should be printed on the photo.");
      if (nameInput) nameInput.focus();
      return;
    }
    if (!printedDate()) {
      setStatus("Pick the date the photograph was taken — it is printed under the name.");
      if (dateInput) dateInput.focus();
      return;
    }
    state.busy = true;
    makeBtn.disabled = true;
    var label = makeBtn.textContent;
    makeBtn.textContent = "Working…";
    setStatus("Working in your browser — printing the name & date and fitting " + spec.w + " × " + spec.h + " px…");
    resetResult();

    var canvas = composeCanvas(spec);
    encodeCanvasToFit(canvas, spec.maxKB * 1024).then(function (res) {
      var finish = function (blob, padded, over) {
        state.busy = false;
        makeBtn.disabled = false;
        makeBtn.textContent = label;
        showResult({ blob: blob, padded: padded, over: over }, spec);
        track("tool_resize_success", {
          tool: "name_date_on_photo", preset: spec.id,
          output_kb: Math.round(blob.size / 1024), padded: padded ? 1 : 0
        });
      };
      var minBytes = (spec.minKB || 0) * 1024;
      if (!res.over && minBytes > 0 && res.blob.size < minBytes) {
        return blobToBytes(res.blob).then(function (bytes) {
          var padded = Core.padJPEGBytes(bytes, minBytes + 16);
          finish(new Blob([padded], { type: "image/jpeg" }), true, false);
        });
      }
      finish(res.blob, false, res.over);
    }).catch(function () {
      state.busy = false;
      makeBtn.disabled = false;
      makeBtn.textContent = label;
      setStatus("Something went wrong while preparing your photo. Please try again with a different image.");
    });
  }

  function showResult(res, spec) {
    if (state.resultURL) URL.revokeObjectURL(state.resultURL);
    state.resultURL = URL.createObjectURL(res.blob);
    if (resultImg) resultImg.src = state.resultURL;
    if (resultMeta) {
      resultMeta.textContent = "Your photo with name & date — " + fmtSize(res.blob.size) +
        " • " + spec.w + " × " + spec.h + " px";
    }
    if (statDims) statDims.textContent = spec.w + " × " + spec.h + " px (exact, strip included)";
    if (statSize) statSize.textContent = fmtSize(res.blob.size);
    if (statBand) statBand.textContent = bandText(spec);
    if (bandStatus) {
      bandStatus.classList.remove("is-ok", "is-warn");
      if (res.over) {
        bandStatus.classList.add("is-warn");
        bandStatus.textContent = "⚠ " + fmtKB(res.blob.size) + " — still above the " + spec.maxKB +
          " KB limit. Try a plainer photo or a tighter crop and make it again.";
      } else if (spec.minKB > 0) {
        bandStatus.classList.add("is-ok");
        bandStatus.textContent = "✓ Within " + spec.minKB + "–" + spec.maxKB + " KB — " +
          fmtKB(res.blob.size) + " is inside the required band.";
      } else {
        bandStatus.classList.add("is-ok");
        bandStatus.textContent = "✓ " + fmtKB(res.blob.size) + " — under the " + spec.maxKB + " KB limit.";
      }
    }
    if (padNote) {
      padNote.hidden = !res.padded;
      if (res.padded) {
        padNote.textContent = "Note: the finished photo alone was smaller than the " + spec.minKB +
          " KB minimum, so harmless empty padding data was added inside the file to bring it into the band. The picture and the printed strip are unchanged.";
      }
    }
    if (downloadBtn) {
      downloadBtn.href = state.resultURL;
      downloadBtn.setAttribute("download",
        "photo-with-name-date-" + spec.slug + "-" + spec.w + "x" + spec.h + ".jpg");
    }
    if (resultPanel) {
      resultPanel.hidden = false;
      resultPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    setStatus("");
  }

  function resetResult() {
    if (state.resultURL) { URL.revokeObjectURL(state.resultURL); state.resultURL = null; }
    if (resultPanel) resultPanel.hidden = true;
  }
  function resetAll() {
    resetResult();
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
      track("tool_download", { tool: "name_date_on_photo" });
    });
  }
  if (resetBtn) resetBtn.addEventListener("click", resetAll);

  /* ---------- Initial state ---------- */
  // Default the date to today (local), as the requirement is the date
  // the photograph was taken — for most users, today.
  if (dateInput && !dateInput.value) {
    var now = new Date();
    var mm = String(now.getMonth() + 1); if (mm.length < 2) mm = "0" + mm;
    var dd = String(now.getDate()); if (dd.length < 2) dd = "0" + dd;
    dateInput.value = now.getFullYear() + "-" + mm + "-" + dd;
  }
  var pagePreset = container.getAttribute("data-preset");
  selectPreset(pagePreset && findPreset(pagePreset) ? pagePreset : PRESETS[0].id);
  drawStripPreview();
})(typeof window !== "undefined" ? window : null);

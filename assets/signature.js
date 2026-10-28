/* Tools Website — Signature Resizer (standalone, signature-only tool)
   Works on any page that contains an element with [data-signature-resizer].
   The page may preset the tool via data-preset="ssc-signature" (etc.) on
   that container.

   This file deliberately contains NO encoding logic of its own: rendering
   at exact pixels, the JPEG quality binary search and the COM-segment
   padding that reaches a KB minimum all come from the tested Tool 2 core
   (window.TWFormResizer in assets/form-resizer.js, which must be loaded
   before this file). Only the preset list and the single-workspace UI
   live here, because this tool needs max-only presets ("Under 10 KB",
   "Under 50 KB") that the combined Photo & Signature tool does not offer.
   All processing happens locally in the browser — the file never uploads.
   No external libraries. */
(function (global) {
  "use strict";

  var PRESETS = [
    { id: "ssc-signature",  slug: "ssc",        label: "SSC Signature",  w: 140, h: 60, minKB: 10, maxKB: 20 },
    { id: "ibps-signature", slug: "ibps",       label: "IBPS Signature", w: 140, h: 60, minKB: 10, maxKB: 20 },
    { id: "under-10kb",     slug: "under-10kb", label: "Under 10 KB",    w: 140, h: 60, minKB: 0,  maxKB: 10 },
    { id: "under-50kb",     slug: "under-50kb", label: "Under 50 KB",    w: 140, h: 60, minKB: 0,  maxKB: 50 },
    { id: "custom",         slug: "custom",     label: "Custom size…" }
  ];

  function findPreset(id) {
    for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === id) return PRESETS[i];
    return null;
  }

  var SigTool = { PRESETS: PRESETS, findPreset: findPreset };
  if (typeof module !== "undefined" && module.exports) module.exports = SigTool;
  if (global) global.TWSignatureResizer = SigTool;

  /* ================================================================
     UI — runs only in a browser page that contains the tool markup,
     and only when the Tool 2 core is available.
     ================================================================ */
  if (typeof document === "undefined" || !document.querySelector) return;
  var Core = global && global.TWFormResizer;
  if (!Core || !Core.fitToBand || !Core.largestCenteredCrop) return;
  var container = document.querySelector("[data-signature-resizer]");
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
  var dropzone    = qs("[data-dropzone]");
  var fileInput   = qs("[data-file-input]");
  var stage       = qs("[data-stage]");
  var origMeta    = qs("[data-original-meta]");
  var cropStage   = qs("[data-crop-stage]");
  var cropImg     = qs("[data-crop-img]");
  var cropBox     = qs("[data-crop-box]");
  var cropHandle  = qs("[data-crop-handle]");
  var chipsWrap   = qs("[data-preset-chips]");
  var customWrap  = qs("[data-custom-fields]");
  var inW         = qs("[data-custom-w]");
  var inH         = qs("[data-custom-h]");
  var inMaxKB     = qs("[data-custom-maxkb]");
  var inMinKB     = qs("[data-custom-minkb]");
  var specText    = qs("[data-preset-spec]");
  var autoBtn     = qs("[data-autocrop]");
  var makeBtn     = qs("[data-make-btn]");
  var statusEl    = qs("[data-status]");
  var resultPanel = qs("[data-result]");
  var resultImg   = qs("[data-result-img]");
  var resultMeta  = qs("[data-result-meta]");
  var statDims    = qs("[data-stat-dims]");
  var statSize    = qs("[data-stat-size]");
  var statBand    = qs("[data-stat-band]");
  var bandStatus  = qs("[data-band-status]");
  var padNote     = qs("[data-pad-note]");
  var downloadBtn = qs("[data-download]");
  var resetBtn    = qs("[data-reset]");

  if (!dropzone || !fileInput || !cropStage || !cropBox || !makeBtn) return;

  var state = {
    file: null, bitmap: null, natW: 0, natH: 0,
    previewURL: null, resultURL: null,
    crop: null,            // {x,y,w,h} in natural pixels
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
    selectPreset(btn.getAttribute("data-preset-id"), false);
  });
  [inW, inH, inMaxKB, inMinKB].forEach(function (inp) {
    if (inp) inp.addEventListener("input", paintSpec);
  });

  function currentSpec() {
    var p = findPreset(state.presetId);
    if (!p) return null;
    if (p.id !== "custom") return p;
    var w = parseInt(inW && inW.value, 10);
    var h = parseInt(inH && inH.value, 10);
    var maxKB = parseInt(inMaxKB && inMaxKB.value, 10);
    var minKB = parseInt(inMinKB && inMinKB.value, 10);
    if (!(minKB > 0)) minKB = 0;
    return { id: "custom", slug: "custom", label: "Custom",
             w: w, h: h, minKB: minKB, maxKB: maxKB };
  }
  function specValid(spec) {
    return spec && spec.w >= 10 && spec.w <= 8000 && spec.h >= 10 && spec.h <= 8000 &&
           spec.maxKB >= 1 && spec.maxKB <= 10000 && spec.minKB >= 0 && spec.minKB < spec.maxKB;
  }
  function bandText(spec) {
    if (!spec || !(spec.maxKB > 0)) return "";
    return spec.minKB > 0
      ? spec.minKB + "–" + spec.maxKB + " KB"
      : "max " + spec.maxKB + " KB";
  }
  function paintSpec() {
    var spec = currentSpec();
    var btns = chipsWrap.querySelectorAll("[data-preset-id]");
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle("is-active", btns[i].getAttribute("data-preset-id") === state.presetId);
    }
    if (customWrap) customWrap.hidden = state.presetId !== "custom";
    if (specText) {
      specText.textContent = spec && spec.w > 0 && spec.h > 0 && spec.maxKB > 0
        ? "Output: " + spec.w + " × " + spec.h + " px • " + bandText(spec) + " • JPG"
        : "Enter the width, height and maximum KB your form asks for.";
    }
  }
  function selectPreset(id, silent) {
    if (!findPreset(id)) id = PRESETS[0].id;
    state.presetId = id;
    paintSpec();
    if (state.crop) refitCrop();
    if (!silent) track("tool_preset_selected", { tool: "signature_resizer", preset: id });
  }

  /* ---------- Crop (aspect locked to the selected preset) ---------- */
  function aspect() {
    var spec = currentSpec();
    if (spec && spec.w > 0 && spec.h > 0) return spec.w / spec.h;
    return 140 / 60;
  }
  function refitCrop() {
    if (!state.natW) return;
    var a = aspect();
    var c = state.crop;
    if (!c) { state.crop = Core.largestCenteredCrop(state.natW, state.natH, a); renderCrop(); return; }
    // Keep the current centre; resize to the new aspect, clamped inside.
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
    var s = dispW / state.natW; // display px per natural px
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
      dropzone.hidden = false;
      setStatus("That file is not an image. Please choose a JPG, PNG or WebP image of your signature.");
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
          " • " + state.natW + " × " + state.natH + " px. Drag the red frame so it hugs your signature tightly.";
      }
      dropzone.hidden = true;
      if (stage) stage.hidden = false;
      state.crop = null;
      autoCenter();
      // The displayed image size settles a tick later — re-render then.
      setTimeout(renderCrop, 30);
      setTimeout(renderCrop, 250);
      setStatus("");
      track("tool_file_selected", { tool: "signature_resizer", file_type: file.type || "" });
    }).catch(function () {
      setStatus("Sorry — this image could not be read. Try a JPG or PNG instead.");
    });
  }

  /* ---------- Make the output ---------- */
  function runMake() {
    if (state.busy || !state.file || !state.bitmap || !state.crop) return;
    var spec = currentSpec();
    if (!specValid(spec)) {
      setStatus("Please check your custom size: width and height between 10 and 8000 px, maximum at least 1 KB, and minimum (if set) below the maximum.");
      return;
    }
    state.busy = true;
    makeBtn.disabled = true;
    var label = makeBtn.textContent;
    makeBtn.textContent = "Working…";
    setStatus("Working in your browser — rendering exactly " + spec.w + " × " + spec.h + " px…");
    resetResult();

    Core.fitToBand(state.bitmap, state.crop, spec).then(function (res) {
      state.busy = false;
      makeBtn.disabled = false;
      makeBtn.textContent = label;
      showResult(res, spec);
      track("tool_resize_success", {
        tool: "signature_resizer", preset: spec.id,
        output_kb: Math.round(res.blob.size / 1024), padded: res.padded ? 1 : 0
      });
    }).catch(function () {
      state.busy = false;
      makeBtn.disabled = false;
      makeBtn.textContent = label;
      setStatus("Something went wrong while preparing your file. Please try again with a different image.");
    });
  }

  function showResult(res, spec) {
    if (state.resultURL) URL.revokeObjectURL(state.resultURL);
    state.resultURL = URL.createObjectURL(res.blob);
    if (resultImg) resultImg.src = state.resultURL;
    if (resultMeta) {
      resultMeta.textContent = "Your form-ready signature — " + fmtSize(res.blob.size) +
        " • " + spec.w + " × " + spec.h + " px";
    }
    if (statDims) statDims.textContent = spec.w + " × " + spec.h + " px (exact)";
    if (statSize) statSize.textContent = fmtSize(res.blob.size);
    if (statBand) statBand.textContent = bandText(spec);
    if (bandStatus) {
      bandStatus.classList.remove("is-ok", "is-warn");
      if (res.over) {
        bandStatus.classList.add("is-warn");
        bandStatus.textContent = "⚠ " + fmtKB(res.blob.size) + " — still above the " + spec.maxKB +
          " KB limit. Try a tighter crop around the signature and make it again.";
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
        padNote.textContent = "Note: your signature picture alone was smaller than the " + spec.minKB +
          " KB minimum, so harmless empty padding data was added inside the file to bring it into the band. The picture itself is unchanged.";
      }
    }
    if (downloadBtn) {
      downloadBtn.href = state.resultURL;
      downloadBtn.setAttribute("download",
        "signature-" + spec.slug + "-" + spec.w + "x" + spec.h + ".jpg");
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
  // Paste a signature image straight from the clipboard (handy for scans
  // and screenshots) — only before a file is chosen, so it never replaces
  // work in progress. Same pattern as compress.js.
  document.addEventListener("paste", function (e) {
    if (!state.file && e.clipboardData && e.clipboardData.files && e.clipboardData.files[0]) {
      handleFile(e.clipboardData.files[0]);
    }
  });
  makeBtn.addEventListener("click", runMake);
  if (downloadBtn) {
    downloadBtn.addEventListener("click", function () {
      track("tool_download", { tool: "signature_resizer" });
    });
  }
  if (resetBtn) resetBtn.addEventListener("click", resetAll);

  /* ---------- Initial preset (page-level data-preset wins) ---------- */
  var pagePreset = container.getAttribute("data-preset");
  selectPreset(pagePreset && findPreset(pagePreset) ? pagePreset : PRESETS[0].id, true);
})(typeof window !== "undefined" ? window : null);

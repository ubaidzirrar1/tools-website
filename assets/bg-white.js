/* Tools Website — Change Photo Background to White
   Works on any page that contains an element with [data-bg-white-tool].

   Primary engine: an on-device AI person segmenter (Google MediaPipe
   Selfie Segmentation, loaded from a public CDN on first use). The AI
   finds the person in the photo and everything else is replaced with
   white / light blue / light grey, with a softened edge band. The photo
   itself is NEVER uploaded — only the AI model files are downloaded,
   once; all processing happens locally in the browser.

   Fallback: if the AI model cannot be loaded (no connection to the
   CDN, very old browser), the tool falls back to the edge flood-fill
   engine from the Passport Photo Maker (window.TWPassportMaker in
   assets/passport.js) and the result panel says so plainly.

   No crop, no KB band: the photo keeps its own dimensions, with very
   large photos processed at up to 2400 px on the long edge (stated
   openly in the UI). */
(function (global) {
  "use strict";

  var MAX_DIM = 2400;
  var INFER_MAX = 1280; // AI runs at up to this long edge; mask is scaled up for compositing
  var FALLBACK_TOLERANCE = 40;
  var MP_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation";
  var AI_TIMEOUT_MS = 60000;

  function findById(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  // Pure: the size a photo is processed at (unit-testable).
  function processDims(natW, natH, maxDim) {
    var m = Math.max(natW, natH);
    if (!m || m <= maxDim) return { w: natW, h: natH, scaled: false };
    var s = maxDim / m;
    return { w: Math.round(natW * s), h: Math.round(natH * s), scaled: true };
  }

  /* Pure compositing (unit-testable): imgData pixels are blended toward
     `target` [r,g,b] by the person mask in maskData (RGBA; MediaPipe's
     mask carries the person probability in the red channel — bright =
     person). A soft band (mask 0.35–0.65) feathers the edge. Returns
     the number of pixels counted as background (keep < 0.5). */
  function compositeWithMask(imgData, maskData, w, h, target) {
    var d = imgData.data;
    var total = w * h;
    if (!d || d.length < total * 4 || !maskData || maskData.length < total * 4) return 0;
    var bgCount = 0;
    for (var i = 0; i < total; i++) {
      var m = maskData[i * 4] / 255;
      var a; // strength of the ORIGINAL pixel to keep
      if (m <= 0.35) a = 0;
      else if (m >= 0.65) a = 1;
      else a = (m - 0.35) / 0.3;
      if (a < 0.5) bgCount++;
      if (a === 1) continue;
      var o = i * 4, na = 1 - a;
      d[o]     = Math.round(d[o] * a + target[0] * na);
      d[o + 1] = Math.round(d[o + 1] * a + target[1] * na);
      d[o + 2] = Math.round(d[o + 2] * a + target[2] * na);
      d[o + 3] = 255;
    }
    return bgCount;
  }

  var BgCore = { MAX_DIM: MAX_DIM, findById: findById, processDims: processDims, compositeWithMask: compositeWithMask };
  if (typeof module !== "undefined" && module.exports) module.exports = BgCore;
  if (global) global.TWBgWhite = BgCore;

  /* ================================================================
     UI
     ================================================================ */
  if (typeof document === "undefined" || !document.querySelector) return;
  var Engine = global && global.TWPassportMaker;
  if (!Engine || !Engine.floodFillReplace || !Engine.hexToRgb) return;
  var container = document.querySelector("[data-bg-white-tool]");
  if (!container) return;

  var BACKGROUNDS = Engine.BACKGROUNDS.filter(function (b) { return !!b.color; });

  function track(action, params) {
    if (typeof window !== "undefined" && typeof window.gtag === "function") {
      try { window.gtag("event", action, params || {}); } catch (e) {}
    }
  }
  function fmtBytes(bytes) { return bytes.toLocaleString("en-US") + " bytes"; }
  function fmtKB(bytes) { return (bytes / 1024).toFixed(1) + " KB"; }
  function fmtSize(bytes) { return fmtKB(bytes) + " (" + fmtBytes(bytes) + ")"; }

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

  function qs(sel) { return container.querySelector(sel); }
  var dropzone    = qs("[data-dropzone]");
  var fileInput   = qs("[data-file-input]");
  var stage       = qs("[data-stage]");
  var origMeta    = qs("[data-original-meta]");
  var previewImg  = qs("[data-preview-img]");
  var bgChips     = qs("[data-bg-chips]");
  var makeBtn     = qs("[data-make-btn]");
  var statusEl    = qs("[data-status]");
  var resultPanel = qs("[data-result]");
  var resultImg   = qs("[data-result-img]");
  var resultMeta  = qs("[data-result-meta]");
  var statDims    = qs("[data-stat-dims]");
  var statSize    = qs("[data-stat-size]");
  var statBg      = qs("[data-stat-bg]");
  var bandStatus  = qs("[data-band-status]");
  var downloadBtn = qs("[data-download]");
  var resetBtn    = qs("[data-reset]");

  if (!dropzone || !fileInput || !makeBtn) return;

  var state = {
    file: null, bitmap: null, natW: 0, natH: 0,
    previewURL: null, resultURL: null,
    bgId: "white",
    busy: false
  };

  function buildChips(wrap, list, attr, withDots) {
    if (!wrap) return;
    list.forEach(function (item) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "chip preset-chip";
      b.setAttribute(attr, item.id);
      if (withDots && item.color) {
        var dot = document.createElement("span");
        dot.className = "bg-dot";
        dot.style.background = item.color;
        dot.setAttribute("aria-hidden", "true");
        b.appendChild(dot);
      }
      b.appendChild(document.createTextNode(item.label));
      wrap.appendChild(b);
    });
    wrap.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest("[" + attr + "]") : null;
      if (!btn) return;
      var id = btn.getAttribute(attr);
      if (findById(BACKGROUNDS, id)) state.bgId = id;
      paintChips(bgChips, "data-bg-id", state.bgId);
    });
  }
  function paintChips(wrap, attr, activeId) {
    if (!wrap) return;
    var btns = wrap.querySelectorAll("[" + attr + "]");
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle("is-active", btns[i].getAttribute(attr) === activeId);
    }
  }
  buildChips(bgChips, BACKGROUNDS, "data-bg-id", true);
  paintChips(bgChips, "data-bg-id", state.bgId);

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
      if (previewImg) previewImg.src = state.previewURL;
      var pd = processDims(state.natW, state.natH, MAX_DIM);
      if (origMeta) {
        origMeta.textContent = "Original: " + file.name + " — " + fmtSize(file.size) +
          " • " + state.natW + " × " + state.natH + " px." +
          (pd.scaled
            ? " Very large photos are processed at " + pd.w + " × " + pd.h + " px (2400 px long edge) — more than enough for form and ID use."
            : " Your photo keeps its own dimensions.");
      }
      dropzone.hidden = true;
      if (stage) stage.hidden = false;
      setStatus("");
      track("tool_file_selected", { tool: "change_background_to_white", file_type: file.type || "" });
    }).catch(function () {
      setStatus("Sorry — this image could not be read. Try a JPG or PNG instead.");
    });
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

  /* ---------- AI segmenter (lazy, singleton) ---------- */
  var segPromise = null;
  var segInstance = null;
  var segPending = null;
  var aiReady = false;

  function loadSegmenter() {
    if (segPromise) return segPromise;
    segPromise = new Promise(function (resolve, reject) {
      function init() {
        try {
          var ss = new global.SelfieSegmentation({
            locateFile: function (f) { return MP_CDN + "/" + f; }
          });
          ss.setOptions({ modelSelection: 1 });
          ss.onResults(function (results) {
            if (segPending) {
              var p = segPending;
              segPending = null;
              p.resolve(results.segmentationMask);
            }
          });
          segInstance = ss;
          aiReady = true;
          resolve(ss);
        } catch (e) { reject(e); }
      }
      if (global.SelfieSegmentation) { init(); return; }
      var s = document.createElement("script");
      s.src = MP_CDN + "/selfie_segmentation.js";
      s.async = true;
      s.onload = init;
      s.onerror = function () { reject(new Error("ai-load-failed")); };
      document.head.appendChild(s);
    });
    // A failed load may succeed on a later attempt (connection hiccup).
    segPromise.catch(function () { segPromise = null; segInstance = null; });
    return segPromise;
  }

  function segmentMask(sourceCanvas) {
    return loadSegmenter().then(function (ss) {
      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () {
          segPending = null;
          reject(new Error("ai-timeout"));
        }, AI_TIMEOUT_MS);
        segPending = {
          resolve: function (mask) { clearTimeout(timer); resolve(mask); }
        };
        ss.send({ image: sourceCanvas }).catch(function (e) {
          clearTimeout(timer);
          segPending = null;
          reject(e);
        });
      });
    });
  }

  function finishWithCanvas(canvas, pd, bg, bgPx, mode) {
    canvasToBlob(canvas, 0.92).then(function (blob) {
      state.busy = false;
      makeBtn.disabled = false;
      makeBtn.textContent = "Change background";
      showResult(blob, pd, bg, bgPx, mode);
      track("tool_resize_success", {
        tool: "change_background_to_white", background: bg.id, engine: mode,
        output_kb: Math.round(blob.size / 1024),
        replaced_pct: Math.round(100 * bgPx / (pd.w * pd.h))
      });
    }).catch(function () {
      state.busy = false;
      makeBtn.disabled = false;
      makeBtn.textContent = "Change background";
      setStatus("Something went wrong while preparing your photo. Please try again.");
    });
  }

  function runMake() {
    if (state.busy || !state.file || !state.bitmap) return;
    var bg = findById(BACKGROUNDS, state.bgId);
    if (!bg) return;
    state.busy = true;
    makeBtn.disabled = true;
    makeBtn.textContent = "Working…";
    resetResult();

    var pd = processDims(state.natW, state.natH, MAX_DIM);
    var canvas = document.createElement("canvas");
    canvas.width = pd.w;
    canvas.height = pd.h;
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, pd.w, pd.h);
    ctx.drawImage(state.bitmap, 0, 0, pd.w, pd.h);
    var target = Engine.hexToRgb(bg.color);

    // Inference runs on a smaller copy; the returned mask is drawn
    // scaled (and smoothed) to the working size for compositing.
    var idims = processDims(pd.w, pd.h, INFER_MAX);
    var inferCanvas = document.createElement("canvas");
    inferCanvas.width = idims.w;
    inferCanvas.height = idims.h;
    inferCanvas.getContext("2d").drawImage(canvas, 0, 0, idims.w, idims.h);

    setStatus(aiReady
      ? "Working in your browser — the AI is finding you in the photo…"
      : "First use: downloading the AI model (a few MB, once only) — your photo itself never leaves your device…");

    segmentMask(inferCanvas).then(function (mask) {
      var maskCanvas = document.createElement("canvas");
      maskCanvas.width = pd.w;
      maskCanvas.height = pd.h;
      var mctx = maskCanvas.getContext("2d");
      mctx.imageSmoothingEnabled = true;
      mctx.drawImage(mask, 0, 0, pd.w, pd.h);
      var maskData = mctx.getImageData(0, 0, pd.w, pd.h).data;
      var imgData = ctx.getImageData(0, 0, pd.w, pd.h);
      var bgPx = compositeWithMask(imgData, maskData, pd.w, pd.h, target);
      ctx.putImageData(imgData, 0, 0);
      finishWithCanvas(canvas, pd, bg, bgPx, "ai");
    }).catch(function () {
      // Fallback: the original edge flood-fill, labelled as basic.
      try {
        var imgData2 = ctx.getImageData(0, 0, pd.w, pd.h);
        var replaced = Engine.floodFillReplace(imgData2, pd.w, pd.h, target, FALLBACK_TOLERANCE);
        if (replaced > 0) ctx.putImageData(imgData2, 0, 0);
        finishWithCanvas(canvas, pd, bg, replaced, "basic");
      } catch (e) {
        state.busy = false;
        makeBtn.disabled = false;
        makeBtn.textContent = "Change background";
        setStatus("Something went wrong while preparing your photo. Please try again with a different image.");
      }
    });
  }

  function showResult(blob, pd, bg, bgPx, mode) {
    if (state.resultURL) URL.revokeObjectURL(state.resultURL);
    state.resultURL = URL.createObjectURL(blob);
    if (resultImg) resultImg.src = state.resultURL;
    var pctRaw = 100 * bgPx / (pd.w * pd.h);
    var pct = pctRaw < 10 ? pctRaw.toFixed(1) : String(Math.round(pctRaw));
    if (resultMeta) {
      resultMeta.textContent = "Your photo with a " + bg.label.toLowerCase() + " background — " +
        fmtSize(blob.size) + " • " + pd.w + " × " + pd.h + " px";
    }
    if (statDims) statDims.textContent = pd.w + " × " + pd.h + " px";
    if (statSize) statSize.textContent = fmtSize(blob.size);
    if (statBg) statBg.textContent = bg.label;
    if (bandStatus) {
      bandStatus.classList.remove("is-ok", "is-warn");
      if (mode === "ai") {
        if (pctRaw >= 2) {
          bandStatus.classList.add("is-ok");
          bandStatus.textContent = "✓ Background changed — the on-device AI found the person in your photo and replaced about " + pct +
            "% of the picture (the background) with " + bg.label.toLowerCase() +
            ". Your photo was never uploaded: the AI runs entirely in your browser.";
        } else if (bgPx > 0) {
          bandStatus.classList.add("is-ok");
          bandStatus.textContent = "✓ Done — the AI found that almost the whole frame is the person, so there was only a small background area (about " + pct + "%) to replace with " + bg.label.toLowerCase() + ".";
        } else {
          bandStatus.classList.add("is-warn");
          bandStatus.textContent = "⚠ The AI could not separate a background in this photo, so it is unchanged. A clearer, front-facing photo with the person distinct from the background works best.";
        }
      } else {
        if (pctRaw >= 2) {
          bandStatus.classList.add("is-ok");
          bandStatus.textContent = "✓ Background changed — about " + pct + "% of the photo was plain background and is now " + bg.label.toLowerCase() +
            ". Note: the AI model could not be loaded this time (connection?), so the basic method was used — it separates plain, evenly lit backgrounds only.";
        } else if (bgPx > 0) {
          bandStatus.classList.add("is-warn");
          bandStatus.textContent = "⚠ Only about " + pct + "% of this photo counted as plain background, so only that small part changed. The AI model could not be loaded this time (connection?), and the basic method used instead works only on plain, evenly lit backgrounds. Check your connection and try again for the full AI method.";
        } else {
          bandStatus.classList.add("is-warn");
          bandStatus.textContent = "⚠ No plain background area was detected, so your photo is unchanged. The AI model could not be loaded this time (connection?) and the basic fallback found nothing it could safely separate. Check your connection and try again.";
        }
      }
    }
    if (downloadBtn) {
      downloadBtn.href = state.resultURL;
      downloadBtn.setAttribute("download", "photo-" + bg.id + "-background.jpg");
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
    state.natW = 0; state.natH = 0;
    if (state.previewURL) { URL.revokeObjectURL(state.previewURL); state.previewURL = null; }
    if (previewImg) previewImg.removeAttribute("src");
    fileInput.value = "";
    if (stage) stage.hidden = true;
    dropzone.hidden = false;
    setStatus("");
    dropzone.focus();
  }

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
    var files2 = e.dataTransfer && e.dataTransfer.files;
    if (files2 && files2[0]) handleFile(files2[0]);
  });
  document.addEventListener("paste", function (e) {
    if (!state.file && e.clipboardData && e.clipboardData.files && e.clipboardData.files[0]) {
      handleFile(e.clipboardData.files[0]);
    }
  });
  makeBtn.addEventListener("click", runMake);
  if (downloadBtn) {
    downloadBtn.addEventListener("click", function () {
      track("tool_download", { tool: "change_background_to_white" });
    });
  }
  if (resetBtn) resetBtn.addEventListener("click", resetAll);
})(typeof window !== "undefined" ? window : null);

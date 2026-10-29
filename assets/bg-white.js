/* Tools Website — Change Photo Background to White
   Works on any page that contains an element with [data-bg-white-tool].

   Replaces a plain photo background with white (or light blue / light
   grey) using the edge flood-fill engine from the Passport Photo Maker
   (window.TWPassportMaker in assets/passport.js, loaded before this
   file — its UI stays inert on pages without a passport container).
   No crop, no KB band: the photo keeps its own dimensions, with very
   large photos processed at up to 2400 px on the long edge (stated
   openly in the UI). Honest by design: if no plain background area is
   found, the tool says so and returns the photo unchanged rather than
   pretending. All processing happens locally in the browser. */
(function (global) {
  "use strict";

  var MAX_DIM = 2400;
  var STRENGTHS = [
    { id: "gentle",   label: "Gentle",   tolerance: 25 },
    { id: "standard", label: "Standard", tolerance: 40 },
    { id: "strong",   label: "Strong",   tolerance: 65 }
  ];

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

  var BgCore = { STRENGTHS: STRENGTHS, MAX_DIM: MAX_DIM, findById: findById, processDims: processDims };
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
  var strChips    = qs("[data-strength-chips]");
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
    bgId: "white", strengthId: "standard",
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
      if (attr === "data-bg-id") {
        if (findById(BACKGROUNDS, id)) state.bgId = id;
        paintChips(bgChips, "data-bg-id", state.bgId);
      } else {
        if (findById(STRENGTHS, id)) state.strengthId = id;
        paintChips(strChips, "data-strength-id", state.strengthId);
      }
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
  buildChips(strChips, STRENGTHS, "data-strength-id", false);
  paintChips(bgChips, "data-bg-id", state.bgId);
  paintChips(strChips, "data-strength-id", state.strengthId);

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

  function runMake() {
    if (state.busy || !state.file || !state.bitmap) return;
    var bg = findById(BACKGROUNDS, state.bgId);
    var str = findById(STRENGTHS, state.strengthId);
    if (!bg || !str) return;
    state.busy = true;
    makeBtn.disabled = true;
    var label = makeBtn.textContent;
    makeBtn.textContent = "Working…";
    setStatus("Working in your browser — replacing the background…");
    resetResult();

    // Let the status paint before the (synchronous) pixel work starts.
    setTimeout(function () {
      try {
        var pd = processDims(state.natW, state.natH, MAX_DIM);
        var canvas = document.createElement("canvas");
        canvas.width = pd.w;
        canvas.height = pd.h;
        var ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, pd.w, pd.h);
        ctx.drawImage(state.bitmap, 0, 0, pd.w, pd.h);
        var imgData = ctx.getImageData(0, 0, pd.w, pd.h);
        var replaced = Engine.floodFillReplace(imgData, pd.w, pd.h, Engine.hexToRgb(bg.color), str.tolerance);
        if (replaced > 0) ctx.putImageData(imgData, 0, 0);
        canvasToBlob(canvas, 0.92).then(function (blob) {
          state.busy = false;
          makeBtn.disabled = false;
          makeBtn.textContent = label;
          showResult(blob, pd, bg, replaced);
          track("tool_resize_success", {
            tool: "change_background_to_white", background: bg.id, strength: str.id,
            output_kb: Math.round(blob.size / 1024), replaced_pct: Math.round(100 * replaced / (pd.w * pd.h))
          });
        }).catch(function () {
          state.busy = false;
          makeBtn.disabled = false;
          makeBtn.textContent = label;
          setStatus("Something went wrong while preparing your photo. Please try again.");
        });
      } catch (e) {
        state.busy = false;
        makeBtn.disabled = false;
        makeBtn.textContent = label;
        setStatus("Something went wrong while preparing your photo. Please try again with a different image.");
      }
    }, 30);
  }

  function showResult(blob, pd, bg, replaced) {
    if (state.resultURL) URL.revokeObjectURL(state.resultURL);
    state.resultURL = URL.createObjectURL(blob);
    if (resultImg) resultImg.src = state.resultURL;
    var pctRaw = 100 * replaced / (pd.w * pd.h);
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
      if (pctRaw >= 2) {
        bandStatus.classList.add("is-ok");
        bandStatus.textContent = "✓ Background changed — about " + pct + "% of the photo was plain background and is now " +
          bg.label.toLowerCase() + ". Anything the tool could not separate cleanly was left untouched.";
      } else if (replaced > 0) {
        bandStatus.classList.add("is-warn");
        bandStatus.textContent = "⚠ Only about " + pct + "% of this photo counted as plain background, so only that small part changed. " +
          "This tool works best on a photo taken against a plain, evenly lit wall — a busy or mixed background is left untouched on purpose, rather than risk cutting into the subject.";
      } else {
        bandStatus.classList.add("is-warn");
        bandStatus.textContent = "⚠ No plain background area was detected, so your photo is unchanged. This works best on a photo taken against a plain, evenly lit wall — or try the Strong setting.";
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
      track("tool_download", { tool: "change_background_to_white" });
    });
  }
  if (resetBtn) resetBtn.addEventListener("click", resetAll);
})(typeof window !== "undefined" ? window : null);

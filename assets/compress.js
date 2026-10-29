/* Tools Website — Compress Image to KB (shared tool logic)
   Works on any page that contains an element with [data-compress-tool].
   The page presets the default target via data-default-kb on that container.
   All processing happens locally in the browser via Canvas — the selected
   file is never uploaded anywhere. No external libraries. */
(function () {
  "use strict";

  var container = document.querySelector("[data-compress-tool]");
  if (!container) return;

  /* ---------- Elements ---------- */
  function qs(sel) { return container.querySelector(sel); }
  var dropzone    = qs("[data-dropzone]");
  var fileInput   = qs("[data-file-input]");
  var stage       = qs("[data-stage]");
  var previewImg  = qs("[data-preview-img]");
  var origMeta    = qs("[data-original-meta]");
  var targetInput = qs("[data-target-input]");
  var chipsWrap   = qs("[data-preset-chips]");
  var alreadyNote = qs("[data-already-note]");
  var compressBtn = qs("[data-compress-btn]");
  var statusEl    = qs("[data-status]");
  var resultPanel = qs("[data-result]");
  var resultImg   = qs("[data-result-img]");
  var resultMeta  = qs("[data-result-meta]");
  var statOrig    = qs("[data-stat-original]");
  var statComp    = qs("[data-stat-compressed]");
  var statSaved   = qs("[data-stat-saved]");
  var statDims    = qs("[data-stat-dims]");
  var downloadBtn = qs("[data-download]");
  var resetBtn    = qs("[data-reset]");

  if (!dropzone || !fileInput || !compressBtn) return;

  /* ---------- State ---------- */
  var defaultKB = parseInt(container.getAttribute("data-default-kb"), 10);
  if (!(defaultKB > 0)) defaultKB = 50;
  var currentFile = null;     // the File the user picked
  var currentBitmap = null;   // decoded ImageBitmap or HTMLImageElement
  var origW = 0, origH = 0;
  var previewURL = null;      // object URL for the original preview
  var resultURL = null;       // object URL for the download/preview
  var busy = false;

  if (targetInput && !targetInput.value) targetInput.value = defaultKB;

  /* ---------- Helpers ---------- */
  function track(action, params) {
    if (typeof window.gtag === "function") {
      try { window.gtag("event", action, params || {}); } catch (e) {}
    }
  }
  function fmtBytes(bytes) {
    return bytes.toLocaleString("en-US") + " bytes";
  }
  function fmtKB(bytes) {
    return (bytes / 1024).toFixed(1) + " KB";
  }
  function fmtSize(bytes) {
    return fmtKB(bytes) + " (" + fmtBytes(bytes) + ")";
  }
  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg || "";
  }
  function targetKB() {
    var v = parseInt(targetInput ? targetInput.value : defaultKB, 10);
    if (!(v > 0)) return 0;
    if (v < 5) v = 5;
    if (v > 10000) v = 10000;
    return v;
  }
  function baseName(name) {
    var n = (name || "image").replace(/\.[^.]+$/, "");
    n = n.toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "");
    return n || "image";
  }

  /* ---------- Preset chips ---------- */
  function paintChips() {
    if (!chipsWrap) return;
    var v = targetInput ? targetInput.value : "";
    var btns = chipsWrap.querySelectorAll("[data-kb]");
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle("is-active", btns[i].getAttribute("data-kb") === String(v));
    }
  }
  if (chipsWrap) {
    chipsWrap.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest("[data-kb]") : null;
      if (!btn) return;
      if (targetInput) targetInput.value = btn.getAttribute("data-kb");
      paintChips();
      updateAlreadyNote();
    });
  }
  if (targetInput) {
    targetInput.addEventListener("input", function () {
      paintChips();
      updateAlreadyNote();
    });
  }

  /* ---------- Image loading ---------- */
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
    // Prefer createImageBitmap with EXIF orientation applied ("from-image").
    if (typeof window.createImageBitmap === "function") {
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
    var w = src.naturalWidth || src.width || 0;
    var h = src.naturalHeight || src.height || 0;
    return { w: w, h: h };
  }

  /* ---------- Encoding ---------- */
  function encodeJPEG(src, w, h, quality) {
    return new Promise(function (resolve, reject) {
      var canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      var ctx = canvas.getContext("2d");
      if (!ctx) { reject(new Error("no-2d-context")); return; }
      // JPEG has no alpha channel: paint white first so transparent PNG
      // areas become white (what form photos expect) instead of black.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(src, 0, 0, w, h);
      if (canvas.toBlob) {
        canvas.toBlob(function (blob) {
          if (blob) resolve(blob); else reject(new Error("encode-failed"));
        }, "image/jpeg", quality);
      } else if (canvas.toDataURL) {
        // Very old browsers: decode the data URL back into a Blob.
        try {
          var dataUrl = canvas.toDataURL("image/jpeg", quality);
          var bin = atob(dataUrl.split(",")[1]);
          var arr = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          resolve(new Blob([arr], { type: "image/jpeg" }));
        } catch (err) { reject(err); }
      } else {
        reject(new Error("canvas-unsupported"));
      }
    });
  }

  var MIN_QUALITY = 0.05, MAX_QUALITY = 0.92, SEARCH_STEPS = 8;

  // Binary search for the highest quality whose JPEG still fits the target.
  // Resolves { blob, quality } or { blob: null, smallest } if nothing fits.
  function searchQuality(src, w, h, targetBytes) {
    var lo = MIN_QUALITY, hi = MAX_QUALITY, best = null, bestQ = 0, smallest = null;
    var step = 0;
    function next() {
      if (step >= SEARCH_STEPS) {
        return Promise.resolve({ blob: best, quality: bestQ, smallest: smallest });
      }
      step++;
      var q = step === 1 ? MAX_QUALITY : (lo + hi) / 2;
      return encodeJPEG(src, w, h, q).then(function (blob) {
        if (!smallest || blob.size < smallest.size) smallest = blob;
        if (blob.size <= targetBytes) { best = blob; bestQ = q; lo = q; }
        else { hi = q; }
        return next();
      });
    }
    return next();
  }

  // Full algorithm: quality search first; if the image still does not fit,
  // scale the dimensions down by 0.85 and search again (capped iterations).
  function compressToTarget(src, targetBytes, onProgress) {
    var scale = 1;
    var bestOverall = null;
    var attempt = 0;
    // 14 attempts reach scale ~0.12 (e.g. a 4000px photo down to ~480px):
    // very noisy or detailed images need those extra reductions to reach
    // small targets like 20–25 KB. Ordinary photos fit in the first few
    // attempts and never pay for the extra headroom.
    var MAX_ATTEMPTS = 14;
    function tryScale() {
      attempt++;
      var w = Math.max(1, Math.round(origW * scale));
      var h = Math.max(1, Math.round(origH * scale));
      if (onProgress) onProgress(attempt, w, h);
      return searchQuality(src, w, h, targetBytes).then(function (res) {
        if (res.smallest && (!bestOverall || res.smallest.size < bestOverall.blob.size)) {
          bestOverall = { blob: res.smallest, w: w, h: h };
        }
        if (res.blob) {
          return { blob: res.blob, w: w, h: h, quality: res.quality, exact: true };
        }
        // Nothing at this size fit — shrink and retry, unless we hit a floor.
        var nextScale = scale * 0.85;
        var nw = Math.round(origW * nextScale), nh = Math.round(origH * nextScale);
        if (attempt >= MAX_ATTEMPTS || nw < 24 || nh < 24 || nw >= w || nh >= h) {
          return { blob: bestOverall ? bestOverall.blob : res.smallest,
                   w: bestOverall ? bestOverall.w : w,
                   h: bestOverall ? bestOverall.h : h,
                   quality: 0, exact: false };
        }
        scale = nextScale;
        return tryScale();
      });
    }
    return tryScale();
  }

  /* ---------- File selection ---------- */
  function handleFile(file) {
    if (!file) return;
    if (file.type && file.type.indexOf("image/") !== 0) {
      setStatus("That file is not an image. Please choose a JPG, PNG or WebP image.");
      return;
    }
    resetResult();
    setStatus("Loading your image…");
    loadSource(file).then(function (loaded) {
      currentFile = file;
      currentBitmap = loaded.source;
      var d = sourceDims(loaded.source);
      origW = d.w; origH = d.h;
      if (previewURL) URL.revokeObjectURL(previewURL);
      previewURL = loaded.url || URL.createObjectURL(file);
      if (previewImg) previewImg.src = previewURL;
      if (origMeta) {
        origMeta.textContent = "Original: " + file.name + " — " + fmtSize(file.size) +
          " • " + origW + " × " + origH + " px";
      }
      dropzone.hidden = true;
      if (stage) stage.hidden = false;
      setStatus("");
      paintChips();
      updateAlreadyNote();
      track("tool_file_selected", { tool: "compress_image_to_kb", file_type: file.type || "" });
    }).catch(function () {
      setStatus("Sorry — this image could not be read. Try a JPG or PNG photo instead.");
    });
  }

  function updateAlreadyNote() {
    if (!alreadyNote || !currentFile) return;
    var kb = targetKB();
    if (kb > 0 && currentFile.size <= kb * 1024) {
      alreadyNote.hidden = false;
      alreadyNote.innerHTML = "<strong>Good news:</strong> your image is already " +
        fmtKB(currentFile.size) + " — smaller than your " + kb + " KB target. " +
        "You can upload your original file as it is. If the form insists on a JPG, " +
        "compress below and we will hand your original back untouched if re-encoding would make it bigger.";
    } else {
      alreadyNote.hidden = true;
    }
  }

  /* ---------- Compression run ---------- */
  function runCompress() {
    if (busy || !currentFile || !currentBitmap) return;
    var kb = targetKB();
    if (!(kb > 0)) {
      setStatus("Please type a target size in KB, or tap one of the preset sizes.");
      if (targetInput) targetInput.focus();
      return;
    }
    var targetBytes = kb * 1024;
    busy = true;
    compressBtn.disabled = true;
    var originalLabel = compressBtn.textContent;
    compressBtn.textContent = "Compressing…";
    setStatus("Working in your browser — squeezing your image towards " + kb + " KB…");
    resetResult();

    compressToTarget(currentBitmap, targetBytes, function (attempt, w, h) {
      if (attempt > 1) {
        setStatus("Still too big — reducing dimensions to " + w + " × " + h + " and trying again…");
      }
    }).then(function (res) {
      busy = false;
      compressBtn.disabled = false;
      compressBtn.textContent = originalLabel;
      if (!res || !res.blob) {
        setStatus("Compression failed for this image. Try a different photo or a larger target size.");
        return;
      }
      // Graceful case: original already fit the target and re-encoding would
      // not produce anything smaller — offer the untouched original instead.
      if (currentFile.size <= targetBytes && res.blob.size >= currentFile.size) {
        showResult(currentFile, origW, origH, true, res);
        return;
      }
      showResult(res.blob, res.w, res.h, false, res);
      track("tool_compress_success", {
        tool: "compress_image_to_kb",
        target_kb: kb,
        output_kb: Math.round(res.blob.size / 1024)
      });
    }).catch(function () {
      busy = false;
      compressBtn.disabled = false;
      compressBtn.textContent = originalLabel;
      setStatus("Something went wrong while compressing. Please try again with a different image.");
    });
  }

  function showResult(blob, w, h, isOriginal, res) {
    if (resultURL) URL.revokeObjectURL(resultURL);
    resultURL = URL.createObjectURL(blob);
    if (resultImg) resultImg.src = resultURL;
    if (resultMeta) {
      resultMeta.textContent = isOriginal
        ? "Your original file — already under the target, handed back untouched."
        : "Compressed image — " + fmtSize(blob.size) + " • " + w + " × " + h + " px";
    }
    if (statOrig) statOrig.textContent = fmtSize(currentFile.size) + " (" + origW + " × " + origH + " px)";
    if (statComp) statComp.textContent = fmtSize(blob.size) + (isOriginal ? " — original, unchanged" : "");
    if (statSaved) {
      var saved = currentFile.size - blob.size;
      var pct = currentFile.size > 0 ? Math.round((saved / currentFile.size) * 100) : 0;
      statSaved.textContent = saved > 0 ? pct + "% smaller (" + fmtKB(saved) + " saved)" : "Already under the target — nothing needed saving";
    }
    if (statDims) statDims.textContent = origW + " × " + origH + " px → " + w + " × " + h + " px";
    if (downloadBtn) {
      var kb = targetKB();
      downloadBtn.href = resultURL;
      downloadBtn.setAttribute("download",
        isOriginal ? currentFile.name : baseName(currentFile.name) + "-" + kb + "kb.jpg");
    }
    if (resultPanel) {
      resultPanel.hidden = false;
      resultPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    setStatus(res && res.exact === false && !isOriginal
      ? "This image was extremely large, so dimensions were reduced as far as practical. The result is the smallest version we could produce."
      : "");
  }

  function resetResult() {
    if (resultURL) { URL.revokeObjectURL(resultURL); resultURL = null; }
    if (resultPanel) resultPanel.hidden = true;
  }

  function resetAll() {
    resetResult();
    currentFile = null;
    currentBitmap = null;
    origW = 0; origH = 0;
    if (previewURL) { URL.revokeObjectURL(previewURL); previewURL = null; }
    if (previewImg) previewImg.removeAttribute("src");
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
  // Paste an image straight from the clipboard ( handy for screenshots/signatures ).
  document.addEventListener("paste", function (e) {
    if (!currentFile && e.clipboardData && e.clipboardData.files && e.clipboardData.files[0]) {
      handleFile(e.clipboardData.files[0]);
    }
  });
  compressBtn.addEventListener("click", runCompress);
  if (downloadBtn) {
    downloadBtn.addEventListener("click", function () {
      track("tool_download", { tool: "compress_image_to_kb" });
    });
  }
  if (resetBtn) resetBtn.addEventListener("click", resetAll);

  paintChips();
})();

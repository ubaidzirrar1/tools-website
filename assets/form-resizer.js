/* Tools Website — Photo & Signature Resizer for Online Forms (shared logic)
   Works on any page that contains an element with [data-form-resizer].
   The page may preset the tool via data-preset="ssc-photo" (etc.) on that
   container. Two modes (Photo / Signature), each with its own upload and
   crop. The cropped region is rendered at EXACTLY the preset pixel size and
   JPEG-encoded to fit the preset KB band; if a minimum KB applies and the
   picture alone is smaller, harmless JPEG comment (COM) padding is added so
   the file lands inside the band without changing the image.
   All processing happens locally in the browser — the file never uploads.
   No external libraries. */
(function (global) {
  "use strict";

  /* ================================================================
     Core — presets, crop math, encoding, band fitting, JPEG padding.
     Exposed as window.TWFormResizer (and module.exports under Node so
     the exact shipped logic can be tested headlessly).
     ================================================================ */

  var PRESETS = {
    photo: [
      { id: "ssc-photo",  slug: "ssc",      label: "SSC Photo",        w: 200, h: 230, minKB: 20, maxKB: 50 },
      { id: "ibps-photo", slug: "ibps",     label: "IBPS Photo",       w: 200, h: 230, minKB: 20, maxKB: 50 },
      { id: "fpsc-photo", slug: "fpsc",     label: "FPSC Photo",       w: 200, h: 230, minKB: 0,  maxKB: 30 },
      { id: "ppsc-photo", slug: "ppsc",     label: "PPSC Photo",       w: 200, h: 230, minKB: 0,  maxKB: 30 },
      { id: "passport",   slug: "passport", label: "Passport Photo 35×45mm (300 DPI)", w: 413, h: 531, minKB: 0, maxKB: 200 },
      { id: "dv-lottery", slug: "dv",       label: "DV Lottery Photo (US Green Card)", w: 600, h: 600, minKB: 0, maxKB: 240 },
      { id: "custom",     slug: "custom",   label: "Custom size…" }
    ],
    signature: [
      { id: "ssc-signature",  slug: "ssc",  label: "SSC Signature",  w: 140, h: 60, minKB: 10, maxKB: 20 },
      { id: "ibps-signature", slug: "ibps", label: "IBPS Signature", w: 140, h: 60, minKB: 10, maxKB: 20 },
      { id: "custom",         slug: "custom", label: "Custom size…" }
    ],
    thumb: [
      { id: "ibps-thumb", slug: "ibps", label: "IBPS / SBI Thumb Impression", w: 240, h: 240, minKB: 20, maxKB: 50 },
      { id: "custom",     slug: "custom", label: "Custom size…" }
    ],
    declaration: [
      { id: "ibps-declaration", slug: "ibps", label: "IBPS / SBI Handwritten Declaration", w: 800, h: 400, minKB: 50, maxKB: 100 },
      { id: "custom",           slug: "custom", label: "Custom size…" }
    ]
  };

  /* Nouns for result and status text per mode. */
  var MODE_NOUNS = { photo: "photo", signature: "signature", thumb: "thumb impression", declaration: "declaration" };
  var MODE_SUBJECTS = { photo: "face", signature: "signature", thumb: "thumb", declaration: "declaration" };

  function findPreset(mode, id) {
    var list = PRESETS[mode] || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  /* Largest crop of the given aspect ratio (w/h) that fits the image,
     centred. Coordinates are in natural image pixels. */
  function largestCenteredCrop(natW, natH, aspect) {
    var w, h;
    if (natW / natH > aspect) { h = natH; w = h * aspect; }
    else { w = natW; h = w / aspect; }
    return { x: (natW - w) / 2, y: (natH - h) / 2, w: w, h: h };
  }

  /* Insert JPEG COM segments (FF FE) immediately after the SOI marker so
     the file grows to (at least) targetTotal bytes. COM segments are legal
     anywhere after SOI and are skipped by decoders, so the picture and its
     dimensions are unchanged. Returns a new Uint8Array. */
  function padJPEGBytes(u8, targetTotal) {
    if (!u8 || u8.length >= targetTotal) return u8;
    if (u8.length < 2 || u8[0] !== 0xFF || u8[1] !== 0xD8) return u8; // not a JPEG
    var need = targetTotal - u8.length;
    if (need < 4) need = 4; // smallest legal COM segment is 4 bytes
    var segs = [];
    var remaining = need;
    while (remaining > 0) {
      var segTotal = remaining <= 65537 ? remaining : 65537;
      var rest = remaining - segTotal;
      if (rest > 0 && rest < 4) segTotal -= (4 - rest); // keep last chunk legal (>= 4)
      var lenField = segTotal - 2; // length field counts its own 2 bytes
      var seg = new Uint8Array(segTotal); // payload stays zero-filled
      seg[0] = 0xFF; seg[1] = 0xFE;
      seg[2] = (lenField >> 8) & 0xFF; seg[3] = lenField & 0xFF;
      segs.push(seg);
      remaining -= segTotal;
    }
    var inserted = 0;
    for (var i = 0; i < segs.length; i++) inserted += segs[i].length;
    var out = new Uint8Array(u8.length + inserted);
    out.set(u8.subarray(0, 2), 0);
    var off = 2;
    for (var j = 0; j < segs.length; j++) { out.set(segs[j], off); off += segs[j].length; }
    out.set(u8.subarray(2), off);
    return out;
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

  /* Draw the crop region onto a canvas at exactly outW × outH (white fill
     first — JPEG has no alpha, and forms expect white backgrounds) and
     encode as JPEG at the given quality. Resolves a Blob. */
  function encodeCropAtQuality(source, crop, outW, outH, quality) {
    return new Promise(function (resolve, reject) {
      var canvas = document.createElement("canvas");
      canvas.width = outW;
      canvas.height = outH;
      var ctx = canvas.getContext("2d");
      if (!ctx) { reject(new Error("no-2d-context")); return; }
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, outW, outH);
      ctx.drawImage(source, crop.x, crop.y, crop.w, crop.h, 0, 0, outW, outH);
      if (canvas.toBlob) {
        canvas.toBlob(function (blob) {
          if (blob) resolve(blob); else reject(new Error("encode-failed"));
        }, "image/jpeg", quality);
      } else if (canvas.toDataURL) {
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

  /* Binary search for the highest quality whose JPEG fits maxBytes.
     Resolves { blob, quality, over } — over=true when even the lowest
     quality could not fit (blob is then the smallest attempt). */
  function searchQualityCrop(source, crop, outW, outH, maxBytes) {
    var lo = MIN_QUALITY, hi = MAX_QUALITY, best = null, bestQ = 0, smallest = null;
    var step = 0;
    function next() {
      if (step >= SEARCH_STEPS) {
        if (best) return Promise.resolve({ blob: best, quality: bestQ, over: false });
        return Promise.resolve({ blob: smallest, quality: 0, over: true });
      }
      step++;
      var q = step === 1 ? MAX_QUALITY : (lo + hi) / 2;
      return encodeCropAtQuality(source, crop, outW, outH, q).then(function (blob) {
        if (!smallest || blob.size < smallest.size) smallest = blob;
        if (blob.size <= maxBytes) { best = blob; bestQ = q; lo = q; }
        else { hi = q; }
        return next();
      });
    }
    return next();
  }

  /* Full band fit: encode at exact dimensions to fit <= maxKB; if a minimum
     applies and the encoded picture is below it, pad with COM segments to
     just above the minimum (image bytes untouched). spec = {w,h,minKB,maxKB}.
     Resolves { blob, quality, padded, over }. */
  function fitToBand(source, crop, spec) {
    var maxBytes = spec.maxKB * 1024;
    var minBytes = (spec.minKB || 0) * 1024;
    return searchQualityCrop(source, crop, spec.w, spec.h, maxBytes).then(function (res) {
      if (!res.blob) throw new Error("encode-failed");
      if (minBytes > 0 && !res.over && res.blob.size < minBytes) {
        return blobToBytes(res.blob).then(function (bytes) {
          var padded = padJPEGBytes(bytes, minBytes + 16);
          return {
            blob: new Blob([padded], { type: "image/jpeg" }),
            quality: res.quality, padded: true, over: false
          };
        });
      }
      return { blob: res.blob, quality: res.quality, padded: false, over: res.over };
    });
  }

  var Core = {
    PRESETS: PRESETS,
    findPreset: findPreset,
    largestCenteredCrop: largestCenteredCrop,
    padJPEGBytes: padJPEGBytes,
    encodeCropAtQuality: encodeCropAtQuality,
    searchQualityCrop: searchQualityCrop,
    fitToBand: fitToBand
  };
  if (typeof module !== "undefined" && module.exports) module.exports = Core;
  if (global) global.TWFormResizer = Core;

  /* ================================================================
     UI — runs only in a browser page that contains the tool markup.
     ================================================================ */
  if (typeof document === "undefined" || !document.querySelector) return;
  var container = document.querySelector("[data-form-resizer]");
  if (!container) return;

  function track(action, params) {
    if (typeof window !== "undefined" && typeof window.gtag === "function") {
      try { window.gtag("event", action, params || {}); } catch (e) {}
    }
  }
  function fmtBytes(bytes) { return bytes.toLocaleString("en-US") + " bytes"; }
  function fmtKB(bytes) { return (bytes / 1024).toFixed(1) + " KB"; }
  function fmtSize(bytes) { return fmtKB(bytes) + " (" + fmtBytes(bytes) + ")"; }

  /* ---------- Image loading (same approach as compress.js) ---------- */
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

  /* ================================================================
     One workspace = one mode (photo or signature). Each keeps its own
     file, crop and result, so the user can prepare both uploads.
     ================================================================ */
  function initWorkspace(ws, mode) {
    function qs(sel) { return ws.querySelector(sel); }
    var dropzone   = qs("[data-dropzone]");
    var fileInput  = qs("[data-file-input]");
    var stage      = qs("[data-stage]");
    var origMeta   = qs("[data-original-meta]");
    var cropStage  = qs("[data-crop-stage]");
    var cropImg    = qs("[data-crop-img]");
    var cropBox    = qs("[data-crop-box]");
    var cropHandle = qs("[data-crop-handle]");
    var chipsWrap  = qs("[data-preset-chips]");
    var customWrap = qs("[data-custom-fields]");
    var inW        = qs("[data-custom-w]");
    var inH        = qs("[data-custom-h]");
    var inMaxKB    = qs("[data-custom-maxkb]");
    var inMinKB    = qs("[data-custom-minkb]");
    var specText   = qs("[data-preset-spec]");
    var autoBtn    = qs("[data-autocrop]");
    var makeBtn    = qs("[data-make-btn]");
    var statusEl   = qs("[data-status]");
    var resultPanel = qs("[data-result]");
    var resultImg  = qs("[data-result-img]");
    var resultMeta = qs("[data-result-meta]");
    var statDims   = qs("[data-stat-dims]");
    var statSize   = qs("[data-stat-size]");
    var statBand   = qs("[data-stat-band]");
    var bandStatus = qs("[data-band-status]");
    var padNote    = qs("[data-pad-note]");
    var downloadBtn = qs("[data-download]");
    var resetBtn   = qs("[data-reset]");

    if (!dropzone || !fileInput || !cropStage || !cropBox || !makeBtn) return;

    var presets = PRESETS[mode];
    var state = {
      file: null, bitmap: null, natW: 0, natH: 0,
      previewURL: null, resultURL: null,
      crop: null,            // {x,y,w,h} in natural pixels
      presetId: presets[0].id,
      busy: false
    };

    /* ---------- Preset chips ---------- */
    presets.forEach(function (p) {
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
      var p = Core.findPreset(mode, state.presetId);
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
      if (!Core.findPreset(mode, id)) id = presets[0].id;
      state.presetId = id;
      paintSpec();
      if (state.crop) refitCrop();
      if (!silent) track("tool_preset_selected", { tool: "photo_signature_resizer", preset: id });
    }

    /* ---------- Crop ---------- */
    function aspect() {
      var spec = currentSpec();
      if (spec && spec.w > 0 && spec.h > 0) return spec.w / spec.h;
      return 1;
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
        setStatus("That file is not an image. Please choose a JPG, PNG or WebP image.");
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
            " • " + state.natW + " × " + state.natH + " px. Drag the red frame to choose what stays in the picture.";
        }
        dropzone.hidden = true;
        if (stage) stage.hidden = false;
        state.crop = null;
        autoCenter();
        // The displayed image size settles a tick later — re-render then.
        setTimeout(renderCrop, 30);
        setTimeout(renderCrop, 250);
        setStatus("");
        track("tool_file_selected", { tool: "photo_signature_resizer", mode: mode, file_type: file.type || "" });
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
          tool: "photo_signature_resizer", preset: spec.id, mode: mode,
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
        resultMeta.textContent = "Your form-ready " + (MODE_NOUNS[mode] || "image") +
          " — " + fmtSize(res.blob.size) + " • " + spec.w + " × " + spec.h + " px";
      }
      if (statDims) statDims.textContent = spec.w + " × " + spec.h + " px (exact)";
      if (statSize) statSize.textContent = fmtSize(res.blob.size);
      if (statBand) statBand.textContent = bandText(spec);
      if (bandStatus) {
        bandStatus.classList.remove("is-ok", "is-warn");
        if (res.over) {
          bandStatus.classList.add("is-warn");
          bandStatus.textContent = "⚠ " + fmtKB(res.blob.size) + " — still above the " + spec.maxKB +
            " KB limit. Try a tighter crop around the " + (MODE_SUBJECTS[mode] || "subject") + " and make it again.";
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
          padNote.textContent = "Note: your picture alone was smaller than the " + spec.minKB +
            " KB minimum, so harmless empty padding data was added inside the file to bring it into the band. The picture itself is unchanged.";
        }
      }
      if (downloadBtn) {
        downloadBtn.href = state.resultURL;
        downloadBtn.setAttribute("download",
          mode + "-" + spec.slug + "-" + spec.w + "x" + spec.h + ".jpg");
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
    makeBtn.addEventListener("click", runMake);
    if (downloadBtn) {
      downloadBtn.addEventListener("click", function () {
        track("tool_download", { tool: "photo_signature_resizer", mode: mode });
      });
    }
    if (resetBtn) resetBtn.addEventListener("click", resetAll);

    /* ---------- Initial preset (page-level data-preset wins) ---------- */
    var pagePreset = container.getAttribute("data-preset");
    var initial = presets[0].id;
    if (pagePreset) {
      if (Core.findPreset(mode, pagePreset)) {
        initial = pagePreset;
      } else if (mode === "signature") {
        // e.g. data-preset="ssc-photo" on an exam page → match "ssc-signature".
        var guess = pagePreset.replace(/-photo$/, "-signature");
        if (Core.findPreset(mode, guess)) initial = guess;
      }
    }
    selectPreset(initial, true);

    return { selectPreset: selectPreset };
  }

  /* ---------- Mode tabs ---------- */
  var workspaces = container.querySelectorAll("[data-workspace]");
  var apis = {};
  for (var i = 0; i < workspaces.length; i++) {
    apis[workspaces[i].getAttribute("data-mode")] = initWorkspace(workspaces[i], workspaces[i].getAttribute("data-mode"));
  }
  var tabs = container.querySelectorAll("[data-mode-tab]");
  function setMode(mode) {
    for (var j = 0; j < workspaces.length; j++) {
      workspaces[j].hidden = workspaces[j].getAttribute("data-mode") !== mode;
    }
    for (var k = 0; k < tabs.length; k++) {
      var active = tabs[k].getAttribute("data-mode-tab") === mode;
      tabs[k].classList.toggle("is-active", active);
      tabs[k].setAttribute("aria-selected", active ? "true" : "false");
    }
    track("tool_mode_switch", { tool: "photo_signature_resizer", mode: mode });
  }
  for (var t = 0; t < tabs.length; t++) {
    tabs[t].addEventListener("click", function () { setMode(this.getAttribute("data-mode-tab")); });
  }
  var defaultMode = container.getAttribute("data-default-mode");
  if (!defaultMode || !apis[defaultMode]) {
    var pp = container.getAttribute("data-preset");
    defaultMode = pp && pp.indexOf("signature") !== -1 ? "signature" : "photo";
  }
  setMode(defaultMode);
})(typeof window !== "undefined" ? window : null);

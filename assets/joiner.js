/* Tools Website — Photo & Signature Joiner
   Works on any page that contains an element with [data-joiner-tool].

   Joins a candidate photograph and a signature into ONE JPG — the
   combined file some application portals ask for ("upload photo and
   signature in a single file"). The photo is cropped to the standard
   form size 200 × 230 px; the signature is cropped into a 200-px-wide
   strip; the two are composed stacked (photo on top) or side by side
   on a white canvas and fitted under the KB cap the user selects
   (50 / 100 / 200 KB or custom). Reuses the shared core from
   assets/form-resizer.js (window.TWFormResizer). There is no single
   national spec for a combined file — portals set their own — and the
   page says so. All processing happens locally in the browser. */
(function (global) {
  "use strict";

  var PHOTO_W = 200, PHOTO_H = 230;
  var STRIP_W = 200, STRIP_H = 67;              // signature strip, ~3:1
  var MODES = [
    { id: "stacked", label: "Stacked — photo on top" },
    { id: "side",    label: "Side by side" }
  ];
  var KB_PRESETS = [
    { id: "50",  label: "Max 50 KB",  maxKB: 50 },
    { id: "100", label: "Max 100 KB", maxKB: 100 },
    { id: "200", label: "Max 200 KB", maxKB: 200 },
    { id: "custom", label: "Custom", maxKB: null }
  ];

  function findById(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  // Pure: geometry of the joined file for a layout mode (unit-testable).
  function composeLayout(mode) {
    if (mode === "side") {
      return {
        total: { w: PHOTO_W + STRIP_W, h: PHOTO_H },
        photo: { x: 0, y: 0, w: PHOTO_W, h: PHOTO_H },
        sig:   { x: PHOTO_W, y: Math.round((PHOTO_H - STRIP_H) / 2), w: STRIP_W, h: STRIP_H }
      };
    }
    return {
      total: { w: PHOTO_W, h: PHOTO_H + STRIP_H },
      photo: { x: 0, y: 0, w: PHOTO_W, h: PHOTO_H },
      sig:   { x: 0, y: PHOTO_H, w: STRIP_W, h: STRIP_H }
    };
  }

  var JoinerCore = {
    PHOTO_W: PHOTO_W, PHOTO_H: PHOTO_H, STRIP_W: STRIP_W, STRIP_H: STRIP_H,
    MODES: MODES, KB_PRESETS: KB_PRESETS, findById: findById, composeLayout: composeLayout
  };
  if (typeof module !== "undefined" && module.exports) module.exports = JoinerCore;
  if (global) global.TWJoiner = JoinerCore;

  /* ================================================================
     UI
     ================================================================ */
  if (typeof document === "undefined" || !document.querySelector) return;
  var Core = global && global.TWFormResizer;
  if (!Core || !Core.largestCenteredCrop) return;
  var container = document.querySelector("[data-joiner-tool]");
  if (!container) return;

  function track(action, params) {
    if (typeof window !== "undefined" && typeof window.gtag === "function") {
      try { window.gtag("event", action, params || {}); } catch (e) {}
    }
  }
  function fmtKB(bytes) { return (bytes / 1024).toFixed(1) + " KB"; }
  function fmtSize(bytes) { return fmtKB(bytes) + " (" + bytes.toLocaleString("en-US") + " bytes)"; }

  function qs(sel, root) { return (root || container).querySelector(sel); }

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
  // Largest JPEG (quality search) that fits under maxBytes; null if even
  // the lowest quality is too big.
  function encodeUnder(canvas, maxBytes) {
    var lo = 0.25, hi = 0.95, best = null;
    function step(n) {
      if (n <= 0) return Promise.resolve(best);
      var q = (lo + hi) / 2;
      return canvasToBlob(canvas, q).then(function (blob) {
        if (blob.size <= maxBytes) { best = blob; lo = q; } else { hi = q; }
        return step(n - 1);
      });
    }
    return canvasToBlob(canvas, hi).then(function (blob) {
      if (blob.size <= maxBytes) return blob;
      return step(7);
    });
  }

  /* ---------- one crop-frame slot (photo or signature) ---------- */
  function makeSlot(section, aspect) {
    var dropzone = qs("[data-dropzone]", section);
    var fileInput = qs("[data-file-input]", section);
    var stage = qs("[data-stage]", section);
    var origMeta = qs("[data-orig-meta]", section);
    var cropImg = qs("[data-crop-img]", section);
    var cropBox = qs("[data-crop-box]", section);
    var slot = {
      section: section, file: null, bitmap: null, natW: 0, natH: 0,
      previewURL: null, crop: { x: 0, y: 0, size: 0 }
    };
    if (!dropzone || !fileInput || !cropImg || !cropBox) return slot;

    function imgDisplaySize() {
      var r = cropImg.getBoundingClientRect();
      return { w: r.width, h: r.height };
    }
    function clampCrop() {
      var d = imgDisplaySize();
      if (!d.w) return;
      var maxByWidth = d.w, maxByHeight = d.h * aspect;
      slot.crop.size = Math.max(24, Math.min(slot.crop.size, maxByWidth, maxByHeight));
      var boxW = slot.crop.size, boxH = slot.crop.size / aspect;
      slot.crop.x = Math.max(0, Math.min(slot.crop.x, d.w - boxW));
      slot.crop.y = Math.max(0, Math.min(slot.crop.y, d.h - boxH));
    }
    function paintCrop() {
      cropBox.style.left = slot.crop.x + "px";
      cropBox.style.top = slot.crop.y + "px";
      cropBox.style.width = slot.crop.size + "px";
      cropBox.style.height = (slot.crop.size / aspect) + "px";
    }
    function initCrop() {
      var d = imgDisplaySize();
      var c = Core.largestCenteredCrop(d.w, d.h, aspect);
      slot.crop = { x: c.x, y: c.y, size: c.size };
      paintCrop();
    }
    slot.readCropNatural = function () {
      var d = imgDisplaySize();
      var sx = slot.natW / d.w, sy = slot.natH / d.h;
      return {
        x: Math.round(slot.crop.x * sx), y: Math.round(slot.crop.y * sy),
        w: Math.round(slot.crop.size * sx), h: Math.round((slot.crop.size / aspect) * sy)
      };
    };
    slot.ready = function () { return !!slot.bitmap; };

    cropImg.addEventListener("load", function () { initCrop(); });

    var drag = null;
    cropBox.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      var handle = e.target.getAttribute && e.target.getAttribute("data-handle");
      drag = {
        mode: handle || "move", startX: e.clientX, startY: e.clientY,
        x: slot.crop.x, y: slot.crop.y, size: slot.crop.size
      };
      cropBox.setPointerCapture(e.pointerId);
    });
    cropBox.addEventListener("pointermove", function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
      if (drag.mode === "move") {
        slot.crop.x = drag.x + dx; slot.crop.y = drag.y + dy;
      } else if (drag.mode === "se") {
        slot.crop.size = drag.size + Math.max(dx, dy * aspect);
      } else if (drag.mode === "sw") {
        var grown = drag.size - dx;
        slot.crop.x = drag.x + (drag.size - grown); slot.crop.size = grown;
      } else if (drag.mode === "ne") {
        var g2 = drag.size + dx;
        slot.crop.y = drag.y + (drag.size - g2) / aspect; slot.crop.size = g2;
      } else if (drag.mode === "nw") {
        var g3 = drag.size - dx;
        slot.crop.x = drag.x + (drag.size - g3);
        slot.crop.y = drag.y + (drag.size - g3) / aspect;
        slot.crop.size = g3;
      }
      clampCrop(); paintCrop();
    });
    function endDrag() { drag = null; }
    cropBox.addEventListener("pointerup", endDrag);
    cropBox.addEventListener("pointercancel", endDrag);

    function handleFile(file, onError) {
      if (!file) return;
      if (file.type && file.type.indexOf("image/") !== 0) {
        onError("That file is not an image. Please choose a JPG, PNG or WebP.");
        return;
      }
      loadSource(file).then(function (loaded) {
        slot.file = file;
        slot.bitmap = loaded.source;
        var dims = sourceDims(loaded.source);
        slot.natW = dims.w; slot.natH = dims.h;
        if (slot.previewURL) URL.revokeObjectURL(slot.previewURL);
        slot.previewURL = loaded.url || URL.createObjectURL(file);
        cropImg.src = slot.previewURL; // 'load' event initialises the crop
        if (origMeta) {
          origMeta.textContent = "Original: " + file.name + " — " + fmtSize(file.size) +
            " • " + slot.natW + " × " + slot.natH + " px. Drag the frame to position it; drag a corner to resize.";
        }
        dropzone.hidden = true;
        if (stage) stage.hidden = false;
        onError("");
        track("tool_file_selected", { tool: "photo_signature_joiner" });
      }).catch(function () {
        onError("Sorry — this image could not be read. Try a JPG or PNG instead.");
      });
    }
    slot.handleFile = handleFile;
    slot.reset = function () {
      slot.file = null; slot.bitmap = null; slot.natW = 0; slot.natH = 0;
      if (slot.previewURL) { URL.revokeObjectURL(slot.previewURL); slot.previewURL = null; }
      cropImg.removeAttribute("src");
      fileInput.value = "";
      if (stage) stage.hidden = true;
      dropzone.hidden = false;
    };

    dropzone.addEventListener("click", function () { fileInput.click(); });
    dropzone.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
    });
    fileInput.addEventListener("change", function () {
      if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0], setStatus);
    });
    ["dragenter", "dragover"].forEach(function (evt) {
      dropzone.addEventListener(evt, function (e) { e.preventDefault(); dropzone.classList.add("is-dragover"); });
    });
    ["dragleave", "drop"].forEach(function (evt) {
      dropzone.addEventListener(evt, function (e) { e.preventDefault(); dropzone.classList.remove("is-dragover"); });
    });
    dropzone.addEventListener("drop", function (e) {
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files[0]) handleFile(files[0], setStatus);
    });
    return slot;
  }

  /* ---------- main wiring ---------- */
  var photoSlot = makeSlot(qs("[data-slot-photo]"), PHOTO_W / PHOTO_H);
  var sigSlot   = makeSlot(qs("[data-slot-signature]"), STRIP_W / STRIP_H);

  var modeChips  = qs("[data-mode-chips]");
  var kbChips    = qs("[data-kb-chips]");
  var customWrap = qs("[data-custom-wrap]");
  var customKb   = qs("[data-custom-kb]");
  var layoutSpec = qs("[data-layout-spec]");
  var joinBtn    = qs("[data-join-btn]");
  var statusEl   = qs("[data-status]");
  var resultPanel = qs("[data-result]");
  var resultImg  = qs("[data-result-img]");
  var resultMeta = qs("[data-result-meta]");
  var statDims   = qs("[data-stat-dims]");
  var statSize   = qs("[data-stat-size]");
  var statReq    = qs("[data-stat-required]");
  var bandStatus = qs("[data-band-status]");
  var downloadBtn = qs("[data-download]");
  var resetBtn   = qs("[data-reset]");

  if (!photoSlot || !sigSlot || !joinBtn) return;

  var state = { modeId: "stacked", kbId: "50", resultURL: null, busy: false };

  function setStatus(msg) { if (statusEl) statusEl.textContent = msg || ""; }

  function buildChips(wrap, list, attr, onPick) {
    if (!wrap) return;
    list.forEach(function (item) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "chip preset-chip";
      b.setAttribute(attr, item.id);
      b.textContent = item.label;
      wrap.appendChild(b);
    });
    wrap.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest("[" + attr + "]") : null;
      if (!btn) return;
      onPick(btn.getAttribute(attr));
    });
  }
  function paintChips(wrap, attr, activeId) {
    if (!wrap) return;
    var btns = wrap.querySelectorAll("[" + attr + "]");
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle("is-active", btns[i].getAttribute(attr) === activeId);
    }
  }
  function currentMaxBytes() {
    var p = findById(KB_PRESETS, state.kbId);
    var kb = p && p.maxKB != null ? p.maxKB : NaN;
    if (p && p.id === "custom") {
      var v = parseFloat(customKb && customKb.value);
      kb = isFinite(v) ? v : NaN;
    }
    return isFinite(kb) && kb >= 5 && kb <= 500 ? Math.round(kb * 1024) : null;
  }
  function paintSpec() {
    paintChips(modeChips, "data-mode-id", state.modeId);
    paintChips(kbChips, "data-kb-id", state.kbId);
    if (customWrap) customWrap.hidden = state.kbId !== "custom";
    var L = composeLayout(state.modeId);
    var p = findById(KB_PRESETS, state.kbId);
    var sizeTxt = p && p.maxKB != null ? "max " + p.maxKB + " KB" : "your custom KB cap";
    if (layoutSpec) {
      layoutSpec.textContent = "Joined file: " + L.total.w + " × " + L.total.h + " px — photograph " +
        PHOTO_W + " × " + PHOTO_H + " px, signature strip " + STRIP_W + " × " + STRIP_H + " px, white background, JPG, " + sizeTxt + ".";
    }
  }
  buildChips(modeChips, MODES, "data-mode-id", function (id) {
    if (findById(MODES, id)) { state.modeId = id; paintSpec(); }
  });
  buildChips(kbChips, KB_PRESETS, "data-kb-id", function (id) {
    if (findById(KB_PRESETS, id)) { state.kbId = id; paintSpec(); }
  });
  if (customKb) customKb.addEventListener("input", paintSpec);
  paintSpec();

  function drawInto(ctx, slot, rect) {
    var c = slot.readCropNatural();
    ctx.drawImage(slot.bitmap, c.x, c.y, c.w, c.h, rect.x, rect.y, rect.w, rect.h);
  }

  function runJoin() {
    if (state.busy) return;
    if (!photoSlot.ready() && !sigSlot.ready()) { setStatus("Add both files first — the photograph and the signature."); return; }
    if (!photoSlot.ready()) { setStatus("The photograph is still missing — add it in step 1."); return; }
    if (!sigSlot.ready()) { setStatus("The signature is still missing — add it in step 2."); return; }
    var maxBytes = currentMaxBytes();
    if (maxBytes == null) { setStatus("Enter a size cap between 5 and 500 KB."); return; }
    state.busy = true;
    joinBtn.disabled = true;
    var label = joinBtn.textContent;
    joinBtn.textContent = "Working…";
    setStatus("Working in your browser — joining your photo and signature…");
    resetResult();

    setTimeout(function () {
      try {
        var L = composeLayout(state.modeId);
        var canvas = document.createElement("canvas");
        canvas.width = L.total.w;
        canvas.height = L.total.h;
        var ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, L.total.w, L.total.h);
        drawInto(ctx, photoSlot, L.photo);
        drawInto(ctx, sigSlot, L.sig);
        encodeUnder(canvas, maxBytes).then(function (blob) {
          state.busy = false;
          joinBtn.disabled = false;
          joinBtn.textContent = label;
          if (!blob) {
            setStatus("Even at the lowest quality this joined file exceeds your size cap. Raise the cap and try again.");
            return;
          }
          showResult(blob, L, maxBytes);
          track("tool_resize_success", {
            tool: "photo_signature_joiner", mode: state.modeId,
            max_kb: Math.round(maxBytes / 1024), output_kb: Math.round(blob.size / 1024)
          });
        }).catch(function () {
          state.busy = false;
          joinBtn.disabled = false;
          joinBtn.textContent = label;
          setStatus("Something went wrong while preparing your file. Please try again.");
        });
      } catch (e) {
        state.busy = false;
        joinBtn.disabled = false;
        joinBtn.textContent = label;
        setStatus("Something went wrong while preparing your file. Please try again with different images.");
      }
    }, 30);
  }

  function showResult(blob, L, maxBytes) {
    if (state.resultURL) URL.revokeObjectURL(state.resultURL);
    state.resultURL = URL.createObjectURL(blob);
    if (resultImg) resultImg.src = state.resultURL;
    if (resultMeta) {
      resultMeta.textContent = "Photo & signature joined — " + fmtSize(blob.size) + " • " + L.total.w + " × " + L.total.h + " px";
    }
    if (statDims) statDims.textContent = L.total.w + " × " + L.total.h + " px";
    if (statSize) statSize.textContent = fmtSize(blob.size);
    if (statReq) statReq.textContent = "Max " + Math.round(maxBytes / 1024) + " KB";
    if (bandStatus) {
      bandStatus.classList.remove("is-warn");
      bandStatus.classList.add("is-ok");
      bandStatus.textContent = "✓ Under the cap — " + fmtKB(blob.size) + " is within your " +
        Math.round(maxBytes / 1024) + " KB limit. Before uploading it, check your portal's notification for its exact combined-file pixel size and KB cap — portals set their own.";
    }
    if (downloadBtn) {
      downloadBtn.href = state.resultURL;
      downloadBtn.setAttribute("download", "photo-and-signature-" + L.total.w + "x" + L.total.h + ".jpg");
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
    photoSlot.reset();
    sigSlot.reset();
    setStatus("");
  }

  joinBtn.addEventListener("click", runJoin);
  if (downloadBtn) {
    downloadBtn.addEventListener("click", function () {
      track("tool_download", { tool: "photo_signature_joiner" });
    });
  }
  if (resetBtn) resetBtn.addEventListener("click", resetAll);
})(typeof window !== "undefined" ? window : null);

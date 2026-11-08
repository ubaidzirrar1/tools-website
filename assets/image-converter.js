/* Tools Website — Generic Image Converter
   Works on any page that contains an element with [data-image-converter-tool].
   The page may preset the output via data-default-format ("jpg" / "png")
   on the container.

   Converts images (WebP first, but any browser-decodable image works —
   the next converters, AVIF to JPG and HEIC to JPG, reuse this engine)
   entirely in the browser: File -> decode -> Canvas at the ORIGINAL
   pixel dimensions -> encode as JPG or PNG. For JPG, transparent
   pixels are flattened onto a chosen background colour (white or
   black) because JPG has no alpha channel. Files are never uploaded.

   HEIC/HEIF exception: no browser can decode HEIC natively, so HEIC
   files are decoded with libheif (self-hosted at
   /assets/vendor/libheif.js), which is loaded LAZILY — only when the
   first HEIC file is added — and then cached. Everything still happens
   on the user's device; HEIC photos are never uploaded either. */
(function (global) {
  "use strict";

  var FORMATS = [
    { id: "jpg", label: "JPG", mime: "image/jpeg", ext: "jpg" },
    { id: "png", label: "PNG", mime: "image/png", ext: "png" }
  ];
  var BACKGROUNDS = [
    { id: "white", label: "White background", css: "#ffffff" },
    { id: "black", label: "Black background", css: "#000000" }
  ];
  var MAX_FILES = 20;
  var DEFAULT_QUALITY = 0.92;

  /* ---- Pure helpers (unit-tested in Node) ---- */

  function normalizeFormat(format) {
    var f = String(format || "").toLowerCase().replace(/^\./, "");
    if (f === "jpeg") f = "jpg";
    for (var i = 0; i < FORMATS.length; i++) if (FORMATS[i].id === f) return f;
    return "jpg";
  }
  function formatInfo(format) {
    var id = normalizeFormat(format);
    for (var i = 0; i < FORMATS.length; i++) if (FORMATS[i].id === id) return FORMATS[i];
    return FORMATS[0];
  }
  /* Clamp a quality value into the encoder range 0.05..1.
     Accepts a 0..1 fraction or a 1..100 percentage; anything invalid
     falls back to DEFAULT_QUALITY. */
  function clampQuality(q) {
    var v = typeof q === "string" ? parseFloat(q) : q;
    if (typeof v !== "number" || !isFinite(v)) return DEFAULT_QUALITY;
    if (v > 1) v = v / 100; // percentage form
    if (v < 0.05) v = 0.05;
    if (v > 1) v = 1;
    return Math.round(v * 100) / 100;
  }
  /* Output file name: original base name (extension stripped, unsafe
     characters replaced) + the new extension. */
  function outputName(inputName, format) {
    var ext = formatInfo(format).ext;
    var base = String(inputName || "image");
    var slash = Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\"));
    if (slash >= 0) base = base.slice(slash + 1);
    var dot = base.lastIndexOf(".");
    if (dot > 0) base = base.slice(0, dot);
    base = base.replace(/[^\w\-. ]+/g, "").replace(/\s+/g, "-").replace(/^-+|-+$/g, "");
    if (!base) base = "image";
    return base + "." + ext;
  }
  function backgroundCss(id) {
    for (var i = 0; i < BACKGROUNDS.length; i++) if (BACKGROUNDS[i].id === id) return BACKGROUNDS[i].css;
    return "#ffffff";
  }
  /* True for HEIC/HEIF files — by MIME type when the browser reports
     one, otherwise by file extension (some systems hand HEIC files over
     with an empty or generic type). */
  function isHeicFile(file) {
    if (!file) return false;
    var type = String(file.type || "").toLowerCase();
    if (type === "image/heic" || type === "image/heif") return true;
    return /\.hei[cf]$/i.test(String(file.name || ""));
  }

  var ConvertCore = {
    FORMATS: FORMATS, BACKGROUNDS: BACKGROUNDS, MAX_FILES: MAX_FILES,
    DEFAULT_QUALITY: DEFAULT_QUALITY,
    normalizeFormat: normalizeFormat, formatInfo: formatInfo,
    clampQuality: clampQuality, outputName: outputName, backgroundCss: backgroundCss,
    isHeicFile: isHeicFile
  };
  if (typeof module !== "undefined" && module.exports) module.exports = ConvertCore;
  if (global) global.TWImageConvert = ConvertCore;

  /* ================================================================
     DOM conversion (browser only)
     ================================================================ */
  /* ---- HEIC decoding via libheif (lazy, cached) ---- */
  function heicLoadError() {
    var e = new Error("HEIC decoder could not load — check your connection and try again.");
    e.isHeicLoadError = true;
    return e;
  }
  var heifModulePromise = null;
  function loadHeifModule() {
    if (heifModulePromise) return heifModulePromise;
    var p = new Promise(function (resolve, reject) {
      function fail() { reject(heicLoadError()); }
      function init() {
        if (typeof window === "undefined" || typeof window.libheif !== "function") { fail(); return; }
        try {
          Promise.resolve(window.libheif()).then(function (mod) {
            if (mod && typeof mod.HeifDecoder === "function") resolve(mod);
            else fail();
          }, fail);
        } catch (e) { fail(); }
      }
      if (typeof window !== "undefined" && typeof window.libheif === "function") { init(); return; }
      if (typeof document === "undefined" || !document.createElement) { fail(); return; }
      var s = document.createElement("script");
      s.src = "/assets/vendor/libheif.js";
      s.async = true;
      s.onload = init;
      s.onerror = fail;
      (document.head || document.documentElement).appendChild(s);
    });
    heifModulePromise = p;
    /* A failed load must not poison the page: clear the cache so the
       next HEIC file retries. */
    p.then(null, function () { if (heifModulePromise === p) heifModulePromise = null; });
    return p;
  }
  function readArrayBuffer(file) {
    if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(new Error("decode")); };
      r.readAsArrayBuffer(file);
    });
  }
  /* Decode a HEIC/HEIF file to a canvas at its exact pixel size. */
  function decodeHeicToCanvas(file) {
    return loadHeifModule().then(function (heif) {
      return readArrayBuffer(file).then(function (buf) {
        var img;
        try {
          var decoder = new heif.HeifDecoder();
          var images = decoder.decode(buf);
          if (!images || !images.length) throw new Error("decode");
          img = images[0];
        } catch (e) { throw new Error("decode"); }
        var w = img.get_width(), h = img.get_height();
        if (!w || !h) throw new Error("decode");
        var canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext("2d");
        var imageData = ctx.createImageData(w, h);
        return new Promise(function (resolve, reject) {
          try {
            img.display(imageData, function (displayData) {
              if (!displayData) { reject(new Error("decode")); return; }
              ctx.putImageData(displayData, 0, 0);
              resolve(canvas);
            });
          } catch (e) { reject(new Error("decode")); }
        });
      });
    });
  }

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
    if (isHeicFile(file)) {
      /* Browsers cannot decode HEIC: go through libheif. The decoded
         canvas doubles as the source, and a JPEG data URL of it serves
         as the list thumbnail (the browser cannot render a HEIC blob
         URL in an <img>). */
      return decodeHeicToCanvas(file).then(function (canvas) {
        var thumb = null;
        try { thumb = canvas.toDataURL("image/jpeg", 0.85); } catch (e) {}
        return { source: canvas, url: thumb };
      });
    }
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
  function canvasToBlob(canvas, mime, quality) {
    return new Promise(function (resolve, reject) {
      if (canvas.toBlob) {
        canvas.toBlob(function (blob) {
          if (blob) resolve(blob); else reject(new Error("encode-failed"));
        }, mime, quality);
      } else {
        try {
          var dataUrl = canvas.toDataURL(mime, quality);
          var bin = atob(dataUrl.split(",")[1]);
          var arr = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          resolve(new Blob([arr], { type: mime }));
        } catch (err) { reject(err); }
      }
    });
  }

  /* Convert one File -> { blob, width, height, name }.
     opts: { format: "jpg"|"png", quality: 0..1|percent, background: "white"|"black" } */
  function convertFile(file, opts) {
    opts = opts || {};
    var info = formatInfo(opts.format);
    var quality = clampQuality(opts.quality != null ? opts.quality : DEFAULT_QUALITY);
    return loadSource(file).then(function (loaded) {
      var src = loaded.source;
      var w = src.naturalWidth || src.width || 0;
      var h = src.naturalHeight || src.height || 0;
      if (!w || !h) { if (loaded.url) URL.revokeObjectURL(loaded.url); throw new Error("decode"); }
      var canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      var ctx = canvas.getContext("2d");
      if (info.id === "jpg") {
        ctx.fillStyle = backgroundCss(opts.background);
        ctx.fillRect(0, 0, w, h);
      }
      ctx.drawImage(src, 0, 0, w, h);
      if (loaded.url) URL.revokeObjectURL(loaded.url);
      if (src.close) { try { src.close(); } catch (e) {} }
      return canvasToBlob(canvas, info.mime, quality).then(function (blob) {
        return { blob: blob, width: w, height: h, name: outputName(file.name, info.id) };
      });
    });
  }
  ConvertCore.convertFile = convertFile;
  if (global) global.TWImageConvert = ConvertCore;

  /* ================================================================
     UI
     ================================================================ */
  if (typeof document === "undefined" || !document.querySelector) return;
  var container = document.querySelector("[data-image-converter-tool]");
  if (!container) return;

  function track(action, params) {
    if (typeof window !== "undefined" && typeof window.gtag === "function") {
      try { window.gtag("event", action, params || {}); } catch (e) {}
    }
  }
  function fmtKB(bytes) { return (bytes / 1024).toFixed(1) + " KB"; }
  function fmtSize(bytes) { return fmtKB(bytes) + " (" + bytes.toLocaleString("en-US") + " bytes)"; }
  function qs(sel) { return container.querySelector(sel); }

  var dropzone    = qs("[data-dropzone]");
  var fileInput   = qs("[data-file-input]");
  var listWrap    = qs("[data-items]");
  var formatChips = qs("[data-format-chips]");
  var bgChips     = qs("[data-bg-chips]");
  var bgWrap      = qs("[data-bg-wrap]");
  var qualityInput = qs("[data-quality]");
  var qualityVal  = qs("[data-quality-value]");
  var convertBtn  = qs("[data-convert-btn]");
  var downloadAllBtn = qs("[data-download-all]");
  var statusEl    = qs("[data-status]");
  var resetBtn    = qs("[data-reset]");

  if (!dropzone || !fileInput || !convertBtn || !listWrap) return;

  var items = []; // {file, natW, natH, thumbURL, state, resultURL, resultName, outSize, error}
  var state = {
    format: normalizeFormat(container.getAttribute("data-default-format") || "jpg"),
    background: "white",
    busy: false
  };

  function setStatus(msg) { if (statusEl) statusEl.textContent = msg || ""; }
  function currentQuality() {
    return qualityInput ? clampQuality(qualityInput.value) : DEFAULT_QUALITY;
  }

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
  buildChips(formatChips, FORMATS, "data-format-id", function (id) {
    state.format = normalizeFormat(id); invalidateResults(); paintAll();
  });
  buildChips(bgChips, BACKGROUNDS, "data-bg-id", function (id) {
    state.background = id; invalidateResults(); paintAll();
  });
  if (qualityInput) {
    qualityInput.addEventListener("input", function () { invalidateResults(); paintAll(); });
  }

  function paintAll() {
    paintChips(formatChips, "data-format-id", state.format);
    paintChips(bgChips, "data-bg-id", state.background);
    if (bgWrap) bgWrap.hidden = state.format !== "jpg";
    if (qualityVal && qualityInput) qualityVal.textContent = Math.round(clampQuality(qualityInput.value) * 100) + "%";
    var done = items.filter(function (it) { return it.state === "done"; }).length;
    if (downloadAllBtn) downloadAllBtn.hidden = done < 2;
  }

  /* Changing any setting invalidates earlier conversions, so what the
     user downloads always matches the settings on screen. */
  function invalidateResults() {
    var changed = false;
    items.forEach(function (it) {
      if (it.state === "done" || it.state === "error") {
        if (it.resultURL) { URL.revokeObjectURL(it.resultURL); it.resultURL = null; }
        it.state = "pending"; it.outSize = null; it.error = null; changed = true;
      }
    });
    if (changed) renderList();
  }

  function renderList() {
    listWrap.innerHTML = "";
    items.forEach(function (it, idx) {
      var row = document.createElement("div");
      row.className = "pdf-item";
      var img = document.createElement("img");
      img.className = "pdf-item-thumb";
      img.src = it.thumbURL;
      img.alt = "";
      row.appendChild(img);
      var info = document.createElement("div");
      info.className = "pdf-item-info";
      var name = document.createElement("strong");
      name.textContent = it.file.name;
      info.appendChild(name);
      var meta = document.createElement("span");
      if (it.state === "done") {
        meta.textContent = it.natW + " × " + it.natH + " px • " + fmtKB(it.file.size) +
          " → " + fmtSize(it.outSize) + " (" + it.resultName + ")";
      } else if (it.state === "error") {
        meta.textContent = "⚠ " + (it.error || "This file could not be converted.");
      } else if (it.state === "converting") {
        meta.textContent = it.natW + " × " + it.natH + " px • " + fmtKB(it.file.size) + " — converting…";
      } else {
        meta.textContent = it.natW + " × " + it.natH + " px • " + fmtKB(it.file.size);
      }
      info.appendChild(meta);
      row.appendChild(info);
      var actions = document.createElement("div");
      actions.className = "pdf-item-actions";
      if (it.state === "done" && it.resultURL) {
        var a = document.createElement("a");
        a.className = "chip pdf-item-btn";
        a.href = it.resultURL;
        a.setAttribute("download", it.resultName);
        a.textContent = "⬇";
        a.title = "Download " + it.resultName;
        a.setAttribute("aria-label", "Download " + it.resultName);
        a.setAttribute("data-act", "download");
        a.setAttribute("data-idx", String(idx));
        actions.appendChild(a);
      }
      var rm = document.createElement("button");
      rm.type = "button";
      rm.className = "chip pdf-item-btn";
      rm.textContent = "✕";
      rm.title = "Remove";
      rm.setAttribute("aria-label", "Remove " + it.file.name);
      rm.setAttribute("data-act", "remove");
      rm.setAttribute("data-idx", String(idx));
      actions.appendChild(rm);
      row.appendChild(actions);
      listWrap.appendChild(row);
    });
    listWrap.hidden = items.length === 0;
    paintAll();
  }
  listWrap.addEventListener("click", function (e) {
    var el = e.target.closest ? e.target.closest("[data-act]") : null;
    if (!el) return;
    var idx = parseInt(el.getAttribute("data-idx"), 10);
    var act = el.getAttribute("data-act");
    if (act === "download") { track("tool_download", { tool: "image_converter" }); return; }
    if (act === "remove") {
      var gone = items.splice(idx, 1)[0];
      if (gone) {
        if (gone.thumbURL) URL.revokeObjectURL(gone.thumbURL);
        if (gone.resultURL) URL.revokeObjectURL(gone.resultURL);
      }
      renderList();
    }
  });

  function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    files.forEach(function (file) {
      if (!isHeicFile(file) && file.type && file.type.indexOf("image/") !== 0) {
        setStatus("“" + file.name + "” is not an image file, so it was skipped.");
        return;
      }
      if (items.length >= MAX_FILES) { setStatus("Up to " + MAX_FILES + " images at a time."); return; }
      loadSource(file).then(function (loaded) {
        var src = loaded.source;
        var w = src.naturalWidth || src.width || 0;
        var h = src.naturalHeight || src.height || 0;
        if (!w || !h) throw new Error("decode");
        items.push({
          file: file, natW: w, natH: h,
          thumbURL: loaded.url || URL.createObjectURL(file),
          state: "pending", resultURL: null, resultName: null, outSize: null, error: null
        });
        if (src.close && loaded.url) { /* Image element: keep the object URL as the thumb */ }
        renderList();
        setStatus("");
        track("tool_file_selected", { tool: "image_converter", file_type: file.type || "" });
      }).catch(function (err) {
        if (err && err.isHeicLoadError) {
          setStatus("“" + file.name + "” — " + err.message);
        } else {
          setStatus("“" + file.name + "” could not be read — it may be damaged, or a format your browser cannot open. A WebP, JPG or PNG will work.");
        }
      });
    });
  }

  function convertAll() {
    if (state.busy) return;
    if (!items.length) { setStatus("Add at least one image first."); return; }
    state.busy = true;
    convertBtn.disabled = true;
    var label = convertBtn.textContent;
    convertBtn.textContent = "Converting…";
    var opts = { format: state.format, quality: currentQuality(), background: state.background };
    var chain = Promise.resolve();
    var okCount = 0, failCount = 0;
    items.forEach(function (it) {
      if (it.state === "done") { okCount++; return; }
      chain = chain.then(function () {
        it.state = "converting"; renderList();
        return convertFile(it.file, opts).then(function (res) {
          it.state = "done";
          it.outSize = res.blob.size;
          it.resultName = res.name;
          if (it.resultURL) URL.revokeObjectURL(it.resultURL);
          it.resultURL = URL.createObjectURL(res.blob);
          okCount++;
          renderList();
        }).catch(function (err) {
          it.state = "error";
          it.error = (err && err.isHeicLoadError)
            ? err.message
            : "Could not convert this file — it may be damaged, or a format your browser cannot decode.";
          failCount++;
          renderList();
        });
      });
    });
    chain.then(function () {
      state.busy = false;
      convertBtn.disabled = false;
      convertBtn.textContent = label;
      if (failCount && okCount) setStatus("Converted " + okCount + " of " + items.length + " images. " + failCount + " could not be converted — see the note under each file.");
      else if (failCount) setStatus("None of the images could be converted. Check the note under each file — a standard WebP, JPG or PNG will work.");
      else setStatus("✅ Converted " + okCount + (okCount === 1 ? " image" : " images") + " — download each one below" + (okCount > 1 ? ", or use Download all." : "."));
      paintAll();
      track("tool_resize_success", { tool: "image_converter", files: okCount, format: state.format });
    });
  }

  function downloadAll() {
    var ready = items.filter(function (it) { return it.state === "done" && it.resultURL; });
    ready.forEach(function (it, i) {
      setTimeout(function () {
        var a = document.createElement("a");
        a.href = it.resultURL;
        a.setAttribute("download", it.resultName);
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, i * 350);
    });
    if (ready.length) track("tool_download", { tool: "image_converter", mode: "all", files: ready.length });
  }

  function resetAll() {
    items.forEach(function (it) {
      if (it.thumbURL) URL.revokeObjectURL(it.thumbURL);
      if (it.resultURL) URL.revokeObjectURL(it.resultURL);
    });
    items = [];
    renderList();
    fileInput.value = "";
    setStatus("");
    dropzone.focus();
  }

  dropzone.addEventListener("click", function () { fileInput.click(); });
  dropzone.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener("change", function () {
    if (fileInput.files && fileInput.files.length) addFiles(fileInput.files);
    fileInput.value = "";
  });
  ["dragenter", "dragover"].forEach(function (evt) {
    dropzone.addEventListener(evt, function (e) { e.preventDefault(); dropzone.classList.add("is-dragover"); });
  });
  ["dragleave", "drop"].forEach(function (evt) {
    dropzone.addEventListener(evt, function (e) { e.preventDefault(); dropzone.classList.remove("is-dragover"); });
  });
  dropzone.addEventListener("drop", function (e) {
    var files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) addFiles(files);
  });
  document.addEventListener("paste", function (e) {
    if (!e.clipboardData || !e.clipboardData.files || !e.clipboardData.files.length) return;
    var tag = (document.activeElement && document.activeElement.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    addFiles(e.clipboardData.files);
  });
  convertBtn.addEventListener("click", convertAll);
  if (downloadAllBtn) downloadAllBtn.addEventListener("click", downloadAll);
  if (resetBtn) resetBtn.addEventListener("click", resetAll);

  paintAll();
})(typeof window !== "undefined" ? window : null);

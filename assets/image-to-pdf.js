/* Tools Website — Image to PDF Converter
   Works on any page that contains an element with [data-image-to-pdf-tool].
   The page may preset the size target via data-default-target (KB) on the
   container.

   Converts multiple images into one PDF entirely in the browser. The
   PDF writer is hand-rolled and dependency-free: each image is
   re-encoded as a JPEG in the browser and embedded directly
   (DCTDecode), one image per page, with the page size (A4 / Letter /
   fit-to-image), margins, reordering, and an optional total-size
   target (e.g. "PDF under 200 KB" for portal document uploads) that a
   quality search fits under. All processing happens locally. */
(function (global) {
  "use strict";

  var A4 = { w: 595, h: 842 };
  var LETTER = { w: 612, h: 792 };
  var PAGE_SIZES = [
    { id: "a4",     label: "A4" },
    { id: "letter", label: "Letter" },
    { id: "fit",    label: "Fit to image" }
  ];
  var MARGINS = [
    { id: "none",  label: "No margin",   pt: 0 },
    { id: "small", label: "Small",       pt: 36 },
    { id: "large", label: "Large",       pt: 72 }
  ];
  var TARGETS = [
    { id: "none", label: "Best quality", maxKB: null },
    { id: "500",  label: "Under 500 KB", maxKB: 500 },
    { id: "200",  label: "Under 200 KB", maxKB: 200 },
    { id: "100",  label: "Under 100 KB", maxKB: 100 },
    { id: "custom", label: "Custom",     maxKB: null }
  ];

  function findById(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function num(n) {
    var s = (Math.round(n * 100) / 100).toString();
    return s;
  }

  /* Pure: the page box (points) for one image under a page-size mode.
     "fit" sizes the page to the image at 150 DPI, clamped to sane
     viewer limits, preserving aspect. */
  function pageSizeFor(mode, imgW, imgH) {
    if (mode === "letter") return { w: LETTER.w, h: LETTER.h };
    if (mode === "fit") {
      var w = imgW * 72 / 150, h = imgH * 72 / 150;
      var maxSide = 1440, minSide = 72;
      var scale = 1;
      if (Math.max(w, h) > maxSide) scale = maxSide / Math.max(w, h);
      if (Math.min(w, h) * scale < minSide) scale = minSide / Math.min(w, h);
      return { w: Math.round(w * scale), h: Math.round(h * scale) };
    }
    return { w: A4.w, h: A4.h };
  }

  /* Pure: contain-fit draw rect (points, PDF bottom-left origin) of an
     image inside a page with a uniform margin, centred. */
  function fitRect(imgW, imgH, pageW, pageH, margin) {
    var availW = Math.max(1, pageW - 2 * margin);
    var availH = Math.max(1, pageH - 2 * margin);
    var scale = Math.min(availW / imgW, availH / imgH);
    var w = imgW * scale, h = imgH * scale;
    return { x: (pageW - w) / 2, y: (pageH - h) / 2, w: w, h: h };
  }

  /* Pure: assemble a complete PDF (Uint8Array) from prepared pages:
     [{ jpeg: Uint8Array, imgW, imgH, pageW, pageH, draw:{x,y,w,h} }]. */
  function buildPDF(pages) {
    var enc = new TextEncoder();
    var chunks = [];
    var offset = 0;
    var offsets = {};
    function push(bytes) { chunks.push(bytes); offset += bytes.length; }
    function pushStr(s) { push(enc.encode(s)); }
    function beginObj(id) { offsets[id] = offset; pushStr(id + " 0 obj\n"); }

    pushStr("%PDF-1.4\n");
    push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A])); // binary comment line

    var kids = [];
    for (var i = 0; i < pages.length; i++) kids.push((3 + i * 3) + " 0 R");

    beginObj(1);
    pushStr("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
    beginObj(2);
    pushStr("<< /Type /Pages /Kids [" + kids.join(" ") + "] /Count " + pages.length + " >>\nendobj\n");

    for (var p = 0; p < pages.length; p++) {
      var pg = pages[p];
      var pageId = 3 + p * 3, contentId = pageId + 1, imageId = pageId + 2;
      beginObj(pageId);
      pushStr("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + num(pg.pageW) + " " + num(pg.pageH) +
        "] /Resources << /XObject << /Im0 " + imageId + " 0 R >> >> /Contents " + contentId + " 0 R >>\nendobj\n");
      var content = "q " + num(pg.draw.w) + " 0 0 " + num(pg.draw.h) + " " + num(pg.draw.x) + " " + num(pg.draw.y) +
        " cm /Im0 Do Q";
      beginObj(contentId);
      pushStr("<< /Length " + content.length + " >>\nstream\n" + content + "\nendstream\nendobj\n");
      beginObj(imageId);
      pushStr("<< /Type /XObject /Subtype /Image /Width " + pg.imgW + " /Height " + pg.imgH +
        " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " + pg.jpeg.length +
        " >>\nstream\n");
      push(pg.jpeg);
      pushStr("\nendstream\nendobj\n");
    }

    var total = 2 + pages.length * 3;
    var xrefPos = offset;
    var xref = "xref\n0 " + (total + 1) + "\n0000000000 65535 f \n";
    for (var o = 1; o <= total; o++) {
      var off = String(offsets[o]);
      while (off.length < 10) off = "0" + off;
      xref += off + " 00000 n \n";
    }
    pushStr(xref);
    pushStr("trailer\n<< /Size " + (total + 1) + " /Root 1 0 R >>\nstartxref\n" + xrefPos + "\n%%EOF");

    var out = new Uint8Array(offset);
    var pos = 0;
    for (var c = 0; c < chunks.length; c++) { out.set(chunks[c], pos); pos += chunks[c].length; }
    return out;
  }

  var PdfCore = {
    A4: A4, LETTER: LETTER, PAGE_SIZES: PAGE_SIZES, MARGINS: MARGINS, TARGETS: TARGETS,
    findById: findById, pageSizeFor: pageSizeFor, fitRect: fitRect, buildPDF: buildPDF
  };
  if (typeof module !== "undefined" && module.exports) module.exports = PdfCore;
  if (global) global.TWImageToPdf = PdfCore;

  /* ================================================================
     UI
     ================================================================ */
  if (typeof document === "undefined" || !document.querySelector) return;
  var container = document.querySelector("[data-image-to-pdf-tool]");
  if (!container) return;

  function track(action, params) {
    if (typeof window !== "undefined" && typeof window.gtag === "function") {
      try { window.gtag("event", action, params || {}); } catch (e) {}
    }
  }
  function fmtKB(bytes) { return (bytes / 1024).toFixed(1) + " KB"; }
  function fmtSize(bytes) { return fmtKB(bytes) + " (" + bytes.toLocaleString("en-US") + " bytes)"; }
  function qs(sel) { return container.querySelector(sel); }

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

  var dropzone   = qs("[data-dropzone]");
  var fileInput  = qs("[data-file-input]");
  var listWrap   = qs("[data-items]");
  var sizeChips  = qs("[data-size-chips]");
  var marginChips = qs("[data-margin-chips]");
  var targetChips = qs("[data-target-chips]");
  var customWrap = qs("[data-custom-wrap]");
  var customKb   = qs("[data-custom-kb]");
  var makeBtn    = qs("[data-make-btn]");
  var statusEl   = qs("[data-status]");
  var resultPanel = qs("[data-result]");
  var resultMeta = qs("[data-result-meta]");
  var statPages  = qs("[data-stat-pages]");
  var statSize   = qs("[data-stat-size]");
  var statTarget = qs("[data-stat-target]");
  var bandStatus = qs("[data-band-status]");
  var downloadBtn = qs("[data-download]");
  var resetBtn   = qs("[data-reset]");

  if (!dropzone || !fileInput || !makeBtn || !listWrap) return;

  var items = []; // {file, bitmap, natW, natH, thumbURL}
  var state = {
    sizeId: "a4", marginId: "small",
    targetId: container.getAttribute("data-default-target") || "none",
    resultURL: null, busy: false
  };
  if (!findById(TARGETS, state.targetId)) state.targetId = "none";

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
  buildChips(sizeChips, PAGE_SIZES, "data-size-id", function (id) {
    if (findById(PAGE_SIZES, id)) { state.sizeId = id; paintAll(); }
  });
  buildChips(marginChips, MARGINS, "data-margin-id", function (id) {
    if (findById(MARGINS, id)) { state.marginId = id; paintAll(); }
  });
  buildChips(targetChips, TARGETS, "data-target-id", function (id) {
    if (findById(TARGETS, id)) { state.targetId = id; paintAll(); }
  });
  if (customKb) customKb.addEventListener("input", paintAll);

  function currentTargetBytes() {
    var t = findById(TARGETS, state.targetId);
    var kb = t && t.maxKB != null ? t.maxKB : NaN;
    if (state.targetId === "custom") {
      var v = parseFloat(customKb && customKb.value);
      kb = isFinite(v) ? v : NaN;
    }
    if (state.targetId === "none") return null;
    return isFinite(kb) && kb >= 20 && kb <= 10000 ? Math.round(kb * 1024) : NaN;
  }
  function paintAll() {
    paintChips(sizeChips, "data-size-id", state.sizeId);
    paintChips(marginChips, "data-margin-id", state.marginId);
    paintChips(targetChips, "data-target-id", state.targetId);
    if (customWrap) customWrap.hidden = state.targetId !== "custom";
  }
  paintAll();

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
      name.textContent = (idx + 1) + ". " + it.file.name;
      var meta = document.createElement("span");
      meta.textContent = it.natW + " × " + it.natH + " px • " + fmtSize(it.file.size);
      info.appendChild(name);
      info.appendChild(meta);
      row.appendChild(info);
      var actions = document.createElement("div");
      actions.className = "pdf-item-actions";
      [["↑", "up", "Move up"], ["↓", "down", "Move down"], ["✕", "remove", "Remove"]].forEach(function (spec) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "chip pdf-item-btn";
        b.textContent = spec[0];
        b.title = spec[2];
        b.setAttribute("aria-label", spec[2] + " " + it.file.name);
        b.setAttribute("data-act", spec[1]);
        b.setAttribute("data-idx", String(idx));
        actions.appendChild(b);
      });
      row.appendChild(actions);
      listWrap.appendChild(row);
    });
    listWrap.hidden = items.length === 0;
  }
  listWrap.addEventListener("click", function (e) {
    var btn = e.target.closest ? e.target.closest("[data-act]") : null;
    if (!btn) return;
    var idx = parseInt(btn.getAttribute("data-idx"), 10);
    var act = btn.getAttribute("data-act");
    if (act === "remove") {
      var gone = items.splice(idx, 1)[0];
      if (gone && gone.thumbURL) URL.revokeObjectURL(gone.thumbURL);
    } else if (act === "up" && idx > 0) {
      var t1 = items[idx - 1]; items[idx - 1] = items[idx]; items[idx] = t1;
    } else if (act === "down" && idx < items.length - 1) {
      var t2 = items[idx + 1]; items[idx + 1] = items[idx]; items[idx] = t2;
    }
    renderList();
  });

  function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    files.forEach(function (file) {
      if (file.type && file.type.indexOf("image/") !== 0) return;
      if (items.length >= 20) { setStatus("Up to 20 images per PDF."); return; }
      loadSource(file).then(function (loaded) {
        var d = sourceDims(loaded.source);
        items.push({
          file: file, bitmap: loaded.source, natW: d.w, natH: d.h,
          thumbURL: loaded.url || URL.createObjectURL(file)
        });
        renderList();
        setStatus("");
        track("tool_file_selected", { tool: "image_to_pdf", file_type: file.type || "" });
      }).catch(function () {
        setStatus("One image could not be read (" + file.name + "). Try a JPG or PNG instead.");
      });
    });
  }

  function encodeItem(it, maxDim, quality) {
    var scale = Math.min(1, maxDim / Math.max(it.natW, it.natH));
    var w = Math.max(1, Math.round(it.natW * scale));
    var h = Math.max(1, Math.round(it.natH * scale));
    var canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(it.bitmap, 0, 0, w, h);
    return canvasToBlob(canvas, quality).then(function (blob) {
      return blob.arrayBuffer().then(function (buf) {
        return { jpeg: new Uint8Array(buf), imgW: w, imgH: h };
      });
    });
  }

  function assemble(encoded) {
    var margin = (findById(MARGINS, state.marginId) || MARGINS[1]).pt;
    var pages = encoded.map(function (e) {
      var ps = pageSizeFor(state.sizeId, e.imgW, e.imgH);
      var draw = fitRect(e.imgW, e.imgH, ps.w, ps.h, state.sizeId === "fit" ? 0 : margin);
      return { jpeg: e.jpeg, imgW: e.imgW, imgH: e.imgH, pageW: ps.w, pageH: ps.h, draw: draw };
    });
    return buildPDF(pages);
  }

  function makePDF() {
    if (state.busy) return;
    if (!items.length) { setStatus("Add at least one image first."); return; }
    var targetBytes = currentTargetBytes();
    if (targetBytes !== null && isNaN(targetBytes)) {
      setStatus("Enter a custom target between 20 and 10,000 KB."); return;
    }
    state.busy = true;
    makeBtn.disabled = true;
    var label = makeBtn.textContent;
    makeBtn.textContent = "Working…";
    resetResult();

    function encodeAll(maxDim, q) {
      setStatus("Working in your browser — building your PDF (" + items.length +
        (items.length === 1 ? " page" : " pages") + ", images up to " + maxDim +
        " px, quality " + Math.round(q * 100) + "%)…");
      return Promise.all(items.map(function (it) { return encodeItem(it, maxDim, q); }))
        .then(function (encoded) { return assemble(encoded); });
    }

    var build;
    if (!targetBytes) {
      build = encodeAll(2000, 0.9);
    } else {
      // Fit search: try the largest image dimensions first, searching
      // quality within them; if even the lowest quality is too big,
      // step the dimensions down and search again. (Quality alone
      // cannot tame very detailed images — dimensions have to move
      // too, exactly as in the image compressor.)
      build = (function () {
        var dims = [1600, 1200, 900, 700, 550, 420];
        var smallest = null;
        function tryDim(di) {
          if (di >= dims.length) return Promise.resolve(smallest);
          var lo = 0.35, hi = 0.92, best = null;
          function step(n, first) {
            var q = first ? hi : (lo + hi) / 2;
            return encodeAll(dims[di], q).then(function (pdf) {
              if (!smallest || pdf.length < smallest.length) smallest = pdf;
              if (pdf.length <= targetBytes) { best = pdf; lo = q; } else { hi = q; }
              if (first && best) return best; // top quality fits at this size
              if (n <= 1) return best;
              return step(n - 1, false);
            });
          }
          return step(5, true).then(function (found) {
            return found || tryDim(di + 1);
          });
        }
        return tryDim(0);
      })();
    }

    build.then(function (pdf) {
      state.busy = false;
      makeBtn.disabled = false;
      makeBtn.textContent = label;
      var blob = new Blob([pdf], { type: "application/pdf" });
      showResult(blob, targetBytes);
      track("tool_resize_success", {
        tool: "image_to_pdf", pages: items.length,
        output_kb: Math.round(blob.size / 1024),
        target_kb: targetBytes ? Math.round(targetBytes / 1024) : 0
      });
    }).catch(function () {
      state.busy = false;
      makeBtn.disabled = false;
      makeBtn.textContent = label;
      setStatus("Something went wrong while building your PDF. Please try again with fewer or smaller images.");
    });
  }

  function showResult(blob, targetBytes) {
    if (state.resultURL) URL.revokeObjectURL(state.resultURL);
    state.resultURL = URL.createObjectURL(blob);
    if (resultMeta) {
      resultMeta.textContent = "Your PDF — " + items.length + (items.length === 1 ? " page" : " pages") +
        " • " + fmtSize(blob.size);
    }
    if (statPages) statPages.textContent = String(items.length);
    if (statSize) statSize.textContent = fmtSize(blob.size);
    if (statTarget) statTarget.textContent = targetBytes ? "Under " + Math.round(targetBytes / 1024) + " KB" : "Best quality (no limit)";
    if (bandStatus) {
      bandStatus.classList.remove("is-ok", "is-warn");
      if (!targetBytes) {
        bandStatus.classList.add("is-ok");
        bandStatus.textContent = "✓ Your PDF is ready — best quality, no size limit applied.";
      } else if (blob.size <= targetBytes) {
        bandStatus.classList.add("is-ok");
        bandStatus.textContent = "✓ Under the target — " + fmtKB(blob.size) + " is within your " +
          Math.round(targetBytes / 1024) + " KB limit.";
      } else {
        bandStatus.classList.add("is-warn");
        bandStatus.textContent = "⚠ The smallest PDF these settings can make is " + fmtKB(blob.size) +
          " — still above your " + Math.round(targetBytes / 1024) + " KB target. Try fewer images, or remove large ones.";
      }
    }
    if (downloadBtn) {
      downloadBtn.href = state.resultURL;
      downloadBtn.setAttribute("download", "images.pdf");
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
    items.forEach(function (it) { if (it.thumbURL) URL.revokeObjectURL(it.thumbURL); });
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
    if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length) {
      addFiles(e.clipboardData.files);
    }
  });
  makeBtn.addEventListener("click", makePDF);
  if (downloadBtn) {
    downloadBtn.addEventListener("click", function () {
      track("tool_download", { tool: "image_to_pdf" });
    });
  }
  if (resetBtn) resetBtn.addEventListener("click", resetAll);
})(typeof window !== "undefined" ? window : null);

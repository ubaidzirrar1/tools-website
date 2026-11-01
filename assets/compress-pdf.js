/* Tools Website — Compress PDF to KB
   Works on any page that contains an element with [data-compress-pdf-tool].
   The page may preset the target via data-default-target (KB) on the
   container (e.g. the Compress PDF to 200KB page).

   How it works, honestly: the PDF is read in the browser with PDF.js
   (loaded once from a public CDN — the FILE itself is never uploaded).
   Every page is rendered once at 200 DPI, then re-built as a new PDF
   with the existing dependency-free PDF writer (window.TWImageToPdf),
   searching dimension/quality steps until the whole file fits the
   chosen KB target at the highest quality that fits. The output keeps
   every page's exact size and look, but pages become images: text is
   no longer selectable and links/form fields do not survive. That
   trade-off is stated on the page and in the result panel — for portal
   document uploads (the main use) it is exactly what is wanted.
   A PDF already under the target is returned unchanged. */
(function (global) {
  "use strict";

  var RENDER_DPI = 200;
  var RENDER_MAX_DIM = 2500;   // px, long edge of a rendered page
  var MAX_PAGES = 50;
  var MAX_INPUT_BYTES = 50 * 1024 * 1024;
  var DIM_LADDER = [2000, 1600, 1200, 900, 700, 550, 420];
  var PDFJS_VERSION = "3.11.174";
  var PDFJS_WORKER = "https://cdn.jsdelivr.net/npm/pdfjs-dist@" + PDFJS_VERSION + "/build/pdf.worker.min.js";

  var TARGETS = [
    { id: "100",  label: "Under 100 KB",  maxKB: 100 },
    { id: "200",  label: "Under 200 KB",  maxKB: 200 },
    { id: "300",  label: "Under 300 KB",  maxKB: 300 },
    { id: "500",  label: "Under 500 KB",  maxKB: 500 },
    { id: "1000", label: "Under 1 MB",    maxKB: 1000 },
    { id: "custom", label: "Custom",      maxKB: null }
  ];

  function findById(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  /* Pure: dimensions of a page image capped at maxDim on the long edge. */
  function scaledDims(w, h, maxDim) {
    var m = Math.max(w, h);
    if (!m || m <= maxDim) return { w: w, h: h, scaled: false };
    var s = maxDim / m;
    return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)), scaled: true };
  }

  /* Pure: the PDF.js render scale for a page of pageWpt × pageHpt
     points — RENDER_DPI, capped so the long edge stays within
     RENDER_MAX_DIM px. */
  function renderScale(pageWpt, pageHpt) {
    var s = RENDER_DPI / 72;
    var longPt = Math.max(pageWpt, pageHpt);
    if (longPt && longPt * s > RENDER_MAX_DIM) s = RENDER_MAX_DIM / longPt;
    return s;
  }

  /* Pure: resolve a target selection to bytes. Returns the byte cap,
     or NaN when the selection is invalid (custom out of range). */
  function targetBytesFor(targetId, customVal) {
    var t = findById(TARGETS, targetId);
    if (!t) return NaN;
    var kb = t.maxKB;
    if (targetId === "custom") {
      var v = parseFloat(customVal);
      kb = isFinite(v) ? v : NaN;
    }
    return isFinite(kb) && kb >= 20 && kb <= 10000 ? Math.round(kb * 1024) : NaN;
  }

  /* Pure: "degree.pdf" → "degree-compressed.pdf" (falls back safely). */
  function outputName(name) {
    var base = String(name || "document").replace(/\.pdf$/i, "");
    if (!base) base = "document";
    return base + "-compressed.pdf";
  }

  /* Pure: percentage saved, one decimal, never negative. */
  function savedPct(origBytes, outBytes) {
    if (!origBytes || origBytes <= 0) return 0;
    var p = (1 - outBytes / origBytes) * 100;
    return p < 0 ? 0 : Math.round(p * 10) / 10;
  }

  var Core = {
    TARGETS: TARGETS, DIM_LADDER: DIM_LADDER,
    RENDER_DPI: RENDER_DPI, RENDER_MAX_DIM: RENDER_MAX_DIM,
    MAX_PAGES: MAX_PAGES, MAX_INPUT_BYTES: MAX_INPUT_BYTES,
    findById: findById, scaledDims: scaledDims, renderScale: renderScale,
    targetBytesFor: targetBytesFor, outputName: outputName, savedPct: savedPct
  };
  if (typeof module !== "undefined" && module.exports) module.exports = Core;
  if (global) global.TWCompressPdf = Core;

  /* ================================================================
     UI
     ================================================================ */
  if (typeof document === "undefined" || !document.querySelector) return;
  var container = document.querySelector("[data-compress-pdf-tool]");
  if (!container) return;
  var PdfWriter = global && global.TWImageToPdf;
  if (!PdfWriter || !PdfWriter.buildPDF) return;
  var pdfjsLib = global && global.pdfjsLib;
  if (pdfjsLib && pdfjsLib.GlobalWorkerOptions) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  }

  function track(action, params) {
    if (typeof window !== "undefined" && typeof window.gtag === "function") {
      try { window.gtag("event", action, params || {}); } catch (e) {}
    }
  }
  function fmtKB(bytes) { return (bytes / 1024).toFixed(1) + " KB"; }
  function fmtSize(bytes) { return fmtKB(bytes) + " (" + bytes.toLocaleString("en-US") + " bytes)"; }
  function qs(sel) { return container.querySelector(sel); }

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

  var dropzone    = qs("[data-dropzone]");
  var fileInput   = qs("[data-file-input]");
  var fileInfo    = qs("[data-file-info]");
  var targetChips = qs("[data-target-chips]");
  var customWrap  = qs("[data-custom-wrap]");
  var customKb    = qs("[data-custom-kb]");
  var makeBtn     = qs("[data-make-btn]");
  var statusEl    = qs("[data-status]");
  var resultPanel = qs("[data-result]");
  var resultMeta  = qs("[data-result-meta]");
  var statPages   = qs("[data-stat-pages]");
  var statOrig    = qs("[data-stat-orig]");
  var statSize    = qs("[data-stat-size]");
  var statSaved   = qs("[data-stat-saved]");
  var statTarget  = qs("[data-stat-target]");
  var bandStatus  = qs("[data-band-status]");
  var downloadBtn = qs("[data-download]");
  var resetBtn    = qs("[data-reset]");

  if (!dropzone || !fileInput || !makeBtn) return;

  var state = {
    file: null, doc: null, pageSizes: [], // [{w,h} in points]
    rendered: null,                        // [{canvas, pageW, pageH}]
    targetId: container.getAttribute("data-default-target") || "200",
    resultURL: null, busy: false
  };
  if (!findById(TARGETS, state.targetId)) state.targetId = "200";

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
  buildChips(targetChips, TARGETS, "data-target-id", function (id) {
    if (findById(TARGETS, id)) { state.targetId = id; paintAll(); }
  });
  if (customKb) customKb.addEventListener("input", paintAll);
  function paintAll() {
    paintChips(targetChips, "data-target-id", state.targetId);
    if (customWrap) customWrap.hidden = state.targetId !== "custom";
  }
  paintAll();

  function clearDoc() {
    if (state.doc) { try { state.doc.destroy(); } catch (e) {} }
    state.doc = null;
    state.pageSizes = [];
    state.rendered = null;
  }

  function loadFile(file) {
    if (state.busy) return;
    var isPdf = (file.type && file.type === "application/pdf") || /\.pdf$/i.test(file.name || "");
    if (!isPdf) { setStatus("That file is not a PDF. Choose a .pdf file."); return; }
    if (file.size > MAX_INPUT_BYTES) {
      setStatus("That PDF is " + fmtKB(file.size) + " — the limit here is 50 MB. Try splitting it first."); return;
    }
    if (!pdfjsLib) {
      setStatus("The PDF reader could not be loaded (it downloads once from a CDN). Check your connection and reload the page."); return;
    }
    resetResult();
    clearDoc();
    state.file = file;
    setStatus("Reading your PDF in your browser…");
    if (fileInfo) fileInfo.hidden = true;
    file.arrayBuffer().then(function (buf) {
      return pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    }).then(function (doc) {
      if (doc.numPages > MAX_PAGES) {
        try { doc.destroy(); } catch (e) {}
        state.file = null;
        setStatus("That PDF has " + doc.numPages + " pages — this tool handles up to " + MAX_PAGES +
          " pages at a time. Split it and compress the parts.");
        return null;
      }
      state.doc = doc;
      var chain = Promise.resolve();
      var sizes = [];
      for (var i = 1; i <= doc.numPages; i++) {
        (function (n) {
          chain = chain.then(function () {
            return doc.getPage(n).then(function (page) {
              var vp = page.getViewport({ scale: 1 });
              sizes.push({ w: vp.width, h: vp.height });
              try { page.cleanup(); } catch (e) {}
            });
          });
        })(i);
      }
      return chain.then(function () {
        state.pageSizes = sizes;
        if (fileInfo) {
          fileInfo.textContent = "📄 " + file.name + " — " + doc.numPages +
            (doc.numPages === 1 ? " page" : " pages") + " • " + fmtSize(file.size);
          fileInfo.hidden = false;
        }
        setStatus("");
        track("tool_file_selected", { tool: "compress_pdf", pages: doc.numPages });
      });
    }).catch(function (err) {
      state.file = null;
      clearDoc();
      if (err && err.name === "PasswordException") {
        setStatus("That PDF is password-protected. Remove the password first, then compress it here.");
      } else {
        setStatus("That file could not be read as a PDF. It may be damaged — try opening it in a PDF viewer first.");
      }
    });
  }

  function renderAllPages() {
    if (state.rendered) return Promise.resolve(state.rendered);
    var doc = state.doc;
    var out = [];
    var chain = Promise.resolve();
    for (var i = 1; i <= doc.numPages; i++) {
      (function (n) {
        chain = chain.then(function () {
          setStatus("Reading page " + n + " of " + doc.numPages + " at 200 DPI…");
          return doc.getPage(n).then(function (page) {
            var size = state.pageSizes[n - 1];
            var scale = renderScale(size.w, size.h);
            var vp = page.getViewport({ scale: scale });
            var canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.floor(vp.width));
            canvas.height = Math.max(1, Math.floor(vp.height));
            var ctx = canvas.getContext("2d");
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
              out.push({ canvas: canvas, pageW: size.w, pageH: size.h });
              try { page.cleanup(); } catch (e) {}
            });
          });
        });
      })(i);
    }
    return chain.then(function () {
      state.rendered = out;
      return out;
    });
  }

  function encodeAll(rendered, maxDim, quality) {
    return Promise.all(rendered.map(function (rp) {
      var d = scaledDims(rp.canvas.width, rp.canvas.height, maxDim);
      var canvas = document.createElement("canvas");
      canvas.width = d.w;
      canvas.height = d.h;
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, d.w, d.h);
      ctx.drawImage(rp.canvas, 0, 0, d.w, d.h);
      return canvasToBlob(canvas, quality).then(function (blob) {
        return blob.arrayBuffer().then(function (buf) {
          return {
            jpeg: new Uint8Array(buf), imgW: d.w, imgH: d.h,
            pageW: rp.pageW, pageH: rp.pageH,
            draw: { x: 0, y: 0, w: rp.pageW, h: rp.pageH }
          };
        });
      });
    })).then(function (pages) {
      return PdfWriter.buildPDF(pages);
    });
  }

  function compress() {
    if (state.busy) return;
    if (!state.file || !state.doc) { setStatus("Choose a PDF first."); return; }
    var targetBytes = targetBytesFor(state.targetId, customKb && customKb.value);
    if (isNaN(targetBytes)) { setStatus("Enter a custom target between 20 and 10,000 KB."); return; }
    state.busy = true;
    makeBtn.disabled = true;
    var label = makeBtn.textContent;
    makeBtn.textContent = "Working…";
    resetResult();

    function finish(pdfBytes, unchanged) {
      state.busy = false;
      makeBtn.disabled = false;
      makeBtn.textContent = label;
      var blob = unchanged ? state.file.slice(0, state.file.size, "application/pdf")
                           : new Blob([pdfBytes], { type: "application/pdf" });
      showResult(blob, targetBytes, unchanged);
      track("tool_resize_success", {
        tool: "compress_pdf", pages: state.pageSizes.length,
        output_kb: Math.round(blob.size / 1024),
        target_kb: Math.round(targetBytes / 1024)
      });
    }

    // Already under the target: hand the original back untouched —
    // recompressing would only cost quality for nothing.
    if (state.file.size <= targetBytes) {
      finish(null, true);
      return;
    }

    renderAllPages().then(function (rendered) {
      var smallest = null;
      function tryDim(di) {
        if (di >= DIM_LADDER.length) return Promise.resolve(smallest);
        var lo = 0.35, hi = 0.92, best = null;
        function step(n, first) {
          var q = first ? hi : (lo + hi) / 2;
          setStatus("Fitting your PDF under " + Math.round(targetBytes / 1024) +
            " KB — trying pages up to " + DIM_LADDER[di] + " px, quality " + Math.round(q * 100) + "%…");
          return encodeAll(rendered, DIM_LADDER[di], q).then(function (pdf) {
            if (!smallest || pdf.length < smallest.length) smallest = pdf;
            if (pdf.length <= targetBytes) { best = pdf; lo = q; } else { hi = q; }
            if (first && best) return best;
            if (n <= 1) return best;
            return step(n - 1, false);
          });
        }
        return step(5, true).then(function (found) {
          return found || tryDim(di + 1);
        });
      }
      return tryDim(0);
    }).then(function (pdf) {
      finish(pdf, false);
    }).catch(function () {
      state.busy = false;
      makeBtn.disabled = false;
      makeBtn.textContent = label;
      setStatus("Something went wrong while compressing. Please try again with a smaller or simpler PDF.");
    });
  }

  function showResult(blob, targetBytes, unchanged) {
    if (state.resultURL) URL.revokeObjectURL(state.resultURL);
    state.resultURL = URL.createObjectURL(blob);
    var pages = state.pageSizes.length;
    if (statPages) statPages.textContent = String(pages);
    if (statOrig) statOrig.textContent = fmtSize(state.file.size);
    if (statSize) statSize.textContent = fmtSize(blob.size);
    if (statSaved) statSaved.textContent = unchanged ? "0% (unchanged)" : savedPct(state.file.size, blob.size) + "% smaller";
    if (statTarget) statTarget.textContent = "Under " + Math.round(targetBytes / 1024) + " KB";
    if (bandStatus) {
      bandStatus.classList.remove("is-ok", "is-warn");
      if (unchanged) {
        bandStatus.classList.add("is-ok");
        bandStatus.textContent = "✓ Your PDF is already under " + Math.round(targetBytes / 1024) +
          " KB (" + fmtKB(state.file.size) + ") — returned unchanged at full quality. No compression needed.";
      } else if (blob.size <= targetBytes) {
        bandStatus.classList.add("is-ok");
        bandStatus.textContent = "✓ Under the target — " + fmtKB(blob.size) + " is within your " +
          Math.round(targetBytes / 1024) + " KB limit (was " + fmtKB(state.file.size) + "). Pages are now images: text is no longer selectable, which is normal for portal uploads.";
      } else {
        bandStatus.classList.add("is-warn");
        bandStatus.textContent = "⚠ The smallest this PDF can be made here is " + fmtKB(blob.size) +
          " — still above your " + Math.round(targetBytes / 1024) + " KB target. Splitting it into two PDFs usually fixes this.";
      }
    }
    if (resultMeta) {
      resultMeta.textContent = "Your compressed PDF — " + pages + (pages === 1 ? " page" : " pages") +
        " • " + fmtSize(blob.size);
    }
    if (downloadBtn) {
      downloadBtn.href = state.resultURL;
      downloadBtn.setAttribute("download", outputName(state.file.name));
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
    clearDoc();
    state.file = null;
    if (fileInfo) { fileInfo.hidden = true; fileInfo.textContent = ""; }
    fileInput.value = "";
    setStatus("");
    dropzone.focus();
  }

  dropzone.addEventListener("click", function () { fileInput.click(); });
  dropzone.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener("change", function () {
    if (fileInput.files && fileInput.files.length) loadFile(fileInput.files[0]);
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
    if (files && files.length) loadFile(files[0]);
  });
  document.addEventListener("paste", function (e) {
    if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length) {
      loadFile(e.clipboardData.files[0]);
    }
  });
  makeBtn.addEventListener("click", compress);
  if (downloadBtn) {
    downloadBtn.addEventListener("click", function () {
      track("tool_download", { tool: "compress_pdf" });
    });
  }
  if (resetBtn) resetBtn.addEventListener("click", resetAll);
})(typeof window !== "undefined" ? window : null);

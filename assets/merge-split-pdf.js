/* Tools Website — Merge & Split PDF
   Works on any page that contains an element with [data-merge-split-tool].
   The page has two modes (tabs): Merge PDF and Split PDF.

   How it works, honestly: everything runs in the browser with pdf-lib
   (loaded once, lazily, from a public CDN — the FILES themselves are
   never uploaded). Pages are copied from the source PDFs into the new
   PDF exactly as they are (pdf-lib copyPages), so merging and splitting
   are lossless: text stays selectable, images keep their quality, and
   links and form fields on the copied pages survive. That is the
   opposite trade-off from Compress PDF, which rebuilds pages as images
   to hit an exact KB size. */
(function (global) {
  "use strict";

  var MAX_MERGE_FILES = 20;
  var MAX_FILE_BYTES = 50 * 1024 * 1024;
  var PDFLIB_VERSION = "1.17.1";
  var PDFLIB_URL = "https://cdn.jsdelivr.net/npm/pdf-lib@" + PDFLIB_VERSION + "/dist/pdf-lib.min.js";
  var MERGED_NAME = "merged.pdf";
  var EXTRACT_NAME = "split-pages.pdf";

  /* Pure: parse a page-range string like "1-3, 5" for a document of
     totalPages pages. Returns { ok: true, pages: [...] } with 1-based
     page numbers sorted ascending, duplicates removed — or
     { ok: false, error: "..." } with a plain-language reason. */
  function parsePageRanges(input, totalPages) {
    if (typeof input !== "string" || !input.trim()) {
      return { ok: false, error: "Enter the pages to extract — for example 1-3, 5." };
    }
    if (!totalPages || totalPages < 1) {
      return { ok: false, error: "Add a PDF first." };
    }
    var seen = {};
    var pages = [];
    var tokens = input.split(",");
    for (var i = 0; i < tokens.length; i++) {
      var tok = tokens[i].trim();
      if (!tok) {
        return { ok: false, error: "That page list has an empty entry — check the commas." };
      }
      var range = /^(\d+)\s*-\s*(\d+)$/.exec(tok);
      var single = /^(\d+)$/.exec(tok);
      var from, to;
      if (range) {
        from = parseInt(range[1], 10);
        to = parseInt(range[2], 10);
      } else if (single) {
        from = to = parseInt(single[1], 10);
      } else {
        return { ok: false, error: "“" + tok + "” is not a page number or a range like 2-4. Use numbers, commas and dashes only." };
      }
      if (from < 1 || to < 1) {
        return { ok: false, error: "Page numbers start at 1 — there is no page 0." };
      }
      if (from > to) {
        return { ok: false, error: "The range " + from + "-" + to + " runs backwards — write the smaller page number first." };
      }
      if (to > totalPages) {
        return { ok: false, error: "This PDF has only " + totalPages + (totalPages === 1 ? " page" : " pages") +
          " — page " + to + " does not exist." };
      }
      for (var p = from; p <= to; p++) {
        if (!seen[p]) { seen[p] = true; pages.push(p); }
      }
    }
    pages.sort(function (a, b) { return a - b; });
    if (!pages.length) {
      return { ok: false, error: "No pages matched that list." };
    }
    return { ok: true, pages: pages };
  }

  /* Pure: download name for one page of a split PDF. */
  function pageFileName(page) { return "page-" + page + ".pdf"; }

  /* Pure: does this file look like a PDF (by type or extension)? */
  function looksLikePdf(name, type) {
    return type === "application/pdf" || /\.pdf$/i.test(name || "");
  }

  /* pdf-lib work, shared by the UI and the Node tests. Each function
     resolves to the finished PDF as a Uint8Array. Pages are copied
     losslessly with copyPages — never re-rendered. */
  function mergeDocuments(PDFLib, srcDocs) {
    return PDFLib.PDFDocument.create().then(function (out) {
      var chain = Promise.resolve();
      srcDocs.forEach(function (src) {
        chain = chain.then(function () {
          return out.copyPages(src, src.getPageIndices()).then(function (copied) {
            copied.forEach(function (page) { out.addPage(page); });
          });
        });
      });
      return chain.then(function () { return out.save(); });
    });
  }

  function extractPages(PDFLib, srcDoc, pages) {
    return PDFLib.PDFDocument.create().then(function (out) {
      var indices = pages.map(function (p) { return p - 1; });
      return out.copyPages(srcDoc, indices).then(function (copied) {
        copied.forEach(function (page) { out.addPage(page); });
        return out.save();
      });
    });
  }

  function splitPage(PDFLib, srcDoc, page) {
    return extractPages(PDFLib, srcDoc, [page]);
  }

  var Core = {
    MAX_MERGE_FILES: MAX_MERGE_FILES, MAX_FILE_BYTES: MAX_FILE_BYTES,
    PDFLIB_VERSION: PDFLIB_VERSION, PDFLIB_URL: PDFLIB_URL,
    MERGED_NAME: MERGED_NAME, EXTRACT_NAME: EXTRACT_NAME,
    parsePageRanges: parsePageRanges, pageFileName: pageFileName,
    looksLikePdf: looksLikePdf,
    mergeDocuments: mergeDocuments, extractPages: extractPages, splitPage: splitPage
  };
  if (typeof module !== "undefined" && module.exports) module.exports = Core;
  if (global) global.TWMergeSplitPdf = Core;

  /* ================================================================
     UI
     ================================================================ */
  if (typeof document === "undefined" || !document.querySelector) return;
  var container = document.querySelector("[data-merge-split-tool]");
  if (!container) return;

  function track(action, params) {
    if (typeof window !== "undefined" && typeof window.gtag === "function") {
      try { window.gtag("event", action, params || {}); } catch (e) {}
    }
  }
  function fmtKB(bytes) { return (bytes / 1024).toFixed(1) + " KB"; }
  function fmtSize(bytes) { return fmtKB(bytes) + " (" + bytes.toLocaleString("en-US") + " bytes)"; }
  function qs(sel, root) { return (root || container).querySelector(sel); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || container).querySelectorAll(sel)); }

  /* pdf-lib is fetched once, the first time a file is added. */
  var pdfLibPromise = null;
  function loadPdfLib() {
    if (global.PDFLib && global.PDFLib.PDFDocument) return Promise.resolve(global.PDFLib);
    if (pdfLibPromise) return pdfLibPromise;
    pdfLibPromise = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = PDFLIB_URL;
      s.async = true;
      s.onload = function () {
        if (global.PDFLib && global.PDFLib.PDFDocument) resolve(global.PDFLib);
        else { pdfLibPromise = null; reject(new Error("pdflib-missing")); }
      };
      s.onerror = function () { pdfLibPromise = null; reject(new Error("pdflib-load")); };
      document.head.appendChild(s);
    });
    return pdfLibPromise;
  }

  function isEncryptedError(err) {
    if (!err) return false;
    if (err.name && /encrypt/i.test(err.name)) return true;
    return /encrypt/i.test(String(err.message || err));
  }

  /* Read + parse one user file. Resolves to
     { file, doc, pageCount } or rejects with a plain-language Error. */
  function readPdf(file) {
    if (!looksLikePdf(file.name, file.type)) {
      return Promise.reject(new Error("“" + file.name + "” is not a PDF. Choose .pdf files only."));
    }
    if (file.size > MAX_FILE_BYTES) {
      return Promise.reject(new Error("“" + file.name + "” is " + fmtKB(file.size) + " — the limit here is 50 MB per file."));
    }
    return loadPdfLib().then(function (PDFLib) {
      return file.arrayBuffer().then(function (buf) {
        return PDFLib.PDFDocument.load(buf).then(function (doc) {
          return { file: file, doc: doc, pageCount: doc.getPageCount() };
        });
      });
    }).catch(function (err) {
      var msg = err && err.message ? err.message : "";
      if (msg.indexOf("is not a PDF") !== -1 || msg.indexOf("the limit here") !== -1) throw err;
      if (msg === "pdflib-load" || msg === "pdflib-missing") {
        throw new Error("The PDF engine could not be loaded (it downloads once from a CDN). Check your connection and try again.");
      }
      if (isEncryptedError(err)) {
        throw new Error("“" + file.name + "” is password-protected. Remove the password first, then add it here.");
      }
      throw new Error("“" + file.name + "” could not be read as a PDF. It may be damaged — try opening it in a PDF viewer first.");
    });
  }

  function downloadBytes(bytes, name) {
    var blob = new Blob([bytes], { type: "application/pdf" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.setAttribute("download", name);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  /* ---------- Mode tabs ---------- */
  var mode = "merge";
  var tabBtns = qsa("[data-mode-tab]");
  var panels = { merge: qs('[data-panel="merge"]'), split: qs('[data-panel="split"]') };
  function setMode(next) {
    mode = next;
    tabBtns.forEach(function (b) {
      var active = b.getAttribute("data-mode-tab") === next;
      b.classList.toggle("is-active", active);
      b.setAttribute("aria-selected", active ? "true" : "false");
    });
    if (panels.merge) panels.merge.hidden = next !== "merge";
    if (panels.split) panels.split.hidden = next !== "split";
  }
  tabBtns.forEach(function (b) {
    b.addEventListener("click", function () { setMode(b.getAttribute("data-mode-tab")); });
  });

  function wireDropzone(panel, input, onFiles) {
    if (!panel || !input) return;
    panel.addEventListener("click", function () { input.click(); });
    panel.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); }
    });
    input.addEventListener("change", function () {
      if (input.files && input.files.length) onFiles(input.files);
      input.value = "";
    });
    ["dragenter", "dragover"].forEach(function (evt) {
      panel.addEventListener(evt, function (e) { e.preventDefault(); panel.classList.add("is-dragover"); });
    });
    ["dragleave", "drop"].forEach(function (evt) {
      panel.addEventListener(evt, function (e) { e.preventDefault(); panel.classList.remove("is-dragover"); });
    });
    panel.addEventListener("drop", function (e) {
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) onFiles(files);
    });
  }

  /* ================================================================
     MERGE mode
     ================================================================ */
  var mergePanel = panels.merge;
  var mDropzone = qs("[data-merge-dropzone]", mergePanel);
  var mInput = qs("[data-merge-input]", mergePanel);
  var mList = qs("[data-merge-list]", mergePanel);
  var mSummary = qs("[data-merge-summary]", mergePanel);
  var mBtn = qs("[data-merge-btn]", mergePanel);
  var mStatus = qs("[data-merge-status]", mergePanel);
  var mResult = qs("[data-merge-result]", mergePanel);
  var mStatFiles = qs("[data-stat-files]", mergePanel);
  var mStatPages = qs("[data-stat-pages]", mergePanel);
  var mStatSize = qs("[data-stat-size]", mergePanel);
  var mMeta = qs("[data-merge-meta]", mergePanel);
  var mDownload = qs("[data-merge-download]", mergePanel);
  var mReset = qs("[data-merge-reset]", mergePanel);

  var mergeFiles = [];   // [{ file, doc, pageCount }]
  var mergeBusy = false;
  var mergeResultURL = null;

  function setMergeStatus(msg) { if (mStatus) mStatus.textContent = msg || ""; }

  function renderMergeList() {
    if (!mList) return;
    mList.innerHTML = "";
    mergeFiles.forEach(function (entry, idx) {
      var row = document.createElement("div");
      row.className = "pdf-item";
      var thumb = document.createElement("div");
      thumb.className = "pdf-item-thumb ms-thumb";
      thumb.setAttribute("aria-hidden", "true");
      thumb.textContent = "📄";
      row.appendChild(thumb);
      var info = document.createElement("div");
      info.className = "pdf-item-info";
      var name = document.createElement("strong");
      name.textContent = (idx + 1) + ". " + entry.file.name;
      var meta = document.createElement("span");
      meta.textContent = entry.pageCount + (entry.pageCount === 1 ? " page" : " pages") + " • " + fmtSize(entry.file.size);
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
        b.setAttribute("aria-label", spec[2] + " " + entry.file.name);
        b.setAttribute("data-act", spec[1]);
        b.setAttribute("data-idx", String(idx));
        actions.appendChild(b);
      });
      row.appendChild(actions);
      mList.appendChild(row);
    });
    mList.hidden = mergeFiles.length === 0;
    var totalPages = mergeFiles.reduce(function (n, e) { return n + e.pageCount; }, 0);
    if (mSummary) {
      mSummary.textContent = mergeFiles.length === 0 ? "" :
        mergeFiles.length + (mergeFiles.length === 1 ? " file" : " files") + " • " + totalPages +
        (totalPages === 1 ? " page" : " pages") + " in total — the merged PDF follows this order.";
    }
    if (mBtn) mBtn.disabled = mergeFiles.length < 2 || mergeBusy;
  }
  if (mList) {
    mList.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest("[data-act]") : null;
      if (!btn) return;
      var idx = parseInt(btn.getAttribute("data-idx"), 10);
      var act = btn.getAttribute("data-act");
      if (act === "remove") {
        mergeFiles.splice(idx, 1);
      } else if (act === "up" && idx > 0) {
        var t1 = mergeFiles[idx - 1]; mergeFiles[idx - 1] = mergeFiles[idx]; mergeFiles[idx] = t1;
      } else if (act === "down" && idx < mergeFiles.length - 1) {
        var t2 = mergeFiles[idx + 1]; mergeFiles[idx + 1] = mergeFiles[idx]; mergeFiles[idx] = t2;
      }
      hideMergeResult();
      renderMergeList();
    });
  }

  function addMergeFiles(fileList) {
    if (mergeBusy) return;
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    setMergeStatus("Reading your PDFs in your browser…");
    var chain = Promise.resolve();
    var errors = [];
    files.forEach(function (file) {
      chain = chain.then(function () {
        if (mergeFiles.length >= MAX_MERGE_FILES) {
          errors.push("You can merge up to " + MAX_MERGE_FILES + " files at a time — “" + file.name + "” was not added.");
          return null;
        }
        return readPdf(file).then(function (entry) {
          mergeFiles.push(entry);
          track("tool_file_selected", { tool: "merge_pdf", pages: entry.pageCount });
        }).catch(function (err) {
          errors.push(err.message);
        });
      });
    });
    chain.then(function () {
      hideMergeResult();
      renderMergeList();
      setMergeStatus(errors.length ? errors[0] : "");
    });
  }

  function hideMergeResult() {
    if (mergeResultURL) { URL.revokeObjectURL(mergeResultURL); mergeResultURL = null; }
    if (mResult) mResult.hidden = true;
  }

  function doMerge() {
    if (mergeBusy || mergeFiles.length < 2) {
      if (mergeFiles.length < 2) setMergeStatus("Add at least two PDFs to merge.");
      return;
    }
    mergeBusy = true;
    if (mBtn) { mBtn.disabled = true; mBtn.textContent = "Working…"; }
    hideMergeResult();
    setMergeStatus("Merging " + mergeFiles.length + " PDFs…");
    loadPdfLib().then(function (PDFLib) {
      return mergeDocuments(PDFLib, mergeFiles.map(function (e) { return e.doc; }));
    }).then(function (bytes) {
      mergeBusy = false;
      if (mBtn) { mBtn.textContent = "Merge PDFs"; }
      renderMergeList();
      var blob = new Blob([bytes], { type: "application/pdf" });
      mergeResultURL = URL.createObjectURL(blob);
      var totalPages = mergeFiles.reduce(function (n, e) { return n + e.pageCount; }, 0);
      if (mStatFiles) mStatFiles.textContent = String(mergeFiles.length);
      if (mStatPages) mStatPages.textContent = String(totalPages);
      if (mStatSize) mStatSize.textContent = fmtSize(blob.size);
      if (mMeta) mMeta.textContent = "Your merged PDF — " + totalPages + (totalPages === 1 ? " page" : " pages") +
        " from " + mergeFiles.length + " files • " + fmtSize(blob.size) + ". Pages were copied exactly — text stays selectable.";
      if (mDownload) {
        mDownload.href = mergeResultURL;
        mDownload.setAttribute("download", MERGED_NAME);
      }
      if (mResult) {
        mResult.hidden = false;
        mResult.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
      setMergeStatus("");
      track("tool_resize_success", { tool: "merge_pdf", files: mergeFiles.length, pages: totalPages, output_kb: Math.round(blob.size / 1024) });
    }).catch(function () {
      mergeBusy = false;
      if (mBtn) { mBtn.textContent = "Merge PDFs"; }
      renderMergeList();
      setMergeStatus("Something went wrong while merging. Please try again with fewer or smaller PDFs.");
    });
  }

  if (mBtn) mBtn.addEventListener("click", doMerge);
  if (mDownload) mDownload.addEventListener("click", function () { track("tool_download", { tool: "merge_pdf" }); });
  if (mReset) mReset.addEventListener("click", function () {
    mergeFiles = [];
    hideMergeResult();
    renderMergeList();
    setMergeStatus("");
    if (mDropzone) mDropzone.focus();
  });
  wireDropzone(mDropzone, mInput, addMergeFiles);
  renderMergeList();

  /* ================================================================
     SPLIT mode
     ================================================================ */
  var splitPanel = panels.split;
  var sDropzone = qs("[data-split-dropzone]", splitPanel);
  var sInput = qs("[data-split-input]", splitPanel);
  var sInfo = qs("[data-split-info]", splitPanel);
  var sOptChips = qs("[data-split-opt-chips]", splitPanel);
  var sExtractWrap = qs("[data-extract-wrap]", splitPanel);
  var sRangeInput = qs("[data-range-input]", splitPanel);
  var sExtractBtn = qs("[data-extract-btn]", splitPanel);
  var sAllWrap = qs("[data-all-wrap]", splitPanel);
  var sAllBtn = qs("[data-all-btn]", splitPanel);
  var sLinks = qs("[data-split-links]", splitPanel);
  var sStatus = qs("[data-split-status]", splitPanel);
  var sResult = qs("[data-split-result]", splitPanel);
  var sStatPages = qs("[data-stat-pages]", splitPanel);
  var sStatSize = qs("[data-stat-size]", splitPanel);
  var sMeta = qs("[data-split-meta]", splitPanel);
  var sDownload = qs("[data-split-download]", splitPanel);
  var sReset = qs("[data-split-reset]", splitPanel);

  var splitFile = null;  // { file, doc, pageCount }
  var splitOpt = "extract";
  var splitBusy = false;
  var splitResultURL = null;
  var splitPageURLs = {};  // page number -> object URL (generated on demand)

  function setSplitStatus(msg) { if (sStatus) sStatus.textContent = msg || ""; }

  function paintSplitOpt() {
    qsa("[data-split-opt]", splitPanel).forEach(function (b) {
      b.classList.toggle("is-active", b.getAttribute("data-split-opt") === splitOpt);
    });
    if (sExtractWrap) sExtractWrap.hidden = splitOpt !== "extract";
    if (sAllWrap) sAllWrap.hidden = splitOpt !== "all";
  }
  if (sOptChips) {
    sOptChips.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest("[data-split-opt]") : null;
      if (!btn) return;
      splitOpt = btn.getAttribute("data-split-opt");
      paintSplitOpt();
    });
  }
  paintSplitOpt();

  function clearSplitLinks() {
    Object.keys(splitPageURLs).forEach(function (k) { URL.revokeObjectURL(splitPageURLs[k]); });
    splitPageURLs = {};
    if (sLinks) { sLinks.innerHTML = ""; sLinks.hidden = true; }
  }
  function hideSplitResult() {
    if (splitResultURL) { URL.revokeObjectURL(splitResultURL); splitResultURL = null; }
    if (sResult) sResult.hidden = true;
  }

  function setSplitFile(entry) {
    splitFile = entry;
    hideSplitResult();
    clearSplitLinks();
    if (sInfo) {
      sInfo.textContent = "📄 " + entry.file.name + " — " + entry.pageCount +
        (entry.pageCount === 1 ? " page" : " pages") + " • " + fmtSize(entry.file.size);
      sInfo.hidden = false;
    }
    if (sRangeInput && !sRangeInput.value) {
      sRangeInput.placeholder = "e.g. 1-3, 5 (of " + entry.pageCount + ")";
    }
    setSplitStatus("");
    track("tool_file_selected", { tool: "split_pdf", pages: entry.pageCount });
  }

  function addSplitFile(fileList) {
    if (splitBusy) return;
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    setSplitStatus("Reading your PDF in your browser…");
    readPdf(files[0]).then(setSplitFile).catch(function (err) {
      setSplitStatus(err.message);
    });
  }

  function doExtract() {
    if (splitBusy) return;
    if (!splitFile) { setSplitStatus("Choose a PDF first."); return; }
    var parsed = parsePageRanges(sRangeInput ? sRangeInput.value : "", splitFile.pageCount);
    if (!parsed.ok) { setSplitStatus(parsed.error); return; }
    splitBusy = true;
    if (sExtractBtn) { sExtractBtn.disabled = true; sExtractBtn.textContent = "Working…"; }
    hideSplitResult();
    clearSplitLinks();
    setSplitStatus("Extracting pages " + parsed.pages.join(", ") + "…");
    loadPdfLib().then(function (PDFLib) {
      return extractPages(PDFLib, splitFile.doc, parsed.pages);
    }).then(function (bytes) {
      splitBusy = false;
      if (sExtractBtn) { sExtractBtn.disabled = false; sExtractBtn.textContent = "Extract pages"; }
      var blob = new Blob([bytes], { type: "application/pdf" });
      splitResultURL = URL.createObjectURL(blob);
      if (sStatPages) sStatPages.textContent = parsed.pages.join(", ");
      if (sStatSize) sStatSize.textContent = fmtSize(blob.size);
      if (sMeta) sMeta.textContent = "Your extracted PDF — pages " + parsed.pages.join(", ") + " of " +
        splitFile.file.name + " • " + fmtSize(blob.size) + ". Pages were copied exactly — text stays selectable.";
      if (sDownload) {
        sDownload.href = splitResultURL;
        sDownload.setAttribute("download", EXTRACT_NAME);
      }
      if (sResult) {
        sResult.hidden = false;
        sResult.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
      setSplitStatus("");
      track("tool_resize_success", { tool: "split_pdf", mode: "extract", pages: parsed.pages.length, output_kb: Math.round(blob.size / 1024) });
    }).catch(function () {
      splitBusy = false;
      if (sExtractBtn) { sExtractBtn.disabled = false; sExtractBtn.textContent = "Extract pages"; }
      setSplitStatus("Something went wrong while extracting. Please try again.");
    });
  }

  function doSplitAll() {
    if (!splitFile) { setSplitStatus("Choose a PDF first."); return; }
    hideSplitResult();
    clearSplitLinks();
    if (!sLinks) return;
    var heading = document.createElement("p");
    heading.className = "tool-file-info";
    heading.textContent = splitFile.pageCount + (splitFile.pageCount === 1 ? " page" : " pages") +
      " — download each one separately:";
    sLinks.appendChild(heading);
    for (var n = 1; n <= splitFile.pageCount; n++) {
      (function (page) {
        var row = document.createElement("div");
        row.className = "pdf-item";
        var info = document.createElement("div");
        info.className = "pdf-item-info";
        var name = document.createElement("strong");
        name.textContent = "Page " + page;
        var meta = document.createElement("span");
        meta.textContent = pageFileName(page);
        info.appendChild(name);
        info.appendChild(meta);
        row.appendChild(info);
        var actions = document.createElement("div");
        actions.className = "pdf-item-actions";
        var b = document.createElement("button");
        b.type = "button";
        b.className = "chip pdf-item-btn ms-dl-btn";
        b.textContent = "⬇ Download";
        b.setAttribute("data-split-dl", String(page));
        actions.appendChild(b);
        row.appendChild(actions);
        sLinks.appendChild(row);
      })(n);
    }
    sLinks.hidden = false;
    sLinks.scrollIntoView({ behavior: "smooth", block: "nearest" });
    setSplitStatus("");
    track("tool_resize_success", { tool: "split_pdf", mode: "all", pages: splitFile.pageCount });
  }
  if (sLinks) {
    sLinks.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest("[data-split-dl]") : null;
      if (!btn || !splitFile || splitBusy) return;
      var page = parseInt(btn.getAttribute("data-split-dl"), 10);
      if (splitPageURLs[page]) {
        var a = document.createElement("a");
        a.href = splitPageURLs[page];
        a.setAttribute("download", pageFileName(page));
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        track("tool_download", { tool: "split_pdf", mode: "all" });
        return;
      }
      splitBusy = true;
      var label = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Preparing…";
      loadPdfLib().then(function (PDFLib) {
        return splitPage(PDFLib, splitFile.doc, page);
      }).then(function (bytes) {
        var blob = new Blob([bytes], { type: "application/pdf" });
        splitPageURLs[page] = URL.createObjectURL(blob);
        downloadBytes(bytes, pageFileName(page));
        track("tool_download", { tool: "split_pdf", mode: "all" });
      }).catch(function () {
        setSplitStatus("Page " + page + " could not be prepared. Please try again.");
      }).then(function () {
        splitBusy = false;
        btn.disabled = false;
        btn.textContent = label;
      });
    });
  }

  if (sExtractBtn) sExtractBtn.addEventListener("click", doExtract);
  if (sAllBtn) sAllBtn.addEventListener("click", doSplitAll);
  if (sDownload) sDownload.addEventListener("click", function () { track("tool_download", { tool: "split_pdf", mode: "extract" }); });
  if (sReset) sReset.addEventListener("click", function () {
    splitFile = null;
    hideSplitResult();
    clearSplitLinks();
    if (sInfo) { sInfo.hidden = true; sInfo.textContent = ""; }
    if (sRangeInput) sRangeInput.value = "";
    setSplitStatus("");
    if (sDropzone) sDropzone.focus();
  });
  wireDropzone(sDropzone, sInput, addSplitFile);

  /* Paste support: files go to whichever mode is active. */
  document.addEventListener("paste", function (e) {
    if (!e.clipboardData || !e.clipboardData.files || !e.clipboardData.files.length) return;
    if (mode === "merge") addMergeFiles(e.clipboardData.files);
    else addSplitFile(e.clipboardData.files);
  });

  setMode("merge");
})(typeof window !== "undefined" ? window : null);

/* PDF to JPG page logic.
 *
 * Flow:
 *   select one PDF (picker + drag&drop) -> validate (PDF type, <=100MB) ->
 *   read page count via pdf.js -> choose all pages or range text
 *   (expanded client-side to an explicit ordered page list) + quality ->
 *   upload PDF to uploads/<request-id>/<safe>.pdf ->
 *   upload manifest pdf-to-jpg-requests/<request-id>.pdf2jpg.json LAST ->
 *   poll each exact output key pdf-to-jpg/<id>/<stem>-page-001.jpg ->
 *   JPG previews with individual downloads + Download All.
 *
 * Pure helpers are exposed on window.PdfToJpg for static tests.
 */
(function () {
  var els = {};
  var file = null;
  var busy = false;
  var lastOutputKeys = [];
  var pageCount = 0;
  var previewReady = false;

  function $(id) {
    return document.getElementById(id);
  }

  function cfg() {
    return window.PdfConfig;
  }

  /* Pure validation over {name, size} — no DOM, no AWS. Used by the page
   * and by tests. */
  function validatePdfToJpgSelection(entry) {
    var errors = [];
    if (!entry) {
      errors.push("Select a PDF file to begin.");
      return { ok: false, errors: errors };
    }
    var ext = String(entry.name || "").split(".").pop().toLowerCase();
    if ((cfg().ALLOWED_EXTENSIONS || ["pdf"]).indexOf(ext) === -1) {
      errors.push("“" + entry.name + "” is not a PDF. Please choose a file ending in .pdf.");
    }
    if (!entry.size || entry.size <= 0) {
      errors.push("“" + entry.name + "” appears to be empty.");
    }
    var perFile = (cfg().MAX_FILE_SIZE_MB || 100) * 1024 * 1024;
    if (entry.size && entry.size > perFile) {
      errors.push("“" + entry.name + "” is larger than the 100 MB limit.");
    }
    return { ok: errors.length === 0, errors: errors };
  }

  function maxPages() {
    return cfg().PDF2JPG_MAX_PAGES || 50;
  }

  function currentQuality() {
    var q = parseInt(els.quality.value, 10);
    if (!(q >= 1 && q <= 100)) q = cfg().PDF2JPG_DEFAULT_QUALITY || 85;
    return q;
  }

  /* Pure "all pages" expansion shared by resolvePages and tests. */
  function expandAllPages(pageCount, maxAllowed) {
    if (!pageCount || pageCount < 1) {
      return { ok: false, pages: [], error: "Page count is still loading — wait a moment." };
    }
    if (pageCount > maxAllowed) {
      return { ok: false, pages: [],
               error: "This document has " + pageCount +
                 " pages — convert up to " + maxAllowed + " at a time." };
    }
    var all = [];
    for (var n = 1; n <= pageCount; n++) all.push(n);
    return { ok: true, pages: all, error: "" };
  }

  /* Resolve the requested page list: "all" expands locally (the backend
   * only ever receives explicit ints). Returns { ok, pages[], error }. */
  function resolvePages() {
    if (els.modeAll && els.modeAll.checked) {
      return expandAllPages(previewReady ? pageCount : 0, maxPages());
    }
    var parsed = window.PdfCloud.parseExtractRanges(
      els.ranges.value, previewReady ? pageCount : 0);
    if (!parsed.ok) return { ok: false, pages: [], error: parsed.error };
    if (parsed.pages.length > maxPages()) {
      return { ok: false, pages: [],
               error: "Too many pages selected — up to " + maxPages() +
                 " at a time." };
    }
    return { ok: true, pages: parsed.pages, error: "" };
  }

  function setStep(name) {
    var order = ["select", "upload", "process", "done"];
    var idx = order.indexOf(name);
    order.forEach(function (key) {
      var li = $("p2jStep" + key.charAt(0).toUpperCase() + key.slice(1));
      if (!li) return;
      var i = order.indexOf(key);
      li.classList.toggle("done", i < idx);
      li.classList.toggle("now", i === idx);
    });
  }

  function setStatus(text) {
    els.status.textContent = text;
  }

  function setProgress(pct) {
    els.progressWrap.hidden = false;
    els.fill.style.width = pct + "%";
    els.percent.textContent = pct + "%";
  }

  function showError(friendly, technical) {
    els.errorCard.hidden = false;
    $("p2jErrorMessage").textContent = friendly;
    $("p2jErrorDetails").textContent = technical || friendly;
    setStatus("Something went wrong — see below.");
  }

  function showAwsError(err, context) {
    showError(
      window.PdfCloud.friendlyError(err, context),
      window.PdfCloud.technicalDetails(err)
    );
  }

  function clearError() {
    els.errorCard.hidden = true;
  }

  function refresh() {
    var validation = validatePdfToJpgSelection(file);
    var resolved = resolvePages();
    if (els.hint) {
      if (!file) els.hint.textContent = "Select a PDF file to begin.";
      else if (!validation.ok) els.hint.textContent = validation.errors[0];
      else if (!previewReady) els.hint.textContent = "Reading page count…";
      else if (!resolved.ok) els.hint.textContent = resolved.error;
      else els.hint.textContent = resolved.pages.length +
        (resolved.pages.length === 1 ? " page" : " pages") +
        " will convert, in the order listed.";
    }
    if (els.selected) {
      els.selected.textContent = resolved.ok
        ? "Selected: " + resolved.pages.join(", ")
        : "Selected: none yet";
    }
    if (els.rangesWrap) els.rangesWrap.hidden = !(els.modeRanges && els.modeRanges.checked);
    if (busy) {
      els.convertBtn.disabled = true;
      els.convertBtn.textContent = "Working…";
    } else if (!validation.ok || !resolved.ok) {
      els.convertBtn.disabled = true;
      els.convertBtn.textContent = !file ? "Select a PDF to begin" : "Fix issues to continue";
    } else {
      els.convertBtn.disabled = false;
      els.convertBtn.textContent = "Convert " + resolved.pages.length +
        (resolved.pages.length === 1 ? " page" : " pages");
    }
    if (els.fileName) {
      els.fileName.textContent = file
        ? file.name + " (" + window.PdfCloud.formatBytes(file.size) + ")"
        : "No file selected.";
    }
    if (els.count) {
      if (!file) els.count.textContent = "Select a PDF file to begin.";
      else if (previewReady && pageCount) {
        els.count.textContent = "This PDF has " + pageCount +
          (pageCount === 1 ? " page." : " pages.");
      } else els.count.textContent = "Reading page count…";
    }
    return { validation: validation, resolved: resolved };
  }

  function readPageCount(picked) {
    pageCount = 0;
    previewReady = false;
    refresh();
    if (typeof window.pdfjsLib === "undefined") {
      setStatus("Preview library unavailable — range entry still works.");
      refresh();
      return;
    }
    try {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = cfg().PDFJS_WORKER_URL;
    } catch (e) { /* default worker is fine */ }
    var reader = new FileReader();
    reader.onload = function () {
      var data = reader.result;
      window.pdfjsLib.getDocument({ data: data }).promise.then(function (pdf) {
        pageCount = pdf.numPages;
        previewReady = true;
        refresh();
        setStatus("Ready — " + pageCount +
          (pageCount === 1 ? " page" : " pages") + " found.");
      }, function () {
        previewReady = false;
        setStatus("Could not read page count — range entry still works.");
        refresh();
      });
    };
    reader.onerror = function () {
      previewReady = false;
      setStatus("Could not read page count — range entry still works.");
      refresh();
    };
    try {
      reader.readAsArrayBuffer(picked);
    } catch (e) {
      previewReady = false;
      refresh();
    }
  }

  function addFile(picked) {
    clearError();
    els.result.hidden = true;
    els.grid.innerHTML = "";
    var list = Array.prototype.slice.call(picked || []);
    if (!list.length) return;
    if (list.length > 1) {
      showError(
        "Convert works on one PDF at a time — the first file was kept.",
        "User picked " + list.length + " files; kept the first."
      );
    }
    file = list[0];
    setStatus("Ready — “" + file.name + "” selected.");
    readPageCount(file);
    refresh();
  }

  function resetAll() {
    file = null;
    busy = false;
    lastOutputKeys = [];
    pageCount = 0;
    previewReady = false;
    els.input.value = "";
    els.ranges.value = "";
    if (els.modeAll) els.modeAll.checked = true;
    els.result.hidden = true;
    els.grid.innerHTML = "";
    els.errorCard.hidden = true;
    els.progressWrap.hidden = true;
    els.fill.style.width = "0";
    els.percent.textContent = "";
    setStep("select");
    setStatus("Ready — select a PDF to begin.");
    refresh();
  }

  function run() {
    if (busy || !file) return;
    var state = refresh();
    if (!state.validation.ok) {
      showError(state.validation.errors[0], state.validation.errors.join(" "));
      return;
    }
    if (!state.resolved.ok) {
      showError(state.resolved.error, state.resolved.error);
      return;
    }
    var pages = state.resolved.pages;
    var quality = currentQuality();
    busy = true;
    clearError();
    els.result.hidden = true;
    els.grid.innerHTML = "";
    refresh();

    var requestId = window.PdfCloud.newPdfToJpgRequestId();
    var safeBase = window.PdfCloud.sanitizeMergeBase(file.name);
    var inputKey = window.PdfCloud.pdfToJpgInputKey(requestId, safeBase);
    var manifest = window.PdfCloud.buildPdfToJpgManifest(
      requestId, inputKey, pages, quality, safeBase);
    var expectedKeys = window.PdfCloud.expectedPdfToJpgOutputKeys(
      requestId, safeBase, pages);

    setStep("upload");
    setStatus("Uploading “" + file.name + "”…");
    setProgress(0);

    // 1) Upload the PDF first (the manifest must never win the race).
    window.PdfCloud.uploadMergePdf(file, inputKey, function (pct) {
      setProgress(pct);
    }).then(function () {
      // 2) PDF succeeded → upload the manifest (the Lambda trigger).
      setProgress(100);
      setStatus("Starting conversion…");
      return window.PdfCloud.putPdfToJpgManifest(requestId, manifest);
    }).then(function () {
      // 3) Poll for EVERY expected JPG key (exact keys, never a listing).
      setStep("process");
      setStatus("Converting pages…");
      var pending = expectedKeys.map(function (key, i) {
        return window.PdfCloud.pollForExactOutput(key, function (attempt, max) {
          setStatus("Converting pages… (" + (i + 1) + "/" + expectedKeys.length +
            ", check " + attempt + " of " + max + ")");
        });
      });
      return Promise.all(pending);
    }).then(function (results) {
      lastOutputKeys = results.map(function (r) { return r.outputKey; });
      setStep("done");
      setStatus("Complete — your JPG images are ready below.");
      setProgress(100);
      $("p2jResultMode").textContent = pages.length +
        (pages.length === 1 ? " page: " : " pages: ") + pages.join(", ");
      renderGrid(lastOutputKeys);
      els.result.hidden = false;
      busy = false;
      refresh();
      if (els.downloadAllBtn) els.downloadAllBtn.focus();
    }).catch(function (err) {
      busy = false;
      refresh();
      var context = err && err.code === "PollTimeout" ? "poll" : "upload";
      showAwsError(err, context);
    });
  }

  function renderGrid(outputKeys) {
    els.grid.innerHTML = "";
    outputKeys.forEach(function (key, i) {
      var name = key.split("/").pop();
      var url = window.PdfCloud.presignedDownloadUrl(key, name);
      var cell = document.createElement("div");
      cell.className = "p2j-cell";
      var img = document.createElement("img");
      img.src = url;
      img.alt = name;
      img.loading = "lazy";
      var cap = document.createElement("div");
      cap.className = "p2j-cap";
      cap.textContent = name;
      var link = document.createElement("a");
      link.className = "btn ghost block";
      link.href = url;
      link.setAttribute("download", name);
      link.textContent = "Download";
      cell.appendChild(img);
      cell.appendChild(cap);
      cell.appendChild(link);
      els.grid.appendChild(cell);
    });
  }

  function downloadAll() {
    if (!lastOutputKeys.length) return;
    // Sequential anchor clicks: each is a direct file download (same
    // presigned URLs as the previews), so browsers treat them as
    // downloads rather than popups.
    lastOutputKeys.forEach(function (key, i) {
      var name = key.split("/").pop();
      var anchor = document.createElement("a");
      anchor.href = window.PdfCloud.presignedDownloadUrl(key, name);
      anchor.setAttribute("download", name);
      document.body.appendChild(anchor);
      setTimeout(function () {
        anchor.click();
        setTimeout(function () {
          if (anchor.parentNode) anchor.parentNode.removeChild(anchor);
        }, 4000);
      }, i * 700);
    });
  }

  function wireDropzone() {
    var dz = $("p2jDropzone");
    ["dragenter", "dragover"].forEach(function (evt) {
      dz.addEventListener(evt, function (e) {
        e.preventDefault();
        dz.classList.add("dragover");
      });
    });
    ["dragleave", "drop"].forEach(function (evt) {
      dz.addEventListener(evt, function (e) {
        e.preventDefault();
        dz.classList.remove("dragover");
      });
    });
    dz.addEventListener("drop", function (e) {
      var list = e.dataTransfer && e.dataTransfer.files;
      if (list && list.length) addFile(list);
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    els = {
      input: $("p2jFiles"),
      modeAll: $("p2jModeAll"),
      modeRanges: $("p2jModeRanges"),
      ranges: $("p2jRanges"),
      rangesWrap: $("p2jRangesWrap"),
      quality: $("p2jQuality"),
      hint: $("p2jHint"),
      count: $("p2jCount"),
      selected: $("p2jSelected"),
      fileName: $("p2jFileName"),
      convertBtn: $("p2jBtn"),
      downloadAllBtn: $("p2jDownloadAllBtn"),
      grid: $("p2jGrid"),
      status: $("p2jStatus"),
      fill: $("p2jProgressFill"),
      percent: $("p2jProgressPercent"),
      progressWrap: $("p2jProgressWrap"),
      result: $("p2jResultCard"),
      errorCard: $("p2jErrorCard")
    };
    try {
      window.PdfCloud.init();
    } catch (err) {
      showAwsError(err, "upload");
      return;
    }
    setStep("select");
    refresh();
    els.input.addEventListener("change", function () {
      addFile(els.input.files);
      els.input.value = "";
    });
    els.modeAll.addEventListener("change", refresh);
    els.modeRanges.addEventListener("change", refresh);
    els.ranges.addEventListener("input", refresh);
    els.quality.addEventListener("change", refresh);
    els.convertBtn.addEventListener("click", run);
    els.downloadAllBtn.addEventListener("click", downloadAll);
    $("p2jResetBtn").addEventListener("click", resetAll);
    $("p2jRetryBtn").addEventListener("click", function () {
      clearError();
      if (!busy && file) run();
      else setStatus("Select a PDF to begin.");
    });
    wireDropzone();
  });

  /* Exposed for static/unit tests (no DOM or AWS needed for these). */
  window.PdfToJpg = {
    validatePdfToJpgSelection: validatePdfToJpgSelection,
    expandAllPages: expandAllPages
  };
})();

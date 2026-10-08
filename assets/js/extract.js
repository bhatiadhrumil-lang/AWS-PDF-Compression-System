/* Extract Pages logic.
 *
 * Flow:
 *   select one PDF (picker + drag&drop) -> validate (PDF type, <=100MB) ->
 *   read page count locally via pdf.js -> pick pages (checkbox tiles and/or
 *   range text like 1,3,5-7, in requested order) ->
 *   upload PDF to uploads/<request-id>/<safe>.pdf ->
 *   upload manifest extract-requests/<request-id>.extract.json LAST ->
 *   poll exact output key extract/<request-id>/<stem>-extracted.pdf ->
 *   presigned download of the new PDF (source file never modified).
 *
 * Pure helpers are exposed on window.PdfExtract for static tests.
 */
(function () {
  var els = {};
  var file = null;
  var busy = false;
  var lastOutputKey = null;
  var pageCount = 0;
  var previewReady = false;
  var selection = []; // ordered 1-indexed ints, deduped (click/add order)

  function $(id) {
    return document.getElementById(id);
  }

  function cfg() {
    return window.PdfConfig;
  }

  /* Pure validation over {name, size} — no DOM, no AWS. Used by the page
   * and by tests. */
  function validateExtractSelection(entry) {
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
    return cfg().EXTRACT_MAX_PAGES || 500;
  }

  function setStep(name) {
    var order = ["select", "upload", "process", "done"];
    var idx = order.indexOf(name);
    order.forEach(function (key) {
      var li = $("extractStep" + key.charAt(0).toUpperCase() + key.slice(1));
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
    $("extractErrorMessage").textContent = friendly;
    $("extractErrorDetails").textContent = technical || friendly;
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

  function selectionText() {
    if (!selection.length) return "Selected: 0 pages";
    var base = "Selected: " + selection.length + (selection.length === 1 ? " page" : " pages");
    if (selection.length <= 20) base += " (" + selection.join(", ") + ")";
    return base;
  }

  function refresh() {
    var validation = validateExtractSelection(file);
    var ready = validation.ok && !busy;
    if (els.hint) {
      if (!file) els.hint.textContent = "Select a PDF file to begin.";
      else if (!validation.ok) els.hint.textContent = validation.errors[0];
      else if (!previewReady) els.hint.textContent = "Page preview is unavailable — type ranges below (e.g. 1, 3, 5-7).";
      else if (!selection.length) els.hint.textContent = "Tick pages above, or type ranges like 1, 3, 5-7.";
      else els.hint.textContent = "Pages will extract in the order listed below.";
    }
    if (els.selected) els.selected.textContent = selectionText();
    var tooMany = selection.length > maxPages();
    if (busy) {
      els.extractBtn.disabled = true;
      els.extractBtn.textContent = "Working…";
    } else if (!validation.ok || !selection.length || tooMany) {
      els.extractBtn.disabled = true;
      els.extractBtn.textContent = !file ? "Select a PDF to begin"
        : tooMany ? "Too many pages selected"
        : !selection.length ? "Select at least one page" : "Fix issues to continue";
    } else {
      els.extractBtn.disabled = false;
      els.extractBtn.textContent = "Extract " + selection.length +
        (selection.length === 1 ? " page" : " pages");
    }
    var hasCount = previewReady && pageCount > 0;
    if (els.selectAll) els.selectAll.disabled = !ready || !hasCount;
    if (els.clearBtn) els.clearBtn.disabled = !ready || !selection.length;
    if (els.fileName) {
      els.fileName.textContent = file
        ? file.name + " (" + window.PdfCloud.formatBytes(file.size) + ")"
        : "No file selected.";
    }
    if (els.count) {
      if (!file) els.count.textContent = "Select a PDF file to begin.";
      else if (hasCount) els.count.textContent = "This PDF has " + pageCount + (pageCount === 1 ? " page." : " pages.");
      else els.count.textContent = "Reading page count…";
    }
    return { validation: validation };
  }

  function renderTiles() {
    els.tiles.innerHTML = "";
    if (!previewReady || !pageCount) return;
    for (var n = 1; n <= pageCount; n++) {
      (function (page) {
        var label = document.createElement("label");
        label.className = "extract-tile" + (selection.indexOf(page) >= 0 ? " checked" : "");
        var box = document.createElement("input");
        box.type = "checkbox";
        box.checked = selection.indexOf(page) >= 0;
        box.setAttribute("aria-label", "Page " + page);
        box.addEventListener("change", function () { togglePage(page); });
        var num = document.createElement("span");
        num.textContent = "Page " + page;
        label.appendChild(box);
        label.appendChild(num);
        els.tiles.appendChild(label);
      })(n);
    }
  }

  function togglePage(page) {
    var at = selection.indexOf(page);
    if (at >= 0) selection.splice(at, 1);
    else selection.push(page);
    clearError();
    renderTiles();
    refresh();
  }

  function selectAllPages() {
    if (!previewReady || !pageCount) return;
    if (pageCount > maxPages()) {
      showError(
        "This document has " + pageCount + " pages — select up to " + maxPages() + " at a time.",
        "pageCount " + pageCount + " exceeds EXTRACT_MAX_PAGES " + maxPages());
      return;
    }
    selection = [];
    for (var n = 1; n <= pageCount; n++) selection.push(n);
    clearError();
    renderTiles();
    refresh();
  }

  function clearSelection() {
    selection = [];
    clearError();
    renderTiles();
    refresh();
  }

  function addRanges() {
    clearError();
    var parsed = window.PdfCloud.parseExtractRanges(
      els.ranges.value, previewReady ? pageCount : 0);
    if (!parsed.ok) {
      showError(parsed.error, parsed.error);
      refresh();
      return;
    }
    var room = maxPages() - selection.length;
    var fresh = parsed.pages.filter(function (p) { return selection.indexOf(p) < 0; });
    if (fresh.length > room) {
      showError(
        "Too many pages selected — up to " + maxPages() + " at a time.",
        "selection would reach " + (selection.length + fresh.length));
      refresh();
      return;
    }
    selection = selection.concat(fresh);
    els.ranges.value = "";
    renderTiles();
    refresh();
    setStatus("Added " + fresh.length + (fresh.length === 1 ? " page." : " pages."));
  }

  function readPageCount(picked) {
    pageCount = 0;
    previewReady = false;
    renderTiles();
    refresh();
    if (typeof window.pdfjsLib === "undefined") {
      setStatus("Preview library unavailable — range entry still works.");
      refresh();
      return;
    }
    try {
      if (window.pdfjsLib.GlobalWorkerOptions && cfg().PDFJS_WORKER_URL) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = cfg().PDFJS_WORKER_URL;
      }
    } catch (err) { /* worker config is best-effort */ }
    var reader = new FileReader();
    reader.onload = function () {
      var data = new Uint8Array(reader.result);
      window.pdfjsLib.getDocument({ data: data }).promise.then(function (pdf) {
        if (!file || picked !== file) return; // user picked another file
        pageCount = pdf.numPages || 0;
        previewReady = pageCount > 0;
        if (!previewReady) {
          setStatus("Could not read pages — type ranges below instead.");
        } else {
          setStatus("Ready — “" + file.name + "” has " + pageCount + " pages.");
        }
        // Drop staged pages that no longer exist (e.g. after re-picking).
        selection = selection.filter(function (p) { return p >= 1 && p <= pageCount; });
        renderTiles();
        refresh();
      }, function () {
        if (picked !== file) return;
        setStatus("Could not read this PDF — type ranges below instead.");
        refresh();
      });
    };
    reader.onerror = function () {
      setStatus("Could not read this PDF — type ranges below instead.");
      refresh();
    };
    reader.readAsArrayBuffer(picked);
  }

  function addFile(picked) {
    clearError();
    els.result.hidden = true;
    var list = Array.prototype.slice.call(picked || []);
    if (!list.length) return;
    if (list.length > 1) {
      showError(
        "Extract works on one PDF at a time — the first file was kept.",
        "User picked " + list.length + " files; kept the first."
      );
    }
    file = list[0];
    selection = [];
    setStatus("Ready — “" + file.name + "” selected. Reading pages…");
    refresh();
    readPageCount(file);
  }

  function resetAll() {
    file = null;
    busy = false;
    lastOutputKey = null;
    pageCount = 0;
    previewReady = false;
    selection = [];
    els.input.value = "";
    els.ranges.value = "";
    els.tiles.innerHTML = "";
    els.result.hidden = true;
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
    if (!selection.length) {
      showError("No pages selected. Please select at least one page.",
        "empty extract selection");
      return;
    }
    if (selection.length > maxPages()) {
      showError("Too many pages selected — up to " + maxPages() + " at a time.",
        "selection of " + selection.length);
      return;
    }
    busy = true;
    clearError();
    els.result.hidden = true;
    refresh();

    var requestId = window.PdfCloud.newExtractRequestId();
    var safeBase = window.PdfCloud.sanitizeMergeBase(file.name);
    var inputKey = window.PdfCloud.extractInputKey(requestId, safeBase);
    var pages = selection.slice();
    var manifest = window.PdfCloud.buildExtractManifest(
      requestId, inputKey, pages, safeBase);
    var expectedOutput = window.PdfCloud.expectedExtractOutputKey(
      requestId, safeBase);

    setStep("upload");
    setStatus("Uploading “" + file.name + "”…");
    setProgress(0);

    // 1) Upload the PDF first (the manifest must never win the race).
    window.PdfCloud.uploadMergePdf(file, inputKey, function (pct) {
      setProgress(pct);
    }).then(function () {
      // 2) PDF succeeded → upload the manifest (the Lambda trigger).
      setProgress(100);
      setStatus("Starting extract…");
      return window.PdfCloud.putExtractManifest(requestId, manifest);
    }).then(function () {
      // 3) Poll for the EXACT PDF key for this request.
      setStep("process");
      setStatus("Extracting pages…");
      return window.PdfCloud.pollForExactOutput(expectedOutput, function (attempt, max) {
        setStatus("Extracting pages… (check " + attempt + " of " + max + ")");
      });
    }).then(function (result) {
      lastOutputKey = result.outputKey;
      setStep("done");
      setStatus("Complete — your extracted PDF is ready below.");
      setProgress(100);
      $("extractResultName").textContent = result.outputKey.split("/").pop();
      $("extractResultMode").textContent = pages.length +
        (pages.length === 1 ? " page: " : " pages: ") + pages.join(", ");
      els.result.hidden = false;
      busy = false;
      refresh();
      if (els.downloadBtn) els.downloadBtn.focus();
    }).catch(function (err) {
      busy = false;
      refresh();
      var context = err && err.code === "PollTimeout" ? "poll" : "upload";
      showAwsError(err, context);
    });
  }

  function download() {
    if (!lastOutputKey) return;
    try {
      setStatus("Preparing download…");
      var name = $("extractResultName").textContent;
      window.PdfCloud.downloadOutput(lastOutputKey, name || undefined);
      setStatus("Complete — your extracted PDF is ready below.");
    } catch (err) {
      showAwsError(err, "download");
    }
  }

  function wireDropzone() {
    var dz = $("extractDropzone");
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
      input: $("extractFiles"),
      count: $("extractCount"),
      tiles: $("extractTiles"),
      selectAll: $("extractSelectAll"),
      clearBtn: $("extractClear"),
      ranges: $("extractRanges"),
      addRanges: $("extractAddRanges"),
      hint: $("extractHint"),
      selected: $("extractSelected"),
      fileName: $("extractFileName"),
      extractBtn: $("extractBtn"),
      downloadBtn: $("extractDownloadBtn"),
      status: $("extractStatus"),
      fill: $("extractProgressFill"),
      percent: $("extractProgressPercent"),
      progressWrap: $("extractProgressWrap"),
      result: $("extractResultCard"),
      errorCard: $("extractErrorCard")
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
    els.selectAll.addEventListener("click", selectAllPages);
    els.clearBtn.addEventListener("click", clearSelection);
    els.addRanges.addEventListener("click", addRanges);
    els.extractBtn.addEventListener("click", run);
    els.downloadBtn.addEventListener("click", download);
    $("extractResetBtn").addEventListener("click", resetAll);
    $("extractRetryBtn").addEventListener("click", function () {
      clearError();
      if (!busy && file) run();
      else setStatus("Select a PDF to begin.");
    });
    wireDropzone();
  });

  /* Exposed for static/unit tests (no DOM or AWS needed for these). */
  window.PdfExtract = {
    validateExtractSelection: validateExtractSelection
  };
})();

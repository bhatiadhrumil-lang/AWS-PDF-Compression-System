/* Split PDF page logic.
 *
 * Flow:
 *   select one PDF (picker + drag&drop) -> validate (PDF type, <=100MB) ->
 *   choose mode (every page | page ranges like 1-3,5,8-10) ->
 *   upload PDF to uploads/<request-id>/<safe>.pdf ->
 *   upload manifest split-requests/<request-id>.split.json LAST ->
 *   poll exact output key split/<request-id>/<stem>-split.zip ->
 *   presigned download of the ZIP.
 *
 * Pure helpers are exposed on window.PdfSplit for static tests.
 */
(function () {
  var els = {};
  var file = null;
  var busy = false;
  var lastOutputKey = null;

  function $(id) {
    return document.getElementById(id);
  }

  function cfg() {
    return window.PdfConfig;
  }

  /* Pure validation over {name, size} — no DOM, no AWS. Used by the page
   * and by tests. */
  function validateSplitSelection(entry) {
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

  function currentMode() {
    if (els.modeRanges && els.modeRanges.checked) return "ranges";
    return "all";
  }

  function setStep(name) {
    var order = ["select", "upload", "process", "done"];
    var idx = order.indexOf(name);
    order.forEach(function (key) {
      var li = $("splitStep" + key.charAt(0).toUpperCase() + key.slice(1));
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
    $("splitErrorMessage").textContent = friendly;
    $("splitErrorDetails").textContent = technical || friendly;
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
    var validation = validateSplitSelection(file);
    var mode = currentMode();
    var rangesOk = true;
    var rangesError = "";
    if (mode === "ranges") {
      var parsed = window.PdfCloud.parseSplitRanges(els.ranges.value);
      rangesOk = parsed.ok;
      rangesError = parsed.error;
    }
    if (els.rangesWrap) els.rangesWrap.hidden = mode !== "ranges";
    if (els.hint) {
      if (!file) els.hint.textContent = "Select a PDF file to begin.";
      else if (!validation.ok) els.hint.textContent = validation.errors[0];
      else if (!rangesOk) els.hint.textContent = rangesError;
      else if (mode === "ranges") els.hint.textContent = "Ranges look good — one PDF per range, in the order listed.";
      else els.hint.textContent = "Every page will become its own PDF inside one ZIP.";
    }
    if (busy) {
      els.splitBtn.disabled = true;
      els.splitBtn.textContent = "Working…";
    } else if (!validation.ok || !rangesOk) {
      els.splitBtn.disabled = true;
      els.splitBtn.textContent = !file ? "Select a PDF to begin" : "Fix issues to continue";
    } else {
      els.splitBtn.disabled = false;
      els.splitBtn.textContent = "Split PDF";
    }
    if (els.fileName) {
      els.fileName.textContent = file
        ? file.name + " (" + window.PdfCloud.formatBytes(file.size) + ")"
        : "No file selected.";
    }
    return { validation: validation, rangesOk: rangesOk };
  }

  function addFile(picked) {
    clearError();
    els.result.hidden = true;
    var list = Array.prototype.slice.call(picked || []);
    if (!list.length) return;
    if (list.length > 1) {
      showError(
        "Split works on one PDF at a time — the first file was kept.",
        "User picked " + list.length + " files; kept the first."
      );
    }
    file = list[0];
    setStatus("Ready — “" + file.name + "” selected.");
    refresh();
  }

  function resetAll() {
    file = null;
    busy = false;
    lastOutputKey = null;
    els.input.value = "";
    els.ranges.value = "";
    if (els.modeAll) els.modeAll.checked = true;
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
    var mode = currentMode();
    var ranges = [];
    if (mode === "ranges") {
      var parsed = window.PdfCloud.parseSplitRanges(els.ranges.value);
      if (!parsed.ok) {
        showError(parsed.error, parsed.error);
        return;
      }
      ranges = parsed.ranges;
    }
    busy = true;
    clearError();
    els.result.hidden = true;
    refresh();

    var requestId = window.PdfCloud.newSplitRequestId();
    var safeBase = window.PdfCloud.sanitizeMergeBase(file.name);
    var inputKey = window.PdfCloud.splitInputKey(requestId, safeBase);
    var manifest = window.PdfCloud.buildSplitManifest(
      requestId, inputKey, mode, ranges, safeBase);
    var expectedOutput = window.PdfCloud.expectedSplitOutputKey(
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
      setStatus("Starting split…");
      return window.PdfCloud.putSplitManifest(requestId, manifest);
    }).then(function () {
      // 3) Poll for the EXACT ZIP key for this request.
      setStep("process");
      setStatus("Splitting PDF…");
      return window.PdfCloud.pollForExactOutput(expectedOutput, function (attempt, max) {
        setStatus("Splitting PDF… (check " + attempt + " of " + max + ")");
      });
    }).then(function (result) {
      lastOutputKey = result.outputKey;
      setStep("done");
      setStatus("Complete — your ZIP is ready below.");
      setProgress(100);
      $("splitResultName").textContent = result.outputKey.split("/").pop();
      $("splitResultMode").textContent = mode === "ranges"
        ? ranges.length + " range(s): " + ranges.join(", ")
        : "Every page as its own PDF";
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
      var name = $("splitResultName").textContent;
      window.PdfCloud.downloadOutput(lastOutputKey, name || undefined);
      setStatus("Complete — your ZIP is ready below.");
    } catch (err) {
      showAwsError(err, "download");
    }
  }

  function wireDropzone() {
    var dz = $("splitDropzone");
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
      input: $("splitFiles"),
      modeAll: $("splitModeAll"),
      modeRanges: $("splitModeRanges"),
      ranges: $("splitRanges"),
      rangesWrap: $("splitRangesWrap"),
      hint: $("splitHint"),
      fileName: $("splitFileName"),
      splitBtn: $("splitBtn"),
      downloadBtn: $("splitDownloadBtn"),
      status: $("splitStatus"),
      fill: $("splitProgressFill"),
      percent: $("splitProgressPercent"),
      progressWrap: $("splitProgressWrap"),
      result: $("splitResultCard"),
      errorCard: $("splitErrorCard")
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
    els.splitBtn.addEventListener("click", run);
    els.downloadBtn.addEventListener("click", download);
    $("splitResetBtn").addEventListener("click", resetAll);
    $("splitRetryBtn").addEventListener("click", function () {
      clearError();
      if (!busy && file) run();
      else setStatus("Select a PDF to begin.");
    });
    wireDropzone();
  });

  /* Exposed for static/unit tests (no DOM or AWS needed for these). */
  window.PdfSplit = {
    validateSplitSelection: validateSplitSelection
  };
})();

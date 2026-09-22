/* Rotate PDF page logic.
 *
 * Flow:
 *   select one PDF (picker + drag&drop) -> validate (PDF type, <=100MB) ->
 *   choose rotation (90° / 180° / 270° clockwise) + pages (all | ranges
 *   like 1-3,5) -> upload PDF to uploads/<request-id>/<safe>.pdf ->
 *   upload manifest rotate-requests/<request-id>.rotate.json LAST ->
 *   poll exact output key rotate/<request-id>/<stem>-rotated.pdf ->
 *   presigned download of the rotated PDF.
 *
 * Pure helpers are exposed on window.PdfRotate for static tests.
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
  function validateRotateSelection(entry) {
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

  function currentAngle() {
    var checked = document.querySelector('input[name="rotateAngle"]:checked');
    return window.PdfCloud.parseRotateAngle(checked ? checked.value : "");
  }

  function currentPagesMode() {
    if (els.pagesSelected && els.pagesSelected.checked) return "selected";
    return "all";
  }

  function setStep(name) {
    var order = ["select", "upload", "process", "done"];
    var idx = order.indexOf(name);
    order.forEach(function (key) {
      var li = $("rotateStep" + key.charAt(0).toUpperCase() + key.slice(1));
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
    $("rotateErrorMessage").textContent = friendly;
    $("rotateErrorDetails").textContent = technical || friendly;
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
    var validation = validateRotateSelection(file);
    var angle = currentAngle();
    var mode = currentPagesMode();
    var rangesOk = true;
    var rangesError = "";
    if (mode === "selected") {
      var parsed = window.PdfCloud.parseSplitRanges(els.ranges.value);
      rangesOk = parsed.ok;
      rangesError = parsed.error;
    }
    if (els.rangesWrap) els.rangesWrap.hidden = mode !== "selected";
    if (els.hint) {
      if (!file) els.hint.textContent = "Select a PDF file to begin.";
      else if (!validation.ok) els.hint.textContent = validation.errors[0];
      else if (!angle.ok) els.hint.textContent = angle.error;
      else if (!rangesOk) els.hint.textContent = rangesError;
      else if (mode === "selected") els.hint.textContent = "Only the listed pages will rotate — everything else stays as-is.";
      else els.hint.textContent = "Every page will rotate — order and content stay the same.";
    }
    if (busy) {
      els.rotateBtn.disabled = true;
      els.rotateBtn.textContent = "Working…";
    } else if (!validation.ok || !angle.ok || !rangesOk) {
      els.rotateBtn.disabled = true;
      els.rotateBtn.textContent = !file ? "Select a PDF to begin" : "Fix issues to continue";
    } else {
      els.rotateBtn.disabled = false;
      els.rotateBtn.textContent = "Rotate PDF";
    }
    if (els.fileName) {
      els.fileName.textContent = file
        ? file.name + " (" + window.PdfCloud.formatBytes(file.size) + ")"
        : "No file selected.";
    }
    return { validation: validation, angle: angle, rangesOk: rangesOk };
  }

  function addFile(picked) {
    clearError();
    els.result.hidden = true;
    var list = Array.prototype.slice.call(picked || []);
    if (!list.length) return;
    if (list.length > 1) {
      showError(
        "Rotate works on one PDF at a time — the first file was kept.",
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
    var first = document.querySelector('input[name="rotateAngle"][value="90"]');
    if (first) first.checked = true;
    if (els.pagesAll) els.pagesAll.checked = true;
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
    if (!state.angle.ok) {
      showError(state.angle.error, state.angle.error);
      return;
    }
    var mode = currentPagesMode();
    var pages = "all";
    if (mode === "selected") {
      var parsed = window.PdfCloud.parseSplitRanges(els.ranges.value);
      if (!parsed.ok) {
        showError(parsed.error, parsed.error);
        return;
      }
      pages = parsed.ranges;
    }
    busy = true;
    clearError();
    els.result.hidden = true;
    refresh();

    var requestId = window.PdfCloud.newRotateRequestId();
    var safeBase = window.PdfCloud.sanitizeMergeBase(file.name);
    var inputKey = window.PdfCloud.rotateInputKey(requestId, safeBase);
    var manifest = window.PdfCloud.buildRotateManifest(
      requestId, inputKey, state.angle.angle, pages, safeBase);
    var expectedOutput = window.PdfCloud.expectedRotateOutputKey(
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
      setStatus("Starting rotation…");
      return window.PdfCloud.putRotateManifest(requestId, manifest);
    }).then(function () {
      // 3) Poll for the EXACT output key for this request.
      setStep("process");
      setStatus("Rotating PDF…");
      return window.PdfCloud.pollForExactOutput(expectedOutput, function (attempt, max) {
        setStatus("Rotating PDF… (check " + attempt + " of " + max + ")");
      });
    }).then(function (result) {
      lastOutputKey = result.outputKey;
      setStep("done");
      setStatus("Complete — your rotated PDF is ready below.");
      setProgress(100);
      $("rotateResultName").textContent = result.outputKey.split("/").pop();
      $("rotateResultMode").textContent = state.angle.angle + "° clockwise, " +
        (pages === "all" ? "all pages" : "pages " + pages.join(", "));
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
      window.PdfCloud.downloadOutput(lastOutputKey);
      setStatus("Complete — your rotated PDF is ready below.");
    } catch (err) {
      showAwsError(err, "download");
    }
  }

  function wireDropzone() {
    var dz = $("rotateDropzone");
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
      input: $("rotateFiles"),
      ranges: $("rotateRanges"),
      rangesWrap: $("rotateRangesWrap"),
      pagesAll: $("rotatePagesAll"),
      pagesSelected: $("rotatePagesSelected"),
      hint: $("rotateHint"),
      fileName: $("rotateFileName"),
      rotateBtn: $("rotateBtn"),
      downloadBtn: $("rotateDownloadBtn"),
      status: $("rotateStatus"),
      fill: $("rotateProgressFill"),
      percent: $("rotateProgressPercent"),
      progressWrap: $("rotateProgressWrap"),
      result: $("rotateResultCard"),
      errorCard: $("rotateErrorCard")
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
    var angleRadios = document.querySelectorAll('input[name="rotateAngle"]');
    Array.prototype.forEach.call(angleRadios, function (r) {
      r.addEventListener("change", refresh);
    });
    els.pagesAll.addEventListener("change", refresh);
    els.pagesSelected.addEventListener("change", refresh);
    els.ranges.addEventListener("input", refresh);
    els.rotateBtn.addEventListener("click", run);
    els.downloadBtn.addEventListener("click", download);
    $("rotateResetBtn").addEventListener("click", resetAll);
    $("rotateRetryBtn").addEventListener("click", function () {
      clearError();
      if (!busy && file) run();
      else setStatus("Select a PDF to begin.");
    });
    wireDropzone();
  });

  /* Exposed for static/unit tests (no DOM or AWS needed for these). */
  window.PdfRotate = {
    validateRotateSelection: validateRotateSelection
  };
})();

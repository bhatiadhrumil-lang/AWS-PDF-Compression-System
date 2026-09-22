/* Delete Pages page logic.
 *
 * Flow:
 *   select one PDF (picker + drag&drop) -> validate (PDF type, <=100MB) ->
 *   enter pages to REMOVE (like 2-4,7) -> upload PDF to
 *   uploads/<request-id>/<safe>.pdf ->
 *   upload manifest delete-requests/<request-id>.delete.json LAST ->
 *   poll exact output key delete/<request-id>/<stem>-deleted.pdf ->
 *   presigned download of the trimmed PDF.
 *
 * Pure helpers are exposed on window.PdfDelete for static tests.
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
  function validateDeleteSelection(entry) {
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

  function setStep(name) {
    var order = ["select", "upload", "process", "done"];
    var idx = order.indexOf(name);
    order.forEach(function (key) {
      var li = $("deleteStep" + key.charAt(0).toUpperCase() + key.slice(1));
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
    $("deleteErrorMessage").textContent = friendly;
    $("deleteErrorDetails").textContent = technical || friendly;
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
    var validation = validateDeleteSelection(file);
    var parsed = window.PdfCloud.parseSplitRanges(els.pages.value);
    var pagesOk = parsed.ok;
    if (els.hint) {
      if (!file) els.hint.textContent = "Select a PDF file to begin.";
      else if (!validation.ok) els.hint.textContent = validation.errors[0];
      else if (!pagesOk) els.hint.textContent = parsed.error;
      else els.hint.textContent = "These pages will be removed — everything else stays in order.";
    }
    if (busy) {
      els.deleteBtn.disabled = true;
      els.deleteBtn.textContent = "Working…";
    } else if (!validation.ok || !pagesOk) {
      els.deleteBtn.disabled = true;
      els.deleteBtn.textContent = !file ? "Select a PDF to begin" : "Fix issues to continue";
    } else {
      els.deleteBtn.disabled = false;
      els.deleteBtn.textContent = "Delete Pages";
    }
    if (els.fileName) {
      els.fileName.textContent = file
        ? file.name + " (" + window.PdfCloud.formatBytes(file.size) + ")"
        : "No file selected.";
    }
    return { validation: validation, parsed: parsed };
  }

  function addFile(picked) {
    clearError();
    els.result.hidden = true;
    var list = Array.prototype.slice.call(picked || []);
    if (!list.length) return;
    if (list.length > 1) {
      showError(
        "Delete works on one PDF at a time — the first file was kept.",
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
    els.pages.value = "";
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
    if (!state.parsed.ok) {
      showError(state.parsed.error, state.parsed.error);
      return;
    }
    var pages = state.parsed.ranges;
    busy = true;
    clearError();
    els.result.hidden = true;
    refresh();

    var requestId = window.PdfCloud.newDeleteRequestId();
    var safeBase = window.PdfCloud.sanitizeMergeBase(file.name);
    var inputKey = window.PdfCloud.deleteInputKey(requestId, safeBase);
    var manifest = window.PdfCloud.buildDeleteManifest(
      requestId, inputKey, pages, safeBase);
    var expectedOutput = window.PdfCloud.expectedDeleteOutputKey(
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
      setStatus("Removing pages…");
      return window.PdfCloud.putDeleteManifest(requestId, manifest);
    }).then(function () {
      // 3) Poll for the EXACT output key for this request.
      setStep("process");
      setStatus("Removing pages…");
      return window.PdfCloud.pollForExactOutput(expectedOutput, function (attempt, max) {
        setStatus("Removing pages… (check " + attempt + " of " + max + ")");
      });
    }).then(function (result) {
      lastOutputKey = result.outputKey;
      setStep("done");
      setStatus("Complete — your PDF is ready below.");
      setProgress(100);
      $("deleteResultName").textContent = result.outputKey.split("/").pop();
      $("deleteResultMode").textContent = "Removed pages: " + pages.join(", ");
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
      setStatus("Complete — your PDF is ready below.");
    } catch (err) {
      showAwsError(err, "download");
    }
  }

  function wireDropzone() {
    var dz = $("deleteDropzone");
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
      input: $("deleteFiles"),
      pages: $("deletePages"),
      hint: $("deleteHint"),
      fileName: $("deleteFileName"),
      deleteBtn: $("deleteBtn"),
      downloadBtn: $("deleteDownloadBtn"),
      status: $("deleteStatus"),
      fill: $("deleteProgressFill"),
      percent: $("deleteProgressPercent"),
      progressWrap: $("deleteProgressWrap"),
      result: $("deleteResultCard"),
      errorCard: $("deleteErrorCard")
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
    els.pages.addEventListener("input", refresh);
    els.deleteBtn.addEventListener("click", run);
    els.downloadBtn.addEventListener("click", download);
    $("deleteResetBtn").addEventListener("click", resetAll);
    $("deleteRetryBtn").addEventListener("click", function () {
      clearError();
      if (!busy && file) run();
      else setStatus("Select a PDF to begin.");
    });
    wireDropzone();
  });

  /* Exposed for static/unit tests (no DOM or AWS needed for these). */
  window.PdfDelete = {
    validateDeleteSelection: validateDeleteSelection
  };
})();

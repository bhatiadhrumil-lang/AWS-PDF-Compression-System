/* Compressor page logic.
 * Flow (same AWS behavior as the original script.js):
 *   select -> validate -> upload (Cognito -> S3 input) ->
 *   poll output bucket -> stats -> presigned download.
 * The UI always shows the ORIGINAL filename; PdfCloud sanitizes only the S3 key.
 */
(function () {
  var els = {};
  var selectedFile = null;
  var busy = false;
  var lastOutputKey = null;
  var lastInputKey = null;

  function $(id) {
    return document.getElementById(id);
  }

  function setStep(name) {
    var order = ["select", "upload", "process", "done"];
    var idx = order.indexOf(name);
    order.forEach(function (key, i) {
      var li = $("step" + key.charAt(0).toUpperCase() + key.slice(1));
      if (!li) return;
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

  function showError(err, context) {
    els.errorCard.hidden = false;
    $("errorMessage").textContent = window.PdfCloud.friendlyError(err, context);
    $("errorDetails").textContent = window.PdfCloud.technicalDetails(err);
    setStatus("Something went wrong — see below.");
  }

  function clearError() {
    els.errorCard.hidden = true;
  }

  function resetAll() {
    selectedFile = null;
    busy = false;
    lastOutputKey = null;
    lastInputKey = null;
    els.input.value = "";
    els.meta.hidden = true;
    els.result.hidden = true;
    els.errorCard.hidden = true;
    els.progressWrap.hidden = true;
    els.fill.style.width = "0";
    els.percent.textContent = "";
    els.uploadBtn.disabled = true;
    els.uploadBtn.textContent = "Select a PDF first";
    setStep("select");
    setStatus("Ready — select a PDF to begin.");
  }

  function validationMessage(reason) {
    switch (reason) {
      case "type":
        return "That doesn't look like a PDF. Please choose a file ending in .pdf.";
      case "size":
        return (
          "That file is over the " +
          window.PdfConfig.MAX_FILE_SIZE_MB +
          " MB limit. Please choose a smaller PDF."
        );
      case "empty":
        return "That file appears to be empty. Please choose a valid PDF.";
      default:
        return "That file can't be used. Please choose a valid PDF.";
    }
  }

  function onFileChosen(file) {
    clearError();
    els.result.hidden = true;
    if (!file) return;
    var check = window.PdfCloud.validatePdfFile(file);
    if (!check.ok) {
      showError({ code: "InvalidFile", message: validationMessage(check.reason) }, "select");
      return;
    }
    selectedFile = file;
    // Display the ORIGINAL filename exactly as-is (never URL-encoded for display).
    $("fileName").textContent = file.name;
    $("fileSize").textContent = window.PdfCloud.formatBytes(file.size);
    els.meta.hidden = false;
    els.uploadBtn.disabled = false;
    els.uploadBtn.textContent = "Compress PDF";
    setStep("select");
    setStatus("Ready to compress “" + file.name + "”.");
  }

  function run() {
    if (!selectedFile || busy) return;
    busy = true;
    clearError();
    els.result.hidden = true;
    els.uploadBtn.disabled = true;
    els.uploadBtn.textContent = "Working…";

    setStep("upload");
    setStatus("Uploading…");
    setProgress(0);

    window.PdfCloud.uploadPdf(selectedFile, setProgress).then(
      function (inputKey) {
        lastInputKey = inputKey;
        setProgress(100);
        setStep("process");
        setStatus("Compressing in the cloud — this usually takes under a minute…");
        return window.PdfCloud.pollForOutput(inputKey, function (attempt, max) {
          setStatus("Compressing in the cloud… (check " + attempt + " of " + max + ")");
        });
      }
    ).then(
      function (result) {
        lastOutputKey = result.outputKey;
        setStep("done");
        var original = selectedFile.size;
        var compressed = result.size;
        $("resultName").textContent = selectedFile.name;
        $("resultOriginal").textContent = window.PdfCloud.formatBytes(original);
        $("resultCompressed").textContent =
          compressed > 0 ? window.PdfCloud.formatBytes(compressed) : "Available on download";
        var reduction =
          compressed > 0 && original > 0
            ? Math.max(0, Math.round((1 - compressed / original) * 100)) + "% smaller"
            : "—";
        $("resultReduction").textContent = reduction;
        els.result.hidden = false;
        els.uploadBtn.textContent = "Compress PDF";
        els.uploadBtn.disabled = false;
        busy = false;
        setStatus("Done — your compressed PDF is ready below.");
        if (els.downloadBtn) els.downloadBtn.focus();
      },
      function (err) {
        busy = false;
        els.uploadBtn.disabled = false;
        els.uploadBtn.textContent = "Compress PDF";
        showError(err, err && err.code === "PollTimeout" ? "poll" : "upload");
      }
    );
  }

  function download() {
    if (!lastOutputKey) return;
    try {
      // Keep the user's original filename in the save dialog.
      window.PdfCloud.downloadOutput(
        lastOutputKey, "compressed-" + selectedFile.name);
    } catch (err) {
      showError(err, "download");
    }
  }

  function wireDropzone() {
    var dz = $("dropzone");
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
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) onFileChosen(f);
    });
    // Keyboard users: Enter/Space on the label opens the file dialog natively.
  }

  document.addEventListener("DOMContentLoaded", function () {
    els = {
      input: $("pdfFile"),
      uploadBtn: $("uploadBtn"),
      downloadBtn: $("downloadBtn"),
      status: $("statusText"),
      fill: $("progressFill"),
      percent: $("progressPercent"),
      progressWrap: $("progressWrap"),
      meta: $("fileMeta"),
      result: $("resultCard"),
      errorCard: $("errorCard")
    };
    try {
      window.PdfCloud.init();
    } catch (err) {
      showError(err, "upload");
      return;
    }
    setStep("select");
    els.input.addEventListener("change", function () {
      onFileChosen(els.input.files[0]);
    });
    els.uploadBtn.addEventListener("click", run);
    els.downloadBtn.addEventListener("click", download);
    $("resetBtn").addEventListener("click", resetAll);
    $("retryBtn").addEventListener("click", function () {
      clearError();
      if (selectedFile && !els.result.hidden) return;
      if (selectedFile) run();
      else setStatus("Select a PDF to begin.");
    });
    wireDropzone();
  });
})();

/* Protect PDF logic.
 *
 * Flow:
 *   select one PDF (picker + drag&drop) -> validate (PDF type, <=100MB) ->
 *   choose a password + confirmation (>=8 chars, must match) ->
 *   upload PDF to uploads/<request-id>/<safe>.pdf ->
 *   upload manifest protect-requests/<request-id>.protect.json LAST ->
 *   poll exact output key protected/<request-id>/<stem>-protected.pdf ->
 *   presigned download of the new encrypted PDF (source never modified).
 *
 * The password is treated as sensitive data end to end:
 *   - never logged, never written into filenames/output keys, never kept
 *     after the run finishes (cleared on success and on reset);
 *   - it MUST ride in the manifest so the backend can encrypt with it, and
 *     that manifest is uploaded LAST, exactly like the other triggers.
 *
 * Pure helpers are exposed on window.PdfProtect for static tests.
 */
(function () {
  var els = {};
  var file = null;
  var busy = false;
  var lastOutputKey = null;
  var password = null;

  function $(id) {
    return document.getElementById(id);
  }

  function cfg() {
    return window.PdfConfig;
  }

  /* Pure validation over {name, size} — no DOM, no AWS. Used by the page
   * and by tests. */
  function validateProtectSelection(entry) {
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
      var li = $("protectStep" + key.charAt(0).toUpperCase() + key.slice(1));
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
    $("protectErrorMessage").textContent = friendly;
    $("protectErrorDetails").textContent = technical || friendly;
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

  function clearPasswords() {
    if (els.password) els.password.value = "";
    if (els.confirm) els.confirm.value = "";
    password = null;
  }

  function refresh() {
    var validation = validateProtectSelection(file);
    var pwdCheck = password !== null && password !== undefined
      ? window.PdfCloud.validateProtectPasswords(
          password, els.confirm ? els.confirm.value : "")
      : { ok: true, errors: [] };
    var ready = validation.ok && pwdCheck.ok && !busy;
    if (els.hint) {
      if (!file) els.hint.textContent = "Select a PDF file to begin.";
      else if (!validation.ok) els.hint.textContent = validation.errors[0];
      else els.hint.textContent = "Choose a password of at least " +
        (cfg().PROTECT_MIN_PASSWORD_LEN || 8) + " characters.";
    }
    if (els.fileName) {
      els.fileName.textContent = file
        ? file.name + " (" + window.PdfCloud.formatBytes(file.size) + ")"
        : "No file selected.";
    }
    if (els.pwdHint) {
      if (pwdCheck.ok) els.pwdHint.textContent = "";
      else els.pwdHint.textContent = pwdCheck.errors[0];
    }
    if (busy) {
      els.protectBtn.disabled = true;
      els.protectBtn.textContent = "Working…";
    } else if (!validation.ok) {
      els.protectBtn.disabled = true;
      els.protectBtn.textContent = "Select a PDF to begin";
    } else if (!pwdCheck.ok) {
      els.protectBtn.disabled = true;
      els.protectBtn.textContent = "Fix the password to continue";
    } else {
      els.protectBtn.disabled = false;
      els.protectBtn.textContent = "Protect PDF";
    }
    return { validation: validation, passwords: pwdCheck };
  }

  function addFile(picked) {
    clearError();
    els.result.hidden = true;
    var list = Array.prototype.slice.call(picked || []);
    if (!list.length) return;
    if (list.length > 1) {
      showError(
        "Protect works on one PDF at a time — the first file was kept.",
        "User picked " + list.length + " files; kept the first."
      );
    }
    file = list[0];
    clearPasswords();
    setStatus("Ready — “" + file.name + "” selected.");
    refresh();
  }

  function resetAll() {
    file = null;
    busy = false;
    lastOutputKey = null;
    els.input.value = "";
    clearPasswords();
    els.result.hidden = true;
    els.errorCard.hidden = true;
    els.progressWrap.hidden = true;
    els.fill.style.width = "0";
    els.percent.textContent = "";
    setStep("select");
    setStatus("Ready — select a PDF and choose a password to begin.");
    refresh();
  }

  function run() {
    if (busy || !file) return;
    var state = refresh();
    if (!state.validation.ok) {
      showError(state.validation.errors[0], state.validation.errors.join(" "));
      return;
    }
    var pwdCheck = window.PdfCloud.validateProtectPasswords(
      password, els.confirm ? els.confirm.value : "");
    if (!pwdCheck.ok) {
      showError(pwdCheck.errors[0], pwdCheck.errors.join(" "));
      clearError();
      refresh();
      return;
    }
    busy = true;
    clearError();
    els.result.hidden = true;
    refresh();

    var requestId = window.PdfCloud.newProtectRequestId();
    var safeBase = window.PdfCloud.sanitizeMergeBase(file.name);
    var inputKey = window.PdfCloud.protectInputKey(requestId, safeBase);
    var usePassword = String(password || "");
    var manifest = window.PdfCloud.buildProtectManifest(
      requestId, inputKey, usePassword, safeBase);
    var expectedOutput = window.PdfCloud.expectedProtectOutputKey(
      requestId, safeBase);

    setStep("upload");
    setStatus("Uploading “" + file.name + "”…");
    setProgress(0);

    // 1) Upload the PDF first (the manifest must never win the race).
    window.PdfCloud.uploadMergePdf(file, inputKey, function (pct) {
      setProgress(pct);
    }).then(function () {
      // 2) PDF succeeded → upload the manifest (the Lambda trigger),
      //    carrying the password (the only object that must contain it).
      setProgress(100);
      setStatus("Starting protect…");
      // Sensitive value consumed by the manifest; drop the local copy now.
      usePassword = "";
      password = null;
      return window.PdfCloud.putProtectManifest(requestId, manifest);
    }).then(function () {
      // 3) Poll for the EXACT encrypted PDF key for this request.
      setStep("process");
      setStatus("Encrypting and protecting…");
      return window.PdfCloud.pollForExactOutput(expectedOutput, function (attempt, max) {
        setStatus("Encrypting and protecting… (check " + attempt + " of " + max + ")");
      });
    }).then(function (result) {
      lastOutputKey = result.outputKey;
      setStep("done");
      setStatus("Complete — your password-protected PDF is ready below.");
      setProgress(100);
      $("protectResultName").textContent = result.outputKey.split("/").pop();
      els.result.hidden = false;
      busy = false;
      clearPasswords();
      refresh();
      if (els.downloadBtn) els.downloadBtn.focus();
    }).catch(function (err) {
      busy = false;
      clearPasswords();
      refresh();
      var context = err && err.code === "PollTimeout" ? "poll" : "upload";
      showAwsError(err, context);
    });
  }

  function download() {
    if (!lastOutputKey) return;
    try {
      setStatus("Preparing download…");
      var name = $("protectResultName").textContent;
      window.PdfCloud.downloadOutput(lastOutputKey, name || undefined);
      setStatus("Complete — your password-protected PDF is ready below.");
    } catch (err) {
      showAwsError(err, "download");
    }
  }

  function wireDropzone() {
    var dz = $("protectDropzone");
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

  function wirePasswordToggles() {
    function bind(buttonId, inputId) {
      var btn = $(buttonId);
      var input = $(inputId);
      if (!btn || !input) return;
      btn.addEventListener("click", function () {
        var show = input.type === "password";
        input.type = show ? "text" : "password";
        btn.textContent = show ? "Hide" : "Show";
      });
    }
    bind("protectToggle1", "protectPassword");
    bind("protectToggle2", "protectConfirm");
  }

  document.addEventListener("DOMContentLoaded", function () {
    els = {
      input: $("protectFiles"),
      hint: $("protectHint"),
      pwdHint: $("protectPwdHint"),
      fileName: $("protectFileName"),
      password: $("protectPassword"),
      confirm: $("protectConfirm"),
      protectBtn: $("protectBtn"),
      downloadBtn: $("protectDownloadBtn"),
      status: $("protectStatus"),
      fill: $("protectProgressFill"),
      percent: $("protectProgressPercent"),
      progressWrap: $("protectProgressWrap"),
      result: $("protectResultCard"),
      errorCard: $("protectErrorCard")
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
    els.password.addEventListener("input", function () {
      password = els.password.value;
      clearError();
      refresh();
    });
    els.confirm.addEventListener("input", function () {
      clearError();
      refresh();
    });
    els.protectBtn.addEventListener("click", run);
    els.downloadBtn.addEventListener("click", download);
    $("protectAnotherBtn").addEventListener("click", resetAll);
    $("protectRetryBtn").addEventListener("click", function () {
      clearError();
      if (!busy && file) run();
      else setStatus("Select a PDF to begin.");
    });
    wireDropzone();
    wirePasswordToggles();
  });

  /* Exposed for static/unit tests (no DOM or AWS needed for these). */
  window.PdfProtect = {
    validateProtectSelection: validateProtectSelection
  };
})();
/* Merge PDF page logic.
 *
 * Flow:
 *   select (picker + drag&drop, multiple) -> validate (2-20 files, PDF type,
 *   <=100MB each, <=200MB total) -> list with reorder (drag + up/down) and
 *   remove -> upload each PDF to uploads/<request-id>/ in UI order ->
 *   upload manifest merge-requests/<request-id>.merge.json LAST ->
 *   poll exact output key merged-<request-id>.pdf -> presigned download.
 *
 * The final order sent to the backend exactly matches the UI order.
 * Pure helpers are exposed on window.PdfMerge for static tests.
 */
(function () {
  var els = {};
  var files = []; // [{ id, file, safeBase }]
  var busy = false;
  var lastOutputKey = null;
  var lastRequestId = null;
  var lastInputCount = 0;
  var lastInputBytes = 0;
  var uidCounter = 0;

  function $(id) {
    return document.getElementById(id);
  }

  function cfg() {
    return window.PdfConfig;
  }

  function limits() {
    var c = cfg();
    return {
      min: c.MERGE_MIN_FILES || 2,
      max: c.MERGE_MAX_FILES || 20,
      perFile: (c.MAX_FILE_SIZE_MB || 100) * 1024 * 1024,
      total: (c.MERGE_MAX_TOTAL_MB || 200) * 1024 * 1024
    };
  }

  function isPdfName(name) {
    var ext = String(name || "").split(".").pop().toLowerCase();
    return (cfg().ALLOWED_EXTENSIONS || ["pdf"]).indexOf(ext) !== -1;
  }

  /* Pure validation over [{name, size}] — no DOM, no AWS. Returns
   * { ok, errors[], totalBytes }. Used by the page and by tests. */
  function validateMergeSelection(entries) {
    var L = limits();
    var errors = [];
    var total = 0;
    var list = entries || [];
    for (var i = 0; i < list.length; i++) {
      total += list[i].size || 0;
    }
    if (list.length < L.min) {
      errors.push("Please select at least 2 PDF files.");
    }
    if (list.length > L.max) {
      errors.push("You can merge up to 20 PDFs at a time.");
    }
    for (var j = 0; j < list.length; j++) {
      var e = list[j];
      if (!isPdfName(e.name)) {
        errors.push("“" + e.name + "” is not a PDF. Please choose files ending in .pdf.");
        break;
      }
      if (!e.size || e.size <= 0) {
        errors.push("“" + e.name + "” appears to be empty.");
        break;
      }
      if (e.size > L.perFile) {
        errors.push("“" + e.name + "” is larger than the 100 MB limit.");
        break;
      }
    }
    if (total > L.total) {
      errors.push("The combined file size cannot exceed 200 MB.");
    }
    return { ok: errors.length === 0, errors: errors, totalBytes: total };
  }

  function moveItem(arr, from, to) {
    if (to < 0 || to >= arr.length) return arr;
    var item = arr.splice(from, 1)[0];
    arr.splice(to, 0, item);
    return arr;
  }

  /* Assign de-duplicated safe basenames within one request so distinct keys
   * never overwrite each other (e.g. two "Report.pdf" -> Report.pdf,
   * Report_2.pdf). Pure over name list; tested. */
  function assignSafeBases(names) {
    var seen = {};
    return (names || []).map(function (original) {
      var safe = window.PdfCloud.sanitizeMergeBase(original);
      var dot = safe.lastIndexOf(".");
      var base = dot > 0 ? safe.slice(0, dot) : safe;
      var ext = dot > 0 ? safe.slice(dot) : ".pdf";
      var candidate = safe;
      var n = 2;
      while (seen[candidate]) {
        candidate = base + "_" + n + ext;
        n++;
      }
      seen[candidate] = true;
      return candidate;
    });
  }

  function totalBytes() {
    return files.reduce(function (acc, f) { return acc + (f.file.size || 0); }, 0);
  }

  function setStep(name) {
    var order = ["select", "upload", "process", "done"];
    var idx = order.indexOf(name);
    order.forEach(function (key) {
      var li = $("mergeStep" + key.charAt(0).toUpperCase() + key.slice(1));
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
    $("mergeErrorMessage").textContent = friendly;
    $("mergeErrorDetails").textContent = technical || friendly;
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

  function refreshTotals() {
    var L = limits();
    els.count.textContent = "Files: " + files.length + " / " + L.max;
    els.totalSize.textContent =
      "Total size: " + window.PdfCloud.formatBytes(totalBytes()) + " / " + L.total / 1024 / 1024 + " MB";
  }

  function refreshButton(validation) {
    if (busy) {
      els.mergeBtn.disabled = true;
      els.mergeBtn.textContent = "Working…";
      return;
    }
    if (!validation.ok) {
      els.mergeBtn.disabled = true;
      els.mergeBtn.textContent =
        files.length < limits().min ? "Select at least 2 PDFs" : "Fix issues to continue";
      return;
    }
    els.mergeBtn.disabled = false;
    els.mergeBtn.textContent = "Merge PDFs";
  }

  function renderList() {
    var validation = validateMergeSelection(files.map(function (f) {
      return { name: f.file.name, size: f.file.size };
    }));
    els.list.innerHTML = "";
    files.forEach(function (entry, idx) {
      var li = document.createElement("li");
      li.className = "merge-item";
      li.draggable = true;
      li.dataset.uid = entry.id;
      li.setAttribute("aria-label", (idx + 1) + " of " + files.length + ": " + entry.file.name);

      var pos = document.createElement("span");
      pos.className = "merge-pos";
      pos.textContent = String(idx + 1);
      li.appendChild(pos);

      var icon = document.createElement("span");
      icon.className = "merge-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = "📄";
      li.appendChild(icon);

      var meta = document.createElement("div");
      meta.className = "merge-meta";
      var nameEl = document.createElement("span");
      nameEl.className = "merge-name";
      nameEl.textContent = entry.file.name;
      nameEl.title = entry.file.name;
      var sizeEl = document.createElement("span");
      sizeEl.className = "merge-size";
      sizeEl.textContent = window.PdfCloud.formatBytes(entry.file.size);
      meta.appendChild(nameEl);
      meta.appendChild(sizeEl);
      li.appendChild(meta);

      var controls = document.createElement("div");
      controls.className = "merge-controls";

      var up = document.createElement("button");
      up.type = "button";
      up.className = "mini-btn";
      up.textContent = "↑";
      up.setAttribute("aria-label", "Move " + entry.file.name + " up");
      up.disabled = idx === 0;
      up.addEventListener("click", function () {
        moveEntry(entry.id, -1);
      });

      var down = document.createElement("button");
      down.type = "button";
      down.className = "mini-btn";
      down.textContent = "↓";
      down.setAttribute("aria-label", "Move " + entry.file.name + " down");
      down.disabled = idx === files.length - 1;
      down.addEventListener("click", function () {
        moveEntry(entry.id, 1);
      });

      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "mini-btn danger";
      remove.textContent = "✕";
      remove.setAttribute("aria-label", "Remove " + entry.file.name);
      remove.addEventListener("click", function () {
        removeEntry(entry.id);
      });

      controls.appendChild(up);
      controls.appendChild(down);
      controls.appendChild(remove);
      li.appendChild(controls);

      // HTML5 drag & drop reordering (no dependencies).
      li.addEventListener("dragstart", function (e) {
        e.dataTransfer.setData("text/plain", entry.id);
        li.classList.add("dragging");
      });
      li.addEventListener("dragend", function () {
        li.classList.remove("dragging");
      });
      li.addEventListener("dragover", function (e) {
        e.preventDefault();
      });
      li.addEventListener("drop", function (e) {
        e.preventDefault();
        var draggedId = e.dataTransfer.getData("text/plain");
        reorderByDrop(draggedId, entry.id);
      });

      els.list.appendChild(li);
    });

    if (!files.length) {
      els.hint.textContent = "Select at least 2 PDF files to begin. Drag items to reorder, or use the up/down buttons.";
    } else if (!validation.ok) {
      els.hint.textContent = validation.errors[0];
    } else {
      els.hint.textContent = "Order looks good — files will merge top to bottom. Drag to reorder or use ↑ ↓.";
    }

    refreshTotals();
    refreshButton(validation);
    return validation;
  }

  function moveEntry(id, delta) {
    var from = -1;
    for (var i = 0; i < files.length; i++) {
      if (files[i].id === id) { from = i; break; }
    }
    if (from < 0) return;
    moveItem(files, from, from + delta);
    clearError();
    renderList();
  }

  function reorderByDrop(draggedId, targetId) {
    if (draggedId === targetId) return;
    var from = -1, to = -1;
    files.forEach(function (f, i) {
      if (f.id === draggedId) from = i;
      if (f.id === targetId) to = i;
    });
    if (from < 0 || to < 0) return;
    var item = files.splice(from, 1)[0];
    // Recompute target index after removal.
    var newTo = -1;
    files.forEach(function (f, i) {
      if (f.id === targetId) newTo = i;
    });
    files.splice(newTo + (from < to ? 1 : 0), 0, item);
    renderList();
  }

  function removeEntry(id) {
    files = files.filter(function (f) { return f.id !== id; });
    clearError();
    els.result.hidden = true;
    renderList();
    setStatus(files.length ? "Ready — " + files.length + " file(s) selected." : "Ready — select at least 2 PDFs to begin.");
  }

  function addFiles(fileList) {
    clearError();
    els.result.hidden = true;
    var incoming = Array.prototype.slice.call(fileList || []);
    var L = limits();
    // Enforce the 20-file cap before adding (keep existing list intact).
    if (files.length + incoming.length > L.max) {
      showError(
        "You can merge up to 20 PDFs at a time.",
        "Selected " + files.length + " existing + " + incoming.length + " new exceeds the " + L.max + " cap."
      );
      renderList();
      return;
    }
    incoming.forEach(function (f) {
      uidCounter++;
      files.push({ id: "m" + Date.now().toString(36) + "-" + uidCounter, file: f, safeBase: null });
    });
    var validation = renderList();
    if (validation.ok) {
      setStatus("Ready to merge " + files.length + " PDFs.");
    } else {
      setStatus(validation.errors[0]);
    }
  }

  function resetAll() {
    files = [];
    busy = false;
    lastOutputKey = null;
    lastRequestId = null;
    lastInputCount = 0;
    lastInputBytes = 0;
    els.input.value = "";
    els.inputMore.value = "";
    els.result.hidden = true;
    els.errorCard.hidden = true;
    els.progressWrap.hidden = true;
    els.fill.style.width = "0";
    els.percent.textContent = "";
    setStep("select");
    setStatus("Ready — select at least 2 PDFs to begin.");
    renderList();
  }

  function run() {
    if (busy || !files.length) return;
    var validation = validateMergeSelection(files.map(function (f) {
      return { name: f.file.name, size: f.file.size };
    }));
    if (!validation.ok) {
      showError(validation.errors[0], validation.errors.join(" "));
      return;
    }
    busy = true;
    clearError();
    els.result.hidden = true;
    refreshButton(validation);

    var requestId = window.PdfCloud.newMergeRequestId();
    lastRequestId = requestId;
    var safeBases = assignSafeBases(files.map(function (f) { return f.file.name; }));
    files.forEach(function (f, i) { f.safeBase = safeBases[i]; });
    // Preserve EXACT UI order for keys + manifest.
    var orderedKeys = files.map(function (f) {
      return window.PdfCloud.mergeInputKey(requestId, f.safeBase);
    });
    var outputName = requestId + ".pdf";
    var manifest = window.PdfCloud.buildMergeManifest(requestId, orderedKeys, outputName);
    var expectedOutput = window.PdfCloud.expectedMergeOutputKey(requestId, outputName);
    lastInputCount = files.length;
    lastInputBytes = totalBytes();

    setStep("upload");
    setStatus("Preparing files…");
    setProgress(0);

    // 1) Upload PDFs sequentially IN ORDER (manifest goes last — race-safe).
    var chain = Promise.resolve();
    files.forEach(function (entry, idx) {
      chain = chain.then(function () {
        setStatus("Uploading " + (idx + 1) + " / " + files.length + " — “" + entry.file.name + "”…");
        return window.PdfCloud.uploadMergePdf(entry.file, orderedKeys[idx], function (pct) {
          var overall = Math.round(((idx + pct / 100) / files.length) * 100);
          setProgress(overall);
        });
      });
    });

    chain.then(function () {
      // 2) All PDFs succeeded → upload the manifest (the Lambda trigger).
      setProgress(100);
      setStatus("Starting merge…");
      return window.PdfCloud.putMergeManifest(requestId, manifest);
    }).then(function () {
      // 3) Poll for the EXACT output key for this request (no cross-user mix).
      setStep("process");
      setStatus("Merging PDFs…");
      return window.PdfCloud.pollForExactOutput(expectedOutput, function (attempt, max) {
        setStatus("Merging PDFs… (check " + attempt + " of " + max + ")");
      });
    }).then(function (result) {
      lastOutputKey = result.outputKey;
      setStep("done");
      setStatus("Complete — your merged PDF is ready below.");
      setProgress(100);
      $("mergeResultCount").textContent = String(lastInputCount);
      $("mergeResultSize").textContent = window.PdfCloud.formatBytes(lastInputBytes);
      $("mergeResultName").textContent = result.outputKey.split("/").pop();
      els.result.hidden = false;
      busy = false;
      renderList();
      if (els.downloadBtn) els.downloadBtn.focus();
    }).catch(function (err) {
      // Any PDF or manifest failure lands here; the manifest is never sent
      // after a failed PDF upload because the chain rejects first.
      busy = false;
      renderList();
      var context = err && err.code === "PollTimeout" ? "poll" : "upload";
      showAwsError(err, context);
    });
  }

  function download() {
    if (!lastOutputKey) return;
    try {
      setStatus("Preparing download…");
      var name = $("mergeResultName").textContent;
      window.PdfCloud.downloadOutput(lastOutputKey, name || undefined);
      setStatus("Complete — your merged PDF is ready below.");
    } catch (err) {
      showAwsError(err, "download");
    }
  }

  function wireDropzone() {
    var dz = $("mergeDropzone");
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
      if (list && list.length) addFiles(list);
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    els = {
      input: $("mergeFiles"),
      inputMore: $("mergeFilesMore"),
      mergeBtn: $("mergeBtn"),
      downloadBtn: $("mergeDownloadBtn"),
      status: $("mergeStatus"),
      fill: $("mergeProgressFill"),
      percent: $("mergeProgressPercent"),
      progressWrap: $("mergeProgressWrap"),
      list: $("mergeList"),
      hint: $("mergeHint"),
      count: $("mergeCount"),
      totalSize: $("mergeTotalSize"),
      result: $("mergeResultCard"),
      errorCard: $("mergeErrorCard")
    };
    try {
      window.PdfCloud.init();
    } catch (err) {
      showAwsError(err, "upload");
      return;
    }
    setStep("select");
    renderList();
    els.input.addEventListener("change", function () {
      addFiles(els.input.files);
      els.input.value = "";
    });
    els.inputMore.addEventListener("change", function () {
      addFiles(els.inputMore.files);
      els.inputMore.value = "";
    });
    $("addMoreBtn").addEventListener("click", function () {
      els.inputMore.click();
    });
    els.mergeBtn.addEventListener("click", run);
    els.downloadBtn.addEventListener("click", download);
    $("mergeResetBtn").addEventListener("click", resetAll);
    $("mergeRetryBtn").addEventListener("click", function () {
      clearError();
      if (!busy && files.length) run();
      else setStatus("Select at least 2 PDFs to begin.");
    });
    wireDropzone();
  });

  /* Exposed for static/unit tests (no DOM or AWS needed for these). */
  window.PdfMerge = {
    validateMergeSelection: validateMergeSelection,
    moveItem: moveItem,
    assignSafeBases: assignSafeBases,
    isPdfName: isPdfName
  };
})();

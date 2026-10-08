/* JPG to PDF page logic.
 *
 * Flow:
 *   select images (picker + drag&drop, multiple) -> validate (1-20 files,
 *   JPEG type, <=100MB each, <=200MB total) -> list with image previews,
 *   reorder (drag + up/down), remove, clear ->
 *   upload each image to uploads/<request-id>/ in UI order ->
 *   upload manifest jpg-to-pdf-requests/<request-id>.jpg2pdf.json LAST ->
 *   poll exact output key jpg-to-pdf/<request-id>/<name>.pdf ->
 *   presigned download of the converted PDF.
 *
 * The final order sent to the backend exactly matches the UI order and
 * becomes the PDF page order. Pure helpers are exposed on window.PdfJpgToPdf
 * for static tests.
 */
(function () {
  var els = {};
  var files = []; // [{ id, file, safeName, url }]
  var busy = false;
  var lastOutputKey = null;
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
      min: 1,
      max: c.JPG2PDF_MAX_IMAGES || 20,
      perFile: (c.MAX_FILE_SIZE_MB || 100) * 1024 * 1024,
      total: (c.JPG2PDF_MAX_TOTAL_MB || 200) * 1024 * 1024
    };
  }

  /* Pure validation over [{name, size, type}] — no DOM, no AWS. Returns
   * { ok, errors[], totalBytes }. Used by the page and by tests. */
  function validateJpgSelection(entries) {
    var L = limits();
    var errors = [];
    var total = 0;
    var list = entries || [];
    for (var i = 0; i < list.length; i++) {
      total += list[i].size || 0;
    }
    if (list.length < L.min) {
      errors.push("Select at least one JPG image to begin.");
    }
    if (list.length > L.max) {
      errors.push("You can convert up to 20 images at a time.");
    }
    for (var j = 0; j < list.length; j++) {
      var check = window.PdfCloud.validateJpgFile({
        name: list[j].name, size: list[j].size, type: list[j].type
      });
      if (!check.ok) {
        if (check.reason === "type") {
          errors.push("“" + list[j].name + "” is not a JPG image. Please choose files ending in .jpg or .jpeg.");
        } else if (check.reason === "size") {
          errors.push("“" + list[j].name + "” is larger than the 100 MB limit.");
        } else {
          errors.push("“" + list[j].name + "” appears to be empty.");
        }
        break;
      }
    }
    if (total > L.total) {
      errors.push("The combined image size cannot exceed 200 MB.");
    }
    return { ok: errors.length === 0, errors: errors, totalBytes: total };
  }

  function moveItem(arr, from, to) {
    if (to < 0 || to >= arr.length) return arr;
    var item = arr.splice(from, 1)[0];
    arr.splice(to, 0, item);
    return arr;
  }

  /* Assign de-duplicated safe filenames within one request so distinct keys
   * never overwrite each other. Pure over name list; tested. */
  function assignSafeNames(names) {
    var seen = {};
    return (names || []).map(function (original) {
      var safe = window.PdfCloud.sanitizeJpgFileName(original);
      var dot = safe.lastIndexOf(".");
      var base = dot > 0 ? safe.slice(0, dot) : safe;
      var ext = dot > 0 ? safe.slice(dot) : ".jpg";
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
      var li = $("jpgStep" + key.charAt(0).toUpperCase() + key.slice(1));
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
    $("jpgErrorMessage").textContent = friendly;
    $("jpgErrorDetails").textContent = technical || friendly;
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
    els.count.textContent = "Images: " + files.length + " / " + L.max;
    els.totalSize.textContent =
      "Total size: " + window.PdfCloud.formatBytes(totalBytes()) + " / " + L.total / 1024 / 1024 + " MB";
    if (els.clearBtn) els.clearBtn.disabled = busy || !files.length;
  }

  function refreshButton(validation) {
    if (busy) {
      els.convertBtn.disabled = true;
      els.convertBtn.textContent = "Working…";
      return;
    }
    if (!validation.ok) {
      els.convertBtn.disabled = true;
      els.convertBtn.textContent =
        !files.length ? "Select images to begin" : "Fix issues to continue";
      return;
    }
    els.convertBtn.disabled = false;
    els.convertBtn.textContent = "Convert to PDF";
  }

  function entryMeta(entry) {
    return { name: entry.file.name, size: entry.file.size, type: entry.file.type };
  }

  function renderList() {
    var validation = validateJpgSelection(files.map(entryMeta));
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

      var thumb = document.createElement("img");
      thumb.className = "jpg-thumb";
      thumb.src = entry.url;
      thumb.alt = "";
      thumb.setAttribute("aria-hidden", "true");
      li.appendChild(thumb);

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
      els.hint.textContent = "Select at least one JPG image to begin. Drag items to reorder, or use the up/down buttons.";
    } else if (!validation.ok) {
      els.hint.textContent = validation.errors[0];
    } else {
      els.hint.textContent = "Order looks good — images become PDF pages top to bottom. Drag to reorder or use ↑ ↓.";
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
    var from = -1;
    files.forEach(function (f, i) {
      if (f.id === draggedId) from = i;
    });
    if (from < 0) return;
    var item = files.splice(from, 1)[0];
    var newTo = -1;
    files.forEach(function (f, i) {
      if (f.id === targetId) newTo = i;
    });
    files.splice(newTo + (from < newTo ? 1 : 0), 0, item);
    renderList();
  }

  function revokeEntry(entry) {
    try {
      if (entry.url) URL.revokeObjectURL(entry.url);
    } catch (e) { /* preview cleanup is best-effort */ }
  }

  function removeEntry(id) {
    var kept = [];
    files.forEach(function (f) {
      if (f.id === id) revokeEntry(f);
      else kept.push(f);
    });
    files = kept;
    clearError();
    els.result.hidden = true;
    renderList();
    setStatus(files.length ? "Ready — " + files.length + " image(s) selected." : "Ready — select images to begin.");
  }

  function clearAll() {
    files.forEach(revokeEntry);
    files = [];
    clearError();
    els.result.hidden = true;
    renderList();
    setStatus("Ready — select images to begin.");
  }

  function addFiles(fileList) {
    clearError();
    els.result.hidden = true;
    var incoming = Array.prototype.slice.call(fileList || []);
    var L = limits();
    if (files.length + incoming.length > L.max) {
      showError(
        "You can convert up to 20 images at a time.",
        "Selected " + files.length + " existing + " + incoming.length + " new exceeds the " + L.max + " cap."
      );
      renderList();
      return;
    }
    incoming.forEach(function (f) {
      uidCounter++;
      var url = null;
      try {
        url = URL.createObjectURL(f);
      } catch (e) { url = null; }
      files.push({ id: "j" + Date.now().toString(36) + "-" + uidCounter, file: f, safeName: null, url: url });
    });
    var validation = renderList();
    if (validation.ok) {
      setStatus("Ready to convert " + files.length + (files.length === 1 ? " image." : " images."));
    } else {
      setStatus(validation.errors[0]);
    }
  }

  function resetAll() {
    files.forEach(revokeEntry);
    files = [];
    busy = false;
    lastOutputKey = null;
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
    setStatus("Ready — select images to begin.");
    renderList();
  }

  function run() {
    if (busy || !files.length) return;
    var validation = validateJpgSelection(files.map(entryMeta));
    if (!validation.ok) {
      showError(validation.errors[0], validation.errors.join(" "));
      return;
    }
    busy = true;
    clearError();
    els.result.hidden = true;
    refreshButton(validation);

    var requestId = window.PdfCloud.newJpgToPdfRequestId();
    var safeNames = assignSafeNames(files.map(function (f) { return f.file.name; }));
    files.forEach(function (f, i) { f.safeName = safeNames[i]; });
    // Preserve EXACT UI order for keys + manifest (= PDF page order).
    var orderedKeys = files.map(function (f) {
      return window.PdfCloud.jpgToPdfInputKey(requestId, f.safeName);
    });
    var outputName = requestId + ".pdf";
    var manifest = window.PdfCloud.buildJpgToPdfManifest(requestId, orderedKeys, outputName);
    var expectedOutput = window.PdfCloud.expectedJpgToPdfOutputKey(requestId, outputName);
    lastInputCount = files.length;
    lastInputBytes = totalBytes();

    setStep("upload");
    setStatus("Preparing images…");
    setProgress(0);

    // 1) Upload images sequentially IN ORDER (manifest goes last — race-safe).
    var chain = Promise.resolve();
    files.forEach(function (entry, idx) {
      chain = chain.then(function () {
        setStatus("Uploading " + (idx + 1) + " / " + files.length + " — “" + entry.file.name + "”…");
        return window.PdfCloud.uploadEditImage(entry.file, orderedKeys[idx], function (pct) {
          var overall = Math.round(((idx + pct / 100) / files.length) * 100);
          setProgress(overall);
        });
      });
    });

    chain.then(function () {
      // 2) All images succeeded → upload the manifest (the Lambda trigger).
      setProgress(100);
      setStatus("Starting conversion…");
      return window.PdfCloud.putJpgToPdfManifest(requestId, manifest);
    }).then(function () {
      // 3) Poll for the EXACT output key for this request (no cross-user mix).
      setStep("process");
      setStatus("Converting images…");
      return window.PdfCloud.pollForExactOutput(expectedOutput, function (attempt, max) {
        setStatus("Converting images… (check " + attempt + " of " + max + ")");
      });
    }).then(function (result) {
      lastOutputKey = result.outputKey;
      setStep("done");
      setStatus("Complete — your PDF is ready below.");
      setProgress(100);
      $("jpgResultCount").textContent = String(lastInputCount) +
        (lastInputCount === 1 ? " image" : " images");
      $("jpgResultSize").textContent = window.PdfCloud.formatBytes(lastInputBytes);
      $("jpgResultName").textContent = result.outputKey.split("/").pop();
      els.result.hidden = false;
      busy = false;
      renderList();
      if (els.downloadBtn) els.downloadBtn.focus();
    }).catch(function (err) {
      // Any image or manifest failure lands here; the manifest is never sent
      // after a failed image upload because the chain rejects first.
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
      var name = $("jpgResultName").textContent;
      window.PdfCloud.downloadOutput(lastOutputKey, name || undefined);
      setStatus("Complete — your PDF is ready below.");
    } catch (err) {
      showAwsError(err, "download");
    }
  }

  function wireDropzone() {
    var dz = $("jpgDropzone");
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
      input: $("jpgFiles"),
      inputMore: $("jpgFilesMore"),
      convertBtn: $("jpgBtn"),
      clearBtn: $("jpgClearBtn"),
      downloadBtn: $("jpgDownloadBtn"),
      status: $("jpgStatus"),
      fill: $("jpgProgressFill"),
      percent: $("jpgProgressPercent"),
      progressWrap: $("jpgProgressWrap"),
      list: $("jpgList"),
      hint: $("jpgHint"),
      count: $("jpgCount"),
      totalSize: $("jpgTotalSize"),
      result: $("jpgResultCard"),
      errorCard: $("jpgErrorCard")
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
    $("jpgAddMoreBtn").addEventListener("click", function () {
      els.inputMore.click();
    });
    els.clearBtn.addEventListener("click", clearAll);
    els.convertBtn.addEventListener("click", run);
    els.downloadBtn.addEventListener("click", download);
    $("jpgResetBtn").addEventListener("click", resetAll);
    $("jpgRetryBtn").addEventListener("click", function () {
      clearError();
      if (!busy && files.length) run();
      else setStatus("Select images to begin.");
    });
    wireDropzone();
  });

  /* Exposed for static/unit tests (no DOM or AWS needed for these). */
  window.PdfJpgToPdf = {
    validateJpgSelection: validateJpgSelection,
    moveItem: moveItem,
    assignSafeNames: assignSafeNames
  };
})();

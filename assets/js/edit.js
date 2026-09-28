/* Edit PDF v1 page logic (overlay editor).
 *
 * Flow:
 *   select one PDF (picker + drag&drop) -> validate (PDF type, <=100MB) ->
 *   pages render in-browser via pinned pdf.js -> pick a tool
 *   (text | draw | highlight | rect | image) and place edits on the overlay
 *   canvas -> edits listed per page (remove / undo / clear) ->
 *   upload PDF to uploads/<request-id>/<safe>.pdf ->
 *   upload overlay images to uploads/<request-id>/img-<n>.png|jpg ->
 *   upload manifest edit-requests/<request-id>.edit.json LAST ->
 *   poll exact output key edit/<request-id>/<stem>-edited.pdf ->
 *   presigned download of the edited PDF.
 *
 * COORDINATE CONVENTION (shared with the backend, see backend README):
 *   Manifest units are PDF points (1/72 inch), origin BOTTOM-LEFT.
 *   The page renders at CSS width W for a page Wpt wide, so:
 *     scale = Wcss / Wpt
 *     x_pt = x_css / scale
 *     y_pt = Hpt - y_css / scale
 *   A CSS box (x0,y0 top-left, w,h) becomes
 *     x_pt = x0/scale, y_pt = Hpt - (y0+h)/scale, w_pt = w/scale, h_pt = h/scale.
 *   Edits store points; display converts back. Never store screen pixels.
 *
 * Pure helpers are exposed on window.PdfEdit for static tests.
 */
(function () {
  var els = {};
  var file = null;
  var busy = false;
  var lastOutputKey = null;
  var pdfDoc = null;
  var pageNum = 1;
  var pageCount = 0;
  var pageSizePt = { w: 0, h: 0 };
  var cssWidth = 0;
  var tool = "text";
  var edits = []; // {uid, page, type, ...pts + display params}
  var uidCounter = 0;
  var images = []; // {uid, file, objectUrl, ext}
  var drawing = null; // active pointer gesture {type, css points/box}
  var pendingImageUid = null;
  var imgCache = {};

  function $(id) {
    return document.getElementById(id);
  }

  function cfg() {
    return window.PdfConfig;
  }

  /* Pure validation over {name, size} — no DOM, no AWS. Used by the page
   * and by tests. */
  function validateEditSelection(entry) {
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

  /* Pure coordinate converters (points <-> CSS px). scale = cssW / pageWpt. */
  function cssToPdf(xCss, yCss, cssW, pageWPt, pageHPt) {
    var scale = cssW / pageWPt;
    return { x: xCss / scale, y: pageHPt - yCss / scale };
  }

  function cssBoxToPdf(x0, y0, w, h, cssW, pageWPt, pageHPt) {
    var scale = cssW / pageWPt;
    return { x: x0 / scale, y: pageHPt - (y0 + h) / scale,
             width: w / scale, height: h / scale };
  }

  function pdfToCssX(xPt, cssW, pageWPt) {
    return xPt * (cssW / pageWPt);
  }

  function pdfToCssY(yPt, cssH, pageHPt) {
    return cssH - yPt * (cssH / pageHPt);
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  function style() {
    return {
      color: els.color.value || "#FF0000",
      fontSize: parseInt(els.fontSize.value, 10) || 16,
      lineWidth: parseInt(els.lineWidth.value, 10) || 3,
      alpha: els.toolAlpha ? (parseFloat(els.toolAlpha.value) || 0.4) : 0.4,
      text: els.textInput.value || "Text"
    };
  }

  function setStep(name) {
    var order = ["select", "upload", "process", "done"];
    var idx = order.indexOf(name);
    order.forEach(function (key) {
      var li = $("editStep" + key.charAt(0).toUpperCase() + key.slice(1));
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
    $("editErrorMessage").textContent = friendly;
    $("editErrorDetails").textContent = technical || friendly;
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

  function canvasPos(evt) {
    var rect = els.overlay.getBoundingClientRect();
    return { x: evt.clientX - rect.left, y: evt.clientY - rect.top,
             w: rect.width, h: rect.height };
  }

  function currentScale() {
    return cssWidth / pageSizePt.w;
  }

  /* ---------- rendering ---------- */

  function renderPage() {
    if (!pdfDoc) return;
    pdfDoc.getPage(pageNum).then(function (page) {
      var viewport0 = page.getViewport({ scale: 1 });
      pageSizePt = { w: viewport0.width, h: viewport0.height };
      var maxW = Math.min(els.stage.clientWidth || 720, 860);
      var scale = maxW / viewport0.width;
      var viewport = page.getViewport({ scale: scale });
      cssWidth = viewport.width;
      [els.base, els.overlay].forEach(function (cv) {
        cv.width = Math.floor(viewport.width);
        cv.height = Math.floor(viewport.height);
        cv.style.width = Math.floor(viewport.width) + "px";
        cv.style.height = Math.floor(viewport.height) + "px";
      });
      var ctx = els.base.getContext("2d");
      page.render({ canvasContext: ctx, viewport: viewport }).promise.then(
        function () {
          redrawOverlay();
          refreshPageLabel();
          refresh();
        });
    }).catch(function (err) {
      showError("Could not render page " + pageNum + ".", String(err));
    });
  }

  function redrawOverlay() {
    var ctx = els.overlay.getContext("2d");
    var scale = currentScale();
    ctx.clearRect(0, 0, els.overlay.width, els.overlay.height);
    edits.filter(function (e) { return e.page === pageNum; })
      .forEach(function (e) { paintEdit(ctx, e, scale); });
    if (drawing) paintGesture(ctx, drawing, scale);
  }

  function paintEdit(ctx, e, scale) {
    if (e.type === "text") {
      ctx.fillStyle = e.color;
      ctx.font = e.font_size + "px Helvetica, Arial, sans-serif";
      ctx.fillText(e.text, e.x * scale,
                   els.overlay.height - e.y * scale);
    } else if (e.type === "draw") {
      ctx.strokeStyle = e.color;
      ctx.lineWidth = Math.max(1, e.width * scale);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      e.points.forEach(function (p, i) {
        var cx = p[0] * scale, cy = els.overlay.height - p[1] * scale;
        if (i === 0) ctx.moveTo(cx, cy);
        else ctx.lineTo(cx, cy);
      });
      ctx.stroke();
    } else if (e.type === "highlight" || e.type === "rect" || e.type === "image") {
      var x = e.x * scale, y = els.overlay.height - (e.y + e.height) * scale;
      var w = e.width * scale, h = e.height * scale;
      if (e.type === "highlight") {
        ctx.globalAlpha = e.alpha;
        ctx.fillStyle = e.color;
        ctx.fillRect(x, y, w, h);
        ctx.globalAlpha = 1;
      } else if (e.type === "rect") {
        if (e.alpha < 1) {
          ctx.globalAlpha = e.alpha;
          ctx.fillStyle = e.color;
          ctx.fillRect(x, y, w, h);
          ctx.globalAlpha = 1;
        }
        ctx.strokeStyle = e.color;
        ctx.lineWidth = Math.max(1, e.border * scale);
        ctx.strokeRect(x, y, w, h);
      } else if (e.type === "image") {
        var img = imgCache[e.imageUid];
        if (img && img.complete && img.naturalWidth) {
          ctx.drawImage(img, x, y, w, h);
        } else {
          ctx.strokeStyle = "#888";
          ctx.setLineDash([6, 4]);
          ctx.strokeRect(x, y, w, h);
          ctx.setLineDash([]);
        }
      }
    }
  }

  function paintGesture(ctx, g, scale) {
    ctx.save();
    ctx.strokeStyle = "#0066CC";
    ctx.fillStyle = "rgba(0,102,204,0.15)";
    ctx.lineWidth = 2;
    if (g.type === "draw" && g.css.length) {
      ctx.beginPath();
      g.css.forEach(function (p, i) {
        if (i === 0) ctx.moveTo(p[0], p[1]);
        else ctx.lineTo(p[0], p[1]);
      });
      ctx.stroke();
    } else if (g.box) {
      ctx.fillRect(g.box.x0, g.box.y0, g.box.w, g.box.h);
      ctx.strokeRect(g.box.x0, g.box.y0, g.box.w, g.box.h);
    }
    ctx.restore();
  }

  /* ---------- edit model ---------- */

  function addEdit(edit) {
    uidCounter++;
    edit.uid = "e" + uidCounter;
    edit.page = pageNum;
    edits.push(edit);
    redrawOverlay();
    refreshList();
    refresh();
  }

  function refreshPageLabel() {
    els.pageLabel.textContent = "Page " + pageNum + " of " + pageCount;
    els.prevBtn.disabled = pageNum <= 1;
    els.nextBtn.disabled = pageNum >= pageCount;
  }

  function refreshList() {
    var list = edits.filter(function (e) { return e.page === pageNum; });
    els.editList.innerHTML = "";
    list.forEach(function (e, i) {
      var li = document.createElement("li");
      li.className = "edit-item";
      var label = document.createElement("span");
      label.textContent = (i + 1) + ". " + describeEdit(e);
      var del = document.createElement("button");
      del.type = "button";
      del.className = "mini-btn danger";
      del.textContent = "✕";
      del.setAttribute("aria-label", "Remove edit " + (i + 1));
      (function (uid) {
        del.addEventListener("click", function () {
          edits = edits.filter(function (x) { return x.uid !== uid; });
          redrawOverlay();
          refreshList();
          refresh();
        });
      })(e.uid);
      li.appendChild(label);
      li.appendChild(del);
      els.editList.appendChild(li);
    });
    els.editEmpty.hidden = list.length > 0;
  }

  function describeEdit(e) {
    if (e.type === "text") return "Text: “" + e.text.slice(0, 40) + "”";
    if (e.type === "draw") return "Drawing (" + e.points.length + " pts)";
    if (e.type === "highlight") return "Highlight";
    if (e.type === "rect") return "Rectangle";
    if (e.type === "image") return "Image";
    return e.type;
  }

  function refresh() {
    var validation = validateEditSelection(file);
    var maxEdits = cfg().EDIT_MAX_EDITS || 200;
    var hint = "";
    if (!file) hint = "Select a PDF file to begin.";
    else if (!validation.ok) hint = validation.errors[0];
    else if (!pdfDoc) hint = "Loading preview…";
    else if (!edits.length) hint = "Pick a tool and click the page to add an edit.";
    else hint = edits.length + " edit(s) ready — preview above, then Apply edits.";
    if (edits.length > maxEdits) hint = "Too many edits (max " + maxEdits + "). Remove some.";
    els.hint.textContent = hint;
    els.count.textContent = "Edits: " + edits.length + " / " + maxEdits;
    if (busy) {
      els.applyBtn.disabled = true;
      els.applyBtn.textContent = "Working…";
    } else if (!validation.ok || !edits.length || edits.length > maxEdits) {
      els.applyBtn.disabled = true;
      els.applyBtn.textContent = !file ? "Select a PDF to begin" : "Add at least 1 edit";
    } else {
      els.applyBtn.disabled = false;
      els.applyBtn.textContent = "Apply edits";
    }
    if (els.fileName) {
      els.fileName.textContent = file
        ? file.name + " (" + window.PdfCloud.formatBytes(file.size) + ")"
        : "No file selected.";
    }
    var tools = document.querySelectorAll('input[name="editTool"]');
    Array.prototype.forEach.call(tools, function (r) {
      if (r.checked) tool = r.value;
    });
    els.textRow.hidden = tool !== "text";
    els.sizeRow.hidden = tool !== "text";
    els.widthRow.hidden = !(tool === "draw" || tool === "rect");
    els.alphaRow.hidden = !(tool === "highlight" || tool === "rect");
    els.imageRow.hidden = tool !== "image";
    return validation;
  }

  /* ---------- pointer gestures ---------- */

  function onPointerDown(evt) {
    if (busy || !pdfDoc || !pageSizePt.w) return;
    if (tool === "image" && !pendingImageUid) {
      showError("Choose an image file first, then click the page to place it.",
                "image tool needs a pending image");
      return;
    }
    evt.preventDefault();
    els.overlay.setPointerCapture && els.overlay.setPointerCapture(evt.pointerId);
    var pos = canvasPos(evt);
    if (tool === "text") {
      var st = style();
      var pt = cssToPdf(pos.x, pos.y, pos.w, pageSizePt.w, pageSizePt.h);
      addEdit({ type: "text", x: round2(pt.x), y: round2(pt.y),
                text: st.text.slice(0, 2000), font_size: st.fontSize,
                color: st.color });
    } else if (tool === "draw") {
      drawing = { type: "draw", css: [[pos.x, pos.y]] };
    } else if (tool === "highlight" || tool === "rect") {
      drawing = { type: tool, start: [pos.x, pos.y], box: null };
    } else if (tool === "image") {
      placePendingImage(pos);
    }
  }

  function onPointerMove(evt) {
    if (!drawing) return;
    var pos = canvasPos(evt);
    if (drawing.type === "draw") {
      var last = drawing.css[drawing.css.length - 1];
      var dx = pos.x - last[0], dy = pos.y - last[1];
      if (dx * dx + dy * dy >= 4 && drawing.css.length < 500) {
        drawing.css.push([pos.x, pos.y]);
      }
    } else {
      var x0 = Math.min(drawing.start[0], pos.x);
      var y0 = Math.min(drawing.start[1], pos.y);
      drawing.box = { x0: x0, y0: y0,
                      w: Math.abs(pos.x - drawing.start[0]),
                      h: Math.abs(pos.y - drawing.start[1]) };
    }
    redrawOverlay();
  }

  function onPointerUp(evt) {
    if (!drawing) return;
    var g = drawing;
    drawing = null;
    var st = style();
    if (g.type === "draw") {
      if (g.css.length < 2) { redrawOverlay(); refresh(); return; }
      var pts = g.css.map(function (p) {
        var pt = cssToPdf(p[0], p[1], cssWidth, pageSizePt.w, pageSizePt.h);
        return [round2(pt.x), round2(pt.y)];
      });
      addEdit({ type: "draw", points: pts, width: st.lineWidth, color: st.color });
    } else if (g.box && g.box.w >= 4 && g.box.h >= 4) {
      var box = cssBoxToPdf(g.box.x0, g.box.y0, g.box.w, g.box.h,
                            cssWidth, pageSizePt.w, pageSizePt.h);
      var edit = { type: g.type, x: round2(box.x), y: round2(box.y),
                   width: round2(box.width), height: round2(box.height),
                   color: st.color };
      if (g.type === "highlight") edit.alpha = st.alpha;
      else edit.border = st.lineWidth;
      addEdit(edit);
    } else {
      redrawOverlay();
      refresh();
    }
  }

  function placePendingImage(pos) {
    var rec = null;
    images.forEach(function (im) { if (im.uid === pendingImageUid) rec = im; });
    if (!rec) return;
    var st = { wPt: 200, hPt: 150 };
    var pt = cssToPdf(pos.x, pos.y, pos.w, pageSizePt.w, pageSizePt.h);
    addEdit({ type: "image", x: round2(pt.x), y: round2(pt.y - st.hPt),
              width: st.wPt, height: st.hPt, imageUid: rec.uid,
              srcKey: null });
    pendingImageUid = null;
    els.imageInput.value = "";
    setStatus("Image placed — pick the image tool file again for another.");
  }

  /* ---------- file handling ---------- */

  function addFile(picked) {
    clearError();
    els.result.hidden = true;
    var list = Array.prototype.slice.call(picked || []);
    if (!list.length) return;
    if (list.length > 1) {
      showError(
        "Edit works on one PDF at a time — the first file was kept.",
        "User picked " + list.length + " files; kept the first."
      );
    }
    file = list[0];
    edits = [];
    images = [];
    imgCache = {};
    pendingImageUid = null;
    pageNum = 1;
    loadPdfPreview();
    setStatus("Ready — “" + file.name + "” selected.");
    refresh();
  }

  function loadPdfPreview() {
    pdfDoc = null;
    pageCount = 0;
    if (!window.pdfjsLib) {
      showError("The PDF preview library failed to load. Check your connection and reload.",
                "pdfjsLib missing");
      return;
    }
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = cfg().PDFJS_WORKER_URL;
    var reader = new FileReader();
    reader.onload = function () {
      window.pdfjsLib.getDocument({ data: reader.result }).promise.then(
        function (doc) {
          pdfDoc = doc;
          pageCount = doc.numPages;
          renderPage();
          refreshList();
        },
        function (err) {
          showError("Could not read that PDF.", String(err && err.message || err));
        });
    };
    reader.readAsArrayBuffer(file);
  }

  function addImageFile(picked) {
    clearError();
    var list = Array.prototype.slice.call(picked || []);
    if (!list.length) return;
    var f = list[0];
    var lower = String(f.name || "").toLowerCase();
    var ext = /\.png$/.test(lower) ? "png" : (/\.jpe?g$/.test(lower) ? "jpg" : "");
    if (!ext) {
      showError("Images must be PNG or JPEG.", "bad image type: " + f.name);
      els.imageInput.value = "";
      return;
    }
    var maxBytes = (cfg().EDIT_MAX_IMAGE_MB || 5) * 1024 * 1024;
    if (f.size > maxBytes) {
      showError("That image is over the " + (cfg().EDIT_MAX_IMAGE_MB || 5) + " MB limit.",
                "image too large: " + f.size);
      els.imageInput.value = "";
      return;
    }
    uidCounter++;
    var rec = { uid: "img" + uidCounter, file: f, ext: ext,
                objectUrl: URL.createObjectURL(f) };
    images.push(rec);
    pendingImageUid = rec.uid;
    var img = new Image();
    img.onload = function () { imgCache[rec.uid] = img; redrawOverlay(); };
    img.src = rec.objectUrl;
    setStatus("Image ready — click the page to place it.");
  }

  function resetAll() {
    file = null;
    busy = false;
    lastOutputKey = null;
    pdfDoc = null;
    pageNum = 1;
    pageCount = 0;
    edits = [];
    images = [];
    imgCache = {};
    pendingImageUid = null;
    els.input.value = "";
    els.imageInput.value = "";
    els.textInput.value = "";
    els.result.hidden = true;
    els.errorCard.hidden = true;
    els.progressWrap.hidden = true;
    els.fill.style.width = "0";
    els.percent.textContent = "";
    var ctx = els.overlay.getContext("2d");
    ctx && ctx.clearRect(0, 0, els.overlay.width, els.overlay.height);
    var bctx = els.base.getContext("2d");
    bctx && bctx.clearRect(0, 0, els.base.width, els.base.height);
    setStep("select");
    setStatus("Ready — select a PDF to begin.");
    refreshList();
    refresh();
  }

  /* ---------- submit ---------- */

  function manifestEdits() {
    return edits.map(function (e) {
      var out = { page: e.page, type: e.type };
      if (e.type === "text") {
        out.x = e.x; out.y = e.y; out.text = e.text;
        out.font_size = e.font_size; out.color = e.color;
      } else if (e.type === "draw") {
        out.points = e.points.map(function (p) { return [p[0], p[1]]; });
        out.width = e.width; out.color = e.color;
      } else if (e.type === "highlight") {
        out.x = e.x; out.y = e.y; out.width = e.width; out.height = e.height;
        out.color = e.color; out.alpha = e.alpha;
      } else if (e.type === "rect") {
        out.x = e.x; out.y = e.y; out.width = e.width; out.height = e.height;
        out.color = e.color; out.border = e.border;
      } else if (e.type === "image") {
        out.x = e.x; out.y = e.y; out.width = e.width; out.height = e.height;
        out.src = e.srcKey;
      }
      return out;
    });
  }

  function run() {
    if (busy || !file) return;
    var validation = validateEditSelection(file);
    if (!validation.ok) {
      showError(validation.errors[0], validation.errors.join(" "));
      return;
    }
    var maxEdits = cfg().EDIT_MAX_EDITS || 200;
    if (!edits.length) {
      showError("Add at least one edit before applying.", "empty edits");
      return;
    }
    if (edits.length > maxEdits) {
      showError("Too many edits (max " + maxEdits + "). Remove some.",
                "edits: " + edits.length);
      return;
    }
    var missingSrc = edits.some(function (e) {
      return e.type === "image" && !e.srcKey;
    });
    if (missingSrc) {
      showError("An image edit lost its upload. Re-place it and try again.",
                "image without srcKey");
      return;
    }
    busy = true;
    clearError();
    els.result.hidden = true;
    refresh();

    var requestId = window.PdfCloud.newEditRequestId();
    var safeBase = window.PdfCloud.sanitizeMergeBase(file.name);
    var inputKey = window.PdfCloud.editInputKey(requestId, safeBase);
    var usedImages = images.filter(function (im) {
      return edits.some(function (e) { return e.imageUid === im.uid; });
    });
    usedImages.forEach(function (im, i) {
      im.key = "uploads/" + requestId + "/" + (cfg().EDIT_IMAGE_PREFIX || "img-")
        + i + "." + im.ext;
    });
    edits.forEach(function (e) {
      if (e.type === "image") {
        usedImages.forEach(function (im) {
          if (im.uid === e.imageUid) e.srcKey = im.key;
        });
      }
    });
    var manifest = window.PdfCloud.buildEditManifest(
      requestId, inputKey, safeBase, manifestEdits());
    var expectedOutput = window.PdfCloud.expectedEditOutputKey(
      requestId, safeBase);
    var totalSteps = 1 + usedImages.length;

    setStep("upload");
    setStatus("Uploading “" + file.name + "”…");
    setProgress(0);

    // 1) Source PDF first (the manifest must never win the race).
    window.PdfCloud.uploadMergePdf(file, inputKey, function (pct) {
      setProgress(Math.round(pct / totalSteps));
    }).then(function () {
      // 2) Overlay images, in order.
      var chain = Promise.resolve();
      usedImages.forEach(function (im, idx) {
        chain = chain.then(function () {
          setStatus("Uploading image " + (idx + 1) + " / " + usedImages.length + "…");
          return window.PdfCloud.uploadEditImage(im.file, im.key, function (pct) {
            setProgress(Math.round(((1 + idx + pct / 100) / totalSteps) * 100));
          });
        });
      });
      return chain;
    }).then(function () {
      // 3) Manifest LAST (the Lambda trigger).
      setProgress(100);
      setStatus("Applying edits…");
      return window.PdfCloud.putEditManifest(requestId, manifest);
    }).then(function () {
      // 4) Poll for the EXACT output key for this request.
      setStep("process");
      setStatus("Applying edits…");
      return window.PdfCloud.pollForExactOutput(expectedOutput, function (attempt, max) {
        setStatus("Applying edits… (check " + attempt + " of " + max + ")");
      });
    }).then(function (result) {
      lastOutputKey = result.outputKey;
      setStep("done");
      setStatus("Complete — your edited PDF is ready below.");
      setProgress(100);
      $("editResultName").textContent = result.outputKey.split("/").pop();
      $("editResultMode").textContent = edits.length + " edit(s) applied";
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
      var name = $("editResultName").textContent;
      window.PdfCloud.downloadOutput(lastOutputKey, name || undefined);
      setStatus("Complete — your edited PDF is ready below.");
    } catch (err) {
      showAwsError(err, "download");
    }
  }

  function wireDropzone() {
    var dz = $("editDropzone");
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
      input: $("editFiles"),
      imageInput: $("editImageFiles"),
      textInput: $("editText"),
      textRow: $("editTextRow"),
      fontSize: $("editFontSize"),
      sizeRow: $("editSizeRow"),
      lineWidth: $("editLineWidth"),
      widthRow: $("editWidthRow"),
      color: $("editColor"),
      toolAlpha: $("editAlpha"),
      alphaRow: $("editAlphaRow"),
      imageRow: $("editImageRow"),
      hint: $("editHint"),
      count: $("editCount"),
      fileName: $("editFileName"),
      editList: $("editList"),
      editEmpty: $("editEmpty"),
      pageLabel: $("editPageLabel"),
      prevBtn: $("editPrevPage"),
      nextBtn: $("editNextPage"),
      base: $("editBaseCanvas"),
      overlay: $("editOverlayCanvas"),
      stage: $("editStage"),
      applyBtn: $("editBtn"),
      downloadBtn: $("editDownloadBtn"),
      status: $("editStatus"),
      fill: $("editProgressFill"),
      percent: $("editProgressPercent"),
      progressWrap: $("editProgressWrap"),
      result: $("editResultCard"),
      errorCard: $("editErrorCard")
    };
    try {
      window.PdfCloud.init();
    } catch (err) {
      showAwsError(err, "upload");
      return;
    }
    setStep("select");
    refreshList();
    refresh();
    els.input.addEventListener("change", function () {
      addFile(els.input.files);
      els.input.value = "";
    });
    els.imageInput.addEventListener("change", function () {
      addImageFile(els.imageInput.files);
    });
    var tools = document.querySelectorAll('input[name="editTool"]');
    Array.prototype.forEach.call(tools, function (r) {
      r.addEventListener("change", refresh);
    });
    ["textInput", "fontSize", "lineWidth", "color", "toolAlpha"].forEach(
      function (k) {
        if (els[k]) els[k].addEventListener("input", refresh);
      });
    els.prevBtn.addEventListener("click", function () {
      if (pageNum > 1) { pageNum--; drawing = null; renderPage(); refreshList(); }
    });
    els.nextBtn.addEventListener("click", function () {
      if (pageNum < pageCount) { pageNum++; drawing = null; renderPage(); refreshList(); }
    });
    $("editUndoBtn").addEventListener("click", function () {
      for (var i = edits.length - 1; i >= 0; i--) {
        if (edits[i].page === pageNum) { edits.splice(i, 1); break; }
      }
      redrawOverlay();
      refreshList();
      refresh();
    });
    $("editClearPageBtn").addEventListener("click", function () {
      edits = edits.filter(function (e) { return e.page !== pageNum; });
      redrawOverlay();
      refreshList();
      refresh();
    });
    els.overlay.addEventListener("pointerdown", onPointerDown);
    els.overlay.addEventListener("pointermove", onPointerMove);
    els.overlay.addEventListener("pointerup", onPointerUp);
    els.overlay.addEventListener("pointercancel", function () {
      drawing = null;
      redrawOverlay();
    });
    els.applyBtn.addEventListener("click", run);
    els.downloadBtn.addEventListener("click", download);
    $("editResetBtn").addEventListener("click", resetAll);
    $("editRetryBtn").addEventListener("click", function () {
      clearError();
      if (!busy && file) run();
      else setStatus("Select a PDF to begin.");
    });
    wireDropzone();
  });

  /* Exposed for static/unit tests (no DOM or AWS needed for these). */
  window.PdfEdit = {
    validateEditSelection: validateEditSelection,
    cssToPdf: cssToPdf,
    cssBoxToPdf: cssBoxToPdf,
    pdfToCssX: pdfToCssX,
    pdfToCssY: pdfToCssY
  };
})();

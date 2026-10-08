/* Professional PDF editor workspace (overlay model, v1-compatible backend).
 *
 * Pipeline (unchanged AWS contract):
 *   PDF.js render -> visual overlay editing (PDF points, bottom-left origin)
 *   -> Apply: PDF upload, image assets, manifest LAST -> exact-key poll
 *   -> presigned download.
 * Page operations (rotate/delete/move/insert blank) are stored as an op list
 * and applied server-side BEFORE overlays; overlay page keys map to FINAL
 * pages at manifest build. Net page rotations are composed into overlay
 * geometry with the backend-identical formula, so the canvas is WYSIWYG.
 */
window.PdfEditor = (function () {
  "use strict";
  var C = window.PdfEditorCoords;
  var S = window.PdfEditorState;
  var M = window.PdfEditorManifest;

  var PDF_FONTS = [
    "Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique",
    "Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic",
    "Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique"
  ];
  var FONT_LABELS = {
    "Helvetica": "Arial", "Helvetica-Bold": "Arial Bold",
    "Helvetica-Oblique": "Arial Italic", "Helvetica-BoldOblique": "Arial Bold Italic",
    "Times-Roman": "Times", "Times-Bold": "Times Bold",
    "Times-Italic": "Times Italic", "Times-BoldItalic": "Times Bold Italic",
    "Courier": "Courier", "Courier-Bold": "Courier Bold",
    "Courier-Oblique": "Courier Italic", "Courier-BoldOblique": "Courier Bold Italic"
  };
  var ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];

  var els = {};
  var state = S.create();
  var doc = null; // {file, pdfDoc, keys[], sizes{}}
  var view = { order: [], rotations: {}, pagePos: 0, zoom: 1, fit: true };
  var tool = "select";
  var opts = {
    color: "#000000", opacity: 1, fontSize: 16, font: "Helvetica",
    align: "left", underline: false, width: 3, thickness: 2, border: 2,
    highlightColor: "#FFFF00", highlightAlpha: 0.4, text: "Text", url: ""
  };
  var busy = false;
  var stagedImage = null; // {file, url, width, height}
  var stagedSignImage = null;
  var signMode = "draw";
  var gesture = null; // in-progress pointer gesture
  var measureCtx = null;
  var lastOutputKey = null;
  var lastResultName = null;
  var imageFiles = {}; // srcKey -> File (filled at apply)
  var textLayerCleanup = [];

  function $(id) { return document.getElementById(id); }

  function cfg() { return window.PdfConfig; }
  function Cloud() { return window.PdfCloud; }

  /* ---------- document / view model ---------- */

  function resetAll() {
    S.clear(state);
    doc = null;
    view = { order: [], rotations: {}, pagePos: 0, zoom: 1, fit: true };
    tool = "select";
    busy = false;
    stagedImage = null;
    stagedSignImage = null;
    gesture = null;
    lastOutputKey = null;
    imageFiles = {};
    clearTextLayer();
    els.workPane.hidden = true;
    els.uploadPane.hidden = false;
    els.thumbsWrap.hidden = true;
    els.toolbar.hidden = true;
    els.resultCard.hidden = true;
    els.errorCard.hidden = true;
    els.applyBtn.disabled = true;
    setTool("select");
    setTopStatus("Select a PDF to begin");
  }

  function currentKey() { return view.order[view.pagePos]; }
  function currentSize() { return doc.sizes[currentKey()]; }
  function currentRotation() { return view.rotations[currentKey()] || 0; }

  function recomputeView() {
    var res = S.applyOpsToKeys(doc.keys, state.pageOps);
    view.order = res.order;
    view.rotations = res.rotations;
    if (view.pagePos >= view.order.length) view.pagePos = Math.max(0, view.order.length - 1);
  }

  function setTopStatus(t) { els.topStatus.textContent = t; }

  function refreshChrome() {
    els.undoBtn.disabled = !state.past.length || busy;
    els.redoBtn.disabled = !state.future.length || busy;
    els.applyBtn.disabled = busy || !doc || !state.objects.length;
    var n = state.objects.length, max = cfg().EDIT_MAX_EDITS;
    setTopStatus(doc ? ("Page " + (view.pagePos + 1) + " / " + view.order.length +
      " · Objects " + n + " / " + max + (state.pageOps.length ? " · Page ops " + state.pageOps.length : "")) :
      "Select a PDF to begin");
  }

  /* ---------- PDF loading ---------- */

  function onFileChosen(file) {
    clearError();
    if (!file) return;
    var check = Cloud().validatePdfFile
      ? Cloud().validatePdfFile(file)
      : { ok: /\.pdf$/i.test(file.name) };
    if (!check.ok) {
      showError({ code: "InvalidFile", message: "That doesn't look like a PDF. Please choose a file ending in .pdf." }, "select");
      return;
    }
    if (file.size > cfg().MAX_FILE_SIZE_MB * 1024 * 1024) {
      showError({ code: "InvalidFile", message: "That file is over the " + cfg().MAX_FILE_SIZE_MB + " MB limit." }, "select");
      return;
    }
    resetAll();
    setTopStatus("Loading PDF…");
    var reader = new FileReader();
    reader.onload = function () {
      var data = new Uint8Array(reader.result);
      pdfjsLib.getDocument({ data: data }).promise.then(function (pdf) {
        var count = pdf.numPages;
        doc = { file: file, pdfDoc: pdf, keys: [], sizes: {} };
        var chain = Promise.resolve();
        for (var i = 0; i < count; i++) {
          (function (idx) {
            chain = chain.then(function () {
              return pdf.getPage(idx + 1).then(function (page) {
                var vp = page.getViewport({ scale: 1 });
                var key = "p" + idx;
                doc.keys.push(key);
                doc.sizes[key] = { w: C.round2(vp.width), h: C.round2(vp.height) };
              });
            });
          })(i);
        }
        chain.then(function () {
          recomputeView();
          els.uploadPane.hidden = true;
          els.workPane.hidden = false;
          els.thumbsWrap.hidden = false;
          els.toolbar.hidden = false;
          renderThumbs();
          renderView();
          refreshChrome();
        }, function (err) {
          showError({ code: "LoadFailed", message: "Unable to load PDF pages. " + ((err && err.message) || "") }, "select");
        });
      }, function (err) {
        showError({ code: "LoadFailed", message: "Unable to load PDF. The file may be corrupted or encrypted. " + (err && err.message ? err.message : "") }, "select");
        resetAll();
      });
    };
    reader.readAsArrayBuffer(file);
  }

  /* ---------- rendering ---------- */

  function cssWidthFor() {
    var wrapW = els.canvasWrap.clientWidth || 720;
    return Math.min(Math.max(280, wrapW), 900);
  }

  function viewDims() {
    var size = currentSize();
    var rot = currentRotation();
    var dims = C.rotatedDims(size.w, size.h, rot);
    var fitW = cssWidthFor();
    var cssW = view.fit ? fitW : Math.min(1400, Math.max(280, fitW * view.zoom));
    var scale = cssW / dims.w;
    return { cssW: cssW, cssH: dims.h * scale, scale: scale, rot: rot, size: size, dims: dims };
  }

  function setupCanvas(canvas, cssW, cssH) {
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  function renderView() {
    if (!doc) return;
    var key = currentKey();
    var vd = viewDims();
    var baseCtx = setupCanvas(els.base, vd.cssW, vd.cssH);
    var overCtx = setupCanvas(els.overlay, vd.cssW, vd.cssH);
    positionTextLayer(vd);
    if (key.indexOf("blank-") === 0) {
      baseCtx.fillStyle = "#ffffff";
      baseCtx.fillRect(0, 0, vd.cssW, vd.cssH);
      baseCtx.fillStyle = "#9aa3b5";
      baseCtx.font = "14px sans-serif";
      baseCtx.fillText("Blank page", 16, 28);
      drawObjects(overCtx, vd);
      afterRender(vd);
      return;
    }
    var origIdx = doc.keys.indexOf(key);
    doc.pdfDoc.getPage(origIdx + 1).then(function (page) {
      var viewport = page.getViewport({ scale: vd.scale });
      // Bake net rotation into the base render so the canvas is WYSIWYG.
      var rot = vd.rot;
      var off = document.createElement("canvas");
      var octx = off.getContext("2d");
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      off.width = Math.floor(vd.cssW * dpr);
      off.height = Math.floor(vd.cssH * dpr);
      octx.setTransform(dpr, 0, 0, dpr, 0, 0);
      octx.translate(vd.cssW / 2, vd.cssH / 2);
      octx.rotate((rot * Math.PI) / 180); // canvas rotate is clockwise-positive (y-down)
      var uw = vd.size.w * vd.scale, uh = vd.size.h * vd.scale;
      octx.translate(-uw / 2, -uh / 2);
      var base = document.createElement("canvas");
      base.width = Math.floor(uw * dpr);
      base.height = Math.floor(uh * dpr);
      var bctx = base.getContext("2d");
      bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      page.render({ canvasContext: bctx, viewport: page.getViewport({ scale: vd.scale }) }).promise.then(function () {
        octx.drawImage(base, 0, 0, uw, uh);
        baseCtx.drawImage(off, 0, 0, vd.cssW, vd.cssH);
        drawObjects(overCtx, vd);
        afterRender(vd);
      });
    });
  }

  function afterRender(vd) {
    els.pageLabel.textContent = "Page " + (view.pagePos + 1) + " / " + view.order.length;
    els.zoomLabel.textContent = Math.round(vd.scale * 100) + "%";
    if (tool === "replace") renderTextLayer(vd); else clearTextLayer();
    refreshChrome();
  }

  function viewOf() {
    var vd = viewDims();
    return { cssW: vd.cssW, cssH: vd.cssH };
  }

  function pageForView() {
    var size = currentSize();
    return { wPt: size.w, hPt: size.h, rotation: currentRotation() };
  }

  function toPage(xCss, yCss) {
    var r = els.overlay.getBoundingClientRect();
    return C.viewToPage(xCss - r.left, yCss - r.top, viewOf(), pageForView());
  }

  function toView(xPt, yPt) {
    return C.pageToView(xPt, yPt, viewOf(), pageForView());
  }

  /* ---------- overlay drawing ---------- */

  function canvasFont(obj, scale) {
    var parts = obj.font.split("-");
    var family = parts[0] === "Times" ? 'Georgia, "Times New Roman", serif'
      : parts[0] === "Courier" ? '"Courier New", Courier, monospace'
        : "Arial, Helvetica, sans-serif";
    var weight = /Bold/.test(obj.font) ? "bold" : "normal";
    var style = /Oblique|Italic/.test(obj.font) ? "italic" : "normal";
    return style + " " + weight + " " + (obj.fontSize * scale) + "px " + family;
  }

  function measure(obj, scale) {
    if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
    measureCtx.font = canvasFont(obj, scale);
    return measureCtx.measureText(obj.text).width;
  }

  function textBoxPt(obj) {
    var vd = viewDims();
    var wCss = measure(obj, vd.scale);
    var wPt = wCss / vd.scale, hPt = obj.fontSize * 1.2;
    var x0 = obj.align === "center" ? obj.x - wPt / 2 : obj.align === "right" ? obj.x - wPt : obj.x;
    return { x: x0, y: obj.y - 2, w: wPt, h: hPt };
  }

  function objectBox(obj) {
    if (obj.type === "text") {
      var b = textBoxPt(obj);
      return { x: b.x, y: b.y, w: b.w, h: b.h };
    }
    if (obj.type === "draw") {
      var xs = obj.points.map(function (p) { return p[0]; });
      var ys = obj.points.map(function (p) { return p[1]; });
      var x0 = Math.min.apply(null, xs), y0 = Math.min.apply(null, ys);
      return { x: x0, y: y0, w: Math.max.apply(null, xs) - x0, h: Math.max.apply(null, ys) - y0 };
    }
    if (obj.type === "line" || obj.type === "arrow") {
      var x0l = Math.min(obj.x1, obj.x2), y0l = Math.min(obj.y1, obj.y2);
      return { x: x0l, y: y0l, w: Math.abs(obj.x2 - obj.x1), h: Math.abs(obj.y2 - obj.y1) };
    }
    if (obj.type === "image" && obj.rotation) {
      var r = C.rotatedBbox(obj.x, obj.y, obj.width, obj.height, obj.rotation);
      return { x: r.x, y: r.y, w: r.w, h: r.h };
    }
    return { x: obj.x, y: obj.y, w: obj.width, h: obj.height };
  }

  function paintObject(ctx, obj, vd, selected) {
    var scale = vd.scale;
    function X(x) { return toView(x, 0).x; }
    function Y(y) { return toView(0, y).y; }
    ctx.save();
    if (obj.type === "text") {
      ctx.globalAlpha = obj.opacity;
      ctx.fillStyle = obj.color;
      ctx.font = canvasFont(obj, scale);
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = obj.align;
      var v = toView(obj.x, obj.y);
      ctx.fillText(obj.text, v.x, v.y);
      if (obj.underline) {
        var wCss = measure(obj, scale);
        var x0 = obj.align === "left" ? v.x : obj.align === "center" ? v.x - wCss / 2 : v.x - wCss;
        ctx.strokeStyle = obj.color;
        ctx.lineWidth = Math.max(1, obj.fontSize * scale / 14);
        ctx.beginPath();
        ctx.moveTo(x0, v.y + 2);
        ctx.lineTo(x0 + wCss, v.y + 2);
        ctx.stroke();
      }
    } else if (obj.type === "draw") {
      ctx.globalAlpha = obj.opacity;
      ctx.strokeStyle = obj.color;
      ctx.lineWidth = Math.max(1, obj.width * scale);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      obj.points.forEach(function (p, i) {
        var v = toView(p[0], p[1]);
        if (i === 0) ctx.moveTo(v.x, v.y); else ctx.lineTo(v.x, v.y);
      });
      ctx.stroke();
    } else if (obj.type === "highlight") {
      ctx.globalAlpha = obj.opacity;
      ctx.fillStyle = obj.color;
      var a = toView(obj.x, obj.y + obj.height), b = toView(obj.x + obj.width, obj.y);
      ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    } else if (obj.type === "whiteout") {
      ctx.fillStyle = obj.color;
      var a2 = toView(obj.x, obj.y + obj.height), b2 = toView(obj.x + obj.width, obj.y);
      ctx.fillRect(a2.x, a2.y, b2.x - a2.x, b2.y - a2.y);
    } else if (obj.type === "rect" || obj.type === "ellipse") {
      var c1 = toView(obj.x, obj.y + obj.height), c2 = toView(obj.x + obj.width, obj.y);
      var rx = c1.x, ry = c1.y, rw = c2.x - c1.x, rh = c2.y - c1.y;
      if (obj.opacity < 1) {
        ctx.globalAlpha = obj.opacity;
        ctx.fillStyle = obj.color;
        if (obj.type === "rect") ctx.fillRect(rx, ry, rw, rh);
        else { ctx.beginPath(); ctx.ellipse(rx + rw / 2, ry + rh / 2, Math.abs(rw / 2), Math.abs(rh / 2), 0, 0, 7); ctx.fill(); }
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = obj.color;
      ctx.lineWidth = Math.max(1, obj.border * scale);
      if (obj.type === "rect") ctx.strokeRect(rx, ry, rw, rh);
      else { ctx.beginPath(); ctx.ellipse(rx + rw / 2, ry + rh / 2, Math.abs(rw / 2), Math.abs(rh / 2), 0, 0, 7); ctx.stroke(); }
    } else if (obj.type === "underline" || obj.type === "strike") {
      ctx.strokeStyle = obj.color;
      ctx.lineWidth = Math.max(1, obj.thickness * scale);
      var yl = obj.type === "underline" ? obj.y + 2 : obj.y + obj.height / 2;
      var u1 = toView(obj.x, yl), u2 = toView(obj.x + obj.width, yl);
      ctx.beginPath(); ctx.moveTo(u1.x, u1.y); ctx.lineTo(u2.x, u2.y); ctx.stroke();
    } else if (obj.type === "line" || obj.type === "arrow") {
      ctx.strokeStyle = obj.color;
      ctx.fillStyle = obj.color;
      ctx.lineWidth = Math.max(1, obj.thickness * scale);
      ctx.lineCap = "round";
      var l1 = toView(obj.x1, obj.y1), l2 = toView(obj.x2, obj.y2);
      ctx.beginPath(); ctx.moveTo(l1.x, l1.y); ctx.lineTo(l2.x, l2.y); ctx.stroke();
      if (obj.type === "arrow") {
        var ang = Math.atan2(l2.y - l1.y, l2.x - l1.x);
        var sz = Math.max(6, obj.thickness * scale * 3);
        ctx.beginPath();
        ctx.moveTo(l2.x, l2.y);
        ctx.lineTo(l2.x - sz * Math.cos(ang - 0.44), l2.y - sz * Math.sin(ang - 0.44));
        ctx.lineTo(l2.x - sz * Math.cos(ang + 0.44), l2.y - sz * Math.sin(ang + 0.44));
        ctx.closePath(); ctx.fill();
      }
    } else if (obj.type === "image") {
      var img = imageCache[obj.fileUid];
      var i1 = toView(obj.x, obj.y + obj.height), i2 = toView(obj.x + obj.width, obj.y);
      if (img && img.complete && img.naturalWidth) {
        if (obj.rotation) {
          ctx.save();
          ctx.translate((i1.x + i2.x) / 2, (i1.y + i2.y) / 2);
          ctx.rotate((obj.rotation * Math.PI) / 180);
          ctx.drawImage(img, -(i2.x - i1.x) / 2, -(i2.y - i1.y) / 2, i2.x - i1.x, i2.y - i1.y);
          ctx.restore();
        } else {
          ctx.drawImage(img, i1.x, i1.y, i2.x - i1.x, i2.y - i1.y);
        }
      } else {
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = "#4f46e5";
        ctx.strokeRect(i1.x, i1.y, i2.x - i1.x, i2.y - i1.y);
        ctx.setLineDash([]);
      }
    } else if (obj.type === "link") {
      var g1 = toView(obj.x, obj.y + obj.height), g2 = toView(obj.x + obj.width, obj.y);
      ctx.strokeStyle = "#4f46e5";
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(g1.x, g1.y, g2.x - g1.x, g2.y - g1.y);
      ctx.setLineDash([]);
    }
    ctx.restore();
    if (selected) drawSelection(ctx, obj, vd);
  }

  var HANDLE_R = 6;
  function drawSelection(ctx, obj, vd) {
    var box = objectBox(obj);
    var a = toView(box.x, box.y + box.h), b = toView(box.x + box.w, box.y);
    var x = a.x, y = a.y, w = b.x - a.x, h = b.y - a.y;
    ctx.save();
    ctx.strokeStyle = "#4f46e5";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    ctx.fillStyle = "#ffffff";
    var pts = [[x, y], [x + w, y], [x, y + h], [x + w, y + h],
               [x + w / 2, y], [x + w / 2, y + h], [x, y + h / 2], [x + w, y + h / 2]];
    pts.forEach(function (p) {
      ctx.fillRect(p[0] - HANDLE_R / 2, p[1] - HANDLE_R / 2, HANDLE_R, HANDLE_R);
      ctx.strokeRect(p[0] - HANDLE_R / 2, p[1] - HANDLE_R / 2, HANDLE_R, HANDLE_R);
    });
    obj._selRect = { x: x, y: y, w: w, h: h };
    ctx.restore();
  }

  function drawObjects(ctx, vd) {
    var key = currentKey();
    state.objects.forEach(function (obj) {
      if (obj.pageKey === key) paintObject(ctx, obj, vd, obj.id === state.selectedId);
    });
    if (gesture && gesture.paint) gesture.paint(ctx, vd);
  }

  function redrawOverlay() {
    if (!doc) return;
    var vd = viewDims();
    var ctx = setupCanvas(els.overlay, vd.cssW, vd.cssH);
    drawObjects(ctx, vd);
  }

  /* ---------- hit testing ---------- */

  function hitTest(obj, pPt, tolPt) {
    function nearSeg(px, py, ax, ay, bx, by, tol) {
      var dx = bx - ax, dy = by - ay;
      var len2 = dx * dx + dy * dy;
      var t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      var cx = ax + t * dx - px, cy = ay + t * dy - py;
      return Math.sqrt(cx * cx + cy * cy) <= tol;
    }
    if (obj.type === "text") {
      var b = textBoxPt(obj);
      return pPt.x >= b.x - tolPt && pPt.x <= b.x + b.w + tolPt &&
        pPt.y >= b.y - tolPt && pPt.y <= b.y + b.h + tolPt;
    }
    if (obj.type === "draw") {
      for (var i = 1; i < obj.points.length; i++) {
        if (nearSeg(pPt.x, pPt.y, obj.points[i - 1][0], obj.points[i - 1][1],
          obj.points[i][0], obj.points[i][1], Math.max(tolPt, obj.width))) return true;
      }
      return false;
    }
    if (obj.type === "line" || obj.type === "arrow") {
      return nearSeg(pPt.x, pPt.y, obj.x1, obj.y1, obj.x2, obj.y2,
        Math.max(tolPt, obj.thickness + 2));
    }
    var box = objectBox(obj);
    return pPt.x >= box.x && pPt.x <= box.x + box.w &&
      pPt.y >= box.y && pPt.y <= box.y + box.h;
  }

  function objectAt(pPt) {
    var key = currentKey();
    for (var i = state.objects.length - 1; i >= 0; i--) {
      var obj = state.objects[i];
      if (obj.pageKey === key && hitTest(obj, pPt, 3)) return obj;
    }
    return null;
  }

  /* Link safety: only http(s) URLs. Dangerous schemes
   * (javascript:, data:, file:, ftp:, ...) are rejected here AND
   * server-side; the editor never navigates to user URLs itself. */
  function isSafeLinkUrl(url) {
    var u = String(url || "").trim();
    if (!u || u.length > 2000) return false;
    if (!/^https?:\/\//i.test(u)) return false;
    if (/[\s<>"']/.test(u)) return false;
    var lower = u.toLowerCase();
    return ["javascript:", "data:", "file:", "ftp:", "vbscript:"].every(
      function (scheme) { return lower.indexOf(scheme) !== 0; });
  }

  /* ---------- pointer interaction ---------- */

  function canvasPos(e) {
    var r = els.overlay.getBoundingClientRect();
    var cx = (e.clientX - r.left), cy = (e.clientY - r.top);
    return { css: { x: cx, y: cy }, pt: toPage(e.clientX, e.clientY), rect: r };
  }

  function capturePointer(e) {
    try {
      els.overlay.setPointerCapture(e.pointerId);
    } catch (err) {
      /* Synthetic events and edge cases may lack an active pointer;
         interaction still works without capture. */
    }
  }

  function onPointerDown(e) {
    if (!doc || busy) return;
    if (e.button !== 0 && e.pointerType === "mouse") return;
    var pos = canvasPos(e);
    capturePointer(e);
    if (tool === "select") {
      var obj = objectAt(pos.pt);
      var handle = obj && obj._selRect ? handleAt(obj, pos.css) : null;
      state.selectedId = obj ? obj.id : null;
      if (obj && handle) {
        gesture = { kind: handle === "rotate" ? "rotate" : "resize", obj: obj, handle: handle, startPt: pos.pt, orig: JSON.parse(JSON.stringify(obj)) };
      } else if (obj) {
        gesture = { kind: "move", obj: obj, startPt: pos.pt, orig: JSON.parse(JSON.stringify(obj)), moved: false };
      } else {
        gesture = null;
      }
      renderProps();
      redrawOverlay();
      refreshChrome();
      return;
    }
    if (tool === "eraser") {
      var target = objectAt(pos.pt);
      if (target && (target.type === "draw" || target.type === "whiteout" ||
          target.type === "highlight" || target.type === "underline" || target.type === "strike")) {
        S.removeObject(state, target.id);
        renderProps();
        redrawOverlay();
        refreshChrome();
      } else if (target) {
        setTopStatus("Eraser only removes drawings, highlights and whiteouts.");
      }
      return;
    }
    if (tool === "text") {
      var t = {
        type: "text", pageKey: currentKey(), x: C.round2(pos.pt.x), y: C.round2(pos.pt.y),
        text: opts.text || "Text", fontSize: opts.fontSize, font: opts.font,
        align: opts.align, color: opts.color, opacity: opts.opacity, underline: opts.underline
      };
      S.addObject(state, t);
      openTextEditor(t);
      renderProps();
      redrawOverlay();
      refreshChrome();
      return;
    }
    if (tool === "image" || (tool === "sign" && signMode === "upload")) {
      var staged = tool === "image" ? stagedImage : stagedSignImage;
      if (!staged) { pickImage(tool === "sign" ? "sign" : "image"); return; }
      var wPt = Math.min(300, staged.width * 72 / 150);
      var hPt = wPt * staged.height / staged.width;
      S.addObject(state, {
        type: "image", pageKey: currentKey(),
        x: C.round2(pos.pt.x - wPt / 2), y: C.round2(pos.pt.y - hPt / 2),
        width: C.round2(wPt), height: C.round2(hPt), rotation: 0,
        fileUid: staged.uid, fileName: staged.file.name
      });
      renderProps();
      redrawOverlay();
      refreshChrome();
      return;
    }
    if (tool === "link") {
      gesture = { kind: "box", startCss: pos.css, startPt: pos.pt, cur: pos.css };
      gesture.paint = function (ctx) {
        var r = normRect(gesture.startCss, gesture.cur);
        ctx.save();
        ctx.strokeStyle = "#4f46e5"; ctx.setLineDash([4, 3]);
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        ctx.restore();
      };
      return;
    }
    if (tool === "draw" || (tool === "sign" && signMode === "draw")) {
      gesture = {
        kind: "stroke", obj: null, pageKey: currentKey(),
        points: [[C.round2(pos.pt.x), C.round2(pos.pt.y)]],
        color: tool === "sign" ? "#1e3a8a" : opts.color,
        width: tool === "sign" ? 2 : opts.width
      };
      gesture.paint = function (ctx, vd) {
        ctx.save();
        ctx.strokeStyle = gesture.color;
        ctx.lineWidth = Math.max(1, gesture.width * vd.scale);
        ctx.lineCap = "round";
        ctx.beginPath();
        gesture.points.forEach(function (p, i) {
          var v = toView(p[0], p[1]);
          if (i === 0) ctx.moveTo(v.x, v.y); else ctx.lineTo(v.x, v.y);
        });
        ctx.stroke();
        ctx.restore();
      };
      return;
    }
    // box tools: rect ellipse highlight whiteout underline strike
    gesture = { kind: "box", startCss: pos.css, startPt: pos.pt, cur: pos.css };
    gesture.paint = function (ctx) {
      var r = normRect(gesture.startCss, gesture.cur);
      ctx.save();
      ctx.strokeStyle = tool === "highlight" ? opts.highlightColor : opts.color;
      ctx.globalAlpha = tool === "highlight" ? opts.highlightAlpha : 1;
      ctx.fillStyle = ctx.strokeStyle;
      if (tool === "highlight" || tool === "whiteout") ctx.fillRect(r.x, r.y, r.w, r.h);
      else ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.restore();
    };
  }

  function normRect(a, b) {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
  }

  function onPointerMove(e) {
    if (!gesture || !doc) return;
    var pos = canvasPos(e);
    if (gesture.kind === "move") {
      var dx = pos.pt.x - gesture.startPt.x, dy = pos.pt.y - gesture.startPt.y;
      if (Math.abs(dx) + Math.abs(dy) > 0.5) gesture.moved = true;
      moveObject(gesture.obj, gesture.orig, dx, dy);
      redrawOverlay();
    } else if (gesture.kind === "resize") {
      resizeObject(gesture.obj, gesture.orig, gesture.handle, gesture.startPt, pos.pt);
      redrawOverlay();
    } else if (gesture.kind === "rotate") {
      rotateObject(gesture.obj, gesture.orig, gesture.startPt, pos.pt);
      redrawOverlay();
    } else if (gesture.kind === "stroke") {
      var last = gesture.points[gesture.points.length - 1];
      var dxs = pos.pt.x - last[0], dys = pos.pt.y - last[1];
      if (dxs * dxs + dys * dys >= 1 && gesture.points.length < 2000) {
        gesture.points.push([C.round2(pos.pt.x), C.round2(pos.pt.y)]);
        redrawOverlay();
      }
    } else if (gesture.kind === "box") {
      gesture.cur = pos.css;
      redrawOverlay();
    }
  }

  function onPointerUp(e) {
    if (!gesture || !doc) { gesture = null; return; }
    var g = gesture;
    gesture = null;
    if (g.kind === "move") {
      if (g.moved) S.touch(state);
      state.selectedId = g.obj.id;
      renderProps(); redrawOverlay(); refreshChrome();
    } else if (g.kind === "resize" || g.kind === "rotate") {
      S.touch(state);
      renderProps(); redrawOverlay(); refreshChrome();
    } else if (g.kind === "stroke") {
      if (g.points.length >= 2) {
        S.addObject(state, {
          type: "draw", pageKey: g.pageKey, points: g.points,
          width: g.width, color: g.color, opacity: tool === "sign" ? 1 : opts.opacity
        });
        setTool("select");
      }
      renderProps(); redrawOverlay(); refreshChrome();
    } else if (g.kind === "box") {
      var r = normRect(g.startCss, g.cur);
      if (r.w < 4 || r.h < 4) { redrawOverlay(); return; }
      var vd = viewDims();
      commitBoxTool(inverseBox(r, vd));
      renderProps(); redrawOverlay(); refreshChrome();
    }
  }

  /* Map a view-space css rect to page pt through the rotation-aware transform. */
  function inverseBox(r, vd) {
    var size = currentSize();
    var tl = C.viewToPage(r.x, r.y, { cssW: vd.cssW, cssH: vd.cssH },
      { wPt: size.w, hPt: size.h, rotation: currentRotation() });
    var br = C.viewToPage(r.x + r.w, r.y + r.h, { cssW: vd.cssW, cssH: vd.cssH },
      { wPt: size.w, hPt: size.h, rotation: currentRotation() });
    var x0 = Math.min(tl.x, br.x), y0 = Math.min(tl.y, br.y);
    return {
      x: C.round2(x0), y: C.round2(y0),
      width: C.round2(Math.abs(br.x - tl.x)), height: C.round2(Math.abs(br.y - tl.y))
    };
  }

  function commitBoxTool(box) {
    box = C.clampBoxToPage(box, currentSize().w, currentSize().h);
    var base = { pageKey: currentKey() };
    if (tool === "highlight") {
      base.type = "highlight";
      base.x = box.x; base.y = box.y; base.width = box.width; base.height = box.height;
      base.color = opts.highlightColor; base.opacity = opts.highlightAlpha;
    } else if (tool === "whiteout") {
      base.type = "whiteout";
      base.x = box.x; base.y = box.y; base.width = box.width; base.height = box.height;
      base.color = "#FFFFFF"; base.opacity = 1;
    } else if (tool === "underline" || tool === "strike") {
      base.type = tool;
      base.x = box.x; base.y = box.y; base.width = box.width; base.height = box.height;
      base.color = opts.color; base.thickness = opts.thickness;
    } else if (tool === "rect" || tool === "ellipse") {
      base.type = tool;
      base.x = box.x; base.y = box.y; base.width = box.width; base.height = box.height;
      base.color = opts.color; base.opacity = opts.opacity; base.border = opts.border;
    } else if (tool === "link") {
      base.type = "link";
      base.x = box.x; base.y = box.y; base.width = box.width; base.height = box.height;
      base.url = opts.url || "";
      setTool("select");
    }
    var added = S.addObject(state, base);
    if (base.type === "link") openLinkEditor(added);
  }

  function moveObject(obj, orig, dx, dy) {
    function sh(v) { return C.round2(v); }
    if (obj.type === "text" || obj.type === "highlight" || obj.type === "rect" ||
        obj.type === "ellipse" || obj.type === "whiteout" || obj.type === "underline" ||
        obj.type === "strike" || obj.type === "link" || obj.type === "image") {
      obj.x = sh(orig.x + dx); obj.y = sh(orig.y + dy);
    } else if (obj.type === "draw") {
      obj.points = orig.points.map(function (p) { return [sh(p[0] + dx), sh(p[1] + dy)]; });
    } else if (obj.type === "line" || obj.type === "arrow") {
      obj.x1 = sh(orig.x1 + dx); obj.y1 = sh(orig.y1 + dy);
      obj.x2 = sh(orig.x2 + dx); obj.y2 = sh(orig.y2 + dy);
    }
  }

  function resizeObject(obj, orig, handle, startPt, curPt) {
    var dx = curPt.x - startPt.x, dy = curPt.y - startPt.y;
    var box = objectBox(orig);
    var x0 = box.x, y0 = box.y, x1 = box.x + box.w, y1 = box.y + box.h;
    if (handle.indexOf("e") >= 0) x1 += dx;
    if (handle.indexOf("w") >= 0) x0 += dx;
    if (handle.indexOf("n") >= 0) y1 += dy;
    if (handle.indexOf("s") >= 0) y0 += dy;
    if (x1 - x0 < 2) x1 = x0 + 2;
    if (y1 - y0 < 2) y1 = y0 + 2;
    applyBoxResize(obj, orig, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, box);
  }

  function applyBoxResize(obj, orig, nb, ob) {
    function r(v) { return C.round2(v); }
    if (obj.type === "text") {
      // Text resizes via font size (height ratio); the anchor point stays put.
      var ratio = ob.h > 0 ? nb.h / ob.h : 1;
      obj.fontSize = Math.min(144, Math.max(6, Math.round(orig.fontSize * ratio)));
      return;
    }
    if (obj.type === "draw") {
      var sx = ob.w > 0 ? nb.w / ob.w : 1, sy = ob.h > 0 ? nb.h / ob.h : 1;
      obj.points = orig.points.map(function (p) {
        return [r(nb.x + (p[0] - ob.x) * sx), r(nb.y + (p[1] - ob.y) * sy)];
      });
      return;
    }
    if (obj.type === "line" || obj.type === "arrow") {
      var sx2 = ob.w > 0 ? nb.w / ob.w : 1, sy2 = ob.h > 0 ? nb.h / ob.h : 1;
      obj.x1 = r(nb.x + (orig.x1 - ob.x) * sx2);
      obj.y1 = r(nb.y + (orig.y1 - ob.y) * sy2);
      obj.x2 = r(nb.x + (orig.x2 - ob.x) * sx2);
      obj.y2 = r(nb.y + (orig.y2 - ob.y) * sy2);
      return;
    }
    if (obj.type === "image" && orig.rotation) {
      // Resize in the unrotated frame: map the new box back.
      var cx = orig.x + orig.width / 2, cy = orig.y + orig.height / 2;
      var th = (orig.rotation * Math.PI) / 180;
      var cos = Math.cos(th), sin = Math.sin(th);
      function inv(px, py) {
        var dx = px - cx, dy = py - cy;
        return [cx + dx * cos + dy * sin, cy - dx * sin + dy * cos];
      }
      var c1 = inv(nb.x, nb.y), c2 = inv(nb.x + nb.w, nb.y + nb.h);
      var ux0 = Math.min(c1[0], c2[0]), uy0 = Math.min(c1[1], c2[1]);
      obj.x = r(ux0); obj.y = r(uy0);
      obj.width = r(Math.abs(c2[0] - c1[0])); obj.height = r(Math.abs(c2[1] - c1[1]));
      return;
    }
    obj.x = r(nb.x); obj.y = r(nb.y);
    obj.width = r(nb.w); obj.height = r(nb.h);
  }

  function rotateObject(obj, orig, startPt, curPt) {
    var cx = orig.x + orig.width / 2, cy = orig.y + orig.height / 2;
    var a0 = Math.atan2(startPt.y - cy, startPt.x - cx);
    var a1 = Math.atan2(curPt.y - cy, curPt.x - cx);
    var deg = ((a1 - a0) * 180) / Math.PI; // pt space is y-up: standard math angle
    var rot = (orig.rotation || 0) - deg; // screen-clockwise positive
    obj.rotation = C.round2(((rot % 360) + 360) % 360);
    if (obj.rotation > 180) obj.rotation = C.round2(obj.rotation - 360);
  }

  function handleAt(obj, cssPos) {
    if (!obj._selRect) return null;
    var r = obj._selRect;
    function near(px, py) {
      return Math.abs(cssPos.x - px) <= 8 && Math.abs(cssPos.y - py) <= 8;
    }
    var x = r.x, y = r.y, w = r.w, h = r.h;
    if (near(x + w / 2, y - 18) && obj.type === "image") return "rotate";
    if (near(x, y)) return "nw";
    if (near(x + w, y)) return "ne";
    if (near(x, y + h)) return "sw";
    if (near(x + w, y + h)) return "se";
    if (near(x + w / 2, y)) return "n";
    if (near(x + w / 2, y + h)) return "s";
    if (near(x, y + h / 2)) return "w";
    if (near(x + w, y + h / 2)) return "e";
    return null;
  }

  /* ---------- text editing ---------- */

  function openTextEditor(obj) {
    var v = toView(obj.x, obj.y);
    var ta = els.textInput;
    ta.hidden = false;
    ta.value = obj.text;
    ta.style.left = Math.max(0, v.x - 4) + "px";
    ta.style.top = Math.max(0, v.y - 24) + "px";
    ta.style.font = canvasFont(obj, viewDims().scale);
    ta.style.color = obj.color;
    ta.dataset.objId = obj.id;
    setTimeout(function () { ta.focus(); ta.select(); }, 0);
  }

  function closeTextEditor(commitText) {
    var ta = els.textInput;
    if (ta.hidden) return;
    ta.hidden = true;
    var obj = S.getObject(state, ta.dataset.objId);
    if (obj && commitText) {
      var v = ta.value;
      if (!v.trim()) {
        S.removeObject(state, obj.id);
      } else {
        S.touch(state);
        obj.text = v.slice(0, 2000);
      }
      renderProps();
      redrawOverlay();
      refreshChrome();
    } else if (obj && !obj.text.trim()) {
      S.removeObject(state, obj.id);
      redrawOverlay();
      refreshChrome();
    }
  }

  function openLinkEditor(obj) {
    renderProps();
    var input = $("edLinkUrl");
    if (input) { input.focus(); input.select(); }
  }

  /* ---------- properties panel ---------- */

  function esc(s) {
    return String(s).split("&").join("&amp;").split("<").join("&lt;")
      .split(">").join("&gt;").split('"').join("&quot;");
  }

  function renderProps() {
    var html = "";
    var sel = state.selectedId ? S.getObject(state, state.selectedId) : null;
    if (sel) {
      html += '<div class="props-row"><strong>' + esc(sel.type) + '</strong> <span class="props-id">' + esc(sel.id) + '</span>';
      html += ' <button class="mini-btn" data-act="dup">Duplicate</button>';
      html += ' <button class="mini-btn danger" data-act="del">Delete</button></div>';
      if (sel.type === "text") {
        html += propsText(sel);
      } else if (sel.type === "image") {
        html += '<div class="props-row"><label>Rotation <input type="number" id="edPropRot" value="' + (sel.rotation || 0) + '" min="-180" max="180" step="1" style="width:70px"></label>°</div>';
      } else if (sel.type === "link") {
        html += '<div class="props-row"><label>URL <input type="url" id="edLinkUrl" value="' + esc(sel.url || "") + '" placeholder="https://…" style="width:260px"></label></div>';
      }
      if (sel.color !== undefined && sel.type !== "link") {
        html += '<div class="props-row"><label>Color <input type="color" id="edPropColor" value="' + esc(sel.color) + '"></label>';
        if (sel.opacity !== undefined) {
          html += '<label>Opacity <input type="range" id="edPropOpacity" min="0.1" max="1" step="0.05" value="' + sel.opacity + '"></label>';
        }
        html += "</div>";
      }
    } else {
      html += "<span class='props-hint'>" + toolHint() + "</span>";
      if (tool === "text") html += propsText(null);
      if (tool === "image") html += '<div class="props-row"><button class="mini-btn" data-act="pick-image">Choose image…</button><span>' + (stagedImage ? esc(stagedImage.file.name) : "none staged") + "</span></div>";
      if (tool === "sign") {
        html += '<div class="props-row"><label><input type="radio" name="signmode" value="draw"' + (signMode === "draw" ? " checked" : "") + "> Draw</label>";
        html += '<label><input type="radio" name="signmode" value="upload"' + (signMode === "upload" ? " checked" : "") + '> Upload</label>';
        if (signMode === "upload") html += '<button class="mini-btn" data-act="pick-sign">Choose file…</button><span>' + (stagedSignImage ? esc(stagedSignImage.file.name) : "none staged") + "</span>";
        html += "</div>";
      }
      if (tool === "link") html += '<div class="props-row"><label>URL <input type="url" id="edLinkUrlNew" value="' + esc(opts.url) + '" placeholder="https://…" style="width:260px"></label></div>';
    }
    els.props.innerHTML = html;
    wireProps(sel);
  }

  function propsText(sel) {
    var f = sel || { font: opts.font, fontSize: opts.fontSize, align: opts.align, color: opts.color, opacity: opts.opacity, underline: opts.underline };
    var h = '<div class="props-row"><label>Font <select id="edPropFont">';
    PDF_FONTS.forEach(function (name) {
      h += '<option value="' + name + '"' + (name === f.font ? " selected" : "") + ">" + FONT_LABELS[name] + "</option>";
    });
    h += '</select></label>';
    h += '<label>Size <input type="number" id="edPropSize" value="' + f.fontSize + '" min="6" max="144" style="width:64px"></label>';
    h += '<label>Align <select id="edPropAlign"><option' + (f.align === "left" ? " selected" : "") + '>left</option><option' + (f.align === "center" ? " selected" : "") + '>center</option><option' + (f.align === "right" ? " selected" : "") + '>right</option></select></label>';
    h += '<label><input type="checkbox" id="edPropUnderline"' + (f.underline ? " checked" : "") + "> U</label></div>";
    return h;
  }

  function toolHint() {
    switch (tool) {
      case "select": return "Click an object to select, drag to move, drag handles to resize. Double-click text to edit.";
      case "text": return "Click on the page to place text, then type.";
      case "image": return stagedImage ? "Click on the page to place the staged image." : "Choose an image, then click on the page to place it.";
      case "draw": return "Drag on the page to draw freehand.";
      case "highlight": return "Drag a box over content to highlight it.";
      case "whiteout": return "Drag a box to cover content (visual cover only — not secure redaction).";
      case "sign": return signMode === "draw" ? "Draw your signature on the page." : "Choose a signature image, then click to place it.";
      case "link": return "Drag a box, then enter the URL.";
      case "replace": return "Select existing page text, then choose Replace selection.";
      case "eraser": return "Click a drawing, highlight or whiteout to remove it.";
      default: return "Drag on the page to draw a " + tool + ".";
    }
  }

  function wireProps(sel) {
    function on(id, evt, fn) {
      var el = $(id);
      if (el) el.addEventListener(evt, fn);
    }
    els.props.querySelectorAll("[data-act]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var act = btn.getAttribute("data-act");
        if (act === "del" && sel) { S.removeObject(state, sel.id); }
        else if (act === "dup" && sel) {
          var copy = JSON.parse(JSON.stringify(sel));
          copy.id = S.nextId(state);
          if (copy.x !== undefined) { copy.x = C.round2(copy.x + 10); copy.y = C.round2(copy.y - 10); }
          S.addObject(state, copy);
        }
        else if (act === "pick-image") pickImage("image");
        else if (act === "pick-sign") pickImage("sign");
        renderProps(); redrawOverlay(); refreshChrome();
      });
    });
    function applyText(target) {
      var f = $("edPropFont"), s = $("edPropSize"), a = $("edPropAlign"), u = $("edPropUnderline");
      var vals = {
        font: f ? f.value : target.font,
        fontSize: s ? Math.min(144, Math.max(6, +s.value || target.fontSize)) : target.fontSize,
        align: a ? a.value : target.align,
        underline: u ? u.checked : target.underline
      };
      if (sel) {
        S.touch(state);
        sel.font = vals.font; sel.fontSize = vals.fontSize;
        sel.align = vals.align; sel.underline = vals.underline;
      } else {
        opts.font = vals.font; opts.fontSize = vals.fontSize;
        opts.align = vals.align; opts.underline = vals.underline;
      }
      redrawOverlay(); refreshChrome();
    }
    ["edPropFont", "edPropSize", "edPropAlign", "edPropUnderline"].forEach(function (id) {
      on(id, "change", function () { applyText(sel || opts); });
    });
    on("edPropColor", "change", function (e) {
      if (sel) { S.touch(state); sel.color = e.target.value; }
      else opts.color = e.target.value;
      redrawOverlay();
    });
    on("edPropOpacity", "change", function (e) {
      if (sel) { S.touch(state); sel.opacity = +e.target.value; }
      else opts.opacity = +e.target.value;
      redrawOverlay();
    });
    on("edPropRot", "change", function (e) {
      if (sel) {
        S.touch(state);
        var r = +e.target.value || 0;
        sel.rotation = Math.max(-180, Math.min(180, r));
        redrawOverlay(); refreshChrome();
      }
    });
    on("edLinkUrl", "change", function (e) {
      if (sel) { S.touch(state); sel.url = e.target.value.trim(); refreshChrome(); }
    });
    on("edLinkUrlNew", "change", function (e) { opts.url = e.target.value.trim(); });
    els.props.querySelectorAll('input[name="signmode"]').forEach(function (r) {
      r.addEventListener("change", function () {
        signMode = document.querySelector('input[name="signmode"]:checked').value;
        renderProps();
      });
    });
  }

  /* ---------- tools ---------- */

  function setTool(name) {
    tool = name;
    els.toolbar.querySelectorAll(".tool-btn").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-tool") === name);
    });
    els.overlay.style.cursor = name === "select" ? "default" : "crosshair";
    if (name === "image" && !stagedImage) pickImage("image");
    if (name === "sign" && signMode === "upload" && !stagedSignImage) pickImage("sign");
    if (name !== "replace") clearTextLayer();
    renderProps();
    redrawOverlay();
  }

  /* ---------- images ---------- */

  /* pickImage(kind) is defined near stepZoom. */

  function stageImageFile(file, kind) {
    clearError();
    Cloud().validateEditImage(file).then(function (clean) {
      if (!clean.ok) {
        showError({ code: "InvalidFile", message: clean.message }, "select");
        return;
      }
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        if (img.naturalWidth > 12000 || img.naturalHeight > 12000) {
          URL.revokeObjectURL(url);
          showError({ code: "InvalidFile", message: "Image dimensions are too large (over 12000 px). Please use a smaller image." }, "select");
          return;
        }
        if (img.naturalWidth < 1 || img.naturalHeight < 1) {
          URL.revokeObjectURL(url);
          showError({ code: "InvalidFile", message: "That image has no readable pixels." }, "select");
          return;
        }
        var staged = {
          uid: "staged-" + Date.now() + "-" + Math.floor(Math.random() * 1e6),
          file: file, url: url, width: img.naturalWidth, height: img.naturalHeight
        };
        imageCache[staged.uid] = img;
        if (kind === "sign") stagedSignImage = staged; else stagedImage = staged;
        renderProps();
        setTopStatus("Image staged: " + file.name + " (" + img.naturalWidth + "×" + img.naturalHeight + "). Click the page to place it.");
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        showError({ code: "InvalidFile", message: "Invalid image format. Please choose a PNG or JPEG file." }, "select");
      };
      img.src = url;
    });
  }

  var imageCache = {};

  /* ---------- thumbnails + page ops ---------- */

  function renderThumbs() {
    els.thumbs.innerHTML = "";
    view.order.forEach(function (key, pos) {
      var li = document.createElement("li");
      li.className = "thumb" + (pos === view.pagePos ? " active" : "");
      li.draggable = true;
      li.dataset.pos = pos;
      var label = document.createElement("span");
      label.className = "thumb-label";
      var rot = view.rotations[key] || 0;
      label.textContent = "Page " + (pos + 1) + (rot ? " (" + rot + "°)" : "") + (key.indexOf("blank-") === 0 ? " (blank)" : "");
      var cv = document.createElement("canvas");
      cv.width = 96;
      cv.height = 128;
      li.appendChild(cv);
      li.appendChild(label);
      var bar = document.createElement("div");
      bar.className = "thumb-bar";
      [["⟲", "rot-ccw", "Rotate counter-clockwise"], ["⟳", "rot-cw", "Rotate clockwise"],
       ["×", "del", "Delete page"], ["‹", "up", "Move earlier"], ["›", "down", "Move later"]].forEach(function (def) {
        var b = document.createElement("button");
        b.className = "mini-btn";
        b.textContent = def[0];
        b.title = def[2];
        b.setAttribute("data-op", def[1]);
        b.setAttribute("data-pos", pos);
        bar.appendChild(b);
      });
      li.appendChild(bar);
      li.addEventListener("click", function (e) {
        var opBtn = e.target.closest("[data-op]");
        if (opBtn) { pageOp(opBtn.getAttribute("data-op"), +opBtn.getAttribute("data-pos")); return; }
        view.pagePos = pos;
        renderThumbs();
        renderView();
        refreshChrome();
      });
      li.addEventListener("dragstart", function (e) {
        e.dataTransfer.setData("text/plain", String(pos));
      });
      li.addEventListener("dragover", function (e) { e.preventDefault(); });
      li.addEventListener("drop", function (e) {
        e.preventDefault();
        var from = +e.dataTransfer.getData("text/plain");
        if (from !== pos) movePageOp(from, pos);
      });
      els.thumbs.appendChild(li);
      paintThumb(cv, key);
    });
  }

  function paintThumb(cv, key) {
    var ctx = cv.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, cv.width, cv.height);
    if (key.indexOf("blank-") === 0) {
      ctx.fillStyle = "#9aa3b5";
      ctx.font = "10px sans-serif";
      ctx.fillText("Blank", 30, 66);
      return;
    }
    var idx = doc.keys.indexOf(key);
    doc.pdfDoc.getPage(idx + 1).then(function (page) {
      var vp = page.getViewport({ scale: 96 / page.getViewport({ scale: 1 }).width });
      cv.height = Math.floor(vp.height);
      page.render({ canvasContext: ctx, viewport: vp });
    });
  }

  function visibleToOpPage(pos) {
    // Visible position -> 1-based page number in the CURRENT op sequence.
    return pos + 1;
  }

  function pageOp(kind, pos) {
    if (busy) return;
    try {
      if (kind === "rot-cw") state.pageOps.push({ action: "rotate", page: visibleToOpPage(pos), angle: 90 });
      else if (kind === "rot-ccw") state.pageOps.push({ action: "rotate", page: visibleToOpPage(pos), angle: 270 });
      else if (kind === "del") state.pageOps.push({ action: "delete", page: visibleToOpPage(pos) });
      else if (kind === "up" || kind === "down") {
        var to = kind === "up" ? pos : pos + 2; // move op uses 1-based final position
        state.pageOps.push({ action: "move", page: visibleToOpPage(pos), to: to });
      }
      S.touch(state);
      recomputeView();
      if (view.pagePos >= view.order.length) view.pagePos = view.order.length - 1;
      renderThumbs();
      renderView();
      refreshChrome();
    } catch (err) {
      state.pageOps.pop();
      showError({ code: "InvalidOp", message: err.message }, "select");
    }
  }

  function movePageOp(from, to) {
    if (busy || from === to) return;
    try {
      state.pageOps.push({ action: "move", page: from + 1, to: to + 1 });
      S.touch(state);
      recomputeView();
      renderThumbs();
      renderView();
      refreshChrome();
    } catch (err) {
      state.pageOps.pop();
      showError({ code: "InvalidOp", message: err.message }, "select");
    }
  }

  /* ---------- replace-text flow ---------- */

  function positionTextLayer(vd) {
    els.textLayer.style.width = vd.cssW + "px";
    els.textLayer.style.height = vd.cssH + "px";
  }

  function clearTextLayer() {
    els.textLayer.hidden = true;
    els.textLayer.innerHTML = "";
    els.replaceBar.hidden = true;
    textLayerCleanup = [];
  }

  function renderTextLayer(vd) {
    clearTextLayer();
    var key = currentKey();
    if (key.indexOf("blank-") === 0) return;
    var idx = doc.keys.indexOf(key);
    doc.pdfDoc.getPage(idx + 1).then(function (page) {
      if (tool !== "replace") return;
      page.getTextContent().then(function (content) {
        if (tool !== "replace") return;
        var viewport = page.getViewport({ scale: vd.scale });
        els.textLayer.hidden = false;
        els.replaceBar.hidden = false;
        content.items.forEach(function (item) {
          var tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
          var h = Math.hypot(tx[2], tx[3]);
          var span = document.createElement("span");
          span.textContent = item.str + " ";
          span.style.left = tx[4] + "px";
          span.style.top = (tx[5] - h) + "px";
          span.style.fontSize = h + "px";
          els.textLayer.appendChild(span);
        });
      });
    });
  }

  function replaceSelection() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      setTopStatus("Select text on the page first.");
      return;
    }
    var layerRect = els.textLayer.getBoundingClientRect();
    var spans = els.textLayer.querySelectorAll("span");
    var boxes = [];
    var full = "";
    spans.forEach(function (sp) {
      if (!sel.containsNode(sp, true)) return;
      var r = sp.getRange ? null : null;
      var rr = sp.getBoundingClientRect();
      if (rr.width > 0 && rr.height > 0 &&
        rr.left >= layerRect.left - 1 && rr.right <= layerRect.right + 1) {
        boxes.push({
          x: rr.left - layerRect.left, y: rr.top - layerRect.top,
          w: rr.width, h: rr.height
        });
        full += sp.textContent;
      }
    });
    if (!boxes.length) {
      setTopStatus("Select text on the page first.");
      return;
    }
    var x0 = Math.min.apply(null, boxes.map(function (b) { return b.x; }));
    var y0 = Math.min.apply(null, boxes.map(function (b) { return b.y; }));
    var x1 = Math.max.apply(null, boxes.map(function (b) { return b.x + b.w; }));
    var y1 = Math.max.apply(null, boxes.map(function (b) { return b.y + b.h; }));
    var vd = viewDims();
    var size = currentSize();
    var pdfBox = inverseBox({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, vd);
    pdfBox = C.clampBoxToPage(pdfBox, size.w, size.h);
    var group = S.nextId(state);
    S.addObject(state, {
      type: "whiteout", pageKey: currentKey(), x: pdfBox.x, y: pdfBox.y,
      width: pdfBox.width, height: pdfBox.height, color: "#FFFFFF", opacity: 1, group: group
    });
    var t = {
      type: "text", pageKey: currentKey(), x: C.round2(pdfBox.x + 2),
      y: C.round2(pdfBox.y + 2), text: full.trim().slice(0, 200) || "Replacement",
      fontSize: Math.min(48, Math.max(6, Math.round(pdfBox.height * 0.6))),
      font: "Helvetica", align: "left", color: "#000000", opacity: 1,
      underline: false, group: group
    };
    S.addObject(state, t);
    sel.removeAllRanges();
    openTextEditor(t);
    renderProps();
    redrawOverlay();
    refreshChrome();
    setTopStatus("Replacement placed — edit the text, then Apply Changes.");
  }

  /* ---------- apply flow ---------- */

  function collectUsedImages() {
    var files = {};
    var order = [];
    state.objects.forEach(function (obj) {
      if (obj.type !== "image") return;
      var staged = imageCache[obj.fileUid];
      if (staged && staged.file && !files[obj.fileUid]) {
        files[obj.fileUid] = staged.file;
        order.push(obj.fileUid);
      }
    });
    return { files: files, order: order };
  }

  function validateBeforeApply() {
    var maxEdits = cfg().EDIT_MAX_EDITS;
    if (!state.objects.length) return "Add at least one edit before applying.";
    if (state.objects.length > maxEdits) {
      return "Too many edits (" + state.objects.length + " > " + maxEdits + "). Remove some and try again.";
    }
    if (state.pageOps.length > 100) return "Too many page operations. Remove some and try again.";
    for (var i = 0; i < state.objects.length; i++) {
      var obj = state.objects[i];
      if (obj.type === "text" && !obj.text.trim()) return "A text box is empty. Fill it in or delete it.";
      if (obj.type === "link") {
        var u = (obj.url || "").trim();
        if (!isSafeLinkUrl(u)) return "A link box needs an http(s) URL. Select it and enter one.";
      }
      if (obj.type === "image" && !imageCache[obj.fileUid]) {
        return "An image is missing its file. Delete it and place it again.";
      }
    }
    return null;
  }

  function runApply() {
    if (!doc || busy) return;
    var problem = validateBeforeApply();
    if (problem) {
      showError({ code: "InvalidEdit", message: problem }, "apply");
      return;
    }
    busy = true;
    clearError();
    els.resultCard.hidden = true;
    els.progressPane.hidden = false;
    refreshChrome();
    setStatus("Preparing edit request…", 0);
    var Cloud = window.PdfCloud;
    var requestId = Cloud.newEditRequestId();
    var safeBase = Cloud.sanitizeMergeBase(doc.file.name);
    var used = collectUsedImages();
    var srcByUid = {};
    used.order.forEach(function (uid, i) {
      var staged = imageCache[uid];
      var ext = staged.file.type === "image/png" ? "png" : "jpg";
      srcByUid[uid] = "uploads/" + requestId + "/" + cfg().EDIT_IMAGE_PREFIX + i + "." + ext;
    });
    state.objects.forEach(function (obj) {
      if (obj.type === "image") obj.srcKey = srcByUid[obj.fileUid];
    });
    var plan;
    try {
      plan = M.buildManifest(
        { objects: state.objects, pageOps: state.pageOps },
        {
          order: view.order, rotations: view.rotations,
          sizes: doc.sizes
        },
        doc.file.name, requestId, safeBase);
    } catch (err) {
      busy = false;
      els.progressPane.hidden = true;
      showError({ code: "InvalidEdit", message: err.message }, "apply");
      refreshChrome();
      return;
    }
    var imageFiles = {};
    Object.keys(srcByUid).forEach(function (uid) {
      imageFiles[srcByUid[uid]] = used.files[uid];
    });
    var resultName = safeBase.replace(/\.pdf$/i, "") + "-edited.pdf";
    M.applyPlan(plan, doc.file, imageFiles, {
      onProgress: function (frac, label) { setStatus(label, Math.round(frac * 100)); },
      onPdfProgress: function (pct) { setStatus("Uploading PDF…", Math.round(pct / (2 + plan.images.length + 2) * 100)); },
      onStage: function () { setStatus("Applying edits in the cloud…", 90); },
      onPollTick: function (a, m) { setStatus("Applying edits in the cloud… (check " + a + " of " + m + ")", 90); }
    }).then(function (found) {
      busy = false;
      lastOutputKey = found.outputKey;
      lastResultName = resultName;
      els.progressPane.hidden = true;
      els.resultCard.hidden = false;
      $("edResultName").textContent = doc.file.name;
      $("edResultCount").textContent = state.objects.length + " edit(s)" +
        (state.pageOps.length ? " + " + state.pageOps.length + " page op(s)" : "");
      setStatus("Done — your edited PDF is ready below.", 100);
      setTopStatus("Done — download your edited PDF below.");
      refreshChrome();
      els.downloadBtn.focus();
    }, function (err) {
      busy = false;
      els.progressPane.hidden = true;
      showError(err, err && err.code === "PollTimeout" ? "poll" : "upload");
      refreshChrome();
    });
  }

  function setStatus(text, pct) {
    els.statusText.textContent = text;
    if (typeof pct === "number") {
      els.progressFill.style.width = pct + "%";
      els.progressPercent.textContent = pct + "%";
    }
  }

  function showError(err, context) {
    els.errorCard.hidden = false;
    $("edErrorMessage").textContent = Cloud().friendlyError(err, context);
    $("edErrorDetails").textContent = (err && err.message) || Cloud().technicalDetails(err);
    els.errorCard.scrollIntoView({ block: "nearest" });
  }

  function clearError() {
    els.errorCard.hidden = true;
  }

  /* ---------- keyboard ---------- */

  function onKeyDown(e) {
    if (!doc || busy) return;
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || "");
    // Ctrl+Z undo, Ctrl+Y / Ctrl+Shift+Z redo.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
      e.preventDefault();
      if (S.undo(state)) { renderThumbs(); renderView(); renderProps(); refreshChrome(); }
      return;
    }
    if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") ||
      ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "z")) {
      e.preventDefault();
      if (S.redo(state)) { renderThumbs(); renderView(); renderProps(); refreshChrome(); }
      return;
    }
    if (typing) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      if (state.selectedId) {
        e.preventDefault();
        S.removeObject(state, state.selectedId);
        renderProps(); redrawOverlay(); refreshChrome();
      }
    } else if (e.key === "Escape") {
      state.selectedId = null;
      setTool("select");
      renderProps(); redrawOverlay();
    } else if (e.key === "v" || e.key === "V") setTool("select");
    else if (e.key === "t" || e.key === "T") setTool("text");
    else if (e.key === "i" || e.key === "I") setTool("image");
    else if (e.key === "h" || e.key === "H") setTool("highlight");
    else if (e.key === "d" || e.key === "D") setTool("draw");
    else if (e.key === "Enter" && state.selectedId) {
      var obj = S.getObject(state, state.selectedId);
      if (obj && obj.type === "text") openTextEditor(obj);
    } else if (e.key.indexOf("Arrow") === 0 && state.selectedId) {
      var sel = S.getObject(state, state.selectedId);
      if (sel) {
        e.preventDefault();
        S.touch(state);
        var d = e.shiftKey ? 10 : 1;
        var dx = e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0;
        var dy = e.key === "ArrowUp" ? d : e.key === "ArrowDown" ? -d : 0;
        moveObject(sel, JSON.parse(JSON.stringify(sel)), dx, dy);
        redrawOverlay();
      }
    } else if (e.key === "PageDown") {
      if (view.pagePos < view.order.length - 1) {
        view.pagePos++;
        renderThumbs(); renderView(); refreshChrome();
      }
    } else if (e.key === "PageUp") {
      if (view.pagePos > 0) {
        view.pagePos--;
        renderThumbs(); renderView(); refreshChrome();
      }
    }
  }

  /* ---------- boot ---------- */

  document.addEventListener("DOMContentLoaded", function () {
    els = {
      topStatus: $("edTopStatus"), undoBtn: $("edUndo"), redoBtn: $("edRedo"), applyBtn: $("edApply"),
      toolbar: $("edToolbar"), props: $("edProps"),
      thumbsWrap: $("edThumbsWrap"), thumbs: $("edThumbs"), insertBlank: $("edInsertBlank"),
      uploadPane: $("edUploadPane"), workPane: $("edWorkPane"),
      drop: $("edDrop"), file: $("edFile"),
      canvasWrap: $("edCanvasWrap"), base: $("edBase"), overlay: $("edOverlay"),
      textLayer: $("edTextLayer"), textInput: $("edTextInput"),
      prevPage: $("edPrevPage"), nextPage: $("edNextPage"), pageLabel: $("edPageLabel"),
      zoomOut: $("edZoomOut"), zoomIn: $("edZoomIn"), zoomLabel: $("edZoomLabel"), zoomFit: $("edZoomFit"),
      replaceBar: $("edReplaceBar"), replaceBtn: $("edReplaceBtn"),
      progressPane: $("edProgressPane"), progressFill: $("edProgressFill"),
      statusText: $("edStatusText"), progressPercent: $("edProgressPercent"),
      resultCard: $("edResultCard"), downloadBtn: $("edDownloadBtn"), resetBtn: $("edResetBtn"),
      errorCard: $("edErrorCard"), retryBtn: $("edRetryBtn"),
      imageInput: $("edImageInput"), signInput: $("edSignInput")
    };
    try {
      Cloud().init();
      if (window.pdfjsLib && cfg().PDFJS_WORKER_URL) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = cfg().PDFJS_WORKER_URL;
      }
    } catch (err) {
      showError(err, "select");
      return;
    }
    els.file.addEventListener("change", function () { onFileChosen(els.file.files[0]); });
    els.drop.addEventListener("dragover", function (e) { e.preventDefault(); });
    els.drop.addEventListener("drop", function (e) {
      e.preventDefault();
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) onFileChosen(f);
    });
    els.toolbar.querySelectorAll(".tool-btn").forEach(function (b) {
      b.addEventListener("click", function () { setTool(b.getAttribute("data-tool")); });
    });
    els.overlay.addEventListener("pointerdown", onPointerDown);
    els.overlay.addEventListener("pointermove", onPointerMove);
    els.overlay.addEventListener("pointerup", onPointerUp);
    els.overlay.addEventListener("dblclick", function (e) {
      var pos = canvasPos(e);
      var obj = objectAt(pos.pt);
      if (obj && obj.type === "text") openTextEditor(obj);
    });
    els.textInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); closeTextEditor(true); }
      else if (e.key === "Escape") { closeTextEditor(false); }
      e.stopPropagation();
    });
    els.textInput.addEventListener("blur", function () { closeTextEditor(true); });
    els.undoBtn.addEventListener("click", function () {
      if (S.undo(state)) { renderThumbs(); renderView(); renderProps(); refreshChrome(); }
    });
    els.redoBtn.addEventListener("click", function () {
      if (S.redo(state)) { renderThumbs(); renderView(); renderProps(); refreshChrome(); }
    });
    els.applyBtn.addEventListener("click", runApply);
    els.prevPage.addEventListener("click", function () {
      if (view.pagePos > 0) { view.pagePos--; renderThumbs(); renderView(); refreshChrome(); }
    });
    els.nextPage.addEventListener("click", function () {
      if (view.pagePos < view.order.length - 1) { view.pagePos++; renderThumbs(); renderView(); refreshChrome(); }
    });
    els.zoomIn.addEventListener("click", function () { stepZoom(1); });
    els.zoomOut.addEventListener("click", function () { stepZoom(-1); });
    els.zoomFit.addEventListener("click", function () { view.fit = true; renderView(); });
    els.replaceBtn.addEventListener("click", replaceSelection);
    els.insertBlank.addEventListener("click", function () {
      if (busy || !doc) return;
      var first = doc.sizes[view.order[0]];
      var key = S.newBlankKey(state);
      doc.sizes[key] = { w: first.w, h: first.h };
      doc.keys.push(key);
      try {
        state.pageOps.push({ action: "insert_blank", at: view.pagePos + 2, key: key });
        S.touch(state);
        recomputeView();
        renderThumbs();
        renderView();
        refreshChrome();
      } catch (err) {
        state.pageOps.pop();
        showError({ code: "InvalidOp", message: err.message }, "select");
      }
    });
    els.downloadBtn.addEventListener("click", function () {
      if (lastOutputKey) Cloud().downloadOutput(lastOutputKey, lastResultName);
    });
    els.resetBtn.addEventListener("click", resetAll);
    els.retryBtn.addEventListener("click", function () { clearError(); });
    els.imageInput.addEventListener("change", function () {
      if (els.imageInput.files[0]) stageImageFile(els.imageInput.files[0], "image");
    });
    els.signInput.addEventListener("change", function () {
      if (els.signInput.files[0]) stageImageFile(els.signInput.files[0], "sign");
    });
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", function () { if (doc && view.fit) renderView(); });
    // Surface unexpected async failures (e.g. a render promise rejection)
    // instead of leaving a blank canvas with no explanation.
    window.addEventListener("unhandledrejection", function (e) {
      if (busy || !doc) return;
      var reason = (e && e.reason && (e.reason.message || e.reason)) || "Unexpected error.";
      setTopStatus("Something went wrong while rendering. " + String(reason).slice(0, 160));
    });
    setTool("select");
    refreshChrome();
  });

  function stepZoom(dir) {
    view.fit = false;
    view.zoom = Math.min(3, Math.max(0.4, view.zoom * (dir > 0 ? 1.25 : 0.8)));
    renderView();
  }

  function pickImage(kind) {
    var input = kind === "sign" ? els.signInput : els.imageInput;
    input.value = "";
    input.click();
  }

  /* Exposed for tests + headless smoke checks. */
  return {
    _state: function () { return state; },
    _view: function () { return view; },
    _doc: function () { return doc; },
    _tool: function () { return tool; },
    setTool: setTool,
    resetAll: resetAll,
    version: 2
  };
})();

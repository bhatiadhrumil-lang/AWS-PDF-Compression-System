/* PDF editor manifest builder + apply flow.
 *
 * Preserves the v1 AWS contract exactly:
 *   1. upload PDF (uploads/<requestId>/<safe>.pdf)
 *   2. upload image assets (uploads/<requestId>/img-<i>.<ext>), in order
 *   3. upload manifest LAST (edit-requests/<requestId>.edit.json = trigger)
 *   4. poll the EXACT output key edit/<requestId>/<stem>-edited.pdf
 *   5. presigned download with the original filename.
 * Never uploads in parallel (no Promise.all over S3 writes).
 */
window.PdfEditorManifest = (function () {
  var C = window.PdfEditorCoords;

  /* Compose a page's net rotation into one object's geometry, returning a
   * backend-ready edit (points/boxes in FINAL page space). Page ops run
   * before overlays server-side, so this mirrors backend _rotated_page. */
  function composeObject(obj, angleCw, pageW, pageH) {
    var out = { page: obj._finalPage, type: obj.type };
    function pt(x, y) {
      var r = C.composeRotation(x, y, pageW, pageH, angleCw);
      return [r.x, r.y];
    }
    function box(x, y, w, h) {
      var corners = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(
        function (c) { return pt(c[0], c[1]); });
      var xs = corners.map(function (c) { return c[0]; });
      var ys = corners.map(function (c) { return c[1]; });
      var x0 = Math.min.apply(null, xs), y0 = Math.min.apply(null, ys);
      return {
        x: C.round2(x0), y: C.round2(y0),
        width: C.round2(Math.max.apply(null, xs) - x0),
        height: C.round2(Math.max.apply(null, ys) - y0)
      };
    }
    if (obj.type === "text") {
      var p = pt(obj.x, obj.y);
      out.x = p[0]; out.y = p[1];
      out.text = obj.text;
      out.font_size = obj.fontSize;
      out.font = obj.font;
      out.align = obj.align;
      out.color = obj.color;
      out.alpha = obj.opacity;
      out.underline = !!obj.underline;
      out.rotation = ((angleCw % 360) + 360) % 360;
    } else if (obj.type === "draw") {
      out.points = obj.points.map(function (q) { return pt(q[0], q[1]); });
      out.width = obj.width;
      out.color = obj.color;
      out.alpha = obj.opacity;
    } else if (obj.type === "highlight" || obj.type === "rect" ||
               obj.type === "ellipse" || obj.type === "whiteout" ||
               obj.type === "underline" || obj.type === "strike" ||
               obj.type === "link") {
      var b = box(obj.x, obj.y, obj.width, obj.height);
      out.x = b.x; out.y = b.y; out.width = b.width; out.height = b.height;
      if (obj.type === "highlight" || obj.type === "rect" ||
          obj.type === "ellipse" || obj.type === "whiteout") {
        out.color = obj.color;
        out.alpha = obj.opacity;
      }
      if (obj.type === "rect" || obj.type === "ellipse") out.border = obj.border;
      if (obj.type === "highlight") out.alpha = obj.opacity;
      if (obj.type === "underline" || obj.type === "strike") {
        out.color = obj.color;
        out.thickness = obj.thickness;
      }
      if (obj.type === "link") out.url = obj.url;
    } else if (obj.type === "line" || obj.type === "arrow") {
      var a = pt(obj.x1, obj.y1), d = pt(obj.x2, obj.y2);
      out.x1 = a[0]; out.y1 = a[1]; out.x2 = d[0]; out.y2 = d[1];
      out.color = obj.color;
      out.thickness = obj.thickness;
    } else if (obj.type === "image") {
      var ctr = pt(obj.x + obj.width / 2, obj.y + obj.height / 2);
      out.x = C.round2(ctr[0] - obj.width / 2);
      out.y = C.round2(ctr[1] - obj.height / 2);
      out.width = obj.width;
      out.height = obj.height;
      out.src = obj.srcKey;
      var rot = (obj.rotation || 0) + angleCw;
      out.rotation = ((rot % 360) + 360) % 360;
      if (out.rotation > 180) out.rotation -= 360; // keep -180..180
    }
    return out;
  }

  /* Build the manifest object + image upload plan from editor state.
   * view: {origCount, keys, order, rotations, sizes: {key: {w, h}}}.
   * Returns {manifest, images: [{obj, key}], requestId, safeBase}. */
  function buildManifest(state, view, fileName, requestId, safeBase) {
    var Cloud = window.PdfCloud;
    var keyToFinal = {};
    view.order.forEach(function (key, i) { keyToFinal[key] = i + 1; });
    var edits = [];
    var images = [];
    var seenSrc = {};
    state.objects.forEach(function (obj) {
      var finalPage = keyToFinal[obj.pageKey];
      if (!finalPage) return; // object on a deleted page: dropped
      var size = view.sizes[obj.pageKey];
      var rot = view.rotations[obj.pageKey] || 0;
      var work = { _finalPage: finalPage };
      Object.keys(obj).forEach(function (k) { work[k] = obj[k]; });
      var edit = composeObject(work, rot, size.w, size.h);
      edits.push(edit);
      if (obj.type === "image" && !seenSrc[obj.srcKey]) {
        seenSrc[obj.srcKey] = true;
        images.push({ obj: obj, key: obj.srcKey });
      }
    });
    var inputKey = Cloud.editInputKey(requestId, safeBase);
    var manifest = Cloud.buildEditManifest(requestId, inputKey, safeBase, edits);
    if (state.pageOps && state.pageOps.length) {
      manifest.pages = JSON.parse(JSON.stringify(state.pageOps));
    }
    return { manifest: manifest, images: images, requestId: requestId, safeBase: safeBase };
  }

  /* Execute the apply flow with progress callbacks. Never parallel S3 writes.
   * plan.images entries carry the File via plan.imageFiles {srcKey: File}. */
  function applyPlan(plan, file, imageFiles, hooks) {
    var Cloud = window.PdfCloud;
    hooks = hooks || {};
    function progress(frac, label) {
      if (hooks.onProgress) hooks.onProgress(frac, label);
    }
    var steps = 2 + plan.images.length + 2; // pdf + images + manifest + poll
    var done = 0;
    function tick(label) {
      done++;
      progress(done / steps, label);
    }
    var inputKey = Cloud.editInputKey(plan.requestId, plan.safeBase);
    progress(0, "Uploading PDF…");
    return Cloud.uploadMergePdf(file, inputKey, hooks.onPdfProgress).then(
      function () {
        tick("PDF uploaded");
        var chain = Promise.resolve();
        plan.images.forEach(function (im) {
          chain = chain.then(function () {
            progress(done / steps, "Uploading image…");
            return Cloud.uploadEditImage(imageFiles[im.key], im.key).then(
              function () { tick("Image uploaded"); });
          });
        });
        return chain;
      }).then(function () {
        progress(done / steps, "Submitting edit request…");
        return Cloud.putEditManifest(plan.requestId, plan.manifest);
      }).then(function () {
        tick("Edit request submitted");
        var expected = Cloud.expectedEditOutputKey(
          plan.requestId, plan.safeBase);
        if (hooks.onStage) hooks.onStage("process");
        return Cloud.pollForExactOutput(expected, hooks.onPollTick).then(
          function (found) {
            tick("Processing complete");
            return { outputKey: found.outputKey, size: found.size };
          });
      });
  }

  return {
    composeObject: composeObject,
    buildManifest: buildManifest,
    applyPlan: applyPlan
  };
})();

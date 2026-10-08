/* PDF editor coordinate utilities (pure, no DOM).
 *
 * CONVENTION (shared with the backend, load-bearing):
 *   * Storage units are PDF points (1/72 inch), NEVER screen pixels.
 *   * Origin is BOTTOM-LEFT (PDF native space); browser y grows downward.
 *   * A page view maps points -> CSS px with a single uniform scale:
 *         scale = cssWidth / pageWidthPt
 *   * Rotated pages compose geometry with the backend-identical transform:
 *     backend _rotated_page maps (x, y) -> R(-t).(x, y) + offset, where the
 *     offset brings the rotated corners into positive space. composeRotation
 *     below implements exactly that formula (clockwise degrees).
 */
window.PdfEditorCoords = (function () {
  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  function isFiniteNumber(n) {
    return typeof n === "number" && isFinite(n);
  }

  function scaleFor(cssWidth, pageWidthPt) {
    return cssWidth / pageWidthPt;
  }

  function cssToPdf(xCss, yCss, cssWidth, pageWPt, pageHPt) {
    var scale = scaleFor(cssWidth, pageWPt);
    return { x: round2(xCss / scale), y: round2(pageHPt - yCss / scale) };
  }

  function cssBoxToPdf(x0, y0, w, h, cssWidth, pageWPt, pageHPt) {
    var scale = scaleFor(cssWidth, pageWPt);
    return {
      x: round2(x0 / scale),
      y: round2(pageHPt - (y0 + h) / scale),
      width: round2(w / scale),
      height: round2(h / scale)
    };
  }

  function pdfToCssX(xPt, cssWidth, pageWPt) {
    return (xPt / pageWPt) * cssWidth;
  }

  function pdfToCssY(yPt, cssHeight, pageHPt) {
    return ((pageHPt - yPt) / pageHPt) * cssHeight;
  }

  /* Clockwise page rotation (90/180/270) composed into overlay geometry.
   * Identical math to backend _rotated_page: R(-t) then translate by
   * (-minX, -minY) of the mapped page corners. Returns {x, y} in the
   * FINAL (rotated) page space of size finalSize {w, h}. */
  function composeRotation(x, y, pageW, pageH, angleCw) {
    var norm = ((angleCw % 360) + 360) % 360;
    if (norm === 0) {
      return { x: round2(x), y: round2(y), w: round2(pageW), h: round2(pageH) };
    }
    var theta = (-norm * Math.PI) / 180;
    var cos = Math.cos(theta), sin = Math.sin(theta);
    function map(px, py) {
      return [px * cos - py * sin, px * sin + py * cos];
    }
    var corners = [[0, 0], [pageW, 0], [pageW, pageH], [0, pageH]].map(
      function (c) { return map(c[0], c[1]); });
    var minX = Math.min.apply(null, corners.map(function (c) { return c[0]; }));
    var minY = Math.min.apply(null, corners.map(function (c) { return c[1]; }));
    var maxX = Math.max.apply(null, corners.map(function (c) { return c[0]; }));
    var maxY = Math.max.apply(null, corners.map(function (c) { return c[1]; }));
    var p = map(x, y);
    return {
      x: round2(p[0] - minX), y: round2(p[1] - minY),
      w: round2(maxX - minX), h: round2(maxY - minY)
    };
  }

  /* Axis-aligned bbox of a box rotated (clockwise degrees) about its center.
   * Mirrors backend rotated_bbox; used for selection previews only. */
  function rotatedBbox(x, y, w, h, rotation) {
    if (!rotation) return { x: x, y: y, w: w, h: h };
    var theta = (-rotation * Math.PI) / 180;
    var cos = Math.cos(theta), sin = Math.sin(theta);
    var cx = x + w / 2, cy = y + h / 2;
    var xs = [], ys = [];
    [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].forEach(function (c) {
      var dx = c[0] - cx, dy = c[1] - cy;
      xs.push(cx + dx * cos - dy * sin);
      ys.push(cy + dx * sin + dy * cos);
    });
    var x0 = Math.min.apply(null, xs), y0 = Math.min.apply(null, ys);
    return {
      x: round2(x0), y: round2(y0),
      w: round2(Math.max.apply(null, xs) - x0),
      h: round2(Math.max.apply(null, ys) - y0)
    };
  }

  /* Forward page transform for a net clockwise rotation (0/90/180/270):
   * page pt (y-up, W x H) -> final pt (y-up, W' x H'). Returns
   * {fx, fy, w, h, minX, minY, theta} where (minX, minY) is the offset
   * subtracted to land in positive space. Identical to composeRotation
   * and to backend _rotated_page. */
  function forwardPage(x, y, pageW, pageH, angleCw) {
    var norm = ((angleCw % 360) + 360) % 360;
    var theta = (-norm * Math.PI) / 180;
    var cos = Math.cos(theta), sin = Math.sin(theta);
    function map(px, py) {
      return [px * cos - py * sin, px * sin + py * cos];
    }
    var corners = [[0, 0], [pageW, 0], [pageW, pageH], [0, pageH]].map(
      function (c) { return map(c[0], c[1]); });
    var xs = corners.map(function (c) { return c[0]; });
    var ys = corners.map(function (c) { return c[1]; });
    var minX = Math.min.apply(null, xs), minY = Math.min.apply(null, ys);
    var p = map(x, y);
    return {
      fx: round2(p[0] - minX), fy: round2(p[1] - minY),
      w: round2(Math.max.apply(null, xs) - minX),
      h: round2(Math.max.apply(null, ys) - minY),
      minX: minX, minY: minY, theta: theta, norm: norm
    };
  }

  /* Inverse: view CSS px (y-down) -> page pt (y-up).
   * view: {cssW, cssH}; page: {wPt, hPt, rotation}. */
  function viewToPage(xCss, yCss, view, page) {
    var fwd0 = forwardPage(0, 0, page.wPt, page.hPt, page.rotation || 0);
    var s = view.cssW / fwd0.w; // uniform fit scale into rotated dims
    var fx = xCss / s, fy = (view.cssH - yCss) / s;
    var ux = fx + fwd0.minX, uy = fy + fwd0.minY;
    var theta = -fwd0.theta; // inverse rotation
    var cos = Math.cos(theta), sin = Math.sin(theta);
    return {
      x: round2(ux * cos - uy * sin),
      y: round2(ux * sin + uy * cos)
    };
  }

  /* Forward: page pt (y-up) -> view CSS px (y-down). Same view/page shapes. */
  function pageToView(xPt, yPt, view, page) {
    var fwd0 = forwardPage(0, 0, page.wPt, page.hPt, page.rotation || 0);
    var s = view.cssW / fwd0.w;
    var f = forwardPage(xPt, yPt, page.wPt, page.hPt, page.rotation || 0);
    return { x: round2(f.fx * s), y: round2(view.cssH - f.fy * s), scale: s };
  }

  function rotatedDims(w, h, rotation) {
    var norm = ((rotation % 360) + 360) % 360;
    if (norm === 90 || norm === 270) return { w: h, h: w };
    return { w: w, h: h };
  }

  function clampBoxToPage(box, pageW, pageH) {
    return {
      x: Math.min(Math.max(0, box.x), pageW),
      y: Math.min(Math.max(0, box.y), pageH),
      width: Math.max(1, Math.min(box.width, pageW)),
      height: Math.max(1, Math.min(box.height, pageH))
    };
  }

  return {
    round2: round2,
    isFiniteNumber: isFiniteNumber,
    scaleFor: scaleFor,
    cssToPdf: cssToPdf,
    cssBoxToPdf: cssBoxToPdf,
    pdfToCssX: pdfToCssX,
    pdfToCssY: pdfToCssY,
    composeRotation: composeRotation,
    forwardPage: forwardPage,
    rotatedBbox: rotatedBbox,
    rotatedDims: rotatedDims,
    viewToPage: viewToPage,
    pageToView: pageToView,
    clampBoxToPage: clampBoxToPage
  };
})();

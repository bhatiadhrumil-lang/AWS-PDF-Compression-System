#!/usr/bin/env python3
"""Edit PDF frontend tests (no AWS credentials needed; all AWS mocked/static).

Workspace (v2) coverage:
  1. Workspace page loads (topbar, toolbars, thumbs, canvas, panes).
  2. Single-file picker + drag & drop wired.
  3. pdf.js preview scripts pinned (page + worker, same version).
  4. Tool buttons for every supported tool; no fake Form tool.
  5. Viewer: navigation, zoom, thumbnails, page ops UI.
  6. Coordinate convention + converters + rotation round-trip mirrors.
  7. Tool registry marks edit available at edit.html.
  8. Manifest builder shape (operation/version/input/output_name/edits).
  9. Manifest uploaded only after PDF and images (static sequencing check).
 10. Output key shape edit/<id>/<stem>-edited.pdf (exact poll).
 11. Image upload helper exists (PNG/JPEG, separate keys, validation).
 12. Download uses the existing presigned downloadOutput mechanism.
 13. Undo/redo + selection model (edit-N ids, history, keyboard).
 14. File validation mirrors other tools.
  15. Config constants present.
  16. New edit types / styling / page-ops tokens present.
  17. Honesty copy: whiteout label, session-only signatures, no fake editor.
  18. No secrets / no version tags.

Math mirrors assets/js/editor-coords.js (rotation formula shared with the
backend _rotated_page). AWS interactions are never executed — JS is
inspected statically.

Run: python3 test_edit.py  (or: python3 -m unittest test_edit -v)
"""
import math
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EDIT_HTML = (ROOT / "edit.html").read_text(encoding="utf-8")
EDIT_JS = (ROOT / "assets/js/edit.js").read_text(encoding="utf-8")
COORDS_JS = (ROOT / "assets/js/editor-coords.js").read_text(encoding="utf-8")
STATE_JS = (ROOT / "assets/js/editor-state.js").read_text(encoding="utf-8")
MANIFEST_JS = (ROOT / "assets/js/editor-manifest.js").read_text(encoding="utf-8")
AWS_JS = (ROOT / "assets/js/aws-client.js").read_text(encoding="utf-8")
CONFIG_JS = (ROOT / "assets/js/config.js").read_text(encoding="utf-8")
TOOLS_JS = (ROOT / "assets/js/tools.js").read_text(encoding="utf-8")


def css_to_pdf(x_css, y_css, css_w, page_w_pt, page_h_pt):
    """Python mirror of editor cssToPdf (unrotated)."""
    scale = css_w / page_w_pt
    return (x_css / scale, page_h_pt - y_css / scale)


def compose_rotation(x, y, page_w, page_h, angle_cw):
    """Python mirror of editor composeRotation == backend _rotated_page."""
    norm = angle_cw % 360
    if norm == 0:
        return (x, y, page_w, page_h)
    theta = math.radians(-norm)
    cos_t, sin_t = math.cos(theta), math.sin(theta)

    def mp(px, py):
        return (px * cos_t - py * sin_t, px * sin_t + py * cos_t)

    corners = [mp(0, 0), mp(page_w, 0), mp(page_w, page_h), mp(0, page_h)]
    min_x = min(c[0] for c in corners)
    min_y = min(c[1] for c in corners)
    max_x = max(c[0] for c in corners)
    max_y = max(c[1] for c in corners)
    px, py = mp(x, y)
    return (px - min_x, py - min_y, max_x - min_x, max_y - min_y)


def view_roundtrip(x, y, page_w, page_h, rot, css_w=800):
    """Mirror of pageToView∘viewToPage (must be identity)."""
    _, _, fw, fh = compose_rotation(0, 0, page_w, page_h, rot)
    s = css_w / fw
    css_h = fh * s
    fx, fy, _, _ = compose_rotation(x, y, page_w, page_h, rot)
    vx, vy = fx * s, css_h - fy * s
    # inverse
    norm = rot % 360
    theta = math.radians(-norm)
    cos_t, sin_t = math.cos(theta), math.sin(theta)

    def mp(px, py):
        return (px * cos_t - py * sin_t, px * sin_t + py * cos_t)

    corners = [mp(0, 0), mp(page_w, 0), mp(page_w, page_h), mp(0, page_h)]
    min_x = min(c[0] for c in corners)
    min_y = min(c[1] for c in corners)
    ux, uy = vx / s + min_x, (css_h - vy) / s + min_y
    it = math.radians(norm)
    ci, si = math.cos(it), math.sin(it)
    return (ux * ci - uy * si, ux * si + uy * ci)


class EditPageTests(unittest.TestCase):
    def test_01_workspace_loads(self):
        self.assertTrue((ROOT / "edit.html").exists())
        for el in ["edTopStatus", "edUndo", "edRedo", "edApply",
                   "edToolbar", "edProps", "edThumbs", "edInsertBlank",
                   "edDrop", "edFile", "edBase", "edOverlay", "edTextLayer",
                   "edTextInput", "edPrevPage", "edNextPage", "edPageLabel",
                   "edZoomIn", "edZoomOut", "edZoomFit", "edZoomLabel",
                   "edReplaceBar", "edProgressFill", "edStatusText",
                   "edResultCard", "edDownloadBtn", "edErrorCard"]:
            self.assertIn('id="%s"' % el, EDIT_HTML)
        for mod in ["editor-coords.js", "editor-state.js",
                    "editor-manifest.js", "edit.js"]:
            self.assertIn(mod, EDIT_HTML)
        self.assertNotIn("Coming soon", EDIT_HTML)

    def test_02_single_file_picker_and_dropzone(self):
        m = re.search(r'<input[^>]*id="edFile"[^>]*>', EDIT_HTML)
        self.assertIsNotNone(m)
        self.assertNotIn("multiple", m.group(0))
        self.assertIn('accept=".pdf,application/pdf"', EDIT_HTML)
        self.assertIn("edDrop", EDIT_HTML)
        self.assertIn("dataTransfer", EDIT_JS)

    def test_03_pdfjs_pinned(self):
        page_versions = set(re.findall(r"pdf\.js/([\d.]+)/pdf\.min\.js",
                                       EDIT_HTML))
        self.assertEqual(page_versions, {"3.11.174"})
        cfg_versions = set(re.findall(r"pdf\.js/([\d.]+)/pdf(?:\.worker)?\.min\.js",
                                      CONFIG_JS))
        self.assertEqual(cfg_versions, {"3.11.174"})
        self.assertIn("PDFJS_WORKER_URL", CONFIG_JS)
        self.assertIn("GlobalWorkerOptions.workerSrc", EDIT_JS)

    def test_04_tool_buttons(self):
        for tool in ["select", "text", "image", "rect", "ellipse", "line",
                     "arrow", "highlight", "draw", "whiteout", "sign",
                     "link", "replace", "eraser"]:
            self.assertRegex(EDIT_HTML, r'data-tool="%s"' % tool)
        # No fake Form tool: an unimplemented button would be misleading UI.
        self.assertNotIn('data-tool="form"', EDIT_HTML)
        self.assertNotIn('data-tool="redact"', EDIT_HTML)

    def test_05_viewer_and_page_ops(self):
        self.assertIn("renderThumbs", EDIT_JS)
        self.assertIn("numPages", EDIT_JS)
        for token in ["rot-cw", "rot-ccw", "insert_blank", '"move"',
                      '"delete"', '"rotate"']:
            self.assertIn(token, EDIT_JS)
        self.assertIn("dragstart", EDIT_JS)  # thumbnail reorder drag

    def test_06_coordinate_convention(self):
        self.assertEqual(css_to_pdf(0, 0, 800, 400, 600), (0.0, 600.0))
        self.assertEqual(css_to_pdf(800, 1200, 800, 400, 600), (400.0, 0.0))
        for token in ["cssToPdf", "BOTTOM-LEFT", "NEVER screen pixels",
                      "viewToPage", "pageToView", "forwardPage"]:
            self.assertIn(token, COORDS_JS)
        # Rotation composes identically to the backend (dims swap on 90°).
        x, y, w, h = compose_rotation(50, 500, 400, 600, 90)
        self.assertAlmostEqual(w, 600)
        self.assertAlmostEqual(h, 400)
        self.assertAlmostEqual((x, y), (500.0, 350.0))
        # View round-trip is identity at every supported rotation.
        for rot in (0, 90, 180, 270):
            rx, ry = view_roundtrip(123.0, 456.0, 400, 600, rot)
            self.assertAlmostEqual(rx, 123.0, places=6, msg=rot)
            self.assertAlmostEqual(ry, 456.0, places=6, msg=rot)

    def test_07_tool_registered_available(self):
        m = re.search(
            r'id:\s*"edit".*?status:\s*"([^"]+)".*?href:\s*"([^"]+)"',
            TOOLS_JS, re.DOTALL)
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), "available")
        self.assertEqual(m.group(2), "edit.html")

    def test_08_manifest_shape(self):
        self.assertIn("buildEditManifest", AWS_JS)
        self.assertIn('operation: "edit"', AWS_JS)
        self.assertIn("version: cfg.EDIT_SCHEMA_VERSION", AWS_JS)
        self.assertIn("output_name", AWS_JS)
        self.assertIn("edits: (edits", AWS_JS)
        # v1 stays version 1; page ops ride along as an additive field.
        self.assertIn("manifest.pages", MANIFEST_JS)
        self.assertIn("composeObject", MANIFEST_JS)

    def test_09_manifest_after_pdf_and_images(self):
        blob = MANIFEST_JS
        self.assertIn("putEditManifest", blob)
        self.assertIn("uploadEditImage", blob)
        self.assertIn("uploadMergePdf", blob)
        self.assertLess(blob.index("uploadMergePdf"),
                        blob.index("uploadEditImage"))
        self.assertLess(blob.index("uploadEditImage"),
                        blob.index("putEditManifest"))
        self.assertLess(blob.index("putEditManifest"),
                        blob.index("pollForExactOutput"))
        self.assertNotIn("Promise.all(", blob)
        self.assertNotIn("Promise.all(", EDIT_JS)

    def test_10_output_key_shape(self):
        self.assertIn("expectedEditOutputKey", AWS_JS)
        self.assertIn('EDIT_OUTPUT_DIR + "/" + id + "/" + stem + "-edited.pdf"', AWS_JS)
        self.assertIn('EDIT_MANIFEST_PREFIX + String(requestId)', AWS_JS)
        self.assertIn('EDIT_MANIFEST_SUFFIX', AWS_JS)

    def test_11_image_upload_helper(self):
        self.assertIn("uploadEditImage", AWS_JS)
        self.assertIn("validateEditImage", AWS_JS)
        self.assertIn("image/png", AWS_JS)
        self.assertIn("EDIT_IMAGE_PREFIX", EDIT_JS)
        self.assertIn("img-", CONFIG_JS)
        self.assertIn("12000", EDIT_JS)  # dimension cap message

    def test_12_download_via_presigned_url(self):
        self.assertIn("downloadOutput(lastOutputKey, lastResultName)", EDIT_JS)
        self.assertIn("edResultName", EDIT_JS)
        self.assertIn("Download edited PDF", EDIT_HTML)

    def test_13_undo_redo_selection(self):
        for token in ["edUndo", "edRedo", "Ctrl+Z", "Ctrl+Y", "MAX_HISTORY",
                      "applyOpsToKeys", '"edit-"']:
            blob = STATE_JS + EDIT_JS
            self.assertIn(token, blob)
        self.assertIn("selectedId", STATE_JS + EDIT_JS)
        # Undo is history-based, never a PDF reload.
        self.assertNotIn("location.reload", EDIT_JS)

    def test_14_file_validation(self):
        self.assertIn("validatePdfFile", EDIT_JS)
        self.assertIn("ALLOWED_EXTENSIONS", EDIT_JS + AWS_JS)
        self.assertIn("MAX_FILE_SIZE_MB", EDIT_JS)

    def test_15_config_constants(self):
        for key in ["EDIT_MANIFEST_PREFIX", "EDIT_MANIFEST_SUFFIX",
                    "EDIT_OUTPUT_DIR", "EDIT_INPUT_PREFIX",
                    "EDIT_SCHEMA_VERSION", "EDIT_MAX_EDITS",
                    "EDIT_MAX_IMAGE_MB", "PDFJS_URL", "PDFJS_WORKER_URL"]:
            self.assertIn(key, CONFIG_JS)
        self.assertIn('".edit.json"', CONFIG_JS)
        self.assertIn('"edit-requests/"', CONFIG_JS)

    def test_16_new_types_styling_pageops(self):
        blob = EDIT_JS + MANIFEST_JS
        for token in ['"ellipse"', '"whiteout"', '"underline"', '"strike"',
                      '"line"', '"arrow"', '"link"', "rotation", "out.align",
                      "insert_blank", "to: to", "angle: 90", "pageOps"]:
            self.assertIn(token, blob)
        for font in ["Helvetica-Bold", "Times-Roman", "Courier"]:
            self.assertIn(font, EDIT_JS)

    def test_17_honesty_copy(self):
        blob = EDIT_HTML + EDIT_JS
        self.assertIn("not secure redaction", blob.lower())
        self.assertIn("visual cover", blob.lower())
        self.assertIn("session", blob.lower())
        self.assertNotIn("Secure Redaction", blob)

    def test_18_link_safety(self):
        self.assertIn("https://", EDIT_JS)
        self.assertIn("javascript:", EDIT_JS)  # rejected-scheme handling/tests
        self.assertIn("data-tool=\"link\"", EDIT_HTML)

    def test_19_no_secrets_no_versions(self):
        blob = EDIT_HTML + EDIT_JS + AWS_JS + COORDS_JS + STATE_JS + MANIFEST_JS
        self.assertNotRegex(blob, r"AKIA[0-9A-Z]{16}")
        self.assertNotIn("PRIVATE KEY", blob)
        for tag in ['"v1"', "'v1'", '"v2"', '"v3"', "versioned"]:
            self.assertNotIn(tag, blob)

    def test_20_replace_panel(self):
        # Panel lives below the toolbar (never covers the PDF) with a real
        # editable textarea + font/size/color controls + action buttons.
        for el in ["edReplacePanel", "edReplaceOrig", "edReplaceText",
                   "edReplaceFont", "edReplaceSize", "edReplaceColor",
                   "edReplaceCancel", "edReplacePreview", "edReplaceApply",
                   "edReplaceDelete"]:
            self.assertIn('id="%s"' % el, EDIT_HTML)
        self.assertRegex(EDIT_HTML, r'<textarea[^>]*id="edReplaceText"')
        self.assertRegex(EDIT_HTML, r'<select[^>]*id="edReplaceFont"')
        self.assertIn("Apply Replacement", EDIT_HTML)
        self.assertIn("Delete selected content", EDIT_HTML)
        # Selected PDF text is shown via textContent (never innerHTML).
        self.assertIn("els.replaceOrig.textContent", EDIT_JS)
        self.assertNotIn("replaceOrig.innerHTML", EDIT_JS)
        # Capture uses the pdf.js text layer + rotation-aware PDF coords.
        self.assertIn("captureReplaceSelection", EDIT_JS)
        self.assertIn("inverseBox", EDIT_JS)
        self.assertIn("clampBoxToPage", EDIT_JS)

    def test_21_replace_single_undo(self):
        # Whiteout + new text share ONE history entry (single Ctrl+Z).
        m = re.search(r"function applyReplacement\(\).*?setTopStatus\(\"Replacement applied",
                      EDIT_JS, re.DOTALL)
        self.assertIsNotNone(m)
        body = m.group(0)
        self.assertEqual(body.count("S.commit(state)"), 1)
        self.assertIn('type: "whiteout"', body)
        self.assertIn('type: "text"', body)
        self.assertNotIn("S.addObject", body)  # addObject commits separately
        self.assertIn("Preview", EDIT_HTML)
        self.assertIn("replacePreview", EDIT_JS)
        # Empty replacement is rejected, panel stays open.
        self.assertIn("Enter replacement text first.", EDIT_JS)

    def test_22_form_element_guard(self):
        # Global shortcuts never hijack inputs/textareas/selects/editables.
        self.assertIn("isFormElement", EDIT_JS)
        for token in ["HTMLInputElement", "HTMLTextAreaElement",
                      "HTMLSelectElement", "isContentEditable"]:
            self.assertIn(token, EDIT_JS)
        m = re.search(r"function onKeyDown\(e\)\s*\{(.*?)\n    \}",
                      EDIT_JS, re.DOTALL)
        self.assertIsNotNone(m)
        head = m.group(1)
        guard = "isFormElement(document.activeElement)"
        self.assertIn(guard, head)
        # The guard runs before ANY shortcut (including Ctrl+Z).
        self.assertLess(head.index(guard), head.index("ctrlKey"))
        # Delete on a Replace selection whites out exactly that region.
        self.assertIn("deleteReplaceSelection", EDIT_JS)

    def test_23_default_zoom(self):
        # Responsive initial scale (~100% when roomy, fit on tiny screens).
        self.assertIn("computeDefaultZoom", EDIT_JS)
        self.assertIn("stageAvailWidth", EDIT_JS)
        self.assertIn("view.fit = dflt.fit", EDIT_JS)
        # Zoom controls + Fit still wired and working.
        for token in ["edZoomIn", "edZoomOut", "edZoomFit", "edZoomLabel",
                      "stepZoom", "view.fit = true"]:
            self.assertIn(token, EDIT_JS + EDIT_HTML)

    def test_24_object_delete_guarded(self):
        # Editor objects stay selectable + deletable with visible selection;
        # Delete never fires while typing in a form field.
        self.assertIn("drawSelection", EDIT_JS)
        self.assertIn("S.removeObject(state, state.selectedId)", EDIT_JS)
        self.assertIn("S.undo(state)", EDIT_JS)


if __name__ == "__main__":
    unittest.main()

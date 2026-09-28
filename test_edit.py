#!/usr/bin/env python3
"""Edit PDF frontend tests (no AWS credentials needed; all AWS mocked/static).

Covers:
  1. Edit page loads with expected header/copy.
  2. Single-file picker + drag & drop wired.
  3. pdf.js preview scripts pinned (page + worker, same version).
  4. Tool buttons for all five edit types.
  5. Page navigation controls present.
  6. Coordinate convention documented and converters present.
  7. Tool registry marks edit available at edit.html.
  8. Manifest builder shape (operation/version/input/output_name/edits).
  9. Manifest uploaded only after PDF and images (static sequencing check).
 10. Output key shape edit/<id>/<stem>-edited.pdf (exact poll).
 11. Image upload helper exists (PNG/JPEG, separate keys).
 12. Download uses the existing presigned downloadOutput mechanism.
 13. Edits list / undo / clear controls present.
 14. File validation mirrors other tools.
 15. Config constants present.
 16. No secrets / no version tags.

Pure logic mirrors assets/js/edit.js coordinate converters (limits read
from assets/js/config.js where applicable).
AWS interactions are never executed — JS is inspected statically.

Run: python3 test_edit.py  (or: python3 -m unittest test_edit -v)
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EDIT_HTML = (ROOT / "edit.html").read_text(encoding="utf-8")
EDIT_JS = (ROOT / "assets/js/edit.js").read_text(encoding="utf-8")
AWS_JS = (ROOT / "assets/js/aws-client.js").read_text(encoding="utf-8")
CONFIG_JS = (ROOT / "assets/js/config.js").read_text(encoding="utf-8")
TOOLS_JS = (ROOT / "assets/js/tools.js").read_text(encoding="utf-8")

MB = 1024 * 1024


def css_to_pdf(x_css, y_css, css_w, page_w_pt, page_h_pt):
    """Python mirror of edit.js cssToPdf."""
    scale = css_w / page_w_pt
    return (x_css / scale, page_h_pt - y_css / scale)


def css_box_to_pdf(x0, y0, w, h, css_w, page_w_pt, page_h_pt):
    """Python mirror of edit.js cssBoxToPdf."""
    scale = css_w / page_w_pt
    return (x0 / scale, page_h_pt - (y0 + h) / scale, w / scale, h / scale)


class EditPageTests(unittest.TestCase):
    def test_01_page_loads(self):
        self.assertTrue((ROOT / "edit.html").exists())
        self.assertIn("<h1>Edit PDF</h1>", EDIT_HTML)
        self.assertIn("edit.js", EDIT_HTML)
        self.assertNotIn("Coming soon", EDIT_HTML)

    def test_02_single_file_picker_and_dropzone(self):
        m = re.search(r'<input[^>]*id="editFiles"[^>]*>', EDIT_HTML)
        self.assertIsNotNone(m)
        self.assertNotIn("multiple", m.group(0))
        self.assertIn('accept=".pdf,application/pdf"', EDIT_HTML)
        self.assertIn("editDropzone", EDIT_HTML)
        self.assertIn("dataTransfer", EDIT_JS)

    def test_03_pdfjs_pinned(self):
        page_versions = set(re.findall(r"pdf\.js/([\d.]+)/pdf\.min\.js",
                                       EDIT_HTML))
        self.assertEqual(page_versions, {"3.11.174"})
        # worker is set at runtime from config (GlobalWorkerOptions), so the
        # pin lives in config.js — both must share one version
        cfg_versions = set(re.findall(r"pdf\.js/([\d.]+)/pdf(?:\.worker)?\.min\.js",
                                      CONFIG_JS))
        self.assertEqual(cfg_versions, {"3.11.174"})
        self.assertIn("PDFJS_WORKER_URL", CONFIG_JS)
        self.assertIn("GlobalWorkerOptions.workerSrc", EDIT_JS)

    def test_04_tool_buttons(self):
        for tool in ["text", "draw", "highlight", "rect", "image"]:
            self.assertRegex(
                EDIT_HTML,
                r'<input[^>]*name="editTool"[^>]*value="%s"' % tool)
        for control in ["editText", "editFontSize", "editLineWidth",
                        "editColor", "editAlpha", "editImageFiles"]:
            self.assertIn('id="%s"' % control, EDIT_HTML)

    def test_05_page_navigation(self):
        for control in ["editPrevPage", "editNextPage", "editPageLabel",
                        "editBaseCanvas", "editOverlayCanvas", "editStage"]:
            self.assertIn('id="%s"' % control, EDIT_HTML)
        self.assertIn("numPages", EDIT_JS)

    def test_06_coordinate_convention(self):
        # bottom-left origin: css top-left (0,0) on a 400x600pt page at
        # 2x scale maps to (0,600); box converts with y-flip
        self.assertEqual(css_to_pdf(0, 0, 800, 400, 600), (0.0, 600.0))
        self.assertEqual(css_to_pdf(800, 1200, 800, 400, 600), (400.0, 0.0))
        self.assertEqual(
            css_box_to_pdf(100, 200, 200, 100, 800, 400, 600),
            (50.0, 450.0, 100.0, 50.0))
        for token in ["cssToPdf", "cssBoxToPdf", "BOTTOM-LEFT",
                      "Never store screen pixels"]:
            self.assertIn(token, EDIT_JS)

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

    def test_09_manifest_after_pdf_and_images(self):
        self.assertIn("putEditManifest", EDIT_JS)
        self.assertIn("uploadEditImage", EDIT_JS)
        order = EDIT_JS
        self.assertLess(order.index("uploadMergePdf"),
                        order.index("uploadEditImage"))
        self.assertLess(order.index("uploadEditImage"),
                        order.index("putEditManifest"))
        self.assertLess(order.index("putEditManifest"),
                        order.index("pollForExactOutput"))
        self.assertNotIn("Promise.all", EDIT_JS)

    def test_10_output_key_shape(self):
        self.assertIn("expectedEditOutputKey", AWS_JS)
        self.assertIn('EDIT_OUTPUT_DIR + "/" + id + "/" + stem + "-edited.pdf"', AWS_JS)
        self.assertIn('EDIT_MANIFEST_PREFIX + String(requestId)', AWS_JS)
        self.assertIn('EDIT_MANIFEST_SUFFIX', AWS_JS)

    def test_11_image_upload_helper(self):
        self.assertIn("uploadEditImage", AWS_JS)
        self.assertIn("image/png", AWS_JS)
        self.assertIn("EDIT_IMAGE_PREFIX", EDIT_JS)
        self.assertIn("img-", CONFIG_JS)

    def test_12_download_via_presigned_url(self):
        self.assertIn("downloadOutput(lastOutputKey,", EDIT_JS)
        self.assertIn('$("editResultName").textContent', EDIT_JS)
        self.assertIn("Download edited PDF", EDIT_HTML)

    def test_13_edits_list_controls(self):
        for control in ["editList", "editEmpty", "editUndoBtn",
                        "editClearPageBtn", "editCount"]:
            self.assertIn('id="%s"' % control, EDIT_HTML)
        self.assertIn("editUndoBtn", EDIT_JS)

    def test_14_file_validation(self):
        self.assertIn("validateEditSelection", EDIT_JS)
        self.assertIn("ALLOWED_EXTENSIONS", EDIT_JS)
        self.assertIn("MAX_FILE_SIZE_MB", EDIT_JS)

    def test_15_config_constants(self):
        for key in ["EDIT_MANIFEST_PREFIX", "EDIT_MANIFEST_SUFFIX",
                    "EDIT_OUTPUT_DIR", "EDIT_INPUT_PREFIX",
                    "EDIT_SCHEMA_VERSION", "EDIT_MAX_EDITS",
                    "EDIT_MAX_IMAGE_MB", "PDFJS_URL", "PDFJS_WORKER_URL"]:
            self.assertIn(key, CONFIG_JS)
        self.assertIn('".edit.json"', CONFIG_JS)
        self.assertIn('"edit-requests/"', CONFIG_JS)

    def test_16_no_secrets_no_versions(self):
        blob = EDIT_HTML + EDIT_JS + AWS_JS
        self.assertNotRegex(blob, r"AKIA[0-9A-Z]{16}")
        self.assertNotIn("PRIVATE KEY", blob)
        for tag in ['"v1"', "'v1'", '"v2"', '"v3"', "versioned"]:
            self.assertNotIn(tag, blob)


if __name__ == "__main__":
    unittest.main()

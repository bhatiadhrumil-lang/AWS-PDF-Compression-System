#!/usr/bin/env python3
"""Rotate PDF frontend tests (no AWS credentials needed; all AWS mocked/static).

Covers:
  1. Rotate page loads with expected header/copy.
  2. Single-file picker + drag & drop wired.
  3. Rotation controls (90 / 180 / 270) present.
  4. Page selection (all / selected) + ranges input present.
  5. Supported rotations accepted (90, 180, 270).
  6. Invalid rotations rejected (0, 360, 45, -90, text, empty).
  7. Page-range validation reuses the split parser.
  8. Non-PDF / oversize / empty file rejected.
  9. Tool registry marks rotate available at rotate.html.
 10. Manifest builder shape (operation/input/rotation/pages/output_name).
 11. Manifest omits pages in "all" mode.
 12. Manifest uploaded only after the PDF (static sequencing check).
 13. Output key shape rotate/<id>/<stem>-rotated.pdf (exact poll).
 14. Download uses the existing presigned downloadOutput mechanism.
 15. Stem sanitization (traversal stripped, spaces/unicode kept).
 16. Request id + manifest/input key helpers.
 17. No secrets / no version tags.

Pure validation logic mirrors assets/js/aws-client.js::parseRotateAngle /
parseSplitRanges and assets/js/rotate.js::validateRotateSelection (limits
read from assets/js/config.js so JS/Python cannot drift silently).
AWS interactions are never executed — JS is inspected statically.

Run: python3 test_rotate.py  (or: python3 -m unittest test_rotate -v)
"""
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ROTATE_HTML = (ROOT / "rotate.html").read_text(encoding="utf-8")
ROTATE_JS = (ROOT / "assets/js/rotate.js").read_text(encoding="utf-8")
AWS_JS = (ROOT / "assets/js/aws-client.js").read_text(encoding="utf-8")
CONFIG_JS = (ROOT / "assets/js/config.js").read_text(encoding="utf-8")
TOOLS_JS = (ROOT / "assets/js/tools.js").read_text(encoding="utf-8")

MB = 1024 * 1024


def _num(key, default):
    m = re.search(rf"{key}\s*:\s*([\d.]+)", CONFIG_JS)
    return float(m.group(1)) if m else default


PER_FILE_MB = float(_num("MAX_FILE_SIZE_MB", 100))


def parse_angle(value):
    """Python mirror of aws-client.js parseRotateAngle."""
    angle = value
    if isinstance(value, str):
        if not value.strip():
            return {"ok": False}
        try:
            angle = float(value)
        except ValueError:
            return {"ok": False}
        if angle != int(angle):
            return {"ok": False}
        angle = int(angle)
    if not isinstance(angle, int) or isinstance(angle, bool):
        return {"ok": False}
    if angle not in (90, 180, 270):
        return {"ok": False}
    return {"ok": True, "angle": angle}


def validate_selection(entry):
    """Python mirror of rotate.js validateRotateSelection."""
    if not entry:
        return {"ok": False, "errors": ["Select a PDF file to begin."]}
    errors = []
    ext = str(entry["name"]).split(".")[-1].lower() if "." in str(entry["name"]) else ""
    if ext != "pdf":
        errors.append("not a PDF")
    if not entry["size"] or entry["size"] <= 0:
        errors.append("empty")
    if entry["size"] and entry["size"] > PER_FILE_MB * MB:
        errors.append("100 MB")
    return {"ok": not errors, "errors": errors}


def sanitize_stem(name, fallback="req"):
    """Python mirror of aws-client.js sanitizeRotateStem (= split stem)."""
    raw = str(name or "").split("/")[-1].split("\\")[-1].strip()
    raw = re.sub(r"[\x00-\x1f\x7f]", "", raw).strip().strip(".")
    if re.search(r"\.zip$", raw, re.IGNORECASE):
        raw = raw[:-4].strip().strip(".")
    elif re.search(r"\.pdf$", raw, re.IGNORECASE):
        raw = raw[:-4].strip().strip(".")
    return (raw or fallback)[:200]


class RotatePageTests(unittest.TestCase):
    def test_01_page_loads(self):
        self.assertTrue((ROOT / "rotate.html").exists())
        self.assertIn("<h1>Rotate PDF</h1>", ROTATE_HTML)
        self.assertIn("rotate.js", ROTATE_HTML)

    def test_02_single_file_picker_and_dropzone(self):
        m = re.search(r'<input[^>]*id="rotateFiles"[^>]*>', ROTATE_HTML)
        self.assertIsNotNone(m)
        self.assertNotIn("multiple", m.group(0))
        self.assertIn('accept=".pdf,application/pdf"', ROTATE_HTML)
        self.assertIn("rotateDropzone", ROTATE_HTML)
        self.assertIn("dataTransfer", ROTATE_JS)

    def test_03_rotation_controls(self):
        for angle in ("90", "180", "270"):
            self.assertRegex(
                ROTATE_HTML,
                r'<input[^>]*name="rotateAngle"[^>]*value="%s"' % angle)
        self.assertIn("90° clockwise", ROTATE_HTML)
        self.assertIn("270° clockwise", ROTATE_HTML)
        self.assertIn("parseRotateAngle", AWS_JS)

    def test_04_page_selection(self):
        self.assertIn('id="rotatePagesAll"', ROTATE_HTML)
        self.assertIn('id="rotatePagesSelected"', ROTATE_HTML)
        self.assertIn('id="rotateRanges"', ROTATE_HTML)
        self.assertIn("1-3, 5, 8-10", ROTATE_HTML)
        self.assertIn("parseSplitRanges", ROTATE_JS)

    def test_05_supported_rotations(self):
        for angle in (90, 180, 270, "90", " 180 "):
            r = parse_angle(angle)
            self.assertTrue(r["ok"], repr(angle))
            self.assertEqual(r["angle"], int(str(angle).strip()))
        self.assertIn("ROTATE_OPTIONS", AWS_JS)
        self.assertIn("[90, 180, 270]", CONFIG_JS)

    def test_06_invalid_rotations(self):
        for bad in (0, 360, 45, -90, 135, "sideways", "", None, 90.5, True):
            self.assertFalse(parse_angle(bad)["ok"], repr(bad))

    def test_07_ranges_reuse_split_parser(self):
        # one parser for both tools: rotate.js must call the split parser,
        # and must not define its own copy
        self.assertIn("parseSplitRanges", ROTATE_JS)
        self.assertNotIn("function parseRotateRanges", AWS_JS)
        self.assertNotIn("function parseRotateRanges", ROTATE_JS)

    def test_08_file_validation(self):
        self.assertFalse(validate_selection(None)["ok"])
        self.assertFalse(validate_selection({"name": "a.txt", "size": 100})["ok"])
        self.assertFalse(validate_selection({"name": "a.pdf", "size": 0})["ok"])
        self.assertFalse(
            validate_selection({"name": "a.pdf", "size": int(101 * MB)})["ok"])
        self.assertTrue(
            validate_selection({"name": "a.PDF", "size": int(10 * MB)})["ok"])
        self.assertIn("validateRotateSelection", ROTATE_JS)

    def test_09_tool_registered_available(self):
        m = re.search(
            r'id:\s*"rotate".*?status:\s*"([^"]+)".*?href:\s*"([^"]+)"',
            TOOLS_JS, re.DOTALL)
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), "available")
        self.assertEqual(m.group(2), "rotate.html")

    def test_10_manifest_shape(self):
        self.assertIn("buildRotateManifest", AWS_JS)
        self.assertIn('operation: "rotate"', AWS_JS)
        self.assertIn("rotation: rotation", AWS_JS)
        self.assertIn("manifest.pages", AWS_JS)
        self.assertIn("output_name", AWS_JS)

    def test_11_manifest_omits_pages_when_all(self):
        self.assertRegex(AWS_JS, r'if \(pages !== "all"\)')
        self.assertIn("rotation", ROTATE_JS)

    def test_12_manifest_after_pdf(self):
        self.assertIn("putRotateManifest", ROTATE_JS)
        order = ROTATE_JS
        self.assertLess(order.index("uploadMergePdf"),
                        order.index("putRotateManifest"))
        self.assertLess(order.index("putRotateManifest"),
                        order.index("pollForExactOutput"))
        self.assertNotIn("Promise.all", ROTATE_JS)

    def test_13_output_key_shape(self):
        self.assertIn("expectedRotateOutputKey", AWS_JS)
        self.assertIn('ROTATE_OUTPUT_DIR + "/" + id + "/" + stem + "-rotated.pdf"', AWS_JS)
        self.assertIn('ROTATE_MANIFEST_PREFIX + String(requestId)', AWS_JS)
        self.assertIn('ROTATE_MANIFEST_SUFFIX', AWS_JS)

    def test_14_download_via_presigned_url(self):
        self.assertIn("downloadOutput(lastOutputKey)", ROTATE_JS)
        self.assertIn("Download rotated PDF", ROTATE_HTML)

    def test_15_stem_sanitization(self):
        self.assertEqual(sanitize_stem("document.pdf"), "document")
        self.assertEqual(sanitize_stem("../../etc/evil"), "evil")
        self.assertEqual(sanitize_stem("Q3 Report (final).pdf"), "Q3 Report (final)")
        self.assertEqual(sanitize_stem("caf\u00e9.pdf"), "caf\u00e9")
        self.assertEqual(sanitize_stem(""), "req")
        self.assertIn("sanitizeRotateStem", AWS_JS)

    def test_16_request_id_and_keys(self):
        self.assertIn("newRotateRequestId", AWS_JS)
        self.assertIn("rotateInputKey", AWS_JS)
        self.assertIn("rotateManifestKey", AWS_JS)
        self.assertIn('"uploads/" + String(requestId)', AWS_JS)

    def test_17_config_constants(self):
        for key in ["ROTATE_MANIFEST_PREFIX", "ROTATE_MANIFEST_SUFFIX",
                    "ROTATE_OUTPUT_DIR", "ROTATE_INPUT_PREFIX",
                    "ROTATE_OPTIONS"]:
            self.assertIn(key, CONFIG_JS)
        self.assertIn('".rotate.json"', CONFIG_JS)
        self.assertIn('"rotate-requests/"', CONFIG_JS)

    def test_18_no_secrets_no_versions(self):
        blob = ROTATE_HTML + ROTATE_JS + AWS_JS
        self.assertNotRegex(blob, r"AKIA[0-9A-Z]{16}")
        self.assertNotIn("PRIVATE KEY", blob)
        for tag in ['"v1"', "'v1'", '"v2"', '"v3"', "versioned"]:
            self.assertNotIn(tag, blob)


if __name__ == "__main__":
    unittest.main()

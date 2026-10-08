#!/usr/bin/env python3
"""JPG to PDF frontend tests (no AWS credentials needed; all AWS mocked/static).

Covers:
   1. JPG to PDF page loads with expected header/copy.
   2. Multi-image picker + drag & drop wired (JPEG accept).
   3. Ordering UI present (previews, up/down, remove, clear, add more).
   4. Valid images accepted (jpg/jpeg extensions, mixed case).
   5. Requested order preserved (manifest order = UI order = PDF pages).
   6. At least one image required.
   7. More than 20 images rejected (mirrors JPG2PDF_MAX_IMAGES).
   8. Non-JPG files rejected (png/pdf/txt).
   9. Individual >100 MB rejected.
  10. Total >200 MB rejected.
  11. Empty files rejected.
  12. Tool registry marks jpg-to-pdf available at jpg-to-pdf.html.
  13. Manifest builder shape (operation/images/output_name).
  14. Manifest uploaded only after all images (static sequencing check).
  15. Output key shape jpg-to-pdf/<id>/<name>.pdf (exact poll, own namespace).
  16. Download uses the existing presigned downloadOutput mechanism.
  17. Safe-name sanitization helper exists (shared merge-style rules).
  18. Request id generation exists and manifest/input keys embed it.
  19. No secrets / no version tags.

Pure validation logic mirrors assets/js/aws-client.js::validateJpgFile and
assets/js/jpg-to-pdf.js::validateJpgSelection (limits read from
assets/js/config.js so JS/Python cannot drift silently).
AWS interactions are never executed — JS is inspected statically.

Run: python3 test_jpg_to_pdf.py  (or: python3 -m unittest test_jpg_to_pdf -v)
"""
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
JPG_HTML = (ROOT / "jpg-to-pdf.html").read_text(encoding="utf-8")
JPG_JS = (ROOT / "assets/js/jpg-to-pdf.js").read_text(encoding="utf-8")
AWS_JS = (ROOT / "assets/js/aws-client.js").read_text(encoding="utf-8")
CONFIG_JS = (ROOT / "assets/js/config.js").read_text(encoding="utf-8")
TOOLS_JS = (ROOT / "assets/js/tools.js").read_text(encoding="utf-8")

MB = 1024 * 1024


def _num(key, default):
    m = re.search(rf"{key}\s*:\s*([\d.]+)", CONFIG_JS)
    return float(m.group(1)) if m else default


PER_FILE_MB = float(_num("MAX_FILE_SIZE_MB", 100))
JPG_MAX = int(_num("JPG2PDF_MAX_IMAGES", 20))
JPG_TOTAL_MB = float(_num("JPG2PDF_MAX_TOTAL_MB", 200))


def validate_one(entry):
    """Python mirror of aws-client.js validateJpgFile."""
    if not entry:
        return {"ok": False, "reason": "empty"}
    ext = str(entry["name"]).split(".")[-1].lower() if "." in str(entry["name"]) else ""
    if ext not in ("jpg", "jpeg"):
        return {"ok": False, "reason": "type"}
    if entry.get("type") and entry["type"] not in ("image/jpeg", "image/jpg"):
        return {"ok": False, "reason": "type"}
    if not entry["size"] or entry["size"] <= 0:
        return {"ok": False, "reason": "empty"}
    if entry["size"] > PER_FILE_MB * MB:
        return {"ok": False, "reason": "size"}
    return {"ok": True, "reason": ""}


def validate_selection(entries):
    """Python mirror of jpg-to-pdf.js validateJpgSelection."""
    errors = []
    total = sum(e["size"] for e in (entries or []))
    if len(entries or []) < 1:
        errors.append("at least one")
    if len(entries or []) > JPG_MAX:
        errors.append("up to 20")
    for e in (entries or []):
        check = validate_one(e)
        if not check["ok"]:
            errors.append(check["reason"])
            break
    if total > JPG_TOTAL_MB * MB:
        errors.append("200 MB")
    return {"ok": not errors, "errors": errors, "total": total}


def jpg(name, size_mb, mime="image/jpeg"):
    return {"name": name, "size": int(size_mb * MB), "type": mime}


class JpgToPdfPageTests(unittest.TestCase):
    def test_01_page_loads(self):
        self.assertTrue((ROOT / "jpg-to-pdf.html").exists())
        self.assertIn("<h1>JPG to PDF</h1>", JPG_HTML)
        self.assertIn("jpg-to-pdf.js", JPG_HTML)
        self.assertIn("one image per page", JPG_HTML)

    def test_02_multi_picker_and_dropzone(self):
        for el in ["jpgFiles", "jpgFilesMore"]:
            m = re.search(r'<input[^>]*id="%s"[^>]*>' % el, JPG_HTML)
            self.assertIsNotNone(m)
            self.assertIn("multiple", m.group(0))
        self.assertIn('accept=".jpg,.jpeg,image/jpeg"', JPG_HTML)
        self.assertIn("jpgDropzone", JPG_HTML)
        self.assertIn("dataTransfer", JPG_JS)
        self.assertIn("+ Add more images", JPG_HTML)

    def test_03_ordering_ui(self):
        for el in ["jpgList", "jpgClearBtn", "jpgAddMoreBtn",
                   "jpgCount", "jpgTotalSize", "jpgHint"]:
            self.assertIn('id="%s"' % el, JPG_HTML + JPG_JS)
        self.assertIn("jpg-thumb", JPG_HTML + JPG_JS)
        self.assertIn("Move ", JPG_JS)  # up/down aria-labels
        self.assertIn("dragstart", JPG_JS)
        self.assertIn("Clear all", JPG_HTML)

    def test_04_valid_images(self):
        for name in ["a.jpg", "b.jpeg", "C.JPG", "d.JPEG", "my photo (1).Jpg"]:
            self.assertTrue(validate_one(jpg(name, 2))["ok"], name)
        self.assertTrue(validate_selection(
            [jpg("a.jpg", 2), jpg("b.jpeg", 3)])["ok"])
        self.assertIn("validateJpgFile", AWS_JS)

    def test_05_order_preserved(self):
        # UI order flows straight into manifest images (page order).
        self.assertRegex(JPG_JS, r"orderedKeys\s*=\s*files\.map")
        self.assertRegex(JPG_JS, r"buildJpgToPdfManifest\(requestId,\s*orderedKeys")
        self.assertRegex(AWS_JS, r"images:\s*\(imageKeys\s*\|\|\s*\[\]\)\.slice\(\)")
        self.assertIn("moveItem", JPG_JS)

    def test_06_at_least_one_required(self):
        r = validate_selection([])
        self.assertFalse(r["ok"])
        self.assertTrue(any("at least one" in e for e in r["errors"]))
        self.assertIn("Select at least one JPG image", JPG_JS)

    def test_07_max_images(self):
        many = [jpg("f%d.jpg" % i, 1) for i in range(JPG_MAX + 1)]
        self.assertFalse(validate_selection(many)["ok"])
        ok_max = [jpg("f%d.jpg" % i, 1) for i in range(JPG_MAX)]
        self.assertTrue(validate_selection(ok_max)["ok"])
        self.assertIn("up to 20 images", JPG_JS)

    def test_08_non_jpg_rejected(self):
        for name in ["a.png", "a.pdf", "a.txt", "ajpg", "a.gif"]:
            r = validate_selection([jpg(name, 2)])
            self.assertFalse(r["ok"], name)
        self.assertIn("is not a JPG image", JPG_JS)

    def test_09_individual_size(self):
        r = validate_selection([jpg("a.jpg", 1), jpg("big.jpg", 101)])
        self.assertFalse(r["ok"])
        self.assertIn("100 MB", JPG_JS)

    def test_10_total_size(self):
        r = validate_selection([jpg("a.jpg", 100), jpg("b.jpg", 100),
                                jpg("c.jpg", 1)])
        self.assertFalse(r["ok"])
        self.assertIn("cannot exceed 200 MB", JPG_JS)

    def test_11_empty_file(self):
        r = validate_selection([jpg("a.jpg", 0)])
        self.assertFalse(r["ok"])
        self.assertIn("appears to be empty", JPG_JS)

    def test_12_tool_registered_available(self):
        m = re.search(
            r'id:\s*"jpg-to-pdf".*?status:\s*"([^"]+)".*?href:\s*"([^"]+)"',
            TOOLS_JS, re.DOTALL)
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), "available")
        self.assertEqual(m.group(2), "jpg-to-pdf.html")

    def test_13_manifest_shape(self):
        self.assertIn("buildJpgToPdfManifest", AWS_JS)
        self.assertIn('operation: "jpg_to_pdf"', AWS_JS)
        self.assertIn("output_name", AWS_JS)

    def test_14_manifest_after_images(self):
        self.assertIn("putJpgToPdfManifest", JPG_JS)
        order = JPG_JS
        self.assertLess(order.index("uploadEditImage"),
                        order.index("putJpgToPdfManifest"))
        self.assertLess(order.index("putJpgToPdfManifest"),
                        order.index("pollForExactOutput"))
        self.assertNotIn("Promise.all", JPG_JS)

    def test_15_output_key_shape(self):
        self.assertIn("expectedJpgToPdfOutputKey", AWS_JS)
        self.assertIn('JPG2PDF_OUTPUT_DIR + "/" + id + "/" + safe', AWS_JS)
        self.assertIn('JPG2PDF_MANIFEST_PREFIX + String(requestId)', AWS_JS)
        self.assertIn('JPG2PDF_MANIFEST_SUFFIX', AWS_JS)
        self.assertIn('"jpg-to-pdf"', CONFIG_JS)
        self.assertIn('".jpg2pdf.json"', CONFIG_JS)

    def test_16_download_via_presigned_url(self):
        self.assertIn("downloadOutput(lastOutputKey,", JPG_JS)
        self.assertIn('$("jpgResultName").textContent', JPG_JS)
        self.assertIn("Download PDF", JPG_HTML)

    def test_17_safe_names(self):
        self.assertIn("sanitizeJpgFileName", AWS_JS)
        self.assertIn("assignSafeNames", JPG_JS)
        self.assertIn("sanitizeJpgOutputName", AWS_JS)

    def test_18_request_id_and_keys(self):
        self.assertIn("newJpgToPdfRequestId", AWS_JS)
        self.assertIn("jpgToPdfInputKey", AWS_JS)
        self.assertIn("jpgToPdfManifestKey", AWS_JS)
        self.assertIn('"uploads/" + String(requestId)', AWS_JS)
        self.assertIn("JPG2PDF_MAX_IMAGES", CONFIG_JS + AWS_JS + JPG_JS)
        self.assertIn("JPG2PDF_MAX_TOTAL_MB", CONFIG_JS + JPG_JS)

    def test_19_no_secrets_no_versions(self):
        blob = JPG_HTML + JPG_JS + AWS_JS
        self.assertNotRegex(blob, r"AKIA[0-9A-Z]{16}")
        self.assertNotIn("PRIVATE KEY", blob)
        for tag in ['"v1"', "'v1'", '"v2"', '"v3"', "versioned"]:
            self.assertNotIn(tag, blob)


if __name__ == "__main__":
    unittest.main()

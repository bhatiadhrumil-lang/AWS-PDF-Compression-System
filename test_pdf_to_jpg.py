#!/usr/bin/env python3
"""PDF to JPG frontend tests (no AWS credentials needed; all AWS mocked/static).

Covers:
  1. PDF to JPG page loads with expected header/copy.
  2. Single-PDF picker + drag & drop wired (PDF accept).
  3. All-pages / selected-pages mode radio present.
  4. Range textbox present with example placeholder.
  5. Quality selector present with sensible default (85).
  6. Page-count display element present.
  7. Valid PDF accepted (pdf extension, mixed case).
  8. Non-PDF / empty / oversize rejected (mirror of page validation).
  9. All-pages expansion 1..N in order.
 10. Over-limit page count rejected client-side.
 11. Invalid range text rejected via shared parser reference.
 12. Tool registry marks pdf-to-jpg available at pdf-to-jpg.html.
 13. Manifest builder shape (operation/input/pages/quality/output_name).
 14. Manifest uploaded only after the PDF (static sequencing check).
 15. Output key shape pdf-to-jpg/<id>/<stem>-page-001.jpg (exact poll keys).
 16. Results grid with previews + per-file downloads + Download All.
 17. Stem sanitization helper exists (shared split-style rules).
 18. Request id generation exists and manifest/input keys embed it.
 19. No secrets / no version tags.

Pure validation logic mirrors assets/js/pdf-to-jpg.js::expandAllPages and
validatePdfToJpgSelection (limits read from assets/js/config.js so JS/Python
cannot drift silently).
AWS interactions are never executed — JS is inspected statically.

Run: python3 test_pdf_to_jpg.py  (or: python3 -m unittest test_pdf_to_jpg -v)
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
P2J_HTML = (ROOT / "pdf-to-jpg.html").read_text(encoding="utf-8")
P2J_JS = (ROOT / "assets/js/pdf-to-jpg.js").read_text(encoding="utf-8")
AWS_JS = (ROOT / "assets/js/aws-client.js").read_text(encoding="utf-8")
CONFIG_JS = (ROOT / "assets/js/config.js").read_text(encoding="utf-8")
TOOLS_JS = (ROOT / "assets/js/tools.js").read_text(encoding="utf-8")

MB = 1024 * 1024


def _num(key, default):
    m = re.search(rf"{key}\s*:\s*([\d.]+)", CONFIG_JS)
    return float(m.group(1)) if m else default


PER_FILE_MB = float(_num("MAX_FILE_SIZE_MB", 100))
P2J_MAX = int(_num("PDF2JPG_MAX_PAGES", 50))
P2J_QUALITY = int(_num("PDF2JPG_DEFAULT_QUALITY", 85))


def validate(entry):
    """Python mirror of pdf-to-jpg.js validatePdfToJpgSelection."""
    errors = []
    if not entry:
        return {"ok": False, "errors": ["Select a PDF file to begin."]}
    ext = str(entry["name"]).split(".")[-1].lower() if "." in str(entry["name"]) else ""
    if ext != "pdf":
        errors.append("not a PDF")
    if not entry["size"] or entry["size"] <= 0:
        errors.append("empty")
    if entry["size"] and entry["size"] > PER_FILE_MB * MB:
        errors.append("100 MB")
    return {"ok": not errors, "errors": errors}


def expand_all(page_count, max_allowed):
    """Python mirror of pdf-to-jpg.js expandAllPages."""
    if not page_count or page_count < 1:
        return {"ok": False, "pages": []}
    if page_count > max_allowed:
        return {"ok": False, "pages": []}
    return {"ok": True, "pages": list(range(1, page_count + 1))}


class PdfToJpgPageTests(unittest.TestCase):
    def test_01_page_loads(self):
        self.assertTrue((ROOT / "pdf-to-jpg.html").exists())
        self.assertIn("<h1>PDF to JPG</h1>", P2J_HTML)
        self.assertIn("pdf-to-jpg.js", P2J_HTML)

    def test_02_single_picker_and_dropzone(self):
        m = re.search(r'<input[^>]*id="p2jFiles"[^>]*>', P2J_HTML)
        self.assertIsNotNone(m)
        self.assertNotIn("multiple", m.group(0))
        self.assertIn('accept=".pdf,application/pdf"', P2J_HTML)
        self.assertIn("p2jDropzone", P2J_HTML)
        self.assertIn("dataTransfer", P2J_JS)

    def test_03_mode_selection(self):
        self.assertIn('id="p2jModeAll"', P2J_HTML)
        self.assertIn('id="p2jModeRanges"', P2J_HTML)
        self.assertIn('id="p2jRanges"', P2J_HTML)
        self.assertIn("1, 3, 5-7", P2J_HTML)

    def test_04_quality_selector(self):
        self.assertIn('id="p2jQuality"', P2J_HTML)
        for value in ('value="70"', 'value="85"', 'value="95"'):
            self.assertIn(value, P2J_HTML)
        self.assertIn("PDF2JPG_DEFAULT_QUALITY", CONFIG_JS)
        self.assertEqual(P2J_QUALITY, 85)
        self.assertIn("currentQuality", P2J_JS)

    def test_05_page_count_display(self):
        self.assertIn('id="p2jCount"', P2J_HTML)
        self.assertIn("numPages", P2J_JS)
        self.assertIn("pdfjsLib", P2J_JS)

    def test_06_valid_pdf(self):
        self.assertTrue(validate({"name": "a.pdf", "size": 100})["ok"])
        self.assertTrue(validate({"name": "a.PDF", "size": 100})["ok"])
        self.assertIn("validatePdfToJpgSelection", P2J_JS)

    def test_07_invalid_pdf(self):
        self.assertFalse(validate({"name": "a.txt", "size": 100})["ok"])
        self.assertFalse(validate({"name": "a.pdf", "size": 0})["ok"])
        self.assertFalse(
            validate({"name": "a.pdf", "size": int(101 * MB)})["ok"])
        self.assertFalse(validate(None)["ok"])

    def test_08_all_pages_expansion(self):
        self.assertEqual(expand_all(3, P2J_MAX)["pages"], [1, 2, 3])
        self.assertEqual(expand_all(1, P2J_MAX)["pages"], [1])
        self.assertIn("expandAllPages", P2J_JS)

    def test_09_over_limit_rejected(self):
        self.assertFalse(expand_all(P2J_MAX + 1, P2J_MAX)["ok"])
        self.assertFalse(expand_all(0, P2J_MAX)["ok"])
        self.assertIn("PDF2JPG_MAX_PAGES", CONFIG_JS + AWS_JS + P2J_JS)

    def test_10_ranges_use_shared_parser(self):
        self.assertIn("parseExtractRanges", P2J_JS)
        self.assertNotIn("function parsePdfToJpgRanges", AWS_JS)
        self.assertNotIn("function parsePdfToJpgRanges", P2J_JS)

    def test_11_tool_registered_available(self):
        m = re.search(
            r'id:\s*"pdf-to-jpg".*?status:\s*"([^"]+)".*?href:\s*"([^"]+)"',
            TOOLS_JS, re.DOTALL)
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), "available")
        self.assertEqual(m.group(2), "pdf-to-jpg.html")

    def test_12_manifest_shape(self):
        self.assertIn("buildPdfToJpgManifest", AWS_JS)
        self.assertIn('operation: "pdf_to_jpg"', AWS_JS)
        self.assertIn("quality", AWS_JS)
        self.assertIn("output_name", AWS_JS)

    def test_13_manifest_after_pdf(self):
        # Sequencing invariant: PDF upload -> manifest (the Lambda trigger)
        # -> parallel exact-key polls. Parallel polling is intended here
        # (one poll per expected JPG); what must never happen is the
        # manifest racing the PDF upload.
        self.assertIn("putPdfToJpgManifest", P2J_JS)
        order = P2J_JS
        self.assertLess(order.index("uploadMergePdf"),
                        order.index("putPdfToJpgManifest"))
        self.assertLess(order.index("putPdfToJpgManifest"),
                        order.index("Promise.all"))
        self.assertLess(order.index("Promise.all"),
                        order.index("renderGrid"))

    def test_14_output_key_shape(self):
        self.assertIn("expectedPdfToJpgOutputKeys", AWS_JS)
        self.assertIn('PDF2JPG_OUTPUT_DIR + "/" + id + "/"', AWS_JS)
        self.assertIn("-page-", AWS_JS)
        self.assertIn("PDF2JPG_MANIFEST_PREFIX + String(requestId)", AWS_JS)
        self.assertIn("PDF2JPG_MANIFEST_SUFFIX", AWS_JS)
        self.assertIn('"pdf-to-jpg"', CONFIG_JS)
        self.assertIn('".pdf2jpg.json"', CONFIG_JS)

    def test_15_results_grid_and_downloads(self):
        self.assertIn('id="p2jGrid"', P2J_HTML)
        self.assertIn("presignedDownloadUrl", P2J_JS)
        self.assertIn("Download All", P2J_HTML)
        self.assertIn("downloadAll", P2J_JS)
        self.assertIn("presignedDownloadUrl", AWS_JS)

    def test_16_stem_helper(self):
        self.assertIn("sanitizePdfToJpgStem", AWS_JS)
        self.assertIn("pdfToJpgPageName", AWS_JS)

    def test_17_request_id_and_keys(self):
        self.assertIn("newPdfToJpgRequestId", AWS_JS)
        self.assertIn("pdfToJpgInputKey", AWS_JS)
        self.assertIn("pdfToJpgManifestKey", AWS_JS)
        self.assertIn('"uploads/" + String(requestId)', AWS_JS)

    def test_18_no_secrets_no_versions(self):
        blob = P2J_HTML + P2J_JS + AWS_JS
        self.assertNotRegex(blob, r"AKIA[0-9A-Z]{16}")
        self.assertNotIn("PRIVATE KEY", blob)
        for tag in ['"v1"', "'v1'", '"v2"', '"v3"', "versioned"]:
            self.assertNotIn(tag, blob)


if __name__ == "__main__":
    unittest.main()

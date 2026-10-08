#!/usr/bin/env python3
"""Extract Pages frontend tests (no AWS credentials needed; all AWS mocked/static).

Covers:
   1. Extract page loads with expected header/copy.
   2. Single-file picker + drag & drop wired.
   3. Page picker UI (tiles, Select All, Clear, range input) + pinned pdf.js.
   4. Valid input accepted (single, span, multiple, whitespace, combos).
   5. Requested order preserved (5,2,8 stays 5,2,8 — never sorted).
   6. Duplicates normalized (1,3,3,5-7 -> 1,3,5,6,7).
   7. Invalid input rejected (0, negative, reversed, malformed, empty).
   8. Out-of-range pages rejected when the count is known.
   9. Too many pages rejected (mirrors EXTRACT_MAX_PAGES from config.js).
  10. Empty selection rejected.
  11. Non-PDF / oversize / empty file rejected.
  12. Tool registry marks extract-pages available at extract.html.
  13. Manifest builder shape (operation/input/pages/output_name).
  14. Manifest uploaded only after the PDF (static sequencing check).
  15. Output key shape extract/<id>/<stem>-extracted.pdf (exact poll).
  16. Download uses the existing presigned downloadOutput mechanism.
  17. Stem sanitization (traversal stripped, spaces/unicode kept).
  18. Request id generation exists and manifest/input keys embed it.
  19. No secrets / no version tags.

Pure validation logic mirrors assets/js/aws-client.js::parseExtractRanges
and assets/js/extract.js::validateExtractSelection (limits read from
assets/js/config.js so JS/Python cannot drift silently).
AWS interactions are never executed — JS is inspected statically.

Run: python3 test_extract.py  (or: python3 -m unittest test_extract -v)
"""
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EXTRACT_HTML = (ROOT / "extract.html").read_text(encoding="utf-8")
EXTRACT_JS = (ROOT / "assets/js/extract.js").read_text(encoding="utf-8")
AWS_JS = (ROOT / "assets/js/aws-client.js").read_text(encoding="utf-8")
CONFIG_JS = (ROOT / "assets/js/config.js").read_text(encoding="utf-8")
TOOLS_JS = (ROOT / "assets/js/tools.js").read_text(encoding="utf-8")

MB = 1024 * 1024


def _num(key, default):
    m = re.search(rf"{key}\s*:\s*([\d.]+)", CONFIG_JS)
    return float(m.group(1)) if m else default


PER_FILE_MB = float(_num("MAX_FILE_SIZE_MB", 100))
EXTRACT_MAX_PAGES = int(_num("EXTRACT_MAX_PAGES", 500))


def parse_extract(text, page_count=0):
    """Python mirror of aws-client.js parseExtractRanges."""
    pieces = str(text or "").split(",")
    expanded = []
    seen = set()
    for piece in pieces:
        trimmed = piece.strip()
        if not trimmed:
            return {"ok": False, "error": "empty"}
        m_single = re.fullmatch(r"\d+", trimmed)
        m_span = re.fullmatch(r"(\d+)\s*-\s*(\d+)", trimmed)
        if m_single:
            start = end = int(m_single.group(0))
        elif m_span:
            start, end = int(m_span.group(1)), int(m_span.group(2))
        else:
            return {"ok": False, "error": "not valid"}
        if start < 1 or end < 1:
            return {"ok": False, "error": "start at 1"}
        if start > end:
            return {"ok": False, "error": "reversed"}
        for p in range(start, end + 1):
            if page_count and p > page_count:
                return {"ok": False, "error": "does not exist"}
            if p not in seen:
                seen.add(p)
                expanded.append(p)
            if len(expanded) > EXTRACT_MAX_PAGES:
                return {"ok": False, "error": "too many"}
    if not expanded:
        return {"ok": False, "error": "at least one"}
    return {"ok": True, "pages": expanded, "error": ""}


def validate_selection(entry):
    """Python mirror of extract.js validateExtractSelection."""
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


def sanitize_stem(name, fallback="req"):
    """Python mirror of aws-client.js sanitizeSplitStem (shared stems)."""
    raw = str(name or "").split("/")[-1].split("\\")[-1].strip()
    raw = re.sub(r"[\x00-\x1f\x7f]", "", raw).strip().strip(".")
    if re.search(r"\.zip$", raw, re.IGNORECASE):
        raw = raw[:-4].strip().strip(".")
    elif re.search(r"\.pdf$", raw, re.IGNORECASE):
        raw = raw[:-4].strip().strip(".")
    return (raw or fallback)[:200]


class ExtractPageTests(unittest.TestCase):
    def test_01_page_loads(self):
        self.assertTrue((ROOT / "extract.html").exists())
        self.assertIn("<h1>Extract Pages</h1>", EXTRACT_HTML)
        self.assertIn("extract.js", EXTRACT_HTML)
        self.assertIn("original file stays unchanged", EXTRACT_HTML.lower())

    def test_02_single_file_picker_and_dropzone(self):
        m = re.search(r'<input[^>]*id="extractFiles"[^>]*>', EXTRACT_HTML)
        self.assertIsNotNone(m)
        self.assertNotIn("multiple", m.group(0))
        self.assertIn('accept=".pdf,application/pdf"', EXTRACT_HTML)
        self.assertIn("extractDropzone", EXTRACT_HTML)
        self.assertIn("dataTransfer", EXTRACT_JS)

    def test_03_picker_ui_and_pdfjs(self):
        for el in ["extractTiles", "extractSelectAll", "extractClear",
                   "extractRanges", "extractAddRanges", "extractSelected",
                   "extractCount"]:
            self.assertIn('id="%s"' % el, EXTRACT_HTML)
        self.assertIn("1, 3, 5-7", EXTRACT_HTML)
        page_versions = set(re.findall(r"pdf\.js/([\d.]+)/pdf\.min\.js",
                                       EXTRACT_HTML))
        self.assertEqual(page_versions, {"3.11.174"})
        self.assertIn("getDocument", EXTRACT_JS)
        self.assertIn("numPages", EXTRACT_JS)

    def test_04_valid_input(self):
        for text, expected in [
            ("1", [1]),
            ("1,3,5", [1, 3, 5]),
            ("2-5", [2, 3, 4, 5]),
            ("1, 4, 7-9", [1, 4, 7, 8, 9]),
            ("  2 - 4 , 7 ", [2, 3, 4, 7]),
        ]:
            r = parse_extract(text)
            self.assertTrue(r["ok"], text)
            self.assertEqual(r["pages"], expected, text)
        self.assertIn("parseExtractRanges", AWS_JS)

    def test_05_order_preserved(self):
        r = parse_extract("5,2,8")
        self.assertTrue(r["ok"])
        self.assertEqual(r["pages"], [5, 2, 8])
        self.assertIn("requested order", AWS_JS + EXTRACT_JS)

    def test_06_duplicates_normalized(self):
        r = parse_extract("1,3,3,5-7")
        self.assertTrue(r["ok"])
        self.assertEqual(r["pages"], [1, 3, 5, 6, 7])
        r2 = parse_extract("1-3,2-5")
        self.assertTrue(r2["ok"])
        self.assertEqual(r2["pages"], [1, 2, 3, 4, 5])

    def test_07_invalid_input(self):
        for text in ["0", "0-3", "-3", "5-2", "abc", "1-", "1-2-3",
                     "", "   ", "1,,2", "1.5"]:
            r = parse_extract(text)
            self.assertFalse(r["ok"], text)

    def test_08_out_of_range(self):
        r = parse_extract("15", page_count=10)
        self.assertFalse(r["ok"])
        self.assertIn("does not exist", r["error"])
        self.assertTrue(parse_extract("10", page_count=10)["ok"])
        self.assertIn("does not exist", AWS_JS)

    def test_09_too_many_pages(self):
        many = ",".join(str(i) for i in range(1, EXTRACT_MAX_PAGES + 2))
        self.assertFalse(parse_extract(many)["ok"])
        ok_max = ",".join(str(i) for i in range(1, EXTRACT_MAX_PAGES + 1))
        self.assertTrue(parse_extract(ok_max)["ok"])
        self.assertIn("EXTRACT_MAX_PAGES", AWS_JS + EXTRACT_JS)

    def test_10_empty_selection_rejected(self):
        self.assertIn("No pages selected", EXTRACT_JS)
        self.assertIn("at least one page", EXTRACT_JS)

    def test_11_file_validation(self):
        self.assertFalse(validate_selection(None)["ok"])
        self.assertFalse(validate_selection({"name": "a.txt", "size": 100})["ok"])
        self.assertFalse(validate_selection({"name": "a.pdf", "size": 0})["ok"])
        self.assertFalse(
            validate_selection({"name": "a.pdf", "size": int(101 * MB)})["ok"])
        self.assertTrue(
            validate_selection({"name": "a.PDF", "size": int(10 * MB)})["ok"])
        self.assertIn("validateExtractSelection", EXTRACT_JS)

    def test_12_tool_registered_available(self):
        m = re.search(
            r'id:\s*"extract-pages".*?status:\s*"([^"]+)".*?href:\s*"([^"]+)"',
            TOOLS_JS, re.DOTALL)
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), "available")
        self.assertEqual(m.group(2), "extract.html")

    def test_13_manifest_shape(self):
        self.assertIn("buildExtractManifest", AWS_JS)
        self.assertIn('operation: "extract"', AWS_JS)
        self.assertIn("output_name", AWS_JS)
        self.assertRegex(AWS_JS, r"pages:\s*\(pages")

    def test_14_manifest_after_pdf(self):
        self.assertIn("putExtractManifest", EXTRACT_JS)
        order = EXTRACT_JS
        self.assertLess(order.index("uploadMergePdf"),
                        order.index("putExtractManifest"))
        self.assertLess(order.index("putExtractManifest"),
                        order.index("pollForExactOutput"))
        self.assertNotIn("Promise.all", EXTRACT_JS)

    def test_15_output_key_shape(self):
        self.assertIn("expectedExtractOutputKey", AWS_JS)
        self.assertIn('EXTRACT_OUTPUT_DIR + "/" + id + "/" + stem + "-extracted.pdf"', AWS_JS)
        self.assertIn('EXTRACT_MANIFEST_PREFIX + String(requestId)', AWS_JS)
        self.assertIn('EXTRACT_MANIFEST_SUFFIX', AWS_JS)

    def test_16_download_via_presigned_url(self):
        self.assertIn("downloadOutput(lastOutputKey,", EXTRACT_JS)
        self.assertIn('$("extractResultName").textContent', EXTRACT_JS)
        self.assertIn("Download extracted PDF", EXTRACT_HTML)

    def test_17_stem_sanitization(self):
        self.assertEqual(sanitize_stem("document.pdf"), "document")
        self.assertEqual(sanitize_stem("../../etc/evil"), "evil")
        self.assertEqual(sanitize_stem("Q3 Report (final).pdf"), "Q3 Report (final)")
        self.assertEqual(sanitize_stem("caf\u00e9 r\u00e9sum\u00e9.pdf"), "caf\u00e9 r\u00e9sum\u00e9")
        self.assertEqual(sanitize_stem(""), "req")
        self.assertIn("sanitizeExtractStem", AWS_JS)

    def test_18_request_id_and_keys(self):
        self.assertIn("newExtractRequestId", AWS_JS)
        self.assertIn("extractInputKey", AWS_JS)
        self.assertIn("extractManifestKey", AWS_JS)
        self.assertIn('"uploads/" + String(requestId)', AWS_JS)

    def test_19_no_secrets_no_versions(self):
        blob = EXTRACT_HTML + EXTRACT_JS + AWS_JS
        self.assertNotRegex(blob, r"AKIA[0-9A-Z]{16}")
        self.assertNotIn("PRIVATE KEY", blob)
        for tag in ['"v1"', "'v1'", '"v2"', '"v3"', "versioned"]:
            self.assertNotIn(tag, blob)


if __name__ == "__main__":
    unittest.main()

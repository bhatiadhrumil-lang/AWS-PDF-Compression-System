#!/usr/bin/env python3
"""Split PDF frontend tests (no AWS credentials needed; all AWS mocked/static).

Covers:
  1. Split page loads with expected header/copy.
  2. Single-file picker + drag & drop wired.
  3. Mode selection (every page / ranges) present.
  4. Ranges input present with example placeholder.
  5. Valid ranges accepted (single, span, multiple, whitespace).
  6. Invalid ranges rejected (0, reversed, malformed, empty, dup, overlap).
  7. Too many ranges rejected (mirrors SPLIT_MAX_RANGES from config.js).
  8. Non-PDF / oversize / empty file rejected.
  9. Tool registry marks split available at split.html.
 10. Manifest builder shape (operation/input/mode/ranges/output_name).
 11. Manifest omits ranges in "all" mode.
 12. Manifest uploaded only after the PDF (static sequencing check).
 13. Output key shape split/<id>/<stem>-split.zip (exact poll, no listing).
 14. ZIP download uses the existing presigned downloadOutput mechanism.
 15. Stem sanitization (traversal stripped, spaces/unicode kept).
 16. Request id generation exists and manifest/split keys embed it.
 17. No secrets / no version tags.

Pure validation logic mirrors assets/js/aws-client.js::parseSplitRanges and
assets/js/split.js::validateSplitSelection (limits read from
assets/js/config.js so JS/Python cannot drift silently).
AWS interactions are never executed — JS is inspected statically.

Run: python3 test_split.py  (or: python3 -m unittest test_split -v)
"""
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SPLIT_HTML = (ROOT / "split.html").read_text(encoding="utf-8")
SPLIT_JS = (ROOT / "assets/js/split.js").read_text(encoding="utf-8")
AWS_JS = (ROOT / "assets/js/aws-client.js").read_text(encoding="utf-8")
CONFIG_JS = (ROOT / "assets/js/config.js").read_text(encoding="utf-8")
TOOLS_JS = (ROOT / "assets/js/tools.js").read_text(encoding="utf-8")

MB = 1024 * 1024


def _num(key, default):
    m = re.search(rf"{key}\s*:\s*([\d.]+)", CONFIG_JS)
    return float(m.group(1)) if m else default


PER_FILE_MB = float(_num("MAX_FILE_SIZE_MB", 100))
SPLIT_MAX_RANGES = int(_num("SPLIT_MAX_RANGES", 50))


def parse_ranges(text):
    """Python mirror of aws-client.js parseSplitRanges."""
    pieces = str(text or "").split(",")
    tokens = []
    for piece in pieces:
        trimmed = piece.strip()
        if not trimmed:
            return {"ok": False, "error": "empty"}
        tokens.append(trimmed)
    if not tokens:
        return {"ok": False, "error": "at least one"}
    if len(tokens) > SPLIT_MAX_RANGES:
        return {"ok": False, "error": "up to"}
    spans = []
    seen = set()
    for tok in tokens:
        m_single = re.fullmatch(r"\d+", tok)
        m_span = re.fullmatch(r"(\d+)\s*-\s*(\d+)", tok)
        if m_single:
            start = end = int(m_single.group(0))
        elif m_span:
            start, end = int(m_span.group(1)), int(m_span.group(2))
        else:
            return {"ok": False, "error": "not a valid range"}
        if start < 1 or end < 1:
            return {"ok": False, "error": "start at 1"}
        if start > end:
            return {"ok": False, "error": "reversed"}
        if (start, end) in seen:
            return {"ok": False, "error": "twice"}
        if any(start <= b and a <= end for a, b in spans):
            return {"ok": False, "error": "overlap"}
        seen.add((start, end))
        spans.append((start, end))
    return {"ok": True, "ranges": tokens, "error": ""}


def validate_selection(entry):
    """Python mirror of split.js validateSplitSelection."""
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
    """Python mirror of aws-client.js sanitizeSplitStem."""
    raw = str(name or "").split("/")[-1].split("\\")[-1].strip()
    raw = re.sub(r"[\x00-\x1f\x7f]", "", raw).strip().strip(".")
    if re.search(r"\.zip$", raw, re.IGNORECASE):
        raw = raw[:-4].strip().strip(".")
    elif re.search(r"\.pdf$", raw, re.IGNORECASE):
        raw = raw[:-4].strip().strip(".")
    return (raw or fallback)[:200]


class SplitPageTests(unittest.TestCase):
    def test_01_page_loads(self):
        self.assertTrue((ROOT / "split.html").exists())
        self.assertIn("<h1>Split PDF</h1>", SPLIT_HTML)
        self.assertIn("split.js", SPLIT_HTML)

    def test_02_single_file_picker_and_dropzone(self):
        m = re.search(r'<input[^>]*id="splitFiles"[^>]*>', SPLIT_HTML)
        self.assertIsNotNone(m)
        self.assertNotIn("multiple", m.group(0))
        self.assertIn('accept=".pdf,application/pdf"', SPLIT_HTML)
        self.assertIn("splitDropzone", SPLIT_HTML)
        self.assertIn("dataTransfer", SPLIT_JS)

    def test_03_mode_selection(self):
        self.assertIn('id="splitModeAll"', SPLIT_HTML)
        self.assertIn('id="splitModeRanges"', SPLIT_HTML)
        self.assertIn('id="splitRanges"', SPLIT_HTML)
        self.assertIn("1-3, 5, 8-10", SPLIT_HTML)
        self.assertIn("currentMode", SPLIT_JS)

    def test_04_valid_ranges(self):
        for text, expected in [
            ("5", ["5"]),
            ("1-3", ["1-3"]),
            ("1-3,5,8-10", ["1-3", "5", "8-10"]),
            ("  2 - 4 , 7 ", ["2 - 4", "7"]),
        ]:
            r = parse_ranges(text)
            self.assertTrue(r["ok"], text)
            self.assertEqual(r["ranges"], expected, text)
        self.assertIn("parseSplitRanges", AWS_JS)
        self.assertIn("1-3, 5, 8-10", SPLIT_JS + AWS_JS)

    def test_05_invalid_ranges(self):
        for text in ["0", "0-3", "5-2", "abc", "1-", "1-2-3", "", "   ",
                     "1,,2", "3,3", "1-3,2-5"]:
            r = parse_ranges(text)
            self.assertFalse(r["ok"], text)

    def test_06_too_many_ranges(self):
        many = ",".join(str(i) for i in range(1, SPLIT_MAX_RANGES + 2))
        self.assertFalse(parse_ranges(many)["ok"])
        ok_max = ",".join(str(i) for i in range(1, SPLIT_MAX_RANGES + 1))
        self.assertTrue(parse_ranges(ok_max)["ok"])
        self.assertIn("SPLIT_MAX_RANGES", AWS_JS)

    def test_07_file_validation(self):
        self.assertFalse(validate_selection(None)["ok"])
        self.assertFalse(validate_selection({"name": "a.txt", "size": 100})["ok"])
        self.assertFalse(validate_selection({"name": "a.pdf", "size": 0})["ok"])
        self.assertFalse(
            validate_selection({"name": "a.pdf", "size": int(101 * MB)})["ok"])
        self.assertTrue(
            validate_selection({"name": "a.PDF", "size": int(10 * MB)})["ok"])
        self.assertIn("validateSplitSelection", SPLIT_JS)

    def test_08_tool_registered_available(self):
        m = re.search(
            r'id:\s*"split".*?status:\s*"([^"]+)".*?href:\s*"([^"]+)"',
            TOOLS_JS, re.DOTALL)
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), "available")
        self.assertEqual(m.group(2), "split.html")

    def test_09_manifest_shape(self):
        self.assertIn("buildSplitManifest", AWS_JS)
        self.assertIn('operation: "split"', AWS_JS)
        self.assertIn("output_name", AWS_JS)
        # ranges mode carries tokens; all mode carries none
        self.assertRegex(AWS_JS, r"manifest\.ranges\s*=\s*\(ranges")
        self.assertIn("mode === \"ranges\"", AWS_JS)

    def test_10_manifest_after_pdf(self):
        # sequencing: upload promise -> putSplitManifest -> poll (never parallel)
        self.assertIn("putSplitManifest", SPLIT_JS)
        order = SPLIT_JS
        self.assertLess(order.index("uploadMergePdf"),
                        order.index("putSplitManifest"))
        self.assertLess(order.index("putSplitManifest"),
                        order.index("pollForExactOutput"))
        self.assertNotIn("Promise.all", SPLIT_JS)

    def test_11_output_key_shape(self):
        self.assertIn("expectedSplitOutputKey", AWS_JS)
        self.assertIn('SPLIT_OUTPUT_DIR + "/" + id + "/" + stem + "-split.zip"', AWS_JS)
        self.assertIn('SPLIT_MANIFEST_PREFIX + String(requestId)', AWS_JS)
        self.assertIn('SPLIT_MANIFEST_SUFFIX', AWS_JS)

    def test_12_zip_download_via_presigned_url(self):
        self.assertIn("downloadOutput(lastOutputKey)", SPLIT_JS)
        self.assertIn("Download ZIP", SPLIT_HTML)

    def test_13_stem_sanitization(self):
        self.assertEqual(sanitize_stem("document.pdf"), "document")
        self.assertEqual(sanitize_stem("archive.zip"), "archive")
        self.assertEqual(sanitize_stem("../../etc/evil"), "evil")
        self.assertEqual(sanitize_stem("Q3 Report (final).pdf"), "Q3 Report (final)")
        self.assertEqual(sanitize_stem("caf\u00e9 r\u00e9sum\u00e9.pdf"), "caf\u00e9 r\u00e9sum\u00e9")
        self.assertEqual(sanitize_stem(""), "req")
        self.assertIn("sanitizeSplitStem", AWS_JS)

    def test_14_request_id_and_keys(self):
        self.assertIn("newSplitRequestId", AWS_JS)
        self.assertIn("splitInputKey", AWS_JS)
        self.assertIn("splitManifestKey", AWS_JS)
        self.assertIn('"uploads/" + String(requestId)', AWS_JS)

    def test_15_config_constants(self):
        for key in ["SPLIT_MAX_RANGES", "SPLIT_MAX_OUTPUTS",
                    "SPLIT_MANIFEST_PREFIX", "SPLIT_MANIFEST_SUFFIX",
                    "SPLIT_OUTPUT_DIR", "SPLIT_INPUT_PREFIX"]:
            self.assertIn(key, CONFIG_JS)
        self.assertIn('".split.json"', CONFIG_JS)
        self.assertIn('"split-requests/"', CONFIG_JS)

    def test_16_no_secrets_no_versions(self):
        blob = SPLIT_HTML + SPLIT_JS + AWS_JS
        self.assertNotRegex(blob, r"AKIA[0-9A-Z]{16}")
        self.assertNotIn("PRIVATE KEY", blob)
        for tag in ['"v1"', "'v1'", '"v2"', '"v3"', "versioned"]:
            self.assertNotIn(tag, blob)


if __name__ == "__main__":
    unittest.main()

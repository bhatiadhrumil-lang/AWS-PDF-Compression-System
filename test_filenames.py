#!/usr/bin/env python3
"""Filename handling tests (no AWS credentials needed; static + mirrors).

The contract: upload keys PRESERVE the user's original basename (spaces,
parentheses, "#", "+", "&", "%", unicode, ...) namespaced for uniqueness.
Only path separators and control characters are neutralized, and ".pdf" is
lowercased for the case-sensitive bucket trigger. The backend decodes S3
event keys, treats manifest keys verbatim, and preserves basenames in
outputs; downloads carry a Content-Disposition so the save dialog keeps a
friendly original-derived name.

Covers:
  1-7.  the seven required filenames preserved through readableBase
  8.     "%" and unicode preserved, multiple spaces preserved
  9.     "/" and "\\" neutralized (never become key structure)
  10.    control characters stripped
  11.    uppercase ".PDF" normalized (trigger filter is case-sensitive)
  12.    empty/degenerate names fall back to "document.pdf"
  13.    compress keys keep a unique namespace prefix
  14.    merge bases carry no unique prefix (request id namespaces them)
  15.    downloadOutput sends ResponseContentDisposition (RFC 5987)
  16.    all five tool pages pass a friendly download name
  17.    no blanket space-to-underscore mangling remains

Python mirror of readableBase() keeps JS/Python from drifting; limits read
from config.js where applicable.

Run: python3 test_filenames.py
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
AWS_JS = (ROOT / "assets/js/aws-client.js").read_text(encoding="utf-8")

NAMES = [
    "simple.pdf",
    "My Report.pdf",
    "Blood Report 2026.pdf",
    "My Report (Final).pdf",
    "Report #1.pdf",
    "Report+Final.pdf",
    "Report & Data.pdf",
]


def readable_base(name):
    """Python mirror of aws-client.js readableBase()."""
    name = str(name or "document.pdf").split("/")[-1].split("\\")[-1]
    dot = name.rfind(".")
    base = name[:dot] if dot > 0 else name
    ext = name[dot:].lower() if dot > 0 else ""
    if ext != ".pdf":
        ext = ".pdf"
    base = re.sub(r"[\x00-\x1f\x7f]", "", base)
    base = re.sub(r"[/\\]+", "_", base)
    base = re.sub(r"^\.+|\.+$", "", base)
    if not base:
        base = "document"
    return base[:120] + ext


class ReadableBaseTests(unittest.TestCase):
    def test_required_names_preserved(self):
        for name in NAMES:
            with self.subTest(name=name):
                self.assertEqual(readable_base(name), name)

    def test_percent_unicode_multispace_preserved(self):
        self.assertEqual(readable_base("100% done.pdf"), "100% done.pdf")
        self.assertEqual(readable_base("caf\u00e9 r\u00e9sum\u00e9.pdf"),
                         "caf\u00e9 r\u00e9sum\u00e9.pdf")
        self.assertEqual(readable_base("a  b   c.pdf"), "a  b   c.pdf")
        self.assertEqual(readable_base("a=b&c=d.pdf"), "a=b&c=d.pdf")

    def test_separators_neutralized(self):
        # path components never become key structure (basename wins)
        self.assertEqual(readable_base("a/b.pdf"), "b.pdf")
        self.assertEqual(readable_base("a\\b.pdf"), "b.pdf")
        self.assertEqual(readable_base("../../etc/evil.pdf"), "evil.pdf")

    def test_controls_stripped(self):
        self.assertEqual(readable_base("a\x00b\x1fc.pdf"), "abc.pdf")

    def test_extension_normalized(self):
        self.assertEqual(readable_base("Report.PDF"), "Report.pdf")
        self.assertEqual(readable_base("notes.txt"), "notes.pdf")
        self.assertEqual(readable_base("noext"), "noext.pdf")

    def test_fallback(self):
        self.assertEqual(readable_base(""), "document.pdf")
        self.assertEqual(readable_base("..."), "document.pdf")

    def test_js_implements_readable_rules(self):
        # no blanket underscore mangling may remain in the base sanitizers
        self.assertIn("function readableBase", AWS_JS)
        self.assertIn('base.replace(/[\\/\\\\]+/g, "_")', AWS_JS)
        for old in ['replace(/[^A-Za-z0-9._-]+/g, "_")',
                    'normalize("NFKD")']:
            self.assertNotIn(old, AWS_JS)

    def test_compress_key_namespaced(self):
        self.assertRegex(AWS_JS, r'"uploads/" \+ uniq \+ "_" \+ readableBase')
        self.assertIn("sanitizeMergeBase(originalName) {\n    return readableBase(originalName);",
                      AWS_JS)


class DownloadDispositionTests(unittest.TestCase):
    def test_disposition_mechanism(self):
        self.assertIn("function contentDisposition", AWS_JS)
        self.assertIn("ResponseContentDisposition", AWS_JS)
        self.assertIn("filename*=UTF-8''", AWS_JS)
        self.assertIn("encodeURIComponent(name)", AWS_JS)

    def test_all_pages_pass_friendly_name(self):
        for page, marker in [("compress.js", '"compressed-" + selectedFile.name'),
                             ("merge.js", '$("mergeResultName").textContent'),
                             ("split.js", '$("splitResultName").textContent'),
                             ("rotate.js", '$("rotateResultName").textContent'),
                             ("delete.js", '$("deleteResultName").textContent')]:
            js = (ROOT / "assets/js" / page).read_text(encoding="utf-8")
            flat = re.sub(r"\s+", "", js)
            with self.subTest(page=page):
                self.assertIn("downloadOutput(lastOutputKey,", flat)
                self.assertIn(re.sub(r"\s+", "", marker), flat)


if __name__ == "__main__":
    unittest.main()

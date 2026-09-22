/* Central tool registry. Every page renders from this single source of truth,
 * so adding a future tool means appending one entry here (plus its page).
 *
 * status: "available" (works end-to-end) | "soon" (placeholder only).
 * href:   where the card navigates. Unimplemented tools go to tool.html?tool=<id>.
 *          NEVER point a "soon" tool at a fake processing flow.
 */
window.PdfTools = [
  {
    id: "compress",
    title: "Compress PDF",
    description: "Reduce PDF file size while preserving readability.",
    icon: "compress",
    status: "available",
    href: "compress.html",
    badge: "Available"
  },
  {
    id: "edit",
    title: "Edit PDF",
    description: "Add text, drawings, images and signatures (planned).",
    icon: "edit",
    status: "soon",
    href: "edit.html",
    badge: "Coming soon"
  },
  {
    id: "merge",
    title: "Merge PDF",
    description: "Combine multiple PDF files into one document.",
    icon: "merge",
    status: "available",
    href: "merge.html",
    badge: "Available"
  },
  {
    id: "split",
    title: "Split PDF",
    description: "Extract pages or divide a PDF into parts.",
    icon: "split",
    status: "available",
    href: "split.html",
    badge: "Available"
  },
  {
    id: "rotate",
    title: "Rotate PDF",
    description: "Rotate pages to the correct orientation.",
    icon: "rotate",
    status: "soon",
    href: "tool.html?tool=rotate",
    badge: "Coming soon"
  },
  {
    id: "delete-pages",
    title: "Delete Pages",
    description: "Remove unwanted pages from your PDF.",
    icon: "trash",
    status: "soon",
    href: "tool.html?tool=delete-pages",
    badge: "Coming soon"
  },
  {
    id: "extract-pages",
    title: "Extract Pages",
    description: "Pull selected pages out into a new PDF.",
    icon: "extract",
    status: "soon",
    href: "tool.html?tool=extract-pages",
    badge: "Coming soon"
  },
  {
    id: "pdf-to-jpg",
    title: "PDF to JPG",
    description: "Convert PDF pages into JPG images.",
    icon: "image",
    status: "soon",
    href: "tool.html?tool=pdf-to-jpg",
    badge: "Coming soon"
  },
  {
    id: "jpg-to-pdf",
    title: "JPG to PDF",
    description: "Turn JPG images into a PDF document.",
    icon: "pdfdoc",
    status: "soon",
    href: "tool.html?tool=jpg-to-pdf",
    badge: "Coming soon"
  },
  {
    id: "watermark",
    title: "Watermark PDF",
    description: "Stamp text or image watermarks onto pages.",
    icon: "watermark",
    status: "soon",
    href: "tool.html?tool=watermark",
    badge: "Coming soon"
  },
  {
    id: "page-numbers",
    title: "Add Page Numbers",
    description: "Number every page of your PDF automatically.",
    icon: "numbers",
    status: "soon",
    href: "tool.html?tool=page-numbers",
    badge: "Coming soon"
  },
  {
    id: "protect",
    title: "Protect PDF",
    description: "Add password protection to sensitive PDFs.",
    icon: "lock",
    status: "soon",
    href: "tool.html?tool=protect",
    badge: "Coming soon"
  }
];

/* Minimal inline SVG icon set (stroke = currentColor, 24x24). */
window.PdfIcons = {
  compress: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h6v6H4z"/><path d="M14 4h6v6h-6z"/><path d="M10 17v3a1 1 0 0 0 1 1h8"/><path d="M14 7V4a1 1 0 0 0-1-1H5"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
  merge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H4v18h4"/><path d="M16 3h4v18h-4"/><path d="M12 2v20"/></svg>',
  split: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.5 15.5"/><path d="M14.5 14.5 20 20"/><path d="M8.5 8.5 12 12"/></svg>',
  rotate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>',
  extract: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M9 15h6"/><path d="M12 12v6"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.5-3.5a2 2 0 0 0-3 0L6 20"/></svg>',
  pdfdoc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M9 13h6"/><path d="M9 17h4"/></svg>',
  watermark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.7 17.7 8.4a8 8 0 1 1-11.4 0Z"/></svg>',
  numbers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3 8 21"/><path d="M16 3l-2 18"/><path d="M4 8h17"/><path d="M3 16h17"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>'
};

window.PdfToolById = function (id) {
  return (window.PdfTools || []).find(function (t) { return t.id === id; }) || null;
};

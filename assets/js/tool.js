/* Generic placeholder for unimplemented tools (tool.html?tool=<id>).
 * Shows the tool's icon/title/description from the registry with a clear
 * "Coming soon" state. Unknown ids render a friendly empty state. */
(function () {
  function param(name) {
    return new URLSearchParams(window.location.search).get(name);
  }

  function render() {
    var box = document.getElementById("placeholder");
    if (!box) return;
    var tool = window.PdfToolById(param("tool"));
    if (!tool) {
      box.innerHTML =
        "<h1>Unknown tool</h1>" +
        "<p>We couldn't find that PDF tool. Please pick one from the toolkit.</p>" +
        '<p><a class="btn" href="index.html">Back to all tools</a></p>';
      document.title = "Unknown tool — PDF Toolkit";
      return;
    }
    document.title = tool.title + " — coming soon — PDF Toolkit";
    box.innerHTML =
      '<a class="back-link" href="index.html">&larr; All tools</a>' +
      '<div class="tool-icon" style="width:56px;height:56px;margin-bottom:14px;">' +
      (window.PdfIcons[tool.icon] || "") +
      "</div>" +
      "<h1></h1>" +
      '<p><span class="badge soon"></span></p>' +
      "<p></p>" +
      "<p>This tool isn't available yet. We're building the toolkit one tool at a time — " +
      "PDF compression is ready today.</p>" +
      '<p><a class="btn" href="compress.html">Try Compress PDF</a> ' +
      '<a class="btn ghost" href="index.html">All tools</a></p>';
    box.querySelector("h1").textContent = tool.title;
    box.querySelector(".badge").textContent = tool.badge;
    box.querySelectorAll("p")[1].textContent = tool.description;
  }

  document.addEventListener("DOMContentLoaded", render);
})();

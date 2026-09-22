/* Homepage: renders Popular + All tool grids from the registry. */
(function () {
  function card(tool) {
    var el = document.createElement("a");
    el.className = "tool-card" + (tool.status === "soon" ? " soon" : "");
    el.href = tool.href;
    if (tool.status === "soon") {
      el.setAttribute("aria-label", tool.title + " — coming soon");
    }
    el.innerHTML =
      '<div class="tool-icon">' +
      (window.PdfIcons[tool.icon] || "") +
      "</div>" +
      '<div><h3></h3><p></p><span class="badge ' +
      (tool.status === "available" ? "ok" : "soon") +
      '"></span></div>';
    el.querySelector("h3").textContent = tool.title;
    el.querySelector("p").textContent = tool.description;
    el.querySelector(".badge").textContent = tool.badge;
    return el;
  }

  function render() {
    var tools = window.PdfTools || [];
    var popular = document.getElementById("popularTools");
    var all = document.getElementById("allTools");
    if (!popular || !all) return;
    var popularIds = ["compress", "edit", "merge", "split", "pdf-to-jpg", "jpg-to-pdf"];
    popularIds.forEach(function (id) {
      var t = window.PdfToolById(id);
      if (t) popular.appendChild(card(t));
    });
    tools.forEach(function (t) {
      all.appendChild(card(t));
    });
  }

  document.addEventListener("DOMContentLoaded", render);
})();

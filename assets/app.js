/* Tools Website — shared JavaScript
   1) Dark-mode toggle persisted in localStorage
   2) Homepage tool search: filters tool cards by name/keywords as the user types */
(function () {
  "use strict";

  /* ---------- Dark mode ---------- */
  var root = document.documentElement;
  var toggle = document.querySelector(".theme-toggle");

  function currentTheme() {
    return root.getAttribute("data-theme") === "dark" ? "dark" : "light";
  }

  function paintToggle() {
    if (!toggle) return;
    var dark = currentTheme() === "dark";
    toggle.textContent = dark ? "☀️" : "🌙";
    toggle.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
    toggle.setAttribute("aria-pressed", dark ? "true" : "false");
  }

  if (toggle) {
    paintToggle();
    toggle.addEventListener("click", function () {
      var next = currentTheme() === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try {
        localStorage.setItem("tw-theme", next);
      } catch (e) { /* private mode: ignore */ }
      paintToggle();
    });
  }

  /* ---------- Tool search (homepage) ---------- */
  var input = document.getElementById("tool-search");
  if (!input) return;

  var cards = Array.prototype.slice.call(document.querySelectorAll(".tool-card[data-name]"));
  var emptyMsg = document.getElementById("search-empty");
  var grids = Array.prototype.slice.call(document.querySelectorAll("[data-filter-section]"));

  function applyFilter() {
    var q = input.value.trim().toLowerCase();
    var visibleTotal = 0;

    cards.forEach(function (card) {
      var haystack = (card.getAttribute("data-name") || "") + " " + card.textContent.toLowerCase();
      var show = q === "" || haystack.indexOf(q) !== -1;
      card.style.display = show ? "" : "none";
      if (show) visibleTotal++;
    });

    /* Hide a whole section when none of its cards match. */
    grids.forEach(function (section) {
      if (q === "") { section.style.display = ""; return; }
      var anyVisible = Array.prototype.some.call(
        section.querySelectorAll(".tool-card[data-name]"),
        function (c) { return c.style.display !== "none"; }
      );
      section.style.display = anyVisible ? "" : "none";
    });

    if (emptyMsg) emptyMsg.hidden = !(q !== "" && visibleTotal === 0);
  }

  input.addEventListener("input", applyFilter);
})();

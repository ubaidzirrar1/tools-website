/* Tools Website — shared JavaScript
   0) Google Analytics 4 (loaded here so every page that includes app.js is tracked)
   1) Dark-mode toggle persisted in localStorage
   2) Homepage tool search + category pills: filters tool cards as the user types / taps */

/* ---------- Google Analytics 4 ---------- */
(function () {
  var GA_ID = "G-MSLHDKGRN4";
  var s = document.createElement("script");
  s.async = true;
  s.src = "https://www.googletagmanager.com/gtag/js?id=" + GA_ID;
  document.head.appendChild(s);
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  window.gtag("js", new Date());
  window.gtag("config", GA_ID);
})();
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

  /* ---------- Tool search + category pills (homepage) ----------
     Both filters apply together: a card shows only when it matches the
     search text AND the active category pill. */
  var input = document.getElementById("tool-search");
  var grid = document.getElementById("tool-grid");
  if (!input && !grid) return;

  var cards = Array.prototype.slice.call(document.querySelectorAll(".tool-card[data-name]"));
  var emptyMsg = document.getElementById("search-empty");
  var pills = Array.prototype.slice.call(document.querySelectorAll(".pill[data-filter]"));
  var activeCategory = "all";

  function applyFilter() {
    var q = input ? input.value.trim().toLowerCase() : "";
    var visibleTotal = 0;

    cards.forEach(function (card) {
      var haystack = (card.getAttribute("data-name") || "") + " " + card.textContent.toLowerCase();
      var matchSearch = q === "" || haystack.indexOf(q) !== -1;
      var matchCategory = activeCategory === "all" ||
        card.getAttribute("data-category") === activeCategory;
      var show = matchSearch && matchCategory;
      card.style.display = show ? "" : "none";
      if (show) visibleTotal++;
    });

    if (emptyMsg) emptyMsg.hidden = visibleTotal !== 0;
  }

  if (input) input.addEventListener("input", applyFilter);

  pills.forEach(function (pill) {
    pill.addEventListener("click", function () {
      activeCategory = pill.getAttribute("data-filter") || "all";
      pills.forEach(function (p) {
        var on = p === pill;
        p.classList.toggle("is-active", on);
        p.setAttribute("aria-pressed", on ? "true" : "false");
      });
      applyFilter();
    });
  });
})();

/* ---------- Header navigation: mega menu + mobile panel ---------- */
(function () {
  "use strict";
  var header = document.querySelector(".site-header");
  if (!header) return;
  var navToggle = header.querySelector("[data-nav-toggle]");
  var megaBtn = header.querySelector("[data-mega-toggle]");
  var megaItem = header.querySelector(".has-mega");

  function closeMega() {
    if (megaItem) megaItem.classList.remove("open");
    if (megaBtn) megaBtn.setAttribute("aria-expanded", "false");
  }
  function closeNav() {
    header.classList.remove("nav-open");
    if (navToggle) {
      navToggle.setAttribute("aria-expanded", "false");
      navToggle.setAttribute("aria-label", "Open menu");
    }
    closeMega();
  }

  if (megaBtn && megaItem) {
    megaBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      var open = megaItem.classList.toggle("open");
      megaBtn.setAttribute("aria-expanded", open ? "true" : "false");
    });
    megaItem.addEventListener("click", function (e) { e.stopPropagation(); });
  }
  if (navToggle) {
    navToggle.addEventListener("click", function (e) {
      e.stopPropagation();
      var open = header.classList.toggle("nav-open");
      navToggle.setAttribute("aria-expanded", open ? "true" : "false");
      navToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
      if (!open) closeMega();
    });
  }
  if (megaItem && window.matchMedia && matchMedia("(min-width: 921px) and (hover: hover)").matches) {
    megaItem.addEventListener("mouseenter", function () {
      megaItem.classList.add("open");
      if (megaBtn) megaBtn.setAttribute("aria-expanded", "true");
    });
    megaItem.addEventListener("mouseleave", function () { closeMega(); });
  }
  document.addEventListener("click", function () { closeMega(); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeNav();
  });
  header.querySelectorAll(".mega-item, .mega-heading, .main-nav > a.nav-link").forEach(function (link) {
    link.addEventListener("click", function () { closeNav(); });
  });
})();

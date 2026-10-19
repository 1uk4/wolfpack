export const MODE_JS = `
// ── View mode (KB / Work) ───────────────────────────────────────────────────
// A segmented pill in the top-left corner of the graph viewport flips the
// dashboard between KB mode (domains/sections/entries) and Work mode
// (domains/factory/initiatives/features/tasks). This module owns the UI,
// localStorage persistence, and a 'mode-change' CustomEvent. Other modules
// (graph, tree, breadcrumb, reader) subscribe in later tasks.
var MODE_STORAGE_KEY = "wolfpack-dashboard-mode";
var currentMode = (function() {
  try {
    var stored = localStorage.getItem(MODE_STORAGE_KEY);
    return stored === "work" ? "work" : "kb";
  } catch (_e) { return "kb"; }
})();

function getMode() { return currentMode; }

function setMode(mode) {
  if (mode !== "kb" && mode !== "work") return;
  if (mode === currentMode) return;
  currentMode = mode;
  try { localStorage.setItem(MODE_STORAGE_KEY, mode); } catch (_e) { /* ignore */ }
  renderModeToggle();
  document.dispatchEvent(new CustomEvent("mode-change", { detail: { mode: mode } }));
}

function renderModeToggle() {
  var container = document.getElementById("mode-toggle");
  if (!container) return;
  container.querySelectorAll("button").forEach(function(btn) {
    var isActive = btn.getAttribute("data-mode") === currentMode;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
}

function wireModeToggle() {
  var container = document.getElementById("mode-toggle");
  if (!container) return;
  container.querySelectorAll("button").forEach(function(btn) {
    btn.addEventListener("click", function() {
      setMode(btn.getAttribute("data-mode"));
    });
  });
  renderModeToggle();
}
wireModeToggle();

`;

// Theme init: run before first paint to avoid a flash of the wrong theme.
(function () {
  var saved = null;
  try {
    saved = localStorage.getItem('stryx-theme');
  } catch {
    // Storage blocked (a private window, site data off): the default theme, not a broken page.
  }
  // Dark is the default aesthetic, so a first visit ignores the OS preference.
  document.documentElement.dataset.theme = saved === 'light' ? 'light' : 'dark';
})();

// Global on purpose: called from the pages' markup (onclick), not from this file.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function toggleStryxTheme() {
  var root = document.documentElement;
  var next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  try {
    localStorage.setItem('stryx-theme', next);
  } catch {
    // Not remembered, still switched.
  }
  chargeLogo();
}

// Replays the logo animation. Also call this on a successful mint.
function chargeLogo() {
  document.querySelectorAll('.stryx-logo').forEach(function (el) {
    el.classList.remove('is-charged');
    void el.offsetWidth;            // restart the animation
    el.classList.add('is-charged');
    setTimeout(function () { el.classList.remove('is-charged'); }, 800);
  });
}

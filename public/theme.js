/**
 * Applies the colour theme before first paint (loaded as a blocking classic script
 * in <head>, since the CSP forbids inline scripts). The choice lives in the same
 * settings object app.js saves: "system" (default), "light" or "dark".
 * window.readAloudTheme.set() is how the Settings drawer changes it.
 */
(function () {
  var KEY = 'readaloud.settings.v1';
  var media = window.matchMedia('(prefers-color-scheme: dark)');
  var choice = 'system';
  try {
    var saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (saved && (saved.theme === 'light' || saved.theme === 'dark')) choice = saved.theme;
  } catch (e) {
    /* storage unavailable: follow the system */
  }

  function apply() {
    var dark = choice === 'dark' || (choice === 'system' && media.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }

  // "System" follows the OS live, e.g. an automatic switch at sunset.
  media.addEventListener('change', function () {
    if (choice === 'system') apply();
  });

  window.readAloudTheme = {
    /** @param {'system'|'light'|'dark'} next */
    set: function (next) {
      choice = next === 'light' || next === 'dark' ? next : 'system';
      apply();
    },
  };
  apply();
})();

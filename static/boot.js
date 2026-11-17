// Runs before first paint so the theme and tint never flash.
(function () {
  var s = {};
  try { s = JSON.parse(localStorage.getItem('pb:settings') || '{}'); } catch (e) {}
  var theme = s.theme && s.theme !== 'auto' ? s.theme
    : (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  var r = document.documentElement;
  r.dataset.theme = theme;
  if (s.hue != null) r.style.setProperty('--hue', s.hue);
})();

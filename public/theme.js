(() => {
  const key = 'cookiecasekit-theme';
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let preference;
  try {
    preference = localStorage.getItem(key);
  } catch {
    /* Storage can be disabled by the host browser. */
  }
  if (!['light', 'dark'].includes(preference)) preference = null;
  function apply() {
    document.documentElement.dataset.theme = preference || (media.matches ? 'dark' : 'light');
    document.dispatchEvent(new Event('cookiecasekit:theme'));
  }
  window.CookieCaseKitTheme = {
    toggle() {
      preference = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(key, preference);
      } catch {
        /* Still works for this page. */
      }
      apply();
    },
  };
  media.addEventListener('change', () => {
    if (!preference) apply();
  });
  apply();
})();

// Shared client-side auth glue for every clinic page.
// Loaded via <script src="js/auth.js"></script> as the FIRST script on every page.
(function () {
  const TOKEN_KEY = 'clinic_token';
  const PAGE = (location.pathname.split('/').pop() || 'index.html').toLowerCase();

  // Pages that don't need auth (login screen itself + print pages that reload after session expiry are fine because their APIs are protected — user will just get 401 and be sent to login)
  const OPEN_PAGES = new Set(['login.html', 'forgot.html']);

  const token = sessionStorage.getItem(TOKEN_KEY);
  if (!token && !OPEN_PAGES.has(PAGE)) {
    location.replace('login.html');
    return;
  }

  const _fetch = window.fetch;
  window.fetch = function (input, init) {
    init = init || {};
    init.headers = Object.assign({}, init.headers || {});
    const t = sessionStorage.getItem(TOKEN_KEY);
    if (t) init.headers['Authorization'] = 'Bearer ' + t;

    // Delete-password prompt for any DELETE call to /api/*
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if ((init.method || '').toUpperCase() === 'DELETE' && /\/api\//.test(url)) {
      const pw = prompt('Enter DELETE password to confirm this deletion:');
      if (!pw) {
        return Promise.resolve(new Response(
          JSON.stringify({ success: false, message: 'Deletion cancelled' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        ));
      }
      init.headers['X-Delete-Password'] = pw;
    }

    return _fetch(input, init).then((res) => {
      if (res.status === 401 && !OPEN_PAGES.has(PAGE)) {
        // If the login token itself is bad → go back to login
        // Clone so caller can still read the JSON if they want
        return res.clone().json().then((j) => {
          if ((j && j.message) === 'Not logged in') {
            sessionStorage.removeItem(TOKEN_KEY);
            location.replace('login.html');
          }
          return res;
        }).catch(() => res);
      }
      return res;
    });
  };

  window.logout = function () {
    sessionStorage.removeItem(TOKEN_KEY);
    location.replace('login.html');
  };

  // Register PWA service worker so the browser offers "Install as desktop app".
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
})();

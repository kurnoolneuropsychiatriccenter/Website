// Shared client-side auth glue for every clinic page.
// Loaded via <script src="js/auth.js"></script> as the FIRST script on every page.
(function () {
  const TOKEN_KEY = 'clinic_token';
  const EDIT_PW_KEY = 'clinic_edit_pw';           // sessionStorage: cached edit/delete password
  const EDIT_PW_TIME_KEY = 'clinic_edit_pw_at';   // ms epoch when cached
  const EDIT_PW_TTL_MS = 15 * 60 * 1000;          // 15-minute idle cache
  const PAGE = (location.pathname.split('/').pop() || 'index.html').toLowerCase();

  // Any /api/* PUT/PATCH path that starts with one of these is exempt from the edit-password prompt
  // (they are auth/settings/danger-zone flows that already require the login password OR are handled specially).
  const EDIT_PW_EXEMPT_PREFIXES = [
    '/api/auth/',
    '/api/settings',            // catches /api/settings, /api/settings/smtp, /api/settings/smtp-test
    '/api/dev/request-danger-code',
    '/api/dev/verify-danger-code'
  ];
  function isEditPwExempt(url) {
    return EDIT_PW_EXEMPT_PREFIXES.some(p => url.indexOf(p) !== -1);
  }
  function isApiUrl(url) { return /\/api\//.test(url); }
  function getCachedEditPw() {
    const at = parseInt(sessionStorage.getItem(EDIT_PW_TIME_KEY) || '0', 10);
    if (!at || Date.now() - at > EDIT_PW_TTL_MS) {
      sessionStorage.removeItem(EDIT_PW_KEY);
      sessionStorage.removeItem(EDIT_PW_TIME_KEY);
      return null;
    }
    return sessionStorage.getItem(EDIT_PW_KEY);
  }
  function setCachedEditPw(pw) {
    sessionStorage.setItem(EDIT_PW_KEY, pw);
    sessionStorage.setItem(EDIT_PW_TIME_KEY, String(Date.now()));
  }
  window.clearEditPassword = function () {
    sessionStorage.removeItem(EDIT_PW_KEY);
    sessionStorage.removeItem(EDIT_PW_TIME_KEY);
  };

  const OPEN_PAGES = new Set(['login.html', 'forgot.html']);
  const token = sessionStorage.getItem(TOKEN_KEY);
  if (!token && !OPEN_PAGES.has(PAGE)) { location.replace('login.html'); return; }

  const _fetch = window.fetch;
  window.fetch = function (input, init) {
    init = init || {};
    init.headers = Object.assign({}, init.headers || {});
    const t = sessionStorage.getItem(TOKEN_KEY);
    if (t) init.headers['Authorization'] = 'Bearer ' + t;

    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = (init.method || 'GET').toUpperCase();
    const needsPw = isApiUrl(url) && ['DELETE', 'PUT', 'PATCH'].includes(method) && !isEditPwExempt(url);

    if (needsPw && !init.headers['X-Delete-Password']) {
      let pw = getCachedEditPw();
      if (!pw) {
        const label = method === 'DELETE'
          ? 'Enter the Edit/Delete password to confirm this DELETE:'
          : 'Enter the Edit/Delete password to confirm this EDIT:';
        pw = prompt(label + '\n\n(The password is remembered for 15 minutes so you\'re not asked again for every change.)');
        if (!pw) {
          return Promise.resolve(new Response(
            JSON.stringify({ success: false, message: (method === 'DELETE' ? 'Deletion' : 'Edit') + ' cancelled' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          ));
        }
        setCachedEditPw(pw);
      }
      init.headers['X-Delete-Password'] = pw;
    }

    return _fetch(input, init).then((res) => {
      // If the server said the password was wrong, clear the cache so the next attempt re-prompts.
      if (res.status === 401 && needsPw) {
        return res.clone().json().then((j) => {
          if (j && /password/i.test(j.message || '')) {
            window.clearEditPassword();
          }
          return res;
        }).catch(() => res);
      }
      if (res.status === 401 && !OPEN_PAGES.has(PAGE)) {
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
    window.clearEditPassword();
    location.replace('login.html');
  };

  // Register PWA service worker so the browser offers "Install as desktop app".
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
})();

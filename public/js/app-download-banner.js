
(() => {
  'use strict';

  const STORAGE_KEY = 'optitrade_android_download_bar_closed_at';
  const APK_URL = '/downloads/OptiTrade.apk';
  const APP_PAGE = '/download-app.html';
  const HIDE_FOR_MS = 7 * 24 * 60 * 60 * 1000;

  // Never advertise the APK from inside the installed OptiTrade Android app.
  if (/OptiTradeAndroid/i.test(navigator.userAgent)) return;

  try {
    const closedAt = Number(localStorage.getItem(STORAGE_KEY) || 0);
    if (closedAt && Date.now() - closedAt < HIDE_FOR_MS) return;
  } catch (_) {}

  const makeBar = () => {
    if (document.getElementById('ot-app-download-bar')) return;

    const bar = document.createElement('aside');
    bar.id = 'ot-app-download-bar';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Download OptiTrade Android app');
    bar.innerHTML = `
      <div class="ot-app-icon" aria-hidden="true">↗</div>
      <div class="ot-app-copy">
        <b>OptiTrade for Android</b>
        <span>Faster access with phone security &amp; trusted-device support.</span>
      </div>
      <a class="ot-app-download-btn" href="${APK_URL}" download>Download App</a>
      <button class="ot-app-close" type="button" aria-label="Close app download reminder">×</button>
    `;

    bar.querySelector('.ot-app-close').addEventListener('click', () => {
      try { localStorage.setItem(STORAGE_KEY, String(Date.now())); } catch (_) {}
      bar.remove();
    });

    const btn = bar.querySelector('.ot-app-download-btn');
    btn.addEventListener('click', async (e) => {
      // If the APK is not live yet, send the user to the download information page.
      try {
        const r = await fetch(APK_URL, { method: 'HEAD', cache: 'no-store' });
        const size = Number(r.headers.get('content-length') || 0);
        if (!r.ok || size === 0) {
          e.preventDefault();
          location.href = APP_PAGE;
        }
      } catch (_) {
        e.preventDefault();
        location.href = APP_PAGE;
      }
    });

    document.body.appendChild(bar);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', makeBar, { once: true });
  } else {
    makeBar();
  }
})();

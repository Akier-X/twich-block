// content.js  (ISOLATED world) — DOM 上の広告要素・オーバーレイを除去
(function () {
  'use strict';

  // 表示広告・スポンサー枠などの要素を隠す CSS
  const CSS = `
    /* 動画プレイヤー上の広告オーバーレイ */
    [data-a-target="video-ad-label"],
    [data-a-target="video-ad-countdown"],
    .video-player__ad-info-container,
    .player-ad-notice,
    span[data-a-target="video-ad-countdown"],
    /* 表示広告 / スポンサー / バナー */
    [data-a-target="advertisement"],
    [aria-label="Advertisement"],
    div[data-test-selector="sad-overlay"],
    .stream-display-ad,
    .persistent-player__ad-container,
    div[class*="StreamDisplayAd"],
    div[class*="display-ad"] {
      display: none !important;
    }
  `;

  function injectCSS() {
    const style = document.createElement('style');
    style.id = 'twitch-adblock-style';
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  // 広告表示中はプレイヤーを検出してオーバーレイ要素を消す
  function removeAdOverlays() {
    const selectors = [
      '.video-player__ad-info-container',
      '[data-a-target="video-ad-label"]',
      'div[data-test-selector="sad-overlay"]',
      '.stream-display-ad',
    ];
    selectors.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => el.remove());
    });
  }

  const observer = new MutationObserver(() => {
    removeAdOverlays();
  });

  function start() {
    injectCSS();
    removeAdOverlays();
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();

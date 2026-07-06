// content.js  (ISOLATED world) — DOM 上の広告要素・オーバーレイを除去 ＋ 早送りフォールバック
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 1) 表示広告・スポンサー枠などの要素を隠す CSS
  //    ※ 広告ラベル/カウントダウンは「検出用シグナル」として DOM に残すため
  //      display:none で“見えなくする”だけにして .remove() はしない。
  // ---------------------------------------------------------------------------
  const CSS = `
    /* 動画プレイヤー上の広告オーバーレイ（DOM には残して視覚的に隠す） */
    [data-a-target="video-ad-label"],
    [data-a-target="video-ad-countdown"],
    .video-player__ad-info-container,
    .player-ad-notice,
    span[data-a-target="video-ad-countdown"],
    /* 表示広告 / スポンサー / バナー（これらは完全に消してよい） */
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

  // 完全に消してよい「表示広告バナー」系だけ DOM から除去する
  function removeDisplayAds() {
    const selectors = [
      'div[data-test-selector="sad-overlay"]',
      '.stream-display-ad',
      '.persistent-player__ad-container',
      'div[class*="StreamDisplayAd"]',
    ];
    selectors.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => el.remove());
    });
  }

  // ---------------------------------------------------------------------------
  // 2) 早送りフォールバック
  //    ストリーム差し替えが失敗して広告が流れてしまった場合の保険。
  //    広告中は「ミュート ＋ バッファ先端(live edge)へジャンプ ＋ 再生倍速アップ」
  //    でバッファ済みの広告セグメントを一気に消化する。
  //    ※ ライブの“まだ配信されていない先”には飛べないため完全スキップは不可。
  // ---------------------------------------------------------------------------
  const FF = {
    enabled: true,     // 早送りフォールバックを有効にするか
    rate: 8,           // 広告中の再生倍速（ブラウザ上限は 16。ライブでは 4〜8 が現実的）
    edgeGap: 0.15,     // live edge の何秒手前まで詰めるか
  };

  // ad 検出用セレクタ（display:none でも querySelector では見つかる）
  const AD_SELECTORS = [
    '[data-a-target="video-ad-label"]',
    '[data-a-target="video-ad-countdown"]',
    'span[data-a-target="video-ad-countdown"]',
    '.player-ad-notice',
    '.video-player__ad-info-container',
    'div[data-test-selector="sad-overlay"]',
  ];

  const stats = { adsSeen: 0, secondsFastForwarded: 0, lastAd: null };
  let adActive = false;
  const saved = { rate: 1, muted: false };

  function getVideo() {
    return document.querySelector('video');
  }

  function adPresent() {
    for (const sel of AD_SELECTORS) {
      if (document.querySelector(sel)) return true;
    }
    return false;
  }

  function enterAd(v) {
    adActive = true;
    stats.adsSeen += 1;
    stats.lastAd = new Date().toISOString();
    saved.rate = v.playbackRate || 1;
    saved.muted = v.muted;
    console.log('[TwitchAdblock] 広告を検出 → 早送りフォールバック開始');
  }

  function tickAd(v) {
    if (!FF.enabled) return;
    v.muted = true;
    // バッファ先端(live edge)へジャンプしてバッファ済み広告を飛ばす
    try {
      if (v.buffered && v.buffered.length) {
        const end = v.buffered.end(v.buffered.length - 1);
        const gap = end - v.currentTime;
        if (gap > 0.5) {
          v.currentTime = end - FF.edgeGap;
          stats.secondsFastForwarded += gap;
        }
      }
    } catch (e) { /* seek 不可のタイミングは無視 */ }
    // バッファに追いつくまでの分は倍速で消化
    try { v.playbackRate = Math.min(16, FF.rate); } catch (e) {}
  }

  function exitAd(v) {
    adActive = false;
    try { v.playbackRate = saved.rate || 1; } catch (e) {}
    v.muted = saved.muted;
    console.log('[TwitchAdblock] 広告終了 → 通常再生に復帰', stats);
  }

  function pump() {
    const v = getVideo();
    if (!v) return;
    const present = adPresent();
    if (present) {
      if (!adActive) enterAd(v);
      tickAd(v);
    } else if (adActive) {
      exitAd(v);
    }
  }

  // 監視ループ（250ms 間隔）— 広告の出現/消滅に素早く反応する
  let loopTimer = null;
  function startLoop() {
    if (loopTimer) return;
    loopTimer = setInterval(pump, 250);
  }

  // 外部（コンソール/ポップアップ）から状態を確認できるように公開
  window.__twitchAdblockStats = stats;

  // ---------------------------------------------------------------------------
  const observer = new MutationObserver(() => {
    removeDisplayAds();
  });

  function start() {
    injectCSS();
    removeDisplayAds();
    startLoop();
    observer.observe(document.documentElement, { childList: true, subtree: true });
    console.log('[TwitchAdblock] content script started (fast-forward fallback: '
      + (FF.enabled ? 'ON, ' + FF.rate + 'x' : 'OFF') + ')');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();

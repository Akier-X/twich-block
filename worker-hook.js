// worker-hook.js  (runs in the MAIN world of twitch.tv)
// -----------------------------------------------------------------------------
// Twitch のライブ広告（配信に埋め込まれる SSAI ミッドロール／プリロール）を除去します。
// 手法:  Twitch は HLS 再生を Web Worker 内で処理します。そのため Worker を
//        ラップして、広告処理コードをワーカーへ注入します。ワーカー内で usher の
//        .m3u8 プレイリスト取得をフックし、広告セグメントを検出したら "広告なし"
//        のバックアップ ストリーム（別プレイヤータイプで取得）に差し替えます。
//
// ベース: pixeltris/TwitchAdSolutions (video-swap-new) を拡張機能向けに整理。
// -----------------------------------------------------------------------------
(function () {
  'use strict';

  // 二重注入防止
  if (window.__twitchAdblockLoaded) return;
  window.__twitchAdblockLoaded = true;

  const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
  const AD_SIGNIFIER = 'stitched';
  const LIVE_SIGNIFIER = ',live';

  // ---- ワーカーへ注入する文字列。これがワーカーのスコープ内で実行されます ----
  function getWorkerHookCode() {
    return `
      var CLIENT_ID = '${CLIENT_ID}';
      var AD_SIGNIFIER = '${AD_SIGNIFIER}';
      var LIVE_SIGNIFIER = '${LIVE_SIGNIFIER}';

      var StreamInfosByUrl = {};
      var StreamInfos = {};

      function gqlRequest(body) {
        return fetch('https://gql.twitch.tv/gql', {
          method: 'POST',
          headers: { 'Client-Id': CLIENT_ID },
          body: JSON.stringify(body),
        });
      }

      // 広告なしのアクセストークンを別プレイヤータイプで取得
      async function getAccessToken(channelName, playerType) {
        var body = {
          operationName: 'PlaybackAccessToken_Template',
          query: 'query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) {  streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) {    value    signature   __typename  }  videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) {    value    signature   __typename  }}',
          variables: {
            isLive: true,
            login: channelName,
            isVod: false,
            vodID: '',
            playerType: playerType,
          },
        };
        return (await gqlRequest(body)).json();
      }

      // usher からプレイリスト(m3u8)を取得
      async function getStreamM3U8(channelName, token, sig) {
        var url = 'https://usher.ttvnw.net/api/channel/hls/' + channelName + '.m3u8';
        var params = new URLSearchParams({
          'allow_source': 'true',
          'fast_bread': 'true',
          'p': Math.floor(Math.random() * 9999999),
          'play_session_id': (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString()),
          'player_backend': 'mediaplayer',
          'playlist_include_framerate': 'true',
          'reassignments_supported': 'true',
          'sig': sig,
          'supported_codecs': 'avc1',
          'token': token,
          'cdm': 'wv',
          'player_version': '1.30.0',
        });
        var res = await fetch(url + '?' + params.toString());
        return await res.text();
      }

      // 広告なしのバックアップ ストリーム(高画質 variant の URL)を取得
      async function tryGetAdFreeStream(channelName) {
        try {
          var accessTokenResponse = await getAccessToken(channelName, 'thunderdome');
          if (!accessTokenResponse || !accessTokenResponse.data || !accessTokenResponse.data.streamPlaybackAccessToken) {
            return null;
          }
          var t = accessTokenResponse.data.streamPlaybackAccessToken;
          var masterText = await getStreamM3U8(channelName, t.value, t.signature);
          if (!masterText || masterText.includes('403') || masterText.trim().length === 0) return null;
          // master プレイリストから最高画質の variant URL を取り出す
          var lines = masterText.split('\\n');
          for (var i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('https://')) {
              return lines[i].trim();
            }
          }
        } catch (e) {
          console.log('[TwitchAdblock] backup stream error', e);
        }
        return null;
      }

      // プレイリスト内に広告があるか判定
      function hasAd(text) {
        return text.includes(AD_SIGNIFIER) || text.includes('Amazon') || text.includes('stitched-ad');
      }

      // メディア(variant) プレイリストをフックして広告時にバックアップへ差し替え
      async function processMediaPlaylist(url, realFetch, streamInfo) {
        var response = await realFetch(url);
        var text = await response.text();
        if (!hasAd(text)) {
          // 広告なし → そのまま返す
          streamInfo.BackupUrl = null;
          return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
        }
        // 広告あり → バックアップ ストリームの同 variant を取得
        console.log('[TwitchAdblock] 広告を検出。広告なしストリームに切り替えます。');
        if (!streamInfo.BackupUrl) {
          streamInfo.BackupUrl = await tryGetAdFreeStream(streamInfo.ChannelName);
        }
        if (streamInfo.BackupUrl) {
          try {
            var backupResp = await realFetch(streamInfo.BackupUrl);
            var backupText = await backupResp.text();
            if (backupText && !hasAd(backupText)) {
              return new Response(backupText, { status: 200, statusText: 'OK' });
            }
          } catch (e) {
            console.log('[TwitchAdblock] backup fetch failed', e);
          }
        }
        // 差し替え失敗時は、広告 daterange 行を除去して返す(フォールバック)
        var cleaned = text
          .split('\\n')
          .filter(function (l) {
            return !(l.startsWith('#EXT-X-DATERANGE') && l.includes(AD_SIGNIFIER));
          })
          .join('\\n');
        return new Response(cleaned, { status: response.status, statusText: response.statusText, headers: response.headers });
      }

      var realFetch = self.fetch;
      self.fetch = function (url, options) {
        if (typeof url === 'string') {
          // master プレイリスト(usher) → チャンネル名を記録
          if (url.includes('usher.ttvnw.net')) {
            var chMatch = url.match(/\\/hls\\/([^.]+)\\.m3u8/) || url.match(/\\/vod\\//);
            var channelName = chMatch && chMatch[1] ? chMatch[1].toLowerCase() : null;
            return realFetch(url, options).then(async function (resp) {
              var masterText = await resp.text();
              // master 内の各 variant URL を記録して、チャンネル名を紐付け
              if (channelName) {
                var info = { ChannelName: channelName, BackupUrl: null };
                masterText.split('\\n').forEach(function (line) {
                  if (line.startsWith('https://') && line.includes('.m3u8')) {
                    StreamInfosByUrl[line.trim()] = info;
                  }
                });
              }
              return new Response(masterText, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
            });
          }
          // variant(メディア) プレイリスト → 広告チェック
          if (url.includes('.m3u8') && StreamInfosByUrl[url]) {
            return processMediaPlaylist(url, realFetch, StreamInfosByUrl[url]);
          }
        }
        return realFetch(url, options);
      };

      console.log('[TwitchAdblock] worker hook installed');
    `;
  }

  // Twitch のワーカーか判定する。
  // Twitch は HLS ワーカーを blob URL (blob:https://www.twitch.tv/...) で生成する。
  // そのため「blob URL かつ中身が Twitch のワーカー」を対象にフックを注入する。
  function isTwitchWorkerUrl(url) {
    if (typeof url !== 'string') return false;
    // blob URL は origin が元ページ(twitch.tv)になる
    if (url.startsWith('blob:')) {
      return url.includes('twitch.tv');
    }
    // 直リンクの worker (静的CDN) も一応対象にする
    return url.includes('twitch') && url.includes('.js');
  }

  // ---- Worker コンストラクタをラップして注入コードを先頭に埋め込む ----
  const OriginalWorker = window.Worker;

  window.Worker = class extends OriginalWorker {
    constructor(url, options) {
      let scriptURL = url;
      if (isTwitchWorkerUrl(url)) {
        try {
          // 元ワーカー(blob)の中身を同期取得。blob は同一オリジン扱いなので読める。
          const xhr = new XMLHttpRequest();
          xhr.open('GET', url, false); // コンストラクタ内なので同期取得
          xhr.send();
          const originalSource = xhr.responseText || '';

          // 元ソースが importScripts のブートストラップだけの場合もあるが、
          // フックコードを前置してから元ソースをそのまま続ければ両パターンに対応できる。
          const merged = getWorkerHookCode() + '\n' + originalSource;
          const blob = new Blob([merged], { type: 'application/javascript' });
          scriptURL = URL.createObjectURL(blob);
          console.log('[TwitchAdblock] Twitch ワーカーにフックを注入しました:', url);
        } catch (e) {
          console.log('[TwitchAdblock] worker wrap failed, fallback to original', e);
          scriptURL = url;
        }
      }
      super(scriptURL, options);
    }
  };

  console.log('[TwitchAdblock] Worker constructor wrapped');
})();

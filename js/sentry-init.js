/**
 * Deer Brand — Sentry エラーモニタリング共通初期化
 *
 * 全HTMLページで defer 読み込み想定。
 * SENTRY_DSN が Vercel env に設定されていれば自動でエラー収集開始。
 * 未設定なら Silent に skip（開発時や Sentry 無しでも動く）。
 *
 * 補足:
 *  - window.deerBuild などの build 情報を自動タグ付け
 *  - CSP violation を securitypolicyviolation イベント経由で収集
 *  - window._deerLastHeicError など Deer 固有ステートも送信
 */
(function () {
  "use strict";

  // Deer 固有ステートをキャプチャ時に自動添付するヘルパ
  function collectDeerContext() {
    var ctx = {};
    try {
      if (typeof window._currentUser !== "undefined") {
        ctx.user_uid = window._currentUser
          ? window._currentUser.uid
          : "anonymous";
        ctx.user_email = window._currentUser ? window._currentUser.email : null;
      }
      if (window.deerBuild) ctx.deer_build = window.deerBuild;
      if (window._deerLastHeicError)
        ctx.last_heic_error = window._deerLastHeicError;
      if (typeof state !== "undefined" && state) {
        ctx.current_step = state.currentStep;
        ctx.selected_item = state.selectedItem;
        ctx.selected_style = state.selectedStyle;
      }
    } catch (_) {}
    return ctx;
  }

  // ── console.* をインターセプトして軽量ログも収集（errorReports に送信）
  //    コンソールにも元通り出力する（元の関数を呼び出す）
  //    同一メッセージの連投は間引く（1秒以内に同じ内容が来たら stack のみ1件残す）
  var _consoleBuffer = [];
  var _lastConsoleMsg = { text: "", t: 0 };
  var CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"];
  CONSOLE_METHODS.forEach(function (m) {
    var orig = console[m];
    if (!orig) return;
    console[m] = function () {
      var args = Array.prototype.slice.call(arguments);
      try {
        var text = args
          .map(function (a) {
            if (typeof a === "string") return a;
            try {
              return JSON.stringify(a).slice(0, 500);
            } catch (_) {
              return String(a);
            }
          })
          .join(" ")
          .slice(0, 2000);
        var now = Date.now();
        if (text === _lastConsoleMsg.text && now - _lastConsoleMsg.t < 1000) {
          // 1秒以内の重複は省略
        } else {
          _lastConsoleMsg = { text: text, t: now };
          _consoleBuffer.push({ t: now, type: "console_" + m, message: text });
          if (_consoleBuffer.length > 300) _consoleBuffer.shift();
        }
      } catch (_) {}
      return orig.apply(console, args);
    };
  });
  // _consoleBuffer を window._deerErrors に定期マージ
  function mergeConsoleIntoErrors() {
    if (!window._deerErrors || _consoleBuffer.length === 0) return;
    // ctx を最新状態で付与
    var drained = _consoleBuffer.splice(0, _consoleBuffer.length);
    drained.forEach(function (e) {
      e.ctx = collectDeerContext();
      window._deerErrors.push(e);
    });
  }
  setInterval(mergeConsoleIntoErrors, 4000);
  window.addEventListener("beforeunload", mergeConsoleIntoErrors);

  fetch("/api/get-user?type=config")
    .then(function (r) {
      return r.ok ? r.json() : null;
    })
    .then(function (cfg) {
      if (!cfg || !cfg.sentryDsn) {
        // DSN 未設定: 代替として軽量な error reporter を登録
        //   → window._deerErrors に蓄積。定期的に /api/get-user?type=error-report へ送信
        window._deerErrors = [];
        var lastFlushAt = 0;
        function flushErrors() {
          if (!window._deerErrors || window._deerErrors.length === 0) return;
          if (Date.now() - lastFlushAt < 3000) return; // 3秒デバウンス
          lastFlushAt = Date.now();
          var toSend = window._deerErrors.splice(0, 50);
          fetch("/api/get-user?type=error-report", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ errors: toSend }),
            keepalive: true,
          }).catch(function () {
            // 送信失敗したら再 push（上限超過したら捨てる）
            if (window._deerErrors.length < 100) {
              window._deerErrors.unshift.apply(window._deerErrors, toSend);
            }
          });
        }
        // 5 秒ごと & ページ離脱時に送信
        setInterval(flushErrors, 5000);
        window.addEventListener("beforeunload", flushErrors);
        window.addEventListener("pagehide", flushErrors);
        window.addEventListener("error", function (e) {
          try {
            window._deerErrors.push({
              t: Date.now(),
              type: "error",
              message: e.message,
              source: e.filename,
              line: e.lineno,
              col: e.colno,
              stack: e.error ? e.error.stack : null,
              ctx: collectDeerContext(),
            });
          } catch (_) {}
        });
        window.addEventListener("unhandledrejection", function (e) {
          try {
            var reason = e.reason || {};
            window._deerErrors.push({
              t: Date.now(),
              type: "rejection",
              message: reason.message || String(reason),
              stack: reason.stack || null,
              ctx: collectDeerContext(),
            });
          } catch (_) {}
        });
        document.addEventListener("securitypolicyviolation", function (e) {
          try {
            window._deerErrors.push({
              t: Date.now(),
              type: "csp",
              violatedDirective: e.violatedDirective,
              blockedURI: e.blockedURI,
              sourceFile: e.sourceFile,
              ctx: collectDeerContext(),
            });
          } catch (_) {}
        });
        return;
      }

      // Sentry SDK ロード
      var s = document.createElement("script");
      s.src = "https://browser.sentry-cdn.com/7.114.0/bundle.min.js";
      s.crossOrigin = "anonymous";
      s.onload = function () {
        if (!window.Sentry) return;
        window.Sentry.init({
          dsn: cfg.sentryDsn,
          tracesSampleRate: 0.2,
          environment:
            location.hostname === "custom.deer.gift"
              ? "production"
              : "development",
          release: window.deerBuild || "unknown",
          beforeSend: function (event) {
            try {
              event.extra = Object.assign(
                event.extra || {},
                collectDeerContext(),
              );
            } catch (_) {}
            return event;
          },
        });

        // CSP 違反を自動で Sentry に送る
        document.addEventListener("securitypolicyviolation", function (e) {
          try {
            window.Sentry.captureMessage(
              "CSP violation: " + e.violatedDirective,
              {
                level: "error",
                extra: {
                  violatedDirective: e.violatedDirective,
                  blockedURI: e.blockedURI,
                  sourceFile: e.sourceFile,
                  lineNumber: e.lineNumber,
                  ctx: collectDeerContext(),
                },
              },
            );
          } catch (_) {}
        });
      };
      document.head.appendChild(s);
    })
    .catch(function () {
      /* 設定取得失敗でも致命エラーにしない */
    });
})();

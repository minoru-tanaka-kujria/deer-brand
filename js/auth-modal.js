/**
 * Deer Brand — 共通ログインモーダル
 * 全ページで <script src="js/auth-modal.js"></script> で読み込む
 *
 * ★ Firebase設定は auth-config.js で一元管理 (TODO: 設定後に更新)
 */

(function () {
  "use strict";

  // ============================================================
  //  モーダルHTML注入
  // ============================================================
  const modalHTML = `
    <div id="authModalOverlay" style="
      display:none; position:fixed; inset:0; z-index:1000;
      background:rgba(44,40,36,0.6); backdrop-filter:blur(4px);
      align-items:center; justify-content:center; padding:1rem;
    ">
      <div style="
        background:#fff; border-radius:20px; width:100%; max-width:420px;
        box-shadow:0 20px 60px rgba(0,0,0,0.2);
        max-height:calc(100vh - 2rem); overflow-y:auto; -webkit-overflow-scrolling:touch;
        animation:authSlideUp 0.3s ease;
      ">
        <!-- ヘッダー -->
        <div style="padding:1.5rem 1.5rem 1rem; border-bottom:1px solid #e8dfd5; display:flex; align-items:center; justify-content:space-between">
          <div>
            <div style="font-family:'Cormorant Garamond',serif; font-size:1.3rem; color:#2c2824">ログイン / 新規登録</div>
            <div style="font-size:0.72rem; color:#9b9490; margin-top:0.1rem">次回から簡単に注文できます</div>
          </div>
          <button onclick="DeerAuth.closeModal()" style="
            background:none; border:none; cursor:pointer; color:#9b9490;
            padding:0.3rem; border-radius:50%; font-size:1.2rem; line-height:1;
          ">✕</button>
        </div>

        <!-- ソーシャルログイン -->
        <div style="padding:1.5rem">
          <!-- Google -->
          <button id="deerGoogleBtn" onclick="DeerAuth.loginGoogle()" style="
            display:flex; align-items:center; justify-content:center; gap:0.8rem;
            width:100%; padding:0.85rem; margin-bottom:0.7rem;
            border:1.5px solid #e8dfd5; border-radius:10px;
            background:#fff; cursor:pointer; font-size:0.85rem;
            font-family:'Zen Maru Gothic',sans-serif; color:#2c2824;
            transition:border-color 0.2s, background 0.2s;
          " onmouseover="this.style.borderColor='#c4a265';this.style.background='#faf7f2'"
             onmouseout="this.style.borderColor='#e8dfd5';this.style.background='#fff'">
            <svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
            <span id="deerGoogleBtnLabel">Googleでログイン</span>
          </button>

          <!-- Apple (Coming soon: ドメイン設定完了まで無効) -->
          <button disabled aria-disabled="true" title="Coming soon" style="
            display:flex; align-items:center; justify-content:center; gap:0.8rem;
            width:100%; padding:0.85rem; margin-bottom:0.7rem;
            border:1.5px solid #e8dfd5; border-radius:10px;
            background:#bbb; cursor:not-allowed; font-size:0.85rem;
            font-family:'Zen Maru Gothic',sans-serif; color:#fff;
            opacity:0.55; position:relative;
          ">
            <svg width="16" height="16" viewBox="0 0 814 1000" fill="#fff"><path d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-161.1-39.5c-73.8 0-98.8 40.5-166.8 40.5s-107.6-58.6-155.5-127.4C46 432.7 45.1 266.5 218.3 166.2c54.5-31.9 116-48 177.7-48 72.6 0 142.2 29.3 192.3 29.3 48.3 0 124.1-30.6 183.9-28.6z"/></svg>
            Appleでログイン
            <span style="font-size:0.68rem; background:#fff; color:#555; padding:0.1rem 0.45rem; border-radius:6px; margin-left:0.4rem;">Coming soon</span>
          </button>

          <!-- LINE (Coming soon: Channel設定完了まで無効) -->
          <button disabled aria-disabled="true" title="Coming soon" style="
            display:flex; align-items:center; justify-content:center; gap:0.8rem;
            width:100%; padding:0.85rem; margin-bottom:1.2rem;
            border:1.5px solid transparent; border-radius:10px;
            background:#9bd6aa; cursor:not-allowed; font-size:0.85rem;
            font-family:'Zen Maru Gothic',sans-serif; color:#fff;
            opacity:0.6; position:relative;
          ">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="#fff"><path d="M19.365 9.863c.349 0 .63.285.63.631 0 .345-.281.63-.63.63H17.61v1.125h1.755c.349 0 .63.283.63.63 0 .344-.281.629-.63.629h-2.386c-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.63-.63h2.386c.346 0 .627.285.627.63 0 .349-.281.63-.63.63H17.61v1.125h1.755zm-3.855 3.016c0 .27-.174.51-.432.596-.064.021-.133.031-.199.031-.211 0-.391-.09-.51-.25l-2.443-3.317v2.94c0 .344-.279.629-.631.629-.346 0-.626-.285-.626-.629V8.108c0-.27.173-.51.43-.595.06-.023.136-.033.194-.033.195 0 .375.105.495.254l2.462 3.33V8.108c0-.345.282-.63.63-.63.345 0 .63.285.63.63v4.771zm-5.741 0c0 .344-.282.629-.631.629-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.63-.63.346 0 .628.285.628.63v4.771zm-2.466.629H4.917c-.345 0-.63-.285-.63-.629V8.108c0-.345.285-.63.63-.63.348 0 .63.285.63.63v4.141h1.756c.348 0 .629.283.629.63 0 .344-.282.629-.629.629M24 10.314C24 4.943 18.615.572 12 .572S0 4.943 0 10.314c0 4.811 4.27 8.842 10.035 9.608.391.082.923.258 1.058.59.12.301.079.766.038 1.08l-.164 1.02c-.045.301-.24 1.186 1.049.645 1.291-.539 6.916-4.078 9.436-6.975C23.176 14.393 24 12.458 24 10.314"/></svg>
            LINEでログイン
            <span style="font-size:0.68rem; background:#fff; color:#555; padding:0.1rem 0.45rem; border-radius:6px; margin-left:0.4rem;">Coming soon</span>
          </button>

          <!-- 区切り線 -->
          <div style="display:flex; align-items:center; gap:1rem; margin-bottom:1.2rem">
            <div style="flex:1; height:1px; background:#e8dfd5"></div>
            <div style="font-size:0.72rem; color:#9b9490; white-space:nowrap">またはメールアドレスで</div>
            <div style="flex:1; height:1px; background:#e8dfd5"></div>
          </div>

          <!-- メール/パスワード -->
          <div id="authEmailForm">
            <div style="margin-bottom:0.7rem">
              <input type="email" id="authEmail" placeholder="メールアドレス" style="
                width:100%; padding:0.75rem 1rem;
                border:1.5px solid #e8dfd5; border-radius:10px;
                font-family:'Zen Maru Gothic',sans-serif; font-size:0.85rem; color:#2c2824;
                background:#faf7f2; transition:border-color 0.3s;
              " onfocus="this.style.borderColor='#c4a265';this.style.background='#fff'"
                 onblur="this.style.borderColor='#e8dfd5';this.style.background='#faf7f2'">
            </div>
            <div style="margin-bottom:0.5rem; position:relative">
              <input type="password" id="authPassword" placeholder="パスワード（6文字以上）" style="
                width:100%; padding:0.75rem 1rem;
                border:1.5px solid #e8dfd5; border-radius:10px;
                font-family:'Zen Maru Gothic',sans-serif; font-size:0.85rem; color:#2c2824;
                background:#faf7f2; transition:border-color 0.3s;
              " onfocus="this.style.borderColor='#c4a265';this.style.background='#fff'"
                 onblur="this.style.borderColor='#e8dfd5';this.style.background='#faf7f2'">
            </div>
            <!-- 新規登録時のみ表示する名前フィールド -->
            <div id="authNameWrap" style="display:none; margin-bottom:0.7rem">
              <input type="text" id="authDisplayName" placeholder="お名前（例：山田花子）" style="
                width:100%; padding:0.75rem 1rem;
                border:1.5px solid #e8dfd5; border-radius:10px;
                font-family:'Zen Maru Gothic',sans-serif; font-size:0.85rem; color:#2c2824;
                background:#faf7f2; transition:border-color 0.3s;
              " onfocus="this.style.borderColor='#c4a265';this.style.background='#fff'"
                 onblur="this.style.borderColor='#e8dfd5';this.style.background='#faf7f2'">
            </div>
            <div id="authError" style="font-size:0.72rem; color:#c0392b; min-height:1.2rem; margin-bottom:0.5rem; display:none"></div>
            <button onclick="DeerAuth.loginEmail()" id="authLoginBtn" style="
              width:100%; padding:0.85rem;
              background:#2c2824; color:#fff; border:none; border-radius:10px;
              font-family:'Zen Maru Gothic',sans-serif; font-size:0.88rem; font-weight:600;
              cursor:pointer; margin-bottom:0.5rem; transition:opacity 0.3s;
            " onmouseover="this.style.opacity='0.85'" onmouseout="this.style.opacity='1'">
              ログイン
            </button>
            <button onclick="DeerAuth.signupEmail()" id="authSignupBtn" style="
              width:100%; padding:0.85rem;
              background:transparent; color:#2c2824; border:1.5px solid #e8dfd5; border-radius:10px;
              font-family:'Zen Maru Gothic',sans-serif; font-size:0.85rem;
              cursor:pointer; transition:all 0.3s;
            " onmouseover="this.style.borderColor='#c4836a';this.style.color='#c4836a'"
               onmouseout="this.style.borderColor='#e8dfd5';this.style.color='#2c2824'">
              新規登録
            </button>
          </div>

          <!-- 注意書き -->
          <p style="font-size:0.65rem; color:#9b9490; text-align:center; margin-top:1rem; line-height:1.6">
            登録することで<a href="/terms" target="_blank" style="color:#c4a265; text-decoration:underline">利用規約</a>と<a href="/privacy" target="_blank" style="color:#c4a265; text-decoration:underline">プライバシーポリシー</a>に同意したことになります
          </p>
        </div>
      </div>
    </div>
    <style>
      @keyframes authSlideUp {
        from { opacity:0; transform:translateY(20px); }
        to   { opacity:1; transform:translateY(0); }
      }
    </style>
  `;

  // DOMに注入
  document.addEventListener("DOMContentLoaded", () => {
    document.body.insertAdjacentHTML("beforeend", modalHTML);
  });

  // ============================================================
  //  ログアウト確認モーダルHTML
  // ============================================================
  const logoutConfirmHTML = `
    <div id="logoutConfirmOverlay" style="
      display:none; position:fixed; inset:0; z-index:2000;
      background:rgba(44,40,36,0.6); backdrop-filter:blur(4px);
      align-items:center; justify-content:center; padding:1rem;
    ">
      <div style="
        background:#fff; border-radius:20px; width:100%; max-width:360px;
        box-shadow:0 20px 60px rgba(0,0,0,0.2); overflow:hidden;
        animation:authSlideUp 0.3s ease; padding:2rem;
        text-align:center;
      ">
        <div style="font-family:'Cormorant Garamond',serif; font-size:1.2rem; color:#2c2824; margin-bottom:0.6rem">
          ログアウト
        </div>
        <p style="font-size:0.85rem; color:#6b6460; margin-bottom:1.5rem; line-height:1.6">
          ログアウトしますか？
        </p>
        <div style="display:flex; gap:0.8rem; justify-content:center">
          <button id="logoutConfirmNo" style="
            flex:1; padding:0.8rem 1rem;
            background:transparent; color:#2c2824;
            border:1.5px solid #e8dfd5; border-radius:10px;
            font-family:'Zen Maru Gothic',sans-serif; font-size:0.85rem;
            cursor:pointer; transition:all 0.2s;
          " onmouseover="this.style.borderColor='#c4a265'" onmouseout="this.style.borderColor='#e8dfd5'">
            いいえ
          </button>
          <button id="logoutConfirmYes" style="
            flex:1; padding:0.8rem 1rem;
            background:#2c2824; color:#fff;
            border:1.5px solid #2c2824; border-radius:10px;
            font-family:'Zen Maru Gothic',sans-serif; font-size:0.85rem;
            cursor:pointer; transition:opacity 0.2s;
          " onmouseover="this.style.opacity='0.8'" onmouseout="this.style.opacity='1'">
            はい
          </button>
        </div>
      </div>
    </div>
  `;

  // DOMに注入（ログアウト確認モーダル）
  document.addEventListener("DOMContentLoaded", () => {
    document.body.insertAdjacentHTML("beforeend", logoutConfirmHTML);

    // 「いいえ」ボタン
    document.getElementById("logoutConfirmNo").addEventListener("click", () => {
      document.getElementById("logoutConfirmOverlay").style.display = "none";
    });

    // 「はい」ボタン（実際のログアウト処理）
    document
      .getElementById("logoutConfirmYes")
      .addEventListener("click", async () => {
        document.getElementById("logoutConfirmOverlay").style.display = "none";
        if (window._deerFirebaseAuth && _firebaseAuthModule) {
          const { signOut } = _firebaseAuthModule;
          try {
            await signOut(window._deerFirebaseAuth);
          } catch (e) {
            console.error("[DeerAuth] logout error:", e);
          }
        } else if (window._deerFirebaseAuth) {
          try {
            const mod =
              await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js");
            const { signOut } = mod;
            await signOut(window._deerFirebaseAuth);
          } catch (e) {
            console.error("[DeerAuth] logout error:", e);
          }
        }
        updateNavForUser(null);
        if (typeof window.onDeerLogout === "function") {
          window.onDeerLogout();
        }
      });

    // オーバーレイ外クリックで閉じる
    document
      .getElementById("logoutConfirmOverlay")
      .addEventListener("click", (e) => {
        if (e.target === document.getElementById("logoutConfirmOverlay")) {
          document.getElementById("logoutConfirmOverlay").style.display =
            "none";
        }
      });
  });

  // ============================================================
  //  グローバル DeerAuth オブジェクト
  // ============================================================
  window.DeerAuth = {
    openModal() {
      const el = document.getElementById("authModalOverlay");
      if (el) {
        el.style.display = "flex";
        // 名前フィールドと登録モードをリセット
        const nameWrap = document.getElementById("authNameWrap");
        const signupBtn = document.getElementById("authSignupBtn");
        const loginBtn = document.getElementById("authLoginBtn");
        if (nameWrap) nameWrap.style.display = "none";
        if (signupBtn) signupBtn.textContent = "新規登録";
        if (loginBtn) loginBtn.style.display = "";
        const nameInput = document.getElementById("authDisplayName");
        if (nameInput) nameInput.value = "";
        // Google ログインボタンの初期化状態を反映
        this._syncGoogleBtnState();
      }
    },

    // 認証SDK初期化状態を Google ボタンに反映する
    _syncGoogleBtnState() {
      const btn = document.getElementById("deerGoogleBtn");
      const label = document.getElementById("deerGoogleBtnLabel");
      if (!btn) return;
      if (window._deerFirebaseAuth && window._deerAuthReady) {
        btn.disabled = false;
        btn.style.opacity = "";
        btn.style.cursor = "pointer";
        if (label) label.textContent = "Googleでログイン";
      } else {
        btn.disabled = true;
        btn.style.opacity = "0.55";
        btn.style.cursor = "wait";
        if (label) label.textContent = "認証準備中…";
        // ready イベントが来たら自動で有効化
        const onReady = () => {
          window.removeEventListener("deer-auth-ready", onReady);
          this._syncGoogleBtnState();
        };
        window.addEventListener("deer-auth-ready", onReady, { once: true });
      }
    },

    logout() {
      const overlay = document.getElementById("logoutConfirmOverlay");
      if (overlay) {
        overlay.style.display = "flex";
      }
    },
    closeModal() {
      const el = document.getElementById("authModalOverlay");
      if (el) {
        el.style.display = "none";
      }
    },
    showError(msg) {
      const el = document.getElementById("authError");
      if (el) {
        el.textContent = msg;
        el.style.display = "block";
      }
    },
    clearError() {
      const el = document.getElementById("authError");
      if (el) {
        el.style.display = "none";
      }
    },

    // ------ Google ------
    // signInWithPopup 専用。signInWithRedirect は custom.deer.gift と
    // deer-brand.firebaseapp.com の cross-origin 環境で localStorage/IndexedDB が
    // 分断され、ログイン完了後に認証情報が消失する不具合が確認されたため廃止。
    // popup 方式なら Firebase handler を別窓で開き、postMessage で親に結果を返すため
    // cross-origin でも認証情報が正しく親オリジンに保存される。
    loginGoogle() {
      this.clearError();
      // 認証SDKがまだ初期化中なら、deer-auth-ready イベントで再発射する
      if (!window._deerFirebaseAuth) {
        this.showError(
          "認証の初期化中です。数秒待ってから再度お試しください。",
        );
        const onReady = () => {
          window.removeEventListener("deer-auth-ready", onReady);
          this.clearError();
          // 再度クリックせずとも自動で続行（ただし popup はジェスチャーを要求するため
          // ユーザーへ再クリックを促すメッセージのみ表示する）
          this.showError(
            "認証の準備が整いました。もう一度 Googleでログイン を押してください。",
          );
        };
        window.addEventListener("deer-auth-ready", onReady, { once: true });
        return;
      }
      if (!_firebaseAuthModule) {
        // ユーザージェスチャー中に await すると popup がブロックされるため、
        // まず即座に about:blank の popup を開いて握っておき、後からURL差し替え
        const popupRef = window.open(
          "about:blank",
          "_blank",
          "width=480,height=700",
        );
        import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js").then(
          (mod) => {
            _firebaseAuthModule = mod;
            // ここでは popup が使えないので close して signInWithPopup に委任
            try {
              popupRef && popupRef.close();
            } catch (_) {}
            this._doGooglePopup();
          },
        );
        return;
      }
      this._doGooglePopup();
    },
    _doGooglePopup() {
      const { signInWithPopup, GoogleAuthProvider } = _firebaseAuthModule;
      const provider = new GoogleAuthProvider();
      signInWithPopup(window._deerFirebaseAuth, provider)
        .then((result) => {
          this.closeModal();
          this._onLoginSuccess(result.user);
        })
        .catch((e) => {
          if (
            e.code === "auth/popup-blocked" ||
            e.code === "auth/cancelled-popup-request"
          ) {
            this.showError(
              "ポップアップがブロックされました。ブラウザのアドレスバー右側のアイコンから許可してください。",
            );
          } else if (e.code === "auth/popup-closed-by-user") {
            this.showError("ログインがキャンセルされました。");
          } else if (e.code === "auth/unauthorized-domain") {
            this.showError(
              "このドメインは Firebase に許可されていません。管理者に連絡してください。",
            );
          } else {
            this.showError("Googleログインに失敗しました: " + e.message);
          }
        });
    },

    // ------ Apple ------
    loginApple() {
      this.clearError();
      if (!window._deerFirebaseAuth) {
        this.showError(
          "認証の初期化中です。少し待ってから再度お試しください。",
        );
        return;
      }
      // ボタンにローディング表示
      const btn = document.querySelector('button[onclick*="loginApple"]');
      const origText = btn ? btn.innerHTML : "";
      if (btn) btn.innerHTML = "⏳ Apple認証中...";
      // signInWithPopup 方式に統一。cross-origin の localStorage 分断問題を
      // 回避するため signInWithRedirect は使わない。
      // iOS Safari で popup がブロックされたら明示的なエラー表示。
      const doApplePopup = (mod) => {
        const { signInWithPopup, OAuthProvider } = mod;
        const provider = new OAuthProvider("apple.com");
        provider.addScope("email");
        provider.addScope("name");
        signInWithPopup(window._deerFirebaseAuth, provider)
          .then((result) => {
            this.closeModal();
            this._onLoginSuccess(result.user);
          })
          .catch((e) => {
            if (btn) btn.innerHTML = origText;
            const msgs = {
              "auth/operation-not-allowed":
                "Apple Sign Inが有効化されていません。Googleでのログインをお試しください。",
              "auth/invalid-oauth-client-id":
                "Apple認証の設定に問題があります。Googleでのログインをお試しください。",
              "auth/popup-blocked":
                "ポップアップがブロックされました。ブラウザでポップアップを許可するか、Googleログインをお試しください。",
              "auth/popup-closed-by-user": "ログインがキャンセルされました。",
              "auth/cancelled-popup-request": null, // 無視
              "auth/unauthorized-domain":
                "このドメインは Firebase に許可されていません。管理者に連絡してください。",
            };
            const msg = msgs[e.code];
            if (msg) this.showError(msg);
            else if (e.code !== "auth/cancelled-popup-request")
              this.showError(
                "Appleログインに失敗しました。Googleでのログインをお試しください。",
              );
          });
      };
      if (_firebaseAuthModule) {
        doApplePopup(_firebaseAuthModule);
      } else {
        import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js")
          .then((mod) => {
            _firebaseAuthModule = mod;
            doApplePopup(mod);
          })
          .catch(() => {
            if (btn) btn.innerHTML = origText;
            this.showError(
              "読み込みに失敗しました。ページを再読み込みしてお試しください。",
            );
          });
      }
    },

    // ------ LINE ------
    loginLine() {
      // window._deerLineClientId が未設定の場合は firebase-config.js の LINE_CHANNEL_ID をフォールバック
      const lineClientId =
        window._deerLineClientId ||
        window._deerConfig?.lineChannelId ||
        "2009690645";
      if (!lineClientId) {
        this.showError(
          "LINEログインは現在ご利用いただけません。Google またはメールアドレスでログインしてください。",
        );
        return;
      }
      // ボタンにローディング表示
      const btn = document.querySelector('button[onclick*="loginLine"]');
      const origBtnHTML = btn ? btn.innerHTML : "";
      if (btn) btn.innerHTML = "⏳ LINE認証中...";

      const redirectUri = encodeURIComponent(
        window.location.origin + "/api/line-callback",
      );
      const state = Math.random().toString(36).slice(2);
      sessionStorage.setItem("lineOAuthState", state);
      document.cookie = [
        `lineOAuthState=${encodeURIComponent(state)}`,
        "Path=/",
        "Max-Age=600",
        "SameSite=Lax",
        window.location.protocol === "https:" ? "Secure" : "",
      ]
        .filter(Boolean)
        .join("; ");

      // popupで開く（callback側がwindow.opener.postMessageを使うため）
      const popup = window.open(
        `https://access.line.me/oauth2/v2.1/authorize?response_type=code&client_id=${lineClientId}&redirect_uri=${redirectUri}&state=${state}&scope=profile%20openid%20email`,
        "line_auth",
        "width=480,height=640,left=200,top=100",
      );

      if (!popup) {
        // popupブロック時はエラーメッセージ表示
        if (btn) btn.innerHTML = origBtnHTML;
        this.showError(
          "ポップアップがブロックされました。ブラウザの設定でポップアップを許可してください。",
        );
        return;
      }

      // メッセージリスナーをセット（一度だけ）
      const onMessage = (e) => {
        if (e.origin !== window.location.origin) return;
        if (
          !e.data ||
          (e.data.type !== "LINE_AUTH" && e.data.type !== "LINE_AUTH_ERROR")
        )
          return;
        window.removeEventListener("message", onMessage);
        if (btn) btn.innerHTML = origBtnHTML;

        if (e.data.type === "LINE_AUTH_ERROR") {
          this.showError(
            "LINEログインに失敗しました: " + (e.data.message || "不明なエラー"),
          );
          return;
        }

        // カスタムトークンでFirebaseにサインイン
        const doSignIn = (mod) => {
          const { signInWithCustomToken } = mod;
          signInWithCustomToken(window._deerFirebaseAuth, e.data.token)
            .then((result) => {
              this.closeModal();
              this._onLoginSuccess(result.user);
            })
            .catch((err) => {
              this.showError("LINEログインに失敗しました: " + err.message);
            });
        };
        if (_firebaseAuthModule) {
          doSignIn(_firebaseAuthModule);
        } else {
          import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js").then(
            (mod) => {
              _firebaseAuthModule = mod;
              doSignIn(mod);
            },
          );
        }
      };
      window.addEventListener("message", onMessage);

      // popupが閉じられたらリスナー解除
      const checkClosed = setInterval(() => {
        if (popup.closed) {
          clearInterval(checkClosed);
          window.removeEventListener("message", onMessage);
          if (btn) btn.innerHTML = origBtnHTML;
        }
      }, 500);
    },

    // ------ Email Login ------
    loginEmail() {
      this.clearError();
      const email = document.getElementById("authEmail")?.value.trim();
      const password = document.getElementById("authPassword")?.value;
      if (!email || !password) {
        this.showError("メールアドレスとパスワードを入力してください");
        return;
      }
      if (!window._deerFirebaseAuth) {
        alert("Firebase設定が必要です。");
        return;
      }
      const doLogin = (mod) => {
        const { signInWithEmailAndPassword } = mod;
        signInWithEmailAndPassword(window._deerFirebaseAuth, email, password)
          .then((result) => {
            this.closeModal();
            this._onLoginSuccess(result.user);
          })
          .catch((e) => {
            const msgs = {
              "auth/user-not-found": "このメールアドレスは登録されていません",
              "auth/wrong-password": "パスワードが正しくありません",
              "auth/invalid-credential":
                "メールアドレスまたはパスワードが正しくありません",
              "auth/invalid-email": "メールアドレスの形式が正しくありません",
              "auth/too-many-requests": "しばらく後に再試行してください",
            };
            this.showError(msgs[e.code] || "ログインに失敗しました");
          });
      };
      if (_firebaseAuthModule) {
        doLogin(_firebaseAuthModule);
      } else {
        import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js").then(
          (mod) => {
            _firebaseAuthModule = mod;
            doLogin(mod);
          },
        );
      }
    },

    // ------ Email Signup ------
    signupEmail() {
      this.clearError();

      // 名前フィールドが非表示なら、まず表示して登録モードに切り替える
      const nameWrap = document.getElementById("authNameWrap");
      const signupBtn = document.getElementById("authSignupBtn");
      const loginBtn = document.getElementById("authLoginBtn");
      if (nameWrap && nameWrap.style.display === "none") {
        nameWrap.style.display = "block";
        if (signupBtn) signupBtn.textContent = "アカウントを作成する";
        if (loginBtn) loginBtn.style.display = "none";
        document.getElementById("authDisplayName")?.focus();
        return;
      }

      const email = document.getElementById("authEmail")?.value.trim();
      const password = document.getElementById("authPassword")?.value;
      const displayName =
        document.getElementById("authDisplayName")?.value.trim() || "";
      if (!email || !password) {
        this.showError("メールアドレスとパスワードを入力してください");
        return;
      }
      if (password.length < 6) {
        this.showError("パスワードは6文字以上にしてください");
        return;
      }
      if (!window._deerFirebaseAuth) {
        alert("Firebase設定が必要です。");
        return;
      }
      const doSignup = (mod) => {
        const { createUserWithEmailAndPassword, updateProfile } = mod;
        createUserWithEmailAndPassword(
          window._deerFirebaseAuth,
          email,
          password,
        )
          .then(async (result) => {
            // displayNameを設定
            if (displayName) {
              await updateProfile(result.user, { displayName }).catch(() => {});
            }
            this.closeModal();
            this._onLoginSuccess(result.user);
            this._giveWelcomeCoupon(result.user.uid);
          })
          .catch((e) => {
            const msgs = {
              "auth/email-already-in-use":
                "このメールアドレスはすでに登録済みです",
              "auth/invalid-email": "メールアドレスの形式が正しくありません",
              "auth/weak-password": "パスワードが弱すぎます（6文字以上）",
            };
            this.showError(msgs[e.code] || "登録に失敗しました");
          });
      };
      if (_firebaseAuthModule) {
        doSignup(_firebaseAuthModule);
      } else {
        import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js").then(
          (mod) => {
            _firebaseAuthModule = mod;
            doSignup(mod);
          },
        );
      }
    },

    // ------ ログイン成功後処理 ------
    _onLoginSuccess(user) {
      // ナビ更新
      updateNavForUser(user);
      // ページ固有コールバックがあれば実行
      if (typeof window.onDeerLogin === "function") {
        window.onDeerLogin(user);
      }
    },

    // ------ 新規登録ウェルカムクーポン付与 ------
    async _giveWelcomeCoupon(uid) {
      try {
        const db = window._deerFirebaseDb;
        if (!db) {
          console.warn(
            "[DeerAuth] Firestore (window._deerFirebaseDb) が未設定です。ウェルカムクーポンを付与できません。",
          );
          return;
        }
        const { doc, setDoc, getDoc, arrayUnion } =
          await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");

        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 30);

        const coupon = {
          code: "WELCOME500",
          discount: 500,
          type: "fixed",
          description: "新規登録特典クーポン",
          expiresAt: expiresAt.toISOString(),
        };

        const userRef = doc(db, "users", uid);
        await setDoc(
          userRef,
          { availableCoupons: arrayUnion(coupon) },
          { merge: true },
        );
        console.log("[DeerAuth] ウェルカムクーポンを付与しました:", uid);
      } catch (e) {
        console.error("[DeerAuth] ウェルカムクーポン付与エラー:", e);
      }
    },
  };

  // モーダル外クリックで閉じる
  document.addEventListener("click", (e) => {
    const overlay = document.getElementById("authModalOverlay");
    if (e.target === overlay) DeerAuth.closeModal();
  });

  // ============================================================
  //  ナビ更新（ログイン状態に応じてボタン切り替え）
  // ============================================================
  function updateNavForUser(user) {
    const loginBtn = document.getElementById("navLoginBtn");
    const accountBtn = document.getElementById("navAccountBtn");
    if (!loginBtn || !accountBtn) return;

    if (user) {
      loginBtn.style.display = "none";
      accountBtn.style.display = "flex";
      const nameEl = document.getElementById("navUserName");
      if (nameEl)
        nameEl.textContent = user.displayName?.split(" ")[0] || "マイページ";
      const avatarEl = document.getElementById("navUserAvatar");
      if (avatarEl && user.photoURL) avatarEl.src = user.photoURL;
    } else {
      loginBtn.style.display = "flex";
      accountBtn.style.display = "none";
    }
  }

  // auth-config.js など外部から呼べるようにグローバルに公開
  window.updateNavForUser = updateNavForUser;

  // Firebaseモジュールをページ読み込み時に先読み（ボタンクリック時にawait importが不要になりジェスチャーチェーン保持）
  let _firebaseAuthModule = null;
  window._deerAuthReady = false;

  window.addEventListener("load", async () => {
    // module scriptのasync initが完了するまで最大5秒待つ
    let elapsed = 0;
    while (!window._deerFirebaseAuth && elapsed < 5000) {
      await new Promise((r) => setTimeout(r, 100));
      elapsed += 100;
    }
    if (!window._deerFirebaseAuth) return;
    try {
      // ★ 先読み：クリック前にimport完了させておく
      _firebaseAuthModule =
        await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js");
      const { onAuthStateChanged, getRedirectResult } = _firebaseAuthModule;

      // リダイレクト結果を無条件で処理（iOS SafariはsessionStorageを消すためフラグ不要）
      try {
        const result = await getRedirectResult(window._deerFirebaseAuth);
        if (result && result.user) {
          updateNavForUser(result.user);
          if (typeof window.onDeerLogin === "function") {
            window.onDeerLogin(result.user);
          }
        }
      } catch (e) {
        console.warn("[DeerAuth] getRedirectResult error:", e.message);
      }

      onAuthStateChanged(window._deerFirebaseAuth, (user) => {
        updateNavForUser(user);
        if (typeof window.onDeerAuthReady === "function") {
          window.onDeerAuthReady(user);
        }
      });
    } catch (e) {
      /* Firebase未設定 */
    }
  });
})();

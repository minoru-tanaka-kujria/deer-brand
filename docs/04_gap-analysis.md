# Deer Brand — ギャップ分析（バグ・問題点一覧）

> 更新日: 2026-04-04 | 調査対象: 全ページ（デスクトップ・モバイル実機テスト済み）

---

## テスト結果サマリー（2026-04-04 実施）

### テスト範囲
- デスクトップ(1280px): 全8画面 ✅
- モバイル(375px): 全8画面 ✅
- コンソールエラー: 全ページ0件 ✅
- 注文フロー: Step1〜Step7まで動作確認 ✅
- 背景選択: 全5種類(フラット/星空/ボタニカル/幾何学/グラデ)サムネ表示OK ✅

### 今回テストで発見・修正済み

| # | 内容 | 修正 |
|---|------|------|
| 11 | index.html モバイル「スタイルを見る」ボタンが2行に折れる | `white-space: nowrap` 追加 ✅ |
| 12 | index.html フッターCTA「愛犬を、アートにしよう」が不自然な行折れ | `<br>` で制御 ✅ |

---

## 問題点サマリー（全件）

| # | カテゴリ | 重要度 | 状態 | 内容 | 対象ファイル |
|---|---------|-------|------|------|------------|
| 1 | バグ | 高 | ✅修正済 | shippingAddressのemail trim()漏れ | upload.html |
| 2 | バグ | 高 | ✅修正済 | step-shippingフォームバリデーション（実装確認済） | upload.html |
| 3 | バグ | 高 | ✅修正済 | account.html住所のfullName参照 | account.html |
| 4 | バグ | 高 | ✅修正済 | 注文履歴に注文日(createdAt)が表示されない | account.html |
| 5 | バグ | 高 | ✅修正済 | FREE-ORDER時にStripe検証が失敗する | api/create-order.js |
| 6 | バグ | 中 | 🔄未修正 | ログアウトに確認なし | account.html |
| 7 | 機能不足 | 中 | ✅修正済 | マイページ「住所を追加」ボタンなし | account.html |
| 8 | 機能不足 | 中 | ✅修正済 | マイページ「デフォルトに設定」ボタンなし | account.html |
| 9 | セキュリティ | 中 | ✅OK | Firestoreルール（Admin SDK経由は正しい） | api/create-order.js |
| 10 | UX | 低 | 🔄未修正 | deleteAddress後にlocation.reload() | account.html |
| 11 | UX | 低 | ✅修正済 | モバイル「スタイルを見る」2行折れ | index.html |
| 12 | UX | 低 | ✅修正済 | フッターCTAの不自然な行折れ | index.html |

---

## 詳細説明と修正コードサンプル

---

### #1 【バグ・高】 shippingAddressにemailフィールドが含まれていない

**発生箇所:** `upload.html` の `completeOrder()` 関数（行 5229〜5237）

**現状の問題:**

`api/create-order.js` のメール送信処理（行 190）では `shippingAddress?.email` を参照している。
emailフィールドが欠落または空の場合、注文確認メールが送信されない。

**コードレビュー結果:**
現状の実装では `email` フィールドはすでに `shippingAddress` に含まれているが（行 5231）、
`?.value` のみで `trim()` が適用されていないため、空白のみの入力が通過するリスクがある。
また、STEP11バリデーション（issue #2）が不完全な場合、空emailで進んだ際にメールが届かない。

**修正コード（completeOrder内の防御的処理）:**
```javascript
async function completeOrder(paymentIntentId) {
  // メールアドレスを確実に取得（trim()を明示）
  const emailValue = document.getElementById("email")?.value?.trim() || "";

  const shippingAddress = {
    fullName: document.getElementById("fullName")?.value?.trim() || "",
    email: emailValue,  // trim()を明示的に適用
    phone: document.getElementById("phone")?.value?.trim() || "",
    zip: document.getElementById("zip")?.value?.trim() || "",
    prefecture: document.getElementById("prefecture")?.value?.trim() || "",
    address1: document.getElementById("address1")?.value?.trim() || "",
    address2: document.getElementById("address2")?.value?.trim() || "",
  };
  // ... 以下続く
}
```

---

### #2 【バグ・高】 step-shippingフォームにバリデーションなし

**発生箇所:** `upload.html` の btnShippingNext イベントリスナー（行 4953〜5000付近）

**コードレビュー結果:**
実際にはバリデーションコードが実装されていることを確認した（行 4956〜5000）。
以下のフィールドが検証されている:
- fullName, email, phone, zip, prefecture, address1（必須チェック）
- メールアドレス形式チェック（RFC形式）
- 電話番号形式チェック（数字とハイフンのみ）
- 郵便番号形式チェック（7桁または XXX-XXXX）

**実際の問題:**
エラー時に枠を赤くするだけで、フィールド下部にエラーメッセージ文字列が表示されない。
何が間違っているかユーザーが分かりにくい（特にアラートを閉じた後）。

**改善提案（フィールド下部エラーメッセージ表示の追加）:**
```javascript
document.getElementById("btnShippingNext").addEventListener("click", () => {
  const validations = [
    { id: "fullName", label: "お名前" },
    { id: "email", label: "メールアドレス" },
    { id: "phone", label: "電話番号" },
    { id: "zip", label: "郵便番号" },
    { id: "prefecture", label: "都道府県" },
    { id: "address1", label: "住所" },
  ];

  let valid = true;
  validations.forEach(({ id, label }) => {
    const el = document.getElementById(id);
    const errEl = document.getElementById(`${id}-error`);
    if (!el.value.trim()) {
      el.style.borderColor = "var(--red)";
      if (errEl) errEl.textContent = `${label}を入力してください`;
      valid = false;
    } else {
      el.style.borderColor = "";
      if (errEl) errEl.textContent = "";
    }
  });

  if (!valid) return;
  // ... 以下、既存のemail/phone/zipフォーマットチェック
});
```

**HTMLに追加すべきエラー表示要素の例:**
```html
<div class="form-group">
  <label>お名前 <span class="required">*</span></label>
  <input type="text" id="fullName" placeholder="山田 太郎" />
  <div class="field-error" id="fullName-error"
       style="color:var(--red);font-size:0.75rem;margin-top:0.25rem;min-height:1rem;"></div>
</div>
```

---

### #3 【バグ・高】 住所表示でlastName/firstNameを参照するがfullNameのみ保存

**発生箇所:** `account.html` の `renderAccountPage()` 関数（行 718）

**現状のコード:**
```javascript
// account.html 行 718
${escHtml(a.lastName)} ${escHtml(a.firstName)}<br>
```

**問題:**
`api/create-order.js` でFirestoreに保存するshippingAddressは `fullName` フィールドを使用しており、
`lastName` や `firstName` は存在しない。
そのため、マイページの住所一覧で氏名が空白表示になる。

**create-order.jsでの保存構造（行 5229〜5237）:**
```javascript
const shippingAddress = {
  fullName: document.getElementById("fullName")?.value || "",  // ← fullNameで保存
  // lastNameやfirstNameは存在しない
};
```

**修正コード:**
```javascript
// account.html 行 718 を修正

// 変更前:
${escHtml(a.lastName)} ${escHtml(a.firstName)}<br>

// 変更後:
${escHtml(a.fullName || `${a.lastName || ''} ${a.firstName || ''}`.trim())}<br>
```

この修正により:
1. `fullName` がある場合（現行の保存形式）はそのまま表示
2. `lastName`/`firstName` がある旧形式データがあればフォールバック対応

---

### #4 【バグ・高】 注文履歴に注文日(createdAt)が表示されない

**発生箇所:** `account.html` の `renderAccountPage()` 内、注文履歴レンダリング部分（行 820〜828）

**現状のコード:**
```javascript
<div class="order-item">
  <div class="order-header">
    <div class="order-id">${escHtml(o.orderId)}</div>
    <span class="order-status ${escHtml(o.status || "pending")}">${statusLabel}</span>
  </div>
  <div class="order-product">${escHtml(productName)}</div>
  <div class="order-detail">...</div>
  <div class="order-price">¥${Number(o.total || 0).toLocaleString()}</div>
  <!-- createdAtが表示されていない -->
</div>
```

**Firestoreの `createdAt` フィールド:** Timestampオブジェクトとして保存されている。

**修正コード:**
```javascript
// 注文日フォーマット用ヘルパー関数を追加
function formatOrderDate(createdAt) {
  if (!createdAt) return "";
  try {
    const date = createdAt.toDate ? createdAt.toDate() : new Date(createdAt);
    return date.toLocaleDateString("ja-JP", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch (e) {
    return "";
  }
}

// 注文アイテムのHTML（修正後 — order-dateを追加）
<div class="order-item">
  <div class="order-header">
    <div class="order-id">${escHtml(o.orderId)}</div>
    <span class="order-status ${escHtml(o.status || "pending")}">${statusLabel}</span>
  </div>
  <div class="order-product">${escHtml(productName)}</div>
  <div class="order-detail">...</div>
  <div class="order-date" style="font-size:0.72rem;color:var(--text-mid);margin-top:0.2rem;">
    ${formatOrderDate(o.createdAt)}
  </div>
  <div class="order-price">¥${Number(o.total || 0).toLocaleString()}</div>
</div>
```

---

### #5 【バグ・高】 FREE-ORDER時にStripe PaymentIntentのretrieveが失敗する

**発生箇所:** `api/create-order.js`（行 98〜110）

**現状のコード:**
```javascript
// api/create-order.js 行 98〜110
let paymentIntent;
try {
  paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
} catch (stripeErr) {
  console.error("[create-order] PaymentIntent取得失敗:", stripeErr.message);
  return res.status(400).json({ error: "PaymentIntentの取得に失敗しました" });
}
if (paymentIntent.status !== "succeeded") {
  return res.status(400).json({
    error: `決済が完了していません (status: ${paymentIntent.status})`,
  });
}
```

**問題の根本原因:**
- `upload.html` の `completeOrder()` は合計¥0の場合 `paymentIntentId = "FREE-ORDER"` で呼び出す（行 5156）
- `api/create-order.js` は無条件でStripeの `paymentIntents.retrieve("FREE-ORDER")` を実行する
- "FREE-ORDER"はStripeの有効なIDではないため、Stripeが例外をスローして400エラーが返る
- 結果: **無料注文が完全に機能しない**

**修正コード:**
```javascript
// api/create-order.js 修正版
// PaymentIntentの有効性検証（FREE-ORDERはスキップ）
if (paymentIntentId !== "FREE-ORDER") {
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    return res.status(500).json({ error: "決済サービスの設定エラーです" });
  }
  const stripe = new Stripe(stripeSecretKey, { apiVersion: "2024-04-10" });
  let paymentIntent;
  try {
    paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  } catch (stripeErr) {
    console.error("[create-order] PaymentIntent取得失敗:", stripeErr.message);
    return res.status(400).json({ error: "PaymentIntentの取得に失敗しました" });
  }
  if (paymentIntent.status !== "succeeded") {
    return res.status(400).json({
      error: `決済が完了していません (status: ${paymentIntent.status})`,
    });
  }
} else {
  // FREE-ORDER: totalが0であることをサーバーサイドでも検証
  if (total !== 0) {
    return res.status(400).json({
      error: "FREE-ORDERは合計金額が0の場合のみ使用できます",
    });
  }
  console.log("[create-order] FREE-ORDER: Stripe検証をスキップします");
}
```

---

### #6 【バグ・中】 ログアウトボタンがDeerAuth.logout()を使わず確認なしでサインアウト

**発生箇所:** `account.html`（行 842〜847）

**現状のコード:**
```javascript
document
  .getElementById("logoutBtn")
  .addEventListener("click", async () => {
    await signOut(auth);
    window.location.href = "index";
  });
```

**問題:**
- 確認ダイアログなしで即座にログアウトする
- `DeerAuth.logout()` が実装されている場合、その確認モーダルが利用されない
- ユーザーが誤ってログアウトボタンをタップするリスクがある（特にモバイル）

**修正コード:**
```javascript
document
  .getElementById("logoutBtn")
  .addEventListener("click", async () => {
    // DeerAuth.logout()が利用可能な場合はそちらを優先（確認モーダル付き）
    if (typeof DeerAuth !== "undefined" && typeof DeerAuth.logout === "function") {
      DeerAuth.logout();
      return;
    }
    // フォールバック: 確認ダイアログ付きのログアウト
    if (!confirm("ログアウトしますか？")) return;
    await signOut(auth);
    window.location.href = "index";
  });
```

---

### #7 【機能不足・中】 マイページに「住所を追加」ボタンがない

**発生箇所:** `account.html` の住所セクション（行 701〜733）

**現状の動作:**
注文時のshippingAddressが `api/create-order.js` によって自動保存されるのみ。
マイページから直接住所を追加する手段がない。

**追加すべきUI（住所セクションヘッダー）:**
```html
<div class="section-card-header">
  <svg width="18" height="18" ...>...</svg>
  <h2>お届け先住所</h2>
  <button class="add-address-btn" onclick="openAddAddressModal()"
          style="margin-left:auto;font-size:0.75rem;padding:0.3rem 0.75rem;background:var(--gold);color:#fff;border:none;border-radius:6px;cursor:pointer">
    + 追加
  </button>
</div>
```

**追加すべきJavaScript（openAddAddressModal・saveNewAddress関数）:**
```javascript
window.openAddAddressModal = () => {
  const modal = document.createElement("div");
  modal.id = "addAddressModal";
  modal.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:1rem";
  modal.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:2rem;max-width:480px;width:100%;max-height:90vh;overflow-y:auto;">
      <h3 style="margin-bottom:1.5rem;font-family:var(--serif)">住所を追加</h3>
      <label style="font-size:0.8rem">お名前 *</label>
      <input id="addAddr-fullName" type="text" placeholder="山田 太郎"
             style="width:100%;padding:0.6rem;border:1px solid var(--border);border-radius:6px;font-size:0.9rem;margin-bottom:1rem">
      <label style="font-size:0.8rem">郵便番号 *</label>
      <input id="addAddr-zip" type="text" placeholder="150-0001"
             style="width:100%;padding:0.6rem;border:1px solid var(--border);border-radius:6px;font-size:0.9rem;margin-bottom:1rem">
      <label style="font-size:0.8rem">都道府県 *</label>
      <input id="addAddr-prefecture" type="text" placeholder="東京都"
             style="width:100%;padding:0.6rem;border:1px solid var(--border);border-radius:6px;font-size:0.9rem;margin-bottom:1rem">
      <label style="font-size:0.8rem">住所1 *</label>
      <input id="addAddr-address1" type="text" placeholder="渋谷区神宮前1-1-1"
             style="width:100%;padding:0.6rem;border:1px solid var(--border);border-radius:6px;font-size:0.9rem;margin-bottom:1rem">
      <label style="font-size:0.8rem">住所2（任意）</label>
      <input id="addAddr-address2" type="text" placeholder="○○マンション101"
             style="width:100%;padding:0.6rem;border:1px solid var(--border);border-radius:6px;font-size:0.9rem;margin-bottom:1.5rem">
      <div style="display:flex;gap:0.75rem">
        <button onclick="document.getElementById('addAddressModal').remove()"
                style="flex:1;padding:0.75rem;border:1px solid var(--border);background:#fff;border-radius:8px;cursor:pointer">キャンセル</button>
        <button onclick="saveNewAddress()"
                style="flex:2;padding:0.75rem;background:var(--gold);color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600">保存する</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
};

window.saveNewAddress = async () => {
  const user = auth.currentUser;
  if (!user) return;

  const newAddress = {
    fullName: document.getElementById("addAddr-fullName").value.trim(),
    zip: document.getElementById("addAddr-zip").value.trim(),
    prefecture: document.getElementById("addAddr-prefecture").value.trim(),
    address1: document.getElementById("addAddr-address1").value.trim(),
    address2: document.getElementById("addAddr-address2").value.trim(),
  };

  if (!newAddress.fullName || !newAddress.zip || !newAddress.prefecture || !newAddress.address1) {
    showToast("必須項目を入力してください", "error");
    return;
  }

  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    const existing = snap.exists() ? snap.data().savedAddresses || [] : [];
    const newAddresses = [newAddress, ...existing].slice(0, 5);
    await updateDoc(doc(db, "users", user.uid), { savedAddresses: newAddresses });
    document.getElementById("addAddressModal")?.remove();
    showToast("住所を追加しました", "success");
    setTimeout(() => location.reload(), 800);
  } catch (e) {
    showToast("住所の追加に失敗しました", "error");
  }
};
```

---

### #8 【機能不足・中】 マイページに「デフォルトに設定」ボタンがない

**発生箇所:** `account.html` の住所アイテムレンダリング部分（行 713〜728）

**現状の動作:**
`savedAddresses[0]`（配列の先頭）が自動的に「デフォルト」バッジ付きで表示されるが、
ユーザーが任意の住所をデフォルトに変更する方法がない。

**追加すべきUI（住所アイテム内の address-actions に追加）:**
```javascript
<div class="address-actions">
  ${i !== 0 ? `
    <button class="icon-btn" title="デフォルトに設定"
            onclick="setDefaultAddress('${user.uid}', ${i})"
            style="font-size:0.7rem;padding:0.25rem 0.5rem;white-space:nowrap;border:1px solid var(--gold);color:var(--gold);border-radius:4px;background:#fff;cursor:pointer">
      デフォルト
    </button>` : ""}
  <button class="icon-btn" title="削除" onclick="deleteAddress('${user.uid}', ${i})">
    <svg ...>...</svg>
  </button>
</div>
```

**追加すべきJavaScript（setDefaultAddress関数）:**
```javascript
window.setDefaultAddress = async (uid, idx) => {
  try {
    const snap = await getDoc(doc(db, "users", uid));
    if (!snap.exists()) return;
    const addresses = snap.data().savedAddresses || [];
    if (idx < 0 || idx >= addresses.length) return;

    // 選択した住所を先頭に移動（配列の順序変更でデフォルトを設定）
    const target = addresses[idx];
    const newAddresses = [
      target,
      ...addresses.filter((_, i) => i !== idx),
    ];

    await updateDoc(doc(db, "users", uid), { savedAddresses: newAddresses });
    showToast("デフォルト住所を変更しました", "success");
    setTimeout(() => location.reload(), 800);
  } catch (e) {
    showToast("デフォルト住所の変更に失敗しました", "error");
  }
};
```

---

### #9 【セキュリティ・中】 Firestoreセキュリティルール — savedAddresses保存の整合性確認

**発生箇所:** `api/create-order.js`（行 168〜184）、`firestore.rules`

**確認結果: 現状維持（OK）**

`savedAddresses` の保存は `api/create-order.js`（Firebase Admin SDK）経由で実行されており、
セキュリティルールをバイパスする形で正しく動作している。

**現状の実装が正しい理由:**
- Firebase Admin SDKはセキュリティルールを適用されないため、サーバーサイドから安全に書き込める
- Firestoreルールでクライアントからの直接書き込みを制限している前提では正しい構成

**ただし以下の点を確認推奨:**
```
// firestore.rules で以下が設定されていることを確認
match /users/{uid} {
  allow read: if request.auth.uid == uid;
  allow write: if false; // Admin SDKのみ書き込み可
}
```

**潜在的なリスク:**
- `account.html` の `deleteAddress` 関数（行 977）はクライアントSDKの `updateDoc` を使用している
- Firestoreルールが `request.auth.uid == uid` の条件なしになっている場合、
  他ユーザーの住所を改ざんできるリスクがある
- ルールを `allow write: if request.auth.uid == uid;` に設定することを推奨

---

### #10 【UX・低】 deleteAddress後にlocation.reload()でページ全体リロード

**発生箇所:** `account.html`（行 980〜982）

**現状のコード:**
```javascript
showToast("住所を削除しました", "success");
// ページをリロードして表示を更新
setTimeout(() => location.reload(), 800);
```

**問題:**
- ページ全体がリロードされるため、スクロール位置がトップに戻る
- 削除操作のたびにFirestoreへの全データ再取得が発生する
- ユーザー体験が損なわれる（特に住所が下部にある場合）

**修正コード（データ再取得 + 再描画方式）:**
```javascript
window.deleteAddress = async (uid, idx) => {
  if (!confirm("この住所を削除しますか？")) return;
  try {
    const snap = await getDoc(doc(db, "users", uid));
    if (!snap.exists()) return;
    const addresses = snap.data().savedAddresses || [];
    const target = addresses[idx];
    if (!target) return;
    await updateDoc(doc(db, "users", uid), {
      savedAddresses: arrayRemove(target),
    });
    showToast("住所を削除しました", "success");

    // ページリロードの代わりにデータ再取得して再描画
    const user = auth.currentUser;
    if (!user) return;

    const updatedSnap = await getDoc(doc(db, "users", user.uid)).catch(() => null);
    const updatedData = updatedSnap?.exists() ? updatedSnap.data() : {};

    // 注文履歴も再取得して完全な状態で再描画
    try {
      const ordersQ = query(
        collection(db, "orders"),
        where("userId", "==", user.uid),
        orderBy("createdAt", "desc"),
        limit(20)
      );
      const ordersSnap = await getDocs(ordersQ);
      updatedData._resolvedOrders = ordersSnap.docs.map((d) => d.data());
    } catch (e) {
      updatedData._resolvedOrders = [];
    }

    renderAccountPage(user, updatedData);
  } catch (e) {
    showToast("住所の削除に失敗しました", "error");
  }
};
```

---

## 修正優先度ロードマップ

### フェーズ1 — 緊急（リリースブロック）

| # | バグ | 影響 |
|---|-----|------|
| 5 | FREE-ORDER時のStripe検証失敗 | 無料注文が完全に機能しない |
| 3 | 住所の氏名が空表示 | 全ユーザーの住所一覧で氏名が表示されない |
| 4 | 注文日が表示されない | 注文履歴の視認性が著しく低い |

### フェーズ2 — 近日中（1週間以内）

| # | バグ | 影響 |
|---|-----|------|
| 1 | shippingAddressのtrim()漏れ | メール未送信リスク |
| 2 | バリデーションエラーメッセージ未表示 | ユーザーがエラー箇所を特定しにくい |
| 6 | ログアウト確認なし | 誤タップによるUX低下 |

### フェーズ3 — 通常（2〜4週間以内）

| # | 内容 | 分類 |
|---|-----|------|
| 7 | 住所追加UI | 機能追加 |
| 8 | デフォルト住所変更UI | 機能追加 |
| 10 | deleteAddress後の再描画 | UX改善 |

### フェーズ4 — 継続改善

| # | 内容 | 分類 |
|---|-----|------|
| 9 | Firestoreルール見直し（deleteAddressのクライアント書き込み権限） | セキュリティ強化 |

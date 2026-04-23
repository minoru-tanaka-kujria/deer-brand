/**
 * data: URL のアート画像 (フレーム合成結果等) を Firebase Storage に
 * アップロードして公開 https URL を返すヘルパー。
 *
 * 経緯:
 *   ブラウザ canvas で art + frame を合成した結果は data:image/png;base64,... URL。
 *   Printful や Stripe 等の外部サービスは public URL を要求するため、合成結果を
 *   そのまま渡せない。create-order.js / stripe-payment-intent.js 等で data: URL を
 *   受け取ったら、このヘルパーでアップロードして https URL を取得する。
 *
 * 保存先:
 *   art-composites/{uid}/{orderId or timestamp}.png
 *   Firebase Storage の公開ダウンロード URL を返す。
 */

import { getStorage } from "firebase-admin/storage";
import { getAdminApp } from "./auth.js";

/**
 * @param {string} dataUrl - "data:image/png;base64,..." 形式
 * @param {object} opts
 * @param {string} opts.uid - ユーザー UID (path に含める)
 * @param {string} [opts.orderId] - 注文 ID (無ければタイムスタンプ)
 * @returns {Promise<string|null>} 公開 https URL、失敗時 null
 */
export async function uploadDataUrlToStorage(dataUrl, { uid, orderId } = {}) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return null;
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  const contentType = m[1];
  const base64 = m[2];
  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length) return null;
  const ext = contentType === "image/jpeg" ? "jpg" : "png";
  const id = orderId || String(Date.now());
  const objectName = `art-composites/${uid || "anon"}/${id}.${ext}`;

  try {
    const bucket = getStorage(getAdminApp()).bucket();
    const file = bucket.file(objectName);
    await file.save(buffer, {
      contentType,
      resumable: false,
      validation: "md5",
      metadata: { cacheControl: "public, max-age=31536000" },
    });

    // 公開 URL 化 (ACL 経由)。Uniform bucket-level access が有効なバケットでは
    // makePublic() が失敗するため、その場合は長期 signed URL を返す。
    let madePublic = false;
    try {
      await file.makePublic();
      madePublic = true;
    } catch (aclErr) {
      console.warn(
        "[art-upload] makePublic failed, will fall back to signed URL:",
        aclErr?.message || aclErr,
      );
    }

    if (madePublic) {
      return `https://storage.googleapis.com/${bucket.name}/${encodeURI(objectName)}`;
    }

    // Signed URL フォールバック (7日間有効)。Printful は短期間ダウンロードするため十分。
    try {
      const [signedUrl] = await file.getSignedUrl({
        action: "read",
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
      });
      return signedUrl;
    } catch (signErr) {
      console.error(
        "[art-upload] getSignedUrl failed:",
        signErr?.message || signErr,
      );
      throw new Error("ART_UPLOAD_URL_UNAVAILABLE");
    }
  } catch (err) {
    console.error("[art-upload] upload failed:", err?.message || err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

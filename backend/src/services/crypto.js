/**
 * Tiện ích bảo vệ dữ liệu:
 *  - Mã hoá trường nhạy cảm (AES-256-GCM) trước khi lưu MongoDB
 *  - Che dữ liệu để hiển thị (0912***678)
 *  - Mã xác thực 2 lớp TOTP (RFC 6238 — tương thích Google Authenticator,
 *    Microsoft Authenticator, Authy...) viết bằng thư viện crypto có sẵn
 *    của Node, không cần cài thêm gói.
 *
 * Khoá mã hoá: DATA_ENCRYPTION_KEY = 64 ký tự hex (32 byte). Tạo bằng:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 * MẤT KHOÁ = MẤT DỮ LIỆU đã mã hoá. Lưu khoá ở Render Environment + một
 * nơi an toàn khác (trình quản lý mật khẩu). KHÔNG lưu cùng chỗ với database.
 */
const crypto = require("crypto");

const PREFIX = "enc:v1:";
let cachedKey = null;

function isProduction() {
  return process.env.NODE_ENV === "production" || process.env.RENDER === "true";
}

function getKey() {
  if (cachedKey) return cachedKey;
  const hex = (process.env.DATA_ENCRYPTION_KEY || "").trim();
  if (/^[0-9a-fA-F]{64}$/.test(hex)) {
    cachedKey = Buffer.from(hex, "hex");
    return cachedKey;
  }
  if (isProduction()) {
    throw new Error("Thiếu hoặc sai DATA_ENCRYPTION_KEY (cần 64 ký tự hex) — không thể mã hoá dữ liệu cá nhân.");
  }
  console.warn("⚠ Chưa có DATA_ENCRYPTION_KEY — dùng khoá suy ra từ JWT_SECRET (CHỈ chấp nhận khi chạy local).");
  cachedKey = crypto.createHash("sha256").update("data-key:" + (process.env.JWT_SECRET || "")).digest();
  return cachedKey;
}

function isEncrypted(value) {
  return typeof value === "string" && value.startsWith(PREFIX);
}

function encrypt(plain) {
  if (plain === undefined || plain === null || plain === "") return "";
  if (isEncrypted(plain)) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

/** Giải mã; giá trị chưa mã hoá (dữ liệu cũ) trả về nguyên trạng */
function decrypt(value) {
  if (!isEncrypted(value)) return value || "";
  const raw = Buffer.from(value.slice(PREFIX.length), "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

// ---------------------------------------------------------------------
// Che dữ liệu để hiển thị
// ---------------------------------------------------------------------

function maskPhone(phone) {
  const d = String(phone || "").replace(/[^0-9+]/g, "");
  if (d.length < 7) return "***";
  return `${d.slice(0, 4)}***${d.slice(-3)}`;
}

function maskName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "***";
  // "Nguyễn Văn An" → "Nguyễn V. A."
  return [parts[0], ...parts.slice(1).map((p) => p[0].toUpperCase() + ".")].join(" ");
}

function maskAddress(address) {
  const parts = String(address || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return "***";
  // Chỉ giữ tỉnh/thành (phần cuối) — "…, Hà Nội"
  return parts.length > 1 ? `…, ${parts[parts.length - 1]}` : "…";
}

// ---------------------------------------------------------------------
// TOTP (RFC 6238) + Base32 (RFC 4648)
// ---------------------------------------------------------------------

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/=+$|\s/g, "");
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("Base32 không hợp lệ");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secretB32, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", base32Decode(secretB32)).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1_000_000).padStart(6, "0");
}

function totpStep(nowMs = Date.now()) {
  return Math.floor(nowMs / 1000 / 30);
}

/**
 * Kiểm tra mã 6 số, cho lệch ±1 bước (±30 giây) do đồng hồ điện thoại.
 * @param {number} lastUsedStep bước đã dùng lần trước — chặn dùng lại cùng 1 mã
 * @returns {number|null} bước khớp (để lưu lại), hoặc null nếu sai
 */
function verifyTotp(secretB32, code, lastUsedStep = -1, nowMs = Date.now()) {
  const c = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const now = totpStep(nowMs);
  for (const step of [now - 1, now, now + 1]) {
    if (step <= lastUsedStep) continue;
    const expected = hotp(secretB32, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return step;
  }
  return null;
}

function totpUri({ secret, account, issuer = "NFTTrace" }) {
  return (
    `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}` +
    `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
  );
}

/** Mã dự phòng 1 lần (khi mất điện thoại) — dạng ABCD-EFGH */
function generateBackupCodes(n = 8) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: n }, () => {
    const bytes = crypto.randomBytes(8);
    const s = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
}

function hashBackupCode(code) {
  return crypto.createHash("sha256").update(String(code).toUpperCase().replace(/\s/g, "")).digest("hex");
}

module.exports = {
  encrypt,
  decrypt,
  isEncrypted,
  getKey,
  maskPhone,
  maskName,
  maskAddress,
  generateTotpSecret,
  verifyTotp,
  totpUri,
  hotp,
  totpStep,
  generateBackupCodes,
  hashBackupCode,
};

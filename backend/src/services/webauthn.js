/**
 * Passkey (WebAuthn / FIDO2) — xác minh phía server, viết bằng thư viện
 * `crypto` có sẵn của Node (không cần gói ngoài).
 *
 * Passkey = cặp khoá: khoá BÍ MẬT nằm trong máy/điện thoại người dùng
 * (Windows Hello, Touch ID, Android, iPhone...), server chỉ giữ khoá CÔNG
 * KHAI. Đăng nhập = thiết bị ký một thử thách ngẫu nhiên sau khi người dùng
 * quét vân tay / khuôn mặt / PIN. Chữ ký gắn chặt với tên miền (rpId) nên
 * web giả mạo không dùng được → chống lừa đảo (phishing).
 *
 * Cấu hình (tuỳ chọn):
 *   WEBAUTHN_RP_ID    tên miền frontend, vd blockchain-nft-frontend.vercel.app
 *                     (mặc định lấy từ origin đầu tiên trong FRONTEND_ORIGIN)
 *   WEBAUTHN_ORIGINS  danh sách origin được chấp nhận, cách nhau dấu phẩy
 *                     (mặc định = FRONTEND_ORIGIN)
 *   WEBAUTHN_RP_NAME  tên hiển thị trong hộp thoại passkey (mặc định NFTTrace)
 */
const crypto = require("crypto");

// ---------------------------------------------------------------------
// base64url
// ---------------------------------------------------------------------
const b64u = {
  encode: (buf) => Buffer.from(buf).toString("base64url"),
  decode: (str) => Buffer.from(String(str || ""), "base64url"),
};

// ---------------------------------------------------------------------
// CBOR (RFC 8949) — bộ giải mã tối giản đủ cho WebAuthn
// ---------------------------------------------------------------------
function cborDecode(buf, start = 0) {
  let pos = start;
  function readLength(info) {
    if (info < 24) return info;
    if (info === 24) return buf.readUInt8(pos++);
    if (info === 25) { const v = buf.readUInt16BE(pos); pos += 2; return v; }
    if (info === 26) { const v = buf.readUInt32BE(pos); pos += 4; return v; }
    if (info === 27) { const v = buf.readBigUInt64BE(pos); pos += 8; return Number(v); }
    throw new Error("CBOR: độ dài không hỗ trợ");
  }
  function item() {
    if (pos >= buf.length) throw new Error("CBOR: hết dữ liệu");
    const first = buf.readUInt8(pos++);
    const major = first >> 5;
    const info = first & 0x1f;
    switch (major) {
      case 0: return readLength(info);
      case 1: return -1 - readLength(info);
      case 2: { const n = readLength(info); const v = buf.subarray(pos, pos + n); pos += n; return Buffer.from(v); }
      case 3: { const n = readLength(info); const v = buf.toString("utf8", pos, pos + n); pos += n; return v; }
      case 4: { const n = readLength(info); const arr = []; for (let i = 0; i < n; i++) arr.push(item()); return arr; }
      case 5: { const n = readLength(info); const m = new Map(); for (let i = 0; i < n; i++) { const k = item(); m.set(k, item()); } return m; }
      case 6: readLength(info); return item(); // tag — bỏ qua
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22 || info === 23) return null;
        throw new Error("CBOR: kiểu đơn không hỗ trợ");
      default:
        throw new Error("CBOR: kiểu không hỗ trợ");
    }
  }
  const value = item();
  return { value, end: pos };
}

// ---------------------------------------------------------------------
// COSE key → khoá công khai Node (hỗ trợ ES256 và RS256)
// ---------------------------------------------------------------------
const ALG_ES256 = -7;
const ALG_RS256 = -257;

function coseToJwk(cose) {
  const kty = cose.get(1);
  const alg = cose.get(3);
  if (kty === 2 && alg === ALG_ES256 && cose.get(-1) === 1) {
    return { alg: ALG_ES256, jwk: { kty: "EC", crv: "P-256", x: b64u.encode(cose.get(-2)), y: b64u.encode(cose.get(-3)) } };
  }
  if (kty === 3 && alg === ALG_RS256) {
    return { alg: ALG_RS256, jwk: { kty: "RSA", n: b64u.encode(cose.get(-1)), e: b64u.encode(cose.get(-2)) } };
  }
  throw new Error("Loại khoá passkey không được hỗ trợ (chỉ ES256/RS256)");
}

// ---------------------------------------------------------------------
// authenticatorData
// ---------------------------------------------------------------------
const FLAG_UP = 0x01; // người dùng có mặt (chạm/bấm)
const FLAG_UV = 0x04; // người dùng đã xác minh (vân tay/khuôn mặt/PIN)
const FLAG_AT = 0x40; // có kèm dữ liệu khoá (lúc đăng ký)

function parseAuthData(buf) {
  if (buf.length < 37) throw new Error("authenticatorData quá ngắn");
  const out = {
    rpIdHash: buf.subarray(0, 32),
    flags: buf.readUInt8(32),
    signCount: buf.readUInt32BE(33),
  };
  if (out.flags & FLAG_AT) {
    let p = 37;
    out.aaguid = buf.subarray(p, p + 16); p += 16;
    const idLen = buf.readUInt16BE(p); p += 2;
    out.credentialId = buf.subarray(p, p + idLen); p += idLen;
    const { value, end } = cborDecode(buf, p);
    out.credentialPublicKey = value;
    out.credentialPublicKeyBytes = buf.subarray(p, end);
  }
  return out;
}

// ---------------------------------------------------------------------
// Cấu hình RP (tên miền frontend)
// ---------------------------------------------------------------------
function allowedOrigins() {
  const raw = process.env.WEBAUTHN_ORIGINS || process.env.FRONTEND_ORIGIN || "";
  const list = raw.split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
  if (!list.length && process.env.NODE_ENV !== "production" && process.env.RENDER !== "true") {
    return ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:5500", "http://127.0.0.1:5500"];
  }
  return list;
}

function rpId() {
  if (process.env.WEBAUTHN_RP_ID) return process.env.WEBAUTHN_RP_ID;
  const first = allowedOrigins()[0];
  try {
    return new URL(first).hostname;
  } catch {
    return "localhost";
  }
}

function rpName() {
  return process.env.WEBAUTHN_RP_NAME || "NFTTrace";
}

function newChallenge() {
  return b64u.encode(crypto.randomBytes(32));
}

// ---------------------------------------------------------------------
// Kiểm tra clientDataJSON chung
// ---------------------------------------------------------------------
function checkClientData(clientDataB64, expectedType, expectedChallenge) {
  const raw = b64u.decode(clientDataB64);
  let cd;
  try {
    cd = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("clientDataJSON không hợp lệ");
  }
  if (cd.type !== expectedType) throw new Error("Sai loại thao tác passkey");
  if (cd.challenge !== expectedChallenge) throw new Error("Thử thách không khớp hoặc đã hết hạn");
  const origin = String(cd.origin || "").replace(/\/$/, "");
  if (!allowedOrigins().includes(origin)) {
    throw new Error(`Passkey được dùng trên trang lạ (${origin}) — có thể là web giả mạo`);
  }
  return { raw, data: cd };
}

function checkRpAndFlags(auth) {
  const expected = crypto.createHash("sha256").update(rpId()).digest();
  if (!crypto.timingSafeEqual(auth.rpIdHash, expected)) throw new Error("Passkey không thuộc tên miền này");
  if (!(auth.flags & FLAG_UP)) throw new Error("Thiết bị không xác nhận có người dùng");
  if (!(auth.flags & FLAG_UV)) throw new Error("Thiết bị chưa xác minh người dùng (vân tay/khuôn mặt/PIN)");
}

/**
 * Xác minh kết quả navigator.credentials.create().
 * @returns {{credId: string, publicKeyJwk: object, alg: number, signCount: number, transports: string[]}}
 */
function verifyRegistration(credential, expectedChallenge) {
  if (!credential || credential.type !== "public-key" || !credential.response) throw new Error("Dữ liệu passkey không hợp lệ");
  checkClientData(credential.response.clientDataJSON, "webauthn.create", expectedChallenge);
  const { value: att } = cborDecode(b64u.decode(credential.response.attestationObject));
  if (!(att instanceof Map) || !Buffer.isBuffer(att.get("authData"))) throw new Error("attestationObject không hợp lệ");
  const auth = parseAuthData(att.get("authData"));
  checkRpAndFlags(auth);
  if (!auth.credentialId || !auth.credentialPublicKey) throw new Error("Thiếu khoá công khai của passkey");
  const credId = b64u.encode(auth.credentialId);
  if (credential.rawId && credential.rawId !== credId) throw new Error("ID passkey không khớp");
  const { alg, jwk } = coseToJwk(auth.credentialPublicKey);
  crypto.createPublicKey({ key: jwk, format: "jwk" }); // đảm bảo khoá dùng được
  return {
    credId,
    publicKeyJwk: jwk,
    alg,
    signCount: auth.signCount,
    transports: Array.isArray(credential.response.transports) ? credential.response.transports.slice(0, 6).map(String) : [],
  };
}

/**
 * Xác minh kết quả navigator.credentials.get().
 * @param stored passkey đã lưu {publicKeyJwk, alg, signCount}
 * @returns {{signCount: number, cloneWarning: boolean}}
 */
function verifyAuthentication(credential, expectedChallenge, stored) {
  if (!credential || credential.type !== "public-key" || !credential.response) throw new Error("Dữ liệu passkey không hợp lệ");
  const { raw } = checkClientData(credential.response.clientDataJSON, "webauthn.get", expectedChallenge);
  const authBuf = b64u.decode(credential.response.authenticatorData);
  const auth = parseAuthData(authBuf);
  checkRpAndFlags(auth);

  const signedData = Buffer.concat([authBuf, crypto.createHash("sha256").update(raw).digest()]);
  const key = crypto.createPublicKey({ key: stored.publicKeyJwk, format: "jwk" });
  const sig = b64u.decode(credential.response.signature);
  const ok =
    stored.alg === ALG_RS256
      ? crypto.verify("RSA-SHA256", signedData, key, sig)
      : crypto.verify("sha256", signedData, { key, dsaEncoding: "der" }, sig);
  if (!ok) throw new Error("Chữ ký passkey không hợp lệ");

  // Bộ đếm chữ ký phải tăng — nếu lùi có thể passkey đã bị sao chép
  const prev = Number(stored.signCount || 0);
  const cloneWarning = auth.signCount !== 0 && prev !== 0 && auth.signCount <= prev;
  return { signCount: auth.signCount, cloneWarning };
}

module.exports = {
  b64u,
  cborDecode,
  parseAuthData,
  verifyRegistration,
  verifyAuthentication,
  newChallenge,
  rpId,
  rpName,
  allowedOrigins,
  ALG_ES256,
  ALG_RS256,
};

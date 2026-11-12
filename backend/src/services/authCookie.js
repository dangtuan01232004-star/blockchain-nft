/**
 * TOKEN ĐĂNG NHẬP TRONG COOKIE HttpOnly + CHỐNG CSRF.
 *
 * Trước: token nằm trong localStorage → script nào chạy được trên trang (XSS)
 * cũng đọc được và gửi đi. Nay: token nằm trong cookie HttpOnly — JavaScript
 * KHÔNG đọc được, trình duyệt tự gửi kèm khi gọi API.
 *
 * Frontend (vercel.app) và backend (onrender.com) KHÁC trang (cross-site) nên cookie phải:
 *   SameSite=None; Secure; Partitioned (CHIPS — trình duyệt chặn cookie bên thứ ba
 *   vẫn cho phép cookie "phân vùng" theo trang đang mở).
 * SameSite=None nghĩa là trình duyệt cũng gửi cookie khi TRANG KHÁC gọi tới API
 * → phải chống CSRF bằng 2 lớp cho mọi yêu cầu thay đổi dữ liệu:
 *   1. Header Origin phải là tên miền frontend chính thức.
 *   2. Header X-CSRF-Token = HMAC(bí mật, mã phiên) — trang lạ không đọc được
 *      (CORS chặn), cũng không tự đặt header này được nếu không qua CORS.
 *
 * Trình duyệt quá cũ không nhận cookie phân vùng → frontend phát hiện và dùng
 * chế độ dự phòng: token Bearer giữ trong sessionStorage của 1 tab (không cần CSRF
 * vì trình duyệt không tự gửi kèm).
 */
const crypto = require("crypto");

const COOKIE = "nft_sid";
const TEST_COOKIE = "nft_cc";
const MAX_AGE_SEC = Number(process.env.SESSION_MAX_HOURS || 8) * 3600;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function isLocalHttp(req) {
  const host = String(req.headers.host || "");
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
}

function cookieAttrs(req, maxAge) {
  // Secure bắt buộc cho SameSite=None/Partitioned; localhost được trình duyệt coi là an toàn
  return `Path=/api; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${maxAge}`;
}

function appendSetCookie(res, value) {
  const prev = res.getHeader("Set-Cookie");
  const list = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
  res.setHeader("Set-Cookie", [...list, value]);
}

function setAuthCookie(req, res, token) {
  appendSetCookie(res, `${COOKIE}=${token}; ${cookieAttrs(req, MAX_AGE_SEC)}`);
}

function clearAuthCookie(req, res) {
  appendSetCookie(res, `${COOKIE}=; ${cookieAttrs(req, 0)}`);
}

function readCookie(req, name) {
  const raw = String(req.headers.cookie || "");
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** Mã CSRF gắn với phiên — không cần lưu DB, tính lại để kiểm tra */
function csrfFor(sid) {
  return crypto.createHmac("sha256", process.env.JWT_SECRET || "").update(`csrf:${sid}`).digest("base64url");
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Dùng CHUNG bộ lọc với CORS (services/corsPolicy.js) để 2 nơi không lệch nhau
function allowedOrigins() {
  const { parseAllowedOrigins } = require("./corsPolicy");
  return parseAllowedOrigins(process.env.FRONTEND_ORIGIN, { production: process.env.NODE_ENV === "production" }).allowed;
}

function originAllowed(origin) {
  if (!origin) return false;
  const list = allowedOrigins();
  if (list.has(origin)) return true;
  if (list.size === 0 && process.env.NODE_ENV !== "production") {
    try {
      const u = new URL(origin);
      return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Kiểm tra CSRF cho yêu cầu xác thực BẰNG COOKIE. Trả về null nếu hợp lệ,
 * hoặc chuỗi lý do nếu phải chặn.
 */
function csrfProblem(req, sid) {
  if (SAFE_METHODS.has(req.method)) return null;
  if (!originAllowed(req.headers.origin)) return `Origin không hợp lệ (${req.headers.origin || "trống"})`;
  if (!safeEqual(req.headers["x-csrf-token"], csrfFor(sid))) return "thiếu hoặc sai mã CSRF";
  return null;
}

/**
 * Trả kết quả đăng nhập cho trình duyệt:
 *  - mặc định: đặt cookie HttpOnly, KHÔNG trả token trong nội dung
 *  - tokenFallback (trình duyệt không nhận cookie): trả token Bearer
 */
function sendLogin(req, res, { token, session, user, status = 200 }) {
  const fallback = Boolean(req.body && req.body.tokenFallback === true);
  if (fallback) {
    return res.status(status).json({ authMode: "bearer", token, user });
  }
  setAuthCookie(req, res, token);
  return res.status(status).json({ authMode: "cookie", csrfToken: csrfFor(session._id), user });
}

module.exports = {
  COOKIE,
  TEST_COOKIE,
  setAuthCookie,
  clearAuthCookie,
  readCookie,
  csrfFor,
  csrfProblem,
  originAllowed,
  sendLogin,
  appendSetCookie,
  cookieAttrs,
  isLocalHttp,
};

const net = require("net");

/**
 * Lấy IP THẬT của người dùng khi backend chạy sau proxy (Render).
 *
 * Request đi qua: người dùng → Cloudflare → bộ cân bằng tải của Render → app.
 * Nếu chỉ tin 1 tầng proxy (trust proxy = 1), Express trả về IP NỘI BỘ của
 * Render (10.x.x.x) — mỗi lần một máy proxy khác → hệ thống tưởng "IP mới"
 * liên tục, và mọi người dùng bị gộp chung giới hạn đăng nhập.
 *
 * Thứ tự ưu tiên:
 *  1. Header Cloudflare (CF-Connecting-IP / True-Client-IP) — Cloudflare tự
 *     ghi đè, người dùng không giả mạo được khi request đi qua Cloudflare.
 *     Tắt bằng TRUST_CLOUDFLARE_HEADERS=false nếu không chạy sau Cloudflare.
 *  2. X-Forwarded-For: đọc từ PHẢI sang TRÁI, bỏ qua địa chỉ nội bộ/riêng tư,
 *     lấy địa chỉ công khai đầu tiên (người dùng chỉ thêm được vào bên TRÁI
 *     nên không giả mạo được bằng cách này).
 *  3. Địa chỉ kết nối trực tiếp.
 */
function normalize(ip) {
  let s = String(ip || "").trim();
  if (s.startsWith("::ffff:")) s = s.slice(7); // IPv4 dạng IPv6
  if (/^\[.*\]$/.test(s)) s = s.slice(1, -1);
  // bỏ cổng "1.2.3.4:5678"
  if (net.isIPv4(s.split(":")[0]) && s.split(":").length === 2) s = s.split(":")[0];
  return net.isIP(s) ? s : "";
}

function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT nội bộ hạ tầng
      a === 0
    );
  }
  const l = ip.toLowerCase();
  return l === "::1" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80");
}

function getClientIp(req) {
  if (process.env.TRUST_CLOUDFLARE_HEADERS !== "false") {
    for (const h of ["cf-connecting-ip", "true-client-ip"]) {
      const v = normalize(req.headers[h]);
      if (v) return v;
    }
  }
  const xff = String(req.headers["x-forwarded-for"] || "")
    .split(",")
    .map(normalize)
    .filter(Boolean);
  for (let i = xff.length - 1; i >= 0; i--) {
    if (!isPrivate(xff[i])) return xff[i];
  }
  const direct = normalize(req.socket && req.socket.remoteAddress);
  return xff[0] || direct || "";
}

/**
 * Middleware: gắn IP thật vào req.ip cho MỌI phần phía sau dùng
 * (ghi nhật ký, phiên đăng nhập, giới hạn số lần thử...).
 */
function clientIpMiddleware(req, res, next) {
  const ip = getClientIp(req);
  if (ip) Object.defineProperty(req, "ip", { value: ip, configurable: true, enumerable: true });
  next();
}

module.exports = { getClientIp, clientIpMiddleware, isPrivate };

/**
 * CORS — CHỈ cho phép đúng các tên miền frontend khai trong FRONTEND_ORIGIN.
 * KHÔNG BAO GIỜ dùng "*": backend gửi cookie đăng nhập (credentials), nếu mở
 * cho mọi tên miền thì trang của kẻ tấn công cũng đọc được phản hồi API bằng
 * phiên của nạn nhân.
 *
 * Chuẩn hoá danh sách lúc khởi động:
 *  - bỏ dấu "/" cuối, so khớp CHÍNH XÁC (không so khớp kiểu "đuôi tên miền",
 *    tránh lọt evil-vercel.app hay frontend.vercel.app.evil.com);
 *  - loại "*", "null", giá trị không phải URL, URL có đường dẫn;
 *  - production: loại origin http:// và localhost (thường sót lại từ
 *    .env.example) — chỉ giữ https.
 */

function parseAllowedOrigins(raw, { production = false } = {}) {
  const allowed = new Set();
  const rejected = [];
  for (const item of String(raw || "").split(",")) {
    const v = item.trim();
    if (!v) continue;
    if (v === "*" || v.includes("*") || v.toLowerCase() === "null") {
      rejected.push([v, "không dùng ký tự đại diện * / null"]);
      continue;
    }
    let url;
    try {
      url = new URL(v);
    } catch {
      rejected.push([v, "không phải URL hợp lệ"]);
      continue;
    }
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
      rejected.push([v, "chỉ ghi giao thức + tên miền, không kèm đường dẫn"]);
      continue;
    }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (production && (url.protocol !== "https:" || local)) {
      rejected.push([v, "production chỉ nhận https và không nhận localhost"]);
      continue;
    }
    if (!["https:", "http:"].includes(url.protocol)) {
      rejected.push([v, "giao thức không hợp lệ"]);
      continue;
    }
    allowed.add(url.origin); // dạng chuẩn: https://ten-mien (không "/" cuối, chữ thường)
  }
  return { allowed, rejected };
}

function isLocalDevOrigin(origin) {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Quyết định 1 request có được CORS không.
 * - Không có header Origin (curl, server-to-server, điều hướng thường): CORS
 *   không liên quan → cho qua; các API ghi vẫn được chặn bằng phiên + CSRF.
 * - Có Origin: phải nằm đúng trong danh sách.
 */
function makeOriginChecker(allowed, { production = false } = {}) {
  return function check(origin) {
    if (!origin) return true;
    if (allowed.has(origin)) return true;
    // Chưa cấu hình gì + đang chạy trên máy → cho localhost để dev
    if (allowed.size === 0 && !production) return isLocalDevOrigin(origin);
    return false;
  };
}

module.exports = { parseAllowedOrigins, makeOriginChecker, isLocalDevOrigin };

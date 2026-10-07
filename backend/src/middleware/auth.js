const jwt = require("jsonwebtoken");

/**
 * Middleware bảo vệ route — yêu cầu header:
 *   Authorization: Bearer <token>
 * Token được cấp khi đăng nhập thành công (xem routes/auth.js).
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Chưa đăng nhập — thiếu token xác thực." });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || "dev-secret-khong-dung-cho-production");
    req.user = payload; // { id, username, role }
    next();
  } catch (err) {
    return res.status(401).json({ error: "Token không hợp lệ hoặc đã hết hạn — vui lòng đăng nhập lại." });
  }
}

/** Bắt buộc phải chạy SAU requireAuth — chỉ tài khoản role="admin" mới qua được */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Chỉ tài khoản admin mới có quyền thực hiện việc này." });
  }
  next();
}

module.exports = { requireAuth, requireAdmin };

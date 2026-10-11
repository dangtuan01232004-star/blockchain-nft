const jwt = require("jsonwebtoken");
const User = require("../models/User");

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

async function requireApproved(req, res, next) {
  try {
    const user = await User.findById(req.user.id).select("role roleStatus walletAddress");
    if (!user) return res.status(401).json({ error: "Tài khoản không tồn tại" });
    if (user.role !== "admin" && user.roleStatus !== "da_duyet") {
      return res.status(403).json({ error: "Tài khoản chưa được duyệt" });
    }
    req.dbUser = user;
    next();
  } catch (err) {
    console.error("Không kiểm tra được trạng thái duyệt tài khoản:", err);
    res.status(500).json({ error: "Không kiểm tra được trạng thái tài khoản" });
  }
}

module.exports = { requireAuth, requireAdmin, requireApproved };

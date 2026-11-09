const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const User = require("../models/User");
const { checkSession } = require("../services/sessions");

/**
 * Middleware bảo vệ route — yêu cầu header:
 *   Authorization: Bearer <token>
 *
 * BẢO MẬT: không tin vào thông tin role nằm trong token. Mỗi request đều
 * đọc lại tài khoản từ MongoDB và kiểm tra:
 *   - tài khoản còn tồn tại, chưa bị khoá (disabled)
 *   - tokenVersion trong token khớp DB (admin "đăng xuất mọi phiên" hoặc
 *     người dùng đổi mật khẩu → mọi token cũ mất hiệu lực ngay)
 *   - role lấy từ DB, nên hạ quyền có hiệu lực ngay, không chờ token hết hạn
 *   - phiên (sid) còn hiệu lực: chưa bị thu hồi, chưa hết hạn, chưa bỏ quên
 *     quá SESSION_IDLE_MINUTES (xem services/sessions.js)
 */
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Chưa đăng nhập — thiếu token xác thực." });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
    if (payload.typ) throw new Error("Không phải token đăng nhập"); // ví dụ token tạm của bước 2FA
  } catch (err) {
    return res.status(401).json({ error: "Token không hợp lệ hoặc đã hết hạn — vui lòng đăng nhập lại." });
  }

  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ error: "Hệ thống tài khoản tạm thời không khả dụng, thử lại sau." });
  }

  try {
    const user = await User.findById(payload.id).select(
      "username displayName role roleStatus walletAddress tokenVersion disabled twoFactorEnabled"
    );
    if (!user || user.disabled || (payload.tv ?? 0) !== (user.tokenVersion ?? 0)) {
      return res.status(401).json({ error: "Phiên đăng nhập không còn hiệu lực — vui lòng đăng nhập lại." });
    }
    const check = await checkSession(payload, req);
    if (!check.ok) return res.status(401).json({ error: check.reason });
    req.authSession = check.session;
    req.dbUser = user;
    req.user = { id: String(user._id), username: user.username, role: user.role };
    next();
  } catch (err) {
    console.error("Không kiểm tra được phiên đăng nhập:", err);
    res.status(500).json({ error: "Không kiểm tra được phiên đăng nhập" });
  }
}

/**
 * Bắt buộc phải chạy SAU requireAuth — role đọc từ DB, không từ token.
 * Đặt REQUIRE_ADMIN_2FA=true → admin CHƯA bật xác thực 2 lớp sẽ không dùng
 * được các chức năng quản trị (vẫn vào được mục "Tài khoản của tôi" để bật).
 */
function requireAdmin(req, res, next) {
  if (!req.dbUser || req.dbUser.role !== "admin") {
    return res.status(403).json({ error: "Chỉ tài khoản admin mới có quyền thực hiện việc này." });
  }
  if (process.env.REQUIRE_ADMIN_2FA === "true" && !req.dbUser.twoFactorEnabled) {
    return res.status(403).json({
      error: "Tài khoản admin phải bật xác thực 2 lớp trước — vào mục Tài khoản của tôi để bật.",
      code: "ADMIN_2FA_REQUIRED",
    });
  }
  next();
}

/** Bắt buộc chạy SAU requireAuth — tài khoản phải được duyệt (trừ admin) */
function requireApproved(req, res, next) {
  const user = req.dbUser;
  if (!user) return res.status(401).json({ error: "Tài khoản không tồn tại" });
  if (user.role !== "admin" && user.roleStatus !== "da_duyet") {
    return res.status(403).json({ error: "Tài khoản chưa được duyệt" });
  }
  next();
}

module.exports = { requireAuth, requireAdmin, requireApproved };

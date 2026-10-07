const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const { requireAuth, requireAdmin } = require("../middleware/auth");

const router = express.Router();

function signToken(user) {
  return jwt.sign(
    { id: user._id, username: user.username, role: user.role },
    process.env.JWT_SECRET || "dev-secret-khong-dung-cho-production",
    { expiresIn: "7d" }
  );
}

/**
 * POST /api/auth/register
 * body: { username, password, displayName, role, walletAddress }
 *
 * Lưu ý: endpoint này đang MỞ CÔNG KHAI (ai cũng đăng ký được) — phù hợp
 * cho demo/đồ án. Khi triển khai thật, nên khoá lại (chỉ admin tạo tài
 * khoản, hoặc thêm bước duyệt) để tránh người lạ tự tạo tài khoản
 * manufacturer/distributor.
 */
router.post("/register", async (req, res) => {
  try {
    const { username, password, displayName, role, walletAddress } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "Thiếu username hoặc password" });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Mật khẩu phải có ít nhất 6 ký tự" });
    }

    const existing = await User.findOne({ username: username.toLowerCase() });
    if (existing) {
      return res.status(409).json({ error: "Username đã tồn tại" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({
      username,
      passwordHash,
      displayName: displayName || username,
      role: ["manufacturer", "distributor", "admin"].includes(role) ? role : "manufacturer",
      walletAddress: walletAddress || "",
    });

    const token = signToken(user);
    res.status(201).json({
      token,
      user: { id: user._id, username: user.username, displayName: user.displayName, role: user.role },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Lỗi khi đăng ký" });
  }
});

/** POST /api/auth/login — body: { username, password } */
router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "Thiếu username hoặc password" });
    }

    const user = await User.findOne({ username: username.toLowerCase() });
    if (!user) {
      return res.status(401).json({ error: "Sai username hoặc mật khẩu" });
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      return res.status(401).json({ error: "Sai username hoặc mật khẩu" });
    }

    const token = signToken(user);
    res.json({
      token,
      user: { id: user._id, username: user.username, displayName: user.displayName, role: user.role },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Lỗi khi đăng nhập" });
  }
});

/** GET /api/auth/me — kiểm tra token còn hợp lệ không, trả lại thông tin user */
router.get("/me", requireAuth, async (req, res) => {
  const user = await User.findById(req.user.id).select("-passwordHash");
  if (!user) return res.status(404).json({ error: "Không tìm thấy tài khoản" });
  res.json(user);
});

/**
 * PATCH /api/auth/me/wallet — người dùng tự liên kết địa chỉ ví MetaMask
 * vào tài khoản của mình (gọi khi họ bấm "Kết nối ví" ở trang quản trị).
 * body: { walletAddress }
 * Đặt roleStatus = "cho_duyet" để admin biết có yêu cầu mới cần xem xét.
 */
router.patch("/me/wallet", requireAuth, async (req, res) => {
  const { walletAddress } = req.body;
  if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress || "")) {
    return res.status(400).json({ error: "Địa chỉ ví không hợp lệ" });
  }
  const user = await User.findByIdAndUpdate(
    req.user.id,
    { walletAddress: walletAddress.toLowerCase(), roleStatus: "cho_duyet" },
    { new: true }
  ).select("-passwordHash");
  if (!user) return res.status(404).json({ error: "Không tìm thấy tài khoản" });
  res.json(user);
});

/**
 * GET /api/auth/users — CHỈ ADMIN — danh sách toàn bộ tài khoản đã đăng ký,
 * dùng để hiển thị màn "Quản lý người dùng" và duyệt cấp quyền on-chain.
 */
router.get("/users", requireAuth, requireAdmin, async (req, res) => {
  const users = await User.find().select("-passwordHash").sort({ createdAt: -1 });
  res.json(users);
});

/**
 * PATCH /api/auth/users/:id/approve — CHỈ ADMIN — đánh dấu đã duyệt cấp
 * quyền on-chain cho tài khoản này. Gọi SAU KHI admin đã tự ký giao dịch
 * contract.grantRole() thành công bằng ví MetaMask của chính admin (xem
 * frontend/js/admin.js) — endpoint này chỉ cập nhật nhãn hiển thị, không
 * tự thực hiện giao dịch blockchain nào cả.
 */
router.patch("/users/:id/approve", requireAuth, requireAdmin, async (req, res) => {
  const user = await User.findByIdAndUpdate(
    req.params.id,
    { roleStatus: "da_duyet" },
    { new: true }
  ).select("-passwordHash");
  if (!user) return res.status(404).json({ error: "Không tìm thấy tài khoản" });
  res.json(user);
});

module.exports = router;

const express = require("express");
const { listPartners, addPartner } = require("../services/partners");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { securityEvent } = require("../services/alerts");

const router = express.Router();

/** GET /api/partners — danh sách đối tác đã đăng ký (tên + địa chỉ ví + vai trò) */
router.get("/", (req, res) => {
  res.json(listPartners());
});

/**
 * POST /api/partners — đăng ký đối tác mới — CHỈ ADMIN.
 * body: { name, walletAddress, role }  (role: DISTRIBUTOR | RETAILER | MANUFACTURER)
 *
 * Vì sao chỉ admin: danh bạ này là nơi mọi người CHỌN ví nhận hàng khi
 * chuyển giao. Nếu ai đăng nhập cũng thêm được, kẻ chiếm 1 tài khoản có
 * thể thêm "Đại lý Hà Nội" trỏ về ví của họ → hàng thật bị chuyển nhầm.
 */
router.post("/", requireAuth, requireAdmin, async (req, res) => {
  const { name, walletAddress, role } = req.body;
  if (!name || !walletAddress || !role) {
    return res.status(400).json({ error: "Thiếu tên, địa chỉ ví hoặc vai trò" });
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
    return res.status(400).json({ error: "Địa chỉ ví không hợp lệ — phải có dạng 0x kèm 40 ký tự hex" });
  }
  if (!["DISTRIBUTOR", "RETAILER", "MANUFACTURER"].includes(role)) {
    return res.status(400).json({ error: "Vai trò đối tác không hợp lệ" });
  }
  const wallet = walletAddress.toLowerCase();
  if (listPartners().some((p) => String(p.walletAddress).toLowerCase() === wallet)) {
    return res.status(409).json({ error: "Ví này đã có trong danh bạ đối tác" });
  }
  const entry = {
    id: Date.now().toString(),
    name: String(name).slice(0, 120),
    walletAddress,
    role,
    addedBy: req.dbUser.username,
    addedAt: new Date().toISOString(),
  };
  addPartner(entry);
  await securityEvent({
    type: "partner_added",
    severity: "info",
    message: `Thêm đối tác "${entry.name}" (${role}) vào danh bạ`,
    user: req.dbUser,
    wallet,
    ip: req.ip,
  });
  res.status(201).json(entry);
});

module.exports = router;

const express = require("express");
const { listPartners, addPartner } = require("../services/partners");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

/** GET /api/partners — danh sách đối tác đã đăng ký (tên + địa chỉ ví + vai trò) */
router.get("/", (req, res) => {
  res.json(listPartners());
});

/**
 * POST /api/partners — đăng ký đối tác mới
 * body: { name, walletAddress, role }  (role: DISTRIBUTOR | RETAILER | MANUFACTURER)
 */
router.post("/", requireAuth, (req, res) => {
  const { name, walletAddress, role } = req.body;
  if (!name || !walletAddress || !role) {
    return res.status(400).json({ error: "Thiếu tên, địa chỉ ví hoặc vai trò" });
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
    return res.status(400).json({ error: "Địa chỉ ví không hợp lệ — phải có dạng 0x kèm 40 ký tự hex" });
  }
  const entry = {
    id: Date.now().toString(),
    name,
    walletAddress,
    role,
    addedAt: new Date().toISOString(),
  };
  addPartner(entry);
  res.status(201).json(entry);
});

module.exports = router;

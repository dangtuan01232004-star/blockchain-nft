const express = require("express");
const Order = require("../models/Order");
const SearchLog = require("../models/SearchLog");
const { listProductsFromBlockchain } = require("../services/productCatalog");
const { listProducts } = require("../services/cache");
const { requireAuth, requireApproved, requireAdmin } = require("../middleware/auth");
const { protectBuyerFields, maskedView, revealOrder } = require("../services/orderPrivacy");
const { securityEvent } = require("../services/alerts");

const router = express.Router();

/**
 * GET /api/shop/products
 * Danh sách sản phẩm có thể xem/mua — lấy từ blockchain.
 * Mỗi NFT là duy nhất (chuẩn ERC-721) nên mỗi sản phẩm hiển thị với số
 * lượng cố định là 1, đúng bản chất "một token — một sản phẩm thực".
 */
router.get("/products", async (req, res) => {
  try {
    const products = await listProductsFromBlockchain();
    res.json(products.map((p) => ({ ...p, quantity: 1 })));
  } catch (err) {
    console.error("Không tải được danh sách sản phẩm cho cửa hàng:", err);
    res.status(500).json({ error: err.message || "Không tải được danh sách sản phẩm" });
  }
});

/**
 * GET /api/shop/search?q=...
 * Tìm kiếm sản phẩm theo tên hoặc mã SKU (không phân biệt hoa/thường).
 * Đồng thời ghi lại từ khoá vào SearchLog để sau này thống kê xu hướng
 * tìm kiếm của người dùng.
 */
router.get("/search", async (req, res) => {
  const q = (req.query.q || "").trim();
  let results;
  try {
    const products = await listProductsFromBlockchain();
    results = q
      ? products.filter(
          (p) =>
            (p.name || "").toLowerCase().includes(q.toLowerCase()) ||
            (p.productCode || "").toLowerCase().includes(q.toLowerCase())
        )
      : products;
  } catch (err) {
    console.error("Không tìm kiếm được sản phẩm trên blockchain:", err);
    return res.status(500).json({ error: err.message || "Không tìm kiếm được sản phẩm" });
  }

  // Ghi log tìm kiếm — không chặn phản hồi nếu MongoDB gặp sự cố
  if (q) {
    SearchLog.create({ query: q, resultCount: results.length }).catch((err) =>
      console.error("Không ghi được lịch sử tìm kiếm:", err.message)
    );
  }

  res.json(results.map((p) => ({ ...p, quantity: 1 })));
});

/**
 * POST /api/shop/orders — người mua đặt hàng (KHÔNG cần đăng nhập, KHÔNG cần ví).
 * body: { tokenId, productName, productCode, buyerName, buyerPhone, buyerAddress, note }
 */
router.post("/orders", async (req, res) => {
  try {
    const { tokenId, productName, productCode, buyerName, buyerPhone, buyerAddress, note } = req.body;
    if (tokenId === undefined || !buyerName || !buyerPhone || !buyerAddress) {
      return res.status(400).json({ error: "Thiếu tokenId, tên, số điện thoại hoặc địa chỉ nhận hàng" });
    }
    const limits = {
      tokenId: 64,
      productName: 200,
      productCode: 100,
      buyerName: 120,
      buyerPhone: 15,
      buyerAddress: 500,
      note: 1000,
    };
    const fields = { tokenId, productName, productCode, buyerName, buyerPhone, buyerAddress, note };
    for (const [field, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue;
      if (typeof value !== "string" && !(field === "tokenId" && typeof value === "number")) {
        return res.status(400).json({ error: `Trường ${field} không hợp lệ` });
      }
      if (String(value).length > limits[field]) {
        return res.status(400).json({ error: `Trường ${field} vượt quá ${limits[field]} ký tự` });
      }
    }
    if (!/^[0-9+\s-]{8,15}$/.test(buyerPhone)) {
      return res.status(400).json({ error: "Số điện thoại không hợp lệ" });
    }
    // Thông tin cá nhân được MÃ HOÁ trước khi lưu
    const order = await Order.create({
      tokenId: String(tokenId),
      productName: productName || "",
      productCode: productCode || "",
      ...protectBuyerFields({ buyerName, buyerPhone, buyerAddress, note: note || "" }),
    });
    // Trả lại cho chính người mua thông tin họ vừa nhập (không đọc lại từ DB)
    res.status(201).json({
      _id: order._id,
      tokenId: order.tokenId,
      productName: order.productName,
      buyerName,
      buyerPhone,
      buyerAddress,
      status: order.status,
      createdAt: order.createdAt,
    });
  } catch (err) {
    console.error(err);
    if (err.name === "ValidationError") {
      return res.status(400).json({ error: "Thông tin đơn hàng không hợp lệ" });
    }
    res.status(500).json({ error: "Lỗi khi đặt hàng" });
  }
});

function getIssuedTokenIds(walletAddress) {
  if (!walletAddress) return [];
  const wallet = walletAddress.toLowerCase();
  return listProducts()
    .filter((product) => String(product.mintedBy || "").toLowerCase() === wallet)
    .map((product) => String(product.tokenId));
}

/** Lấy đơn mà tài khoản này được phép xem (admin: tất cả; NSX: đơn sản phẩm mình phát hành) */
async function findAllowedOrder(req, orderId) {
  const order = await Order.findById(orderId);
  if (!order) return null;
  if (req.dbUser.role === "admin") return order;
  const tokenIds = new Set(await getIssuedTokenIds(req.dbUser.walletAddress));
  return tokenIds.has(order.tokenId) ? order : null;
}

/**
 * GET /api/shop/orders — danh sách đơn, thông tin người mua ĐÃ CHE
 * (0912***678, "…, Hà Nội"). Muốn xem đầy đủ phải mở từng đơn.
 */
router.get("/orders", requireAuth, requireApproved, async (req, res) => {
  try {
    let orders = await Order.find().sort({ createdAt: -1 });
    if (req.dbUser.role !== "admin") {
      const tokenIds = new Set(await getIssuedTokenIds(req.dbUser.walletAddress));
      orders = orders.filter((order) => tokenIds.has(order.tokenId));
    }
    res.json(orders.map(maskedView));
  } catch (err) {
    console.error("Không tải được đơn hàng của sản phẩm đã phát hành:", err);
    res.status(500).json({ error: "Không tải được danh sách đơn hàng" });
  }
});

/**
 * POST /api/shop/orders/:id/reveal — xem đầy đủ thông tin người mua 1 đơn.
 * Mỗi lần mở đều được ghi nhật ký; mở quá nhiều/giờ sẽ bị cảnh báo rồi chặn.
 */
router.post("/orders/:id/reveal", requireAuth, requireApproved, async (req, res) => {
  try {
    const order = await findAllowedOrder(req, req.params.id);
    if (!order) return res.status(404).json({ error: "Không tìm thấy đơn hàng" });
    const r = await revealOrder(order, req.dbUser, req);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.json(r.data);
  } catch (err) {
    console.error("Không mở được thông tin đơn hàng:", err);
    res.status(500).json({ error: "Không mở được thông tin đơn hàng" });
  }
});

/** PATCH /api/shop/orders/:id/status — chỉ tài khoản đã duyệt cập nhật đơn sản phẩm mình phát hành */
router.patch("/orders/:id/status", requireAuth, requireApproved, async (req, res) => {
  const { status } = req.body;
  if (!["moi", "da_xac_nhan", "da_giao"].includes(status)) {
    return res.status(400).json({ error: "Trạng thái không hợp lệ" });
  }
  try {
    const existing = await findAllowedOrder(req, req.params.id);
    if (!existing) return res.status(404).json({ error: "Không tìm thấy đơn hàng" });
    // Ghi mốc giao hàng — dùng để tính hạn xoá thông tin cá nhân
    const update = { status, deliveredAt: status === "da_giao" ? existing.deliveredAt || new Date() : null };
    const order = await Order.findByIdAndUpdate(existing._id, update, { new: true });
    res.json(maskedView(order));
  } catch (err) {
    console.error("Không cập nhật được trạng thái đơn hàng:", err);
    res.status(500).json({ error: "Không cập nhật được trạng thái đơn hàng" });
  }
});

// ---------------------------------------------------------------------
// Đơn bẫy (canary) — CHỈ ADMIN
// ---------------------------------------------------------------------

/**
 * POST /api/shop/canary — tạo đơn bẫy.
 * body: { tokenId, buyerName, buyerPhone, buyerAddress, note }
 * Dùng SỐ ĐIỆN THOẠI DO BẠN GIỮ (sim phụ): nếu số này bị gọi/nhắn tin lạ,
 * nghĩa là dữ liệu khách hàng đã bị lộ ra ngoài. Ngoài ra, bất kỳ ai bấm
 * "Xem đầy đủ" đơn này trong hệ thống cũng kích hoạt báo động ngay.
 * tokenId: chọn 1 sản phẩm của nhà sản xuất muốn "giăng bẫy" → đơn bẫy
 * hiện trong danh sách đơn của họ y như đơn thật.
 */
router.post("/canary", requireAuth, requireAdmin, async (req, res) => {
  const { tokenId, buyerName, buyerPhone, buyerAddress, note, productName } = req.body || {};
  if (tokenId === undefined || !buyerName || !buyerPhone || !buyerAddress) {
    return res.status(400).json({ error: "Thiếu tokenId, tên, số điện thoại hoặc địa chỉ" });
  }
  if (!/^[0-9+\s-]{8,15}$/.test(String(buyerPhone))) {
    return res.status(400).json({ error: "Số điện thoại không hợp lệ" });
  }
  const order = await Order.create({
    tokenId: String(tokenId),
    productName: productName || "",
    ...protectBuyerFields({ buyerName, buyerPhone, buyerAddress, note: note || "" }),
    isCanary: true,
  });
  await securityEvent({
    type: "canary_created",
    severity: "info",
    message: `Tạo đơn bẫy cho sản phẩm #${tokenId}`,
    user: req.dbUser,
    ip: req.ip,
    meta: { orderId: String(order._id) },
  });
  res.status(201).json({ ...maskedView(order), isCanary: true });
});

/** GET /api/shop/canary — danh sách đơn bẫy (để admin quản lý) */
router.get("/canary", requireAuth, requireAdmin, async (req, res) => {
  const list = await Order.find({ isCanary: true }).sort({ createdAt: -1 });
  res.json(list.map((o) => ({ ...maskedView(o), isCanary: true, revealCount: o.revealCount || 0 })));
});

/** DELETE /api/shop/canary/:id — gỡ đơn bẫy */
router.delete("/canary/:id", requireAuth, requireAdmin, async (req, res) => {
  const o = await Order.findById(req.params.id);
  if (!o || !o.isCanary) return res.status(404).json({ error: "Không tìm thấy đơn bẫy" });
  await Order.deleteOne({ _id: o._id });
  res.json({ ok: true });
});

module.exports = router;

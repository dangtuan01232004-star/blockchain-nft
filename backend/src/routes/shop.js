const express = require("express");
const Order = require("../models/Order");
const SearchLog = require("../models/SearchLog");
const { listProducts } = require("../services/cache");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

/**
 * GET /api/shop/products
 * Danh sách sản phẩm có thể xem/mua — lấy từ cache sản phẩm đã mint.
 * Mỗi NFT là duy nhất (chuẩn ERC-721) nên mỗi sản phẩm hiển thị với số
 * lượng cố định là 1, đúng bản chất "một token — một sản phẩm thực".
 */
router.get("/products", (req, res) => {
  const products = listProducts();
  res.json(products.map((p) => ({ ...p, quantity: 1 })));
});

/**
 * GET /api/shop/search?q=...
 * Tìm kiếm sản phẩm theo tên hoặc mã SKU (không phân biệt hoa/thường).
 * Đồng thời ghi lại từ khoá vào SearchLog để sau này thống kê xu hướng
 * tìm kiếm của người dùng.
 */
router.get("/search", async (req, res) => {
  const q = (req.query.q || "").trim();
  const products = listProducts();
  const results = q
    ? products.filter(
        (p) =>
          (p.name || "").toLowerCase().includes(q.toLowerCase()) ||
          (p.productCode || "").toLowerCase().includes(q.toLowerCase())
      )
    : products;

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
    if (!tokenId || !buyerName || !buyerPhone || !buyerAddress) {
      return res.status(400).json({ error: "Thiếu tokenId, tên, số điện thoại hoặc địa chỉ nhận hàng" });
    }
    if (!/^[0-9+\s-]{8,15}$/.test(buyerPhone)) {
      return res.status(400).json({ error: "Số điện thoại không hợp lệ" });
    }
    const order = await Order.create({
      tokenId: String(tokenId),
      productName: productName || "",
      productCode: productCode || "",
      buyerName,
      buyerPhone,
      buyerAddress,
      note: note || "",
    });
    res.status(201).json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Lỗi khi đặt hàng" });
  }
});

/** GET /api/shop/orders — CHỈ tài khoản đã đăng nhập (bên bán) xem được danh sách đơn hàng */
router.get("/orders", requireAuth, async (req, res) => {
  const orders = await Order.find().sort({ createdAt: -1 });
  res.json(orders);
});

/** PATCH /api/shop/orders/:id/status — bên bán cập nhật trạng thái xử lý đơn */
router.patch("/orders/:id/status", requireAuth, async (req, res) => {
  const { status } = req.body;
  if (!["moi", "da_xac_nhan", "da_giao"].includes(status)) {
    return res.status(400).json({ error: "Trạng thái không hợp lệ" });
  }
  const order = await Order.findByIdAndUpdate(req.params.id, { status }, { new: true });
  if (!order) return res.status(404).json({ error: "Không tìm thấy đơn hàng" });
  res.json(order);
});

module.exports = router;

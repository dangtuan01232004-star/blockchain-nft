const mongoose = require("mongoose");

/**
 * Đơn hàng do người tiêu dùng đặt mua. Người mua KHÔNG cần ví MetaMask —
 * đúng nguyên tắc xuyên suốt hệ thống: người tiêu dùng chỉ tương tác qua
 * thông tin cá nhân thông thường (tên, số điện thoại, địa chỉ giao hàng).
 *
 * Đơn hàng này là dữ liệu OFF-CHAIN (chỉ lưu ở MongoDB) — không tự động
 * tạo giao dịch blockchain nào. Việc "chốt bán" thật sự trên chain (đóng
 * dấu bước cuối SOLD trong lịch sử chuỗi cung ứng) vẫn do bên bán (nhà sản
 * xuất/phân phối đang giữ token) chủ động thực hiện bằng ví của họ ở màn
 * "Đơn hàng" trong trang quản trị, sau khi xác nhận đã giao hàng thành công.
 */
const orderSchema = new mongoose.Schema(
  {
    tokenId: { type: String, required: true },
    productName: { type: String, default: "" },
    productCode: { type: String, default: "" },
    buyerName: { type: String, required: true },
    buyerPhone: { type: String, required: true },
    buyerAddress: { type: String, required: true },
    note: { type: String, default: "" },
    status: {
      type: String,
      enum: ["moi", "da_xac_nhan", "da_giao"],
      default: "moi",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Order", orderSchema);

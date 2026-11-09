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
    tokenId: { type: String, required: true, maxlength: 64 },
    productName: { type: String, default: "", maxlength: 200 },
    productCode: { type: String, default: "", maxlength: 100 },

    // Thông tin cá nhân người mua — lưu dạng MÃ HOÁ AES-256-GCM ("enc:v1:...").
    // Lộ bản sao database cũng không đọc được nếu không có DATA_ENCRYPTION_KEY.
    buyerName: { type: String, required: true },
    buyerPhone: { type: String, required: true },
    buyerAddress: { type: String, required: true },
    note: { type: String, default: "" },

    // Bản đã che để hiển thị danh sách (không cần giải mã)
    buyerNameMasked: { type: String, default: "" },
    buyerPhoneMasked: { type: String, default: "" },
    buyerAddressMasked: { type: String, default: "" },

    status: {
      type: String,
      enum: ["moi", "da_xac_nhan", "da_giao"],
      default: "moi",
    },
    deliveredAt: { type: Date, default: null },
    // Đã xoá thông tin cá nhân theo chính sách lưu trữ
    anonymizedAt: { type: Date, default: null },
    // Số lần có người bấm "Xem đầy đủ"
    revealCount: { type: Number, default: 0 },
    // Đơn BẪY (canary) do admin tạo — trông như đơn thật. Bất kỳ ai mở xem
    // đầy đủ đơn này đều kích hoạt báo động. Không bao giờ trả trường này ra API.
    isCanary: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Order", orderSchema);

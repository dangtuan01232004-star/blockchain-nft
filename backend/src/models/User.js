const mongoose = require("mongoose");

/**
 * Tài khoản đăng nhập trang quản trị (admin.html).
 *
 * Lưu ý quan trọng: tài khoản này KHÔNG thay thế ví MetaMask — nó chỉ là
 * lớp "gác cổng" trước khi vào trang quản trị và gọi các API hỗ trợ
 * (lưu metadata, đăng ký đối tác...). Việc mint NFT / chuyển giao chuỗi
 * cung ứng thật sự vẫn phải ký bằng ví MetaMask có đúng role trên smart
 * contract — 2 lớp bảo vệ độc lập nhau, không cái nào thay cho cái kia.
 *
 * `roleStatus` theo dõi việc admin đã CẤP QUYỀN ON-CHAIN cho ví của tài
 * khoản này hay chưa (gọi contract.grantRole() thật) — đây chỉ là nhãn
 * hiển thị tiện lợi ở giao diện, KHÔNG phải nguồn sự thật; nguồn sự thật
 * vẫn là kết quả contract.hasRole() đọc trực tiếp từ blockchain.
 */
const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true },
    displayName: { type: String, default: "" },
    role: {
      type: String,
      enum: ["manufacturer", "distributor", "admin"],
      default: "manufacturer",
    },
    // Địa chỉ ví MetaMask người dùng tự kết nối lúc dùng trang quản trị —
    // dùng để admin biết cấp quyền on-chain cho đúng địa chỉ nào.
    walletAddress: { type: String, default: "" },
    roleStatus: {
      type: String,
      enum: ["chua_ket_noi_vi", "cho_duyet", "da_duyet"],
      default: "chua_ket_noi_vi",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);

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
 * `roleStatus` theo dõi việc ví của tài khoản này đã được CẤP QUYỀN ON-CHAIN
 * hay chưa — chỉ là nhãn hiển thị; nguồn sự thật vẫn là contract.hasRole().
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

    // --- Ví liên kết (đã chứng minh sở hữu bằng chữ ký SIWE) ---
    walletAddress: { type: String, default: "" },
    walletVerifiedAt: { type: Date, default: null },
    // Ví trước đó + thời điểm đổi — để admin thấy rõ "ví cũ → ví mới" khi
    // duyệt, chống kịch bản kẻ tấn công chiếm tài khoản rồi đổi sang ví của họ.
    previousWallet: { type: String, default: "" },
    walletChangedAt: { type: Date, default: null },
    // Nonce dùng 1 lần cho tin nhắn ký liên kết ví
    walletNonce: { type: String, default: "" },
    walletNonceFor: { type: String, default: "" }, // ví mà nonce này được cấp cho
    walletNonceExpires: { type: Date, default: null },

    roleStatus: {
      type: String,
      enum: ["chua_ket_noi_vi", "cho_duyet", "da_duyet"],
      default: "chua_ket_noi_vi",
    },

    // --- Bảo vệ phiên đăng nhập ---
    // Tăng số này = mọi JWT đã cấp trước đó lập tức mất hiệu lực
    tokenVersion: { type: Number, default: 0 },
    // Admin khoá tài khoản khi nghi bị chiếm (không đăng nhập được nữa)
    disabled: { type: Boolean, default: false },
    // Khoá tạm theo tài khoản sau nhiều lần sai mật khẩu (chống dò mật khẩu
    // phân tán từ nhiều IP — rate-limit theo IP không chặn được kiểu này)
    failedLogins: { type: Number, default: 0 },
    lockUntil: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
    lastLoginIp: { type: String, default: "" },
    // Các IP đã từng đăng nhập thành công (tối đa 20 gần nhất) — IP ngoài
    // danh sách này → báo cho chính chủ "đăng nhập từ IP mới"
    knownIps: { type: [String], default: [] },

    // --- Xác thực 2 lớp (TOTP) ---
    twoFactorEnabled: { type: Boolean, default: false },
    twoFactorSecret: { type: String, default: "" }, // đã mã hoá AES-GCM
    twoFactorPendingSecret: { type: String, default: "" }, // đang cài, chưa xác nhận
    twoFactorLastStep: { type: Number, default: -1 }, // chống dùng lại cùng 1 mã
    backupCodeHashes: { type: [String], default: [] },

    // --- Passkey (WebAuthn): chỉ lưu KHOÁ CÔNG KHAI, khoá bí mật nằm trong thiết bị ---
    passkeys: {
      type: [
        new mongoose.Schema(
          {
            credId: { type: String, required: true },
            publicKeyJwk: { type: mongoose.Schema.Types.Mixed, required: true },
            alg: { type: Number, required: true },
            signCount: { type: Number, default: 0 },
            name: { type: String, default: "Passkey" },
            transports: { type: [String], default: [] },
            createdAt: { type: Date, default: Date.now },
            lastUsedAt: { type: Date, default: null },
          },
          { _id: false }
        ),
      ],
      default: [],
    },

    // --- Telegram cá nhân (nhận cảnh báo đăng nhập + nút "Không phải tôi") ---
    telegramChatId: { type: String, default: "" },
    telegramLinkCode: { type: String, default: "" },
    telegramLinkExpires: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);

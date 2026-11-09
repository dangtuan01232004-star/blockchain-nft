const mongoose = require("mongoose");

/**
 * Mã cào dùng 1 lần của một sản phẩm (in dưới lớp bạc cạnh mã QR).
 *
 * KHÔNG lưu mã gốc — chỉ lưu `codeHash` = HMAC-SHA256(khoá bí mật của
 * server, contract:tokenId:mã). Lộ toàn bộ database cũng không suy ra được
 * mã nào, vì không có khoá để thử. Mã gốc chỉ hiện ĐÚNG 1 LẦN lúc phát hành
 * để in tem.
 *
 * Người mua cào tem → quét QR → nhập mã → trở thành chủ sở hữu. Trình duyệt
 * của họ giữ `ownerToken` (server chỉ lưu bản băm) để lần sau quét lại được
 * nhận ra là "sản phẩm của bạn".
 */
const productClaimSchema = new mongoose.Schema(
  {
    contract: { type: String, required: true, lowercase: true },
    tokenId: { type: String, required: true },

    codeHash: { type: String, required: true },
    codeVersion: { type: Number, default: 1 }, // tăng mỗi lần cấp lại mã
    codeIssuedAt: { type: Date, default: Date.now },
    codeIssuedBy: { type: String, default: "" },

    claimedAt: { type: Date, default: null },
    ownerTokenHash: { type: String, default: "" },
    // Liên hệ của chủ sở hữu (để khôi phục khi đổi điện thoại) — mã hoá
    contactEnc: { type: String, default: "" },
    contactMasked: { type: String, default: "" },

    // Chống đoán mã
    failedAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },

    // Số lần người quét báo "nghi hàng giả"
    reportCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

productClaimSchema.index({ contract: 1, tokenId: 1 }, { unique: true });

module.exports = mongoose.model("ProductClaim", productClaimSchema);

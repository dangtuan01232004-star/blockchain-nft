const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");

const QR_DIR = path.join(__dirname, "..", "data", "qrcodes");
fs.mkdirSync(QR_DIR, { recursive: true });

/**
 * Tạo mã QR chứa link xác thực sản phẩm và lưu ra file PNG.
 * Link nhúng trong QR trỏ tới trang xác thực frontend kèm tokenId,
 * ví dụ: http://localhost:5173/verify.html?tokenId=0
 */
async function generateProductQRCode(tokenId) {
  const verifyUrl = `${process.env.FRONTEND_VERIFY_URL || "http://localhost:5173/verify.html"}?tokenId=${tokenId}`;

  const filePath = path.join(QR_DIR, `${tokenId}.png`);
  await QRCode.toFile(filePath, verifyUrl, {
    errorCorrectionLevel: "H",
    margin: 2,
    width: 512,
    color: { dark: "#0f172a", light: "#ffffff" },
  });

  const dataUrl = await QRCode.toDataURL(verifyUrl, { errorCorrectionLevel: "H" });

  return { verifyUrl, filePath, dataUrl };
}

module.exports = { generateProductQRCode, QR_DIR };

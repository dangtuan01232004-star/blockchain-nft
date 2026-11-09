const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");

const QR_DIR = path.join(__dirname, "..", "data", "qrcodes");
fs.mkdirSync(QR_DIR, { recursive: true });

function getProductVerifyURL(tokenId) {
  const verifyUrl = new URL(
    process.env.FRONTEND_VERIFY_URL || "http://localhost:5173/verify.html"
  );
  verifyUrl.searchParams.set("tokenId", String(tokenId));
  return verifyUrl.href;
}

/**
 * Tạo mã QR chứa link xác thực sản phẩm và lưu ra file PNG.
 * Link nhúng trong QR trỏ tới trang xác thực frontend kèm tokenId,
 * ví dụ: http://localhost:5173/verify.html?tokenId=0
 */
async function generateProductQRCode(tokenId) {
  const verifyUrl = getProductVerifyURL(tokenId);

  const filePath = path.join(QR_DIR, `${tokenId}.png`);
  await saveQRCode(filePath, verifyUrl);

  const dataUrl = await QRCode.toDataURL(verifyUrl, { errorCorrectionLevel: "H" });

  return { verifyUrl, filePath, dataUrl };
}

async function ensureProductQRCode(tokenId) {
  const verifyUrl = getProductVerifyURL(tokenId);
  const filePath = path.join(QR_DIR, `${tokenId}.png`);
  const urlFilePath = path.join(QR_DIR, `${tokenId}.url`);
  const savedVerifyUrl = fs.existsSync(urlFilePath)
    ? fs.readFileSync(urlFilePath, "utf8")
    : "";

  if (!fs.existsSync(filePath) || savedVerifyUrl !== verifyUrl) {
    await saveQRCode(filePath, verifyUrl);
  }

  return { verifyUrl, filePath };
}

async function saveQRCode(filePath, verifyUrl) {
  await QRCode.toFile(filePath, verifyUrl, {
    errorCorrectionLevel: "H",
    margin: 2,
    width: 512,
    color: { dark: "#0f172a", light: "#ffffff" },
  });
  fs.writeFileSync(filePath.replace(/\.png$/, ".url"), verifyUrl, "utf8");
}

module.exports = { generateProductQRCode, ensureProductQRCode, getProductVerifyURL, QR_DIR };

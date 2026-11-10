require("dotenv").config();
if (!process.env.JWT_SECRET) {
  console.error("Thiếu JWT_SECRET — backend sẽ dừng để tránh dùng secret mặc định không an toàn.");
  process.exit(1);
}
// Chặn secret yếu / chuỗi mẫu trong .env.example: ai biết secret này đều
// tự tạo được token admin giả mà không cần mật khẩu.
{
  const secret = process.env.JWT_SECRET;
  const isProd = process.env.NODE_ENV === "production" || process.env.RENDER === "true";
  const weak = secret.length < 32 || /doi-chuoi-nay|changeme|secret/i.test(secret);
  if (weak && isProd) {
    console.error(
      "JWT_SECRET quá yếu hoặc vẫn là chuỗi mẫu — backend dừng lại. Tạo chuỗi mới bằng:\n" +
        "  node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\"\n" +
        "rồi đặt vào Render → Environment → JWT_SECRET."
    );
    process.exit(1);
  } else if (weak) {
    console.warn("⚠ JWT_SECRET đang yếu / là chuỗi mẫu — chỉ chấp nhận khi chạy local. Đổi trước khi deploy.");
  }
}
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const path = require("path");

const productsRouter = require("./routes/products");
const contractRouter = require("./routes/contract");
const partnersRouter = require("./routes/partners");
const authRouter = require("./routes/auth");
const shopRouter = require("./routes/shop");
const telegramRouter = require("./routes/telegram");
const { clientIpMiddleware } = require("./services/clientIp");
const mongoose = require("mongoose");
const { getKey } = require("./services/crypto");
const { runOrderPrivacyMaintenance } = require("./services/orderPrivacy");
const { METADATA_DIR, PHOTOS_DIR } = require("./services/storage");
const { QR_DIR } = require("./services/qrcode");
const { resetCacheIfContractChanged } = require("./services/cacheReset");
const { connectDB } = require("./services/db");

// Chạy NGAY lúc khởi động, trước khi mount route nào — đảm bảo cache
// sản phẩm/đối tác không bao giờ lẫn dữ liệu của một contract đã deploy lại.
resetCacheIfContractChanged();

// Khoá mã hoá dữ liệu cá nhân phải có trước khi nhận đơn hàng nào
try {
  getKey();
} catch (err) {
  console.error(err.message + "\nTạo khoá: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
  process.exit(1);
}

connectDB();

// Bảo vệ dữ liệu đơn hàng: mã hoá đơn cũ + xoá thông tin quá hạn — chạy khi
// kết nối DB xong và mỗi 6 giờ (Render Free ngủ thì monitor.js chạy bù)
mongoose.connection.once("open", () => {
  const run = () => runOrderPrivacyMaintenance().catch((err) => console.error("Lỗi bảo trì dữ liệu đơn hàng:", err.message));
  run();
  setInterval(run, 6 * 60 * 60 * 1000).unref();
});

const app = express();
app.set("trust proxy", 1);
// Lấy IP THẬT của người dùng (Render có nhiều tầng proxy — xem services/clientIp.js).
// Phải đặt TRƯỚC mọi middleware dùng req.ip (giới hạn số lần thử, ghi nhật ký...).
app.use(clientIpMiddleware);
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));

const allowedOrigins = new Set(
  (process.env.FRONTEND_ORIGIN || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);
if (allowedOrigins.size === 0) {
  console.warn(
    process.env.NODE_ENV === "production"
      ? "FRONTEND_ORIGIN chưa được cấu hình; trình duyệt cross-origin sẽ không được CORS cho phép."
      : "FRONTEND_ORIGIN chưa được cấu hình; chỉ origin localhost mới được CORS cho phép trong môi trường phát triển."
  );
}
app.use(cors({
  origin(origin, callback) {
    let isLocalDevelopmentOrigin = false;
    if (allowedOrigins.size === 0 && process.env.NODE_ENV !== "production" && origin) {
      try {
        const url = new URL(origin);
        isLocalDevelopmentOrigin =
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      } catch {
        isLocalDevelopmentOrigin = false;
      }
    }
    callback(null, !origin || allowedOrigins.has(origin) || isLocalDevelopmentOrigin);
  },
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Quá nhiều lần đăng nhập. Vui lòng thử lại sau 15 phút." },
});
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Quá nhiều lần đăng ký. Vui lòng thử lại sau." },
});
const orderLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Quá nhiều yêu cầu đặt hàng. Vui lòng thử lại sau." },
});

const walletLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Quá nhiều yêu cầu liên kết ví. Vui lòng thử lại sau." },
});

const accountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Quá nhiều yêu cầu. Vui lòng thử lại sau." },
});

app.use("/api/auth/login", loginLimiter); // gồm cả /login/2fa
app.use("/api/auth/me/password", accountLimiter);
app.use("/api/auth/me/2fa", accountLimiter);
app.use("/api/auth/me/wallet", walletLimiter);
app.use("/api/auth/register", registerLimiter);
app.post("/api/shop/orders", orderLimiter);
app.use(express.json({ limit: "5mb" }));

// "IPFS gateway" cục bộ cho metadata NFT
app.get("/metadata/:tokenId", (req, res) => {
  const filePath = path.join(METADATA_DIR, `${req.params.tokenId}.json`);
  res.sendFile(filePath, (err) => {
    if (err) res.status(404).json({ error: "Không tìm thấy metadata" });
  });
});

// Phục vụ ảnh QR code đã tạo
app.use("/qrcodes", express.static(QR_DIR));

// Phục vụ ảnh chụp chuỗi cung ứng lưu cục bộ (khi chưa cấu hình Pinata)
app.use("/photos", express.static(PHOTOS_DIR));

app.use("/api/products", productsRouter);
app.use("/api/contract", contractRouter);
app.use("/api/partners", partnersRouter);
app.use("/api/auth", authRouter);
app.use("/api/shop", shopRouter);
app.use("/api/telegram", telegramRouter);

app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Backend truy xuất nguồn gốc đang chạy tại http://localhost:${PORT}`);
});

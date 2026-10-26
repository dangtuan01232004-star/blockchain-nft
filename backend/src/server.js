require("dotenv").config();
if (!process.env.JWT_SECRET) {
  console.error("Thiếu JWT_SECRET — backend sẽ dừng để tránh dùng secret mặc định không an toàn.");
  process.exit(1);
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
const { METADATA_DIR, PHOTOS_DIR } = require("./services/storage");
const { QR_DIR } = require("./services/qrcode");
const { resetCacheIfContractChanged } = require("./services/cacheReset");
const { connectDB } = require("./services/db");

// Chạy NGAY lúc khởi động, trước khi mount route nào — đảm bảo cache
// sản phẩm/đối tác không bao giờ lẫn dữ liệu của một contract đã deploy lại.
resetCacheIfContractChanged();
connectDB();

const app = express();
app.set("trust proxy", 1);
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
  console.warn("FRONTEND_ORIGIN chưa được cấu hình; trình duyệt cross-origin sẽ không được CORS cho phép.");
}
app.use(cors({
  origin(origin, callback) {
    callback(null, !origin || allowedOrigins.has(origin));
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

app.use("/api/auth/login", loginLimiter);
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

app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Backend truy xuất nguồn gốc đang chạy tại http://localhost:${PORT}`);
});

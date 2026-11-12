const crypto = require("crypto");
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
const { parseAllowedOrigins, makeOriginChecker } = require("./services/corsPolicy");
const { maskErrorBody } = require("./services/errorMask");
const { rateLimit } = require("express-rate-limit");
const path = require("path");

const productsRouter = require("./routes/products");
const contractRouter = require("./routes/contract");
const partnersRouter = require("./routes/partners");
const authRouter = require("./routes/auth");
const shopRouter = require("./routes/shop");
const telegramRouter = require("./routes/telegram");
const { clientIpMiddleware } = require("./services/clientIp");
const { reportRateLimited, reportApiFlood } = require("./services/loginGuard");
const { ipBlockMiddleware } = require("./services/ipBlock");
const { probeDetectMiddleware } = require("./services/probeDetect");
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
// IP trong danh sách chặn → từ chối mọi API ngay từ đầu (webhook Telegram vẫn đi qua)
app.use("/api", (req, res, next) => (req.path.startsWith("/telegram/") ? next() : ipBlockMiddleware(req, res, next)));
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));

const PRODUCTION = process.env.NODE_ENV === "production";
const { allowed: allowedOrigins, rejected: rejectedOrigins } = parseAllowedOrigins(process.env.FRONTEND_ORIGIN, {
  production: PRODUCTION,
});
for (const [value, why] of rejectedOrigins) {
  console.warn(`⚠ CORS: bỏ qua FRONTEND_ORIGIN "${value}" — ${why}`);
}
if (allowedOrigins.size === 0) {
  console.warn(
    PRODUCTION
      ? "FRONTEND_ORIGIN chưa được cấu hình; trình duyệt cross-origin sẽ không được CORS cho phép."
      : "FRONTEND_ORIGIN chưa được cấu hình; chỉ origin localhost mới được CORS cho phép trong môi trường phát triển."
  );
} else {
  console.log("CORS chỉ cho phép: " + [...allowedOrigins].join(", "));
}
const originAllowed = makeOriginChecker(allowedOrigins, { production: PRODUCTION });
app.use(cors({
  // KHÔNG dùng "*": chỉ trả Access-Control-Allow-Origin cho đúng tên miền trong danh sách
  origin(origin, callback) {
    callback(null, originAllowed(origin));
  },
  // Cho trình duyệt gửi/nhận cookie đăng nhập HttpOnly giữa frontend và backend (khác tên miền)
  credentials: true,
  methods: ["GET", "HEAD", "POST", "PATCH", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization", "X-CSRF-Token", "X-Background-Check", "X-Device-Id", "X-Owner-Token"],
  maxAge: 600,
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Quá nhiều lần đăng nhập. Vui lòng thử lại sau 15 phút." },
  // Bị chặn = dấu hiệu dò mật khẩu → báo admin (mỗi IP tối đa 1 lần / 15 phút)
  handler: (req, res, next, options) => {
    reportRateLimited(req.ip, req.originalUrl).catch(() => {});
    res.status(options.statusCode).json(options.message);
  },
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
app.use("/api/auth/passkey", accountLimiter);
app.use("/api/auth/me/passkeys", accountLimiter);
app.use("/api/auth/me/wallet", walletLimiter);
app.use("/api/auth/register", registerLimiter);
app.post("/api/shop/orders", orderLimiter);
// Giới hạn chung cho TOÀN BỘ API — chống gọi dồn làm sập server (Render Free yếu)
// và chống công cụ quét lỗ hổng. Các route nhạy cảm vẫn có giới hạn chặt hơn ở trên.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.API_RATE_LIMIT_PER_MIN || 300),
  standardHeaders: true,
  legacyHeaders: false,
  // Webhook Telegram đến từ server Telegram, đã có secret token riêng
  skip: (req) => req.path.startsWith("/telegram/"),
  handler: (req, res, next, options) => {
    reportApiFlood(req.ip, req.originalUrl).catch(() => {});
    res.status(options.statusCode).json({ error: "Bạn gửi quá nhiều yêu cầu. Vui lòng chờ 1 phút rồi thử lại." });
  },
});
app.use("/api", apiLimiter);

// KHÔNG lộ chi tiết lỗi nội bộ (tên thư viện, đường dẫn, lỗi DB/Pinata...) ra ngoài:
// mọi phản hồi lỗi 500 được thay bằng câu chung + MÃ LỖI; chi tiết thật chỉ ghi vào log
// để admin tra theo mã lỗi.
app.use((req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body) => {
    // 5xx: luôn thay bằng câu chung + mã lỗi. 4xx: thay nếu nội dung là lỗi kỹ thuật.
    const safe = maskErrorBody(res.statusCode, body, (ref, original) =>
      console.error(`[Lỗi ${ref}] ${res.statusCode} ${req.method} ${req.originalUrl} → ${original}`)
    );
    return json(safe || body);
  };
  next();
});

app.use(express.json({ limit: "5mb" }));
// Phát hiện kẻ đang DÒ LỖ HỔNG (XSS / SQLi / NoSQL / ../ / công cụ quét) → chặn + báo động + tự chặn IP
app.use("/api", probeDetectMiddleware);

// "IPFS gateway" cục bộ cho metadata NFT
app.get("/metadata/:tokenId", (req, res) => {
  // Chỉ nhận số — chặn "../" dò đọc file khác trên server (path traversal)
  if (!/^\d{1,12}$/.test(req.params.tokenId)) return res.status(404).json({ error: "Không tìm thấy metadata" });
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

// API không tồn tại → 404 dạng JSON (không lộ trang lỗi mặc định của Express)
app.use("/api", (req, res) => res.status(404).json({ error: "Không tìm thấy API" }));
// Đường dẫn lạ ngoài /api: trả JSON gọn thay cho trang lỗi mặc định "Cannot GET /..." của Express
app.use((req, res) => res.status(404).json({ error: "Không tìm thấy" }));

// Lỗi không bắt được (JSON sai cú pháp, file quá lớn, lỗi lập trình...) → KHÔNG trả stack trace
app.use((err, req, res, next) => {
  if (err && err.type === "entity.parse.failed") return res.status(400).json({ error: "Dữ liệu gửi lên không đúng định dạng JSON" });
  if (err && (err.type === "entity.too.large" || err.code === "LIMIT_FILE_SIZE")) {
    return res.status(413).json({ error: "Dữ liệu/tệp gửi lên quá lớn" });
  }
  // Lỗi lập trình / thư viện: chỉ ghi log, ra ngoài là câu chung + mã lỗi (qua lớp che ở trên)
  console.error("Lỗi không xử lý:", err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "internal" });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Backend truy xuất nguồn gốc đang chạy tại http://localhost:${PORT}`);
});

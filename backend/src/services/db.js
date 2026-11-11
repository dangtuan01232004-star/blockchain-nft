const mongoose = require("mongoose");

/**
 * Kết nối MongoDB — dùng để lưu tài khoản người dùng (đăng nhập trang
 * quản trị). KHÔNG dùng để lưu dữ liệu sản phẩm/chuỗi cung ứng — nguồn dữ
 * liệu thật của những thứ đó vẫn là blockchain (xem README mục "Vì sao
 * dùng JSON thay vì database" để hiểu rõ nguyên tắc source-of-truth).
 *
 * Bảo mật kết nối:
 *  - Bắt buộc mã hoá đường truyền (TLS) khi DB không nằm trên máy local.
 *  - strictQuery: bỏ qua trường lạ trong điều kiện truy vấn.
 *  - Sau khi kết nối, TỰ KIỂM TRA QUYỀN của user DB: nếu là admin toàn cụm
 *    (atlasAdmin, root, readWriteAnyDatabase...) → cảnh báo, vì backend chỉ
 *    cần readWrite trên đúng 1 database (nguyên tắc quyền tối thiểu).
 */

// Quyền "quá rộng" — lộ chuỗi kết nối là mất toàn bộ cụm, kể cả DB khác
const OVERPRIVILEGED_ROLES = new Set([
  "atlasAdmin",
  "root",
  "dbAdminAnyDatabase",
  "readWriteAnyDatabase",
  "userAdminAnyDatabase",
  "clusterAdmin",
  "dbOwner",
  "userAdmin",
]);

function isLocalHost(uri) {
  return /^mongodb:\/\/([^@]+@)?(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$|\?)/i.test(uri);
}

/** Kiểm tra chuỗi kết nối; trả về danh sách vấn đề (rỗng = ổn) */
function auditConnectionString(uri) {
  const problems = [];
  const local = isLocalHost(uri);
  const srv = uri.startsWith("mongodb+srv://");
  const tlsOff = /[?&](tls|ssl)=false/i.test(uri);
  const tlsOn = /[?&](tls|ssl)=true/i.test(uri);
  if (!local && (tlsOff || (!srv && !tlsOn))) {
    problems.push("Kết nối DB qua Internet KHÔNG bật TLS — mật khẩu và dữ liệu có thể bị nghe lén. Dùng chuỗi mongodb+srv:// của Atlas hoặc thêm tls=true.");
  }
  if (/tlsAllowInvalidCertificates=true|tlsInsecure=true/i.test(uri)) {
    problems.push("Chuỗi kết nối TẮT kiểm tra chứng chỉ TLS (tlsAllowInvalidCertificates/tlsInsecure) — dễ bị tấn công giả mạo server.");
  }
  if (!local && !/^mongodb(\+srv)?:\/\/[^:/@]+:[^@]+@/.test(uri)) {
    problems.push("Chuỗi kết nối không có user/mật khẩu — DB đang mở không xác thực?");
  }
  return problems;
}

/** Hỏi MongoDB: user đang dùng có những quyền gì */
async function checkDbPrivileges(conn = mongoose.connection) {
  const status = await conn.db.admin().command({ connectionStatus: 1 });
  const roles = (status.authInfo && status.authInfo.authenticatedUserRoles) || [];
  const users = (status.authInfo && status.authInfo.authenticatedUsers) || [];
  const tooBroad = roles.filter((r) => OVERPRIVILEGED_ROLES.has(r.role));
  return { roles, user: users[0] ? users[0].user : "", tooBroad, dbName: conn.db.databaseName };
}

async function reportDbSecurity(problems, priv) {
  const lines = [...problems];
  if (priv && priv.tooBroad.length) {
    lines.push(
      `User DB "${priv.user}" có quyền QUÁ RỘNG (${priv.tooBroad.map((r) => `${r.role}@${r.db}`).join(", ")}). ` +
        `Backend chỉ cần quyền readWrite trên database "${priv.dbName}". Vào Atlas → Database Access để hạ quyền.`
    );
  }
  if (!lines.length) {
    if (priv) console.log(`✓ Bảo mật DB: TLS bật, user "${priv.user}" quyền ${priv.roles.map((r) => `${r.role}@${r.db}`).join(", ") || "(không rõ)"}`);
    return;
  }
  for (const l of lines) console.warn("⚠ Bảo mật DB: " + l);
  try {
    // Nạp muộn để tránh vòng phụ thuộc (alerts → AuditLog → mongoose)
    const { securityEvent } = require("./alerts");
    await securityEvent({
      type: "db_config_weak",
      severity: "warning",
      message: "Cấu hình cơ sở dữ liệu chưa an toàn: " + lines.join(" | "),
      dedupeKey: `db_config_weak:${new Date().toISOString().slice(0, 10)}`,
    });
  } catch {
    /* không chặn khởi động */
  }
}

async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn(
      "⚠ Chưa cấu hình MONGODB_URI trong .env — tính năng đăng nhập/đăng ký sẽ không hoạt động " +
      "(các phần khác của hệ thống vẫn chạy bình thường)."
    );
    return;
  }

  const problems = auditConnectionString(uri);
  // Môi trường production (Render) mà kết nối không mã hoá → từ chối, không gửi mật khẩu đi
  if (process.env.NODE_ENV === "production" && problems.some((p) => p.includes("TLS"))) {
    console.error("✗ Từ chối kết nối MongoDB: " + problems.join(" "));
    return;
  }

  mongoose.set("strictQuery", true);
  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 15000,
      maxPoolSize: 10,
      appName: "nfttrace-backend",
    });
    console.log("Đã kết nối MongoDB thành công.");
  } catch (err) {
    // Không in cả chuỗi kết nối (có mật khẩu) ra log
    console.error("Lỗi kết nối MongoDB:", String(err.message).replace(/\/\/[^@]+@/g, "//***@"));
    return;
  }

  let priv = null;
  try {
    priv = await checkDbPrivileges();
  } catch (err) {
    console.warn("Không kiểm tra được quyền user DB:", err.message);
  }
  await reportDbSecurity(problems, priv);
}

module.exports = { connectDB, auditConnectionString, checkDbPrivileges, OVERPRIVILEGED_ROLES };

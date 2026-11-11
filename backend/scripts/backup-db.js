/**
 * Sao lưu MongoDB ra 1 file ĐÃ MÃ HOÁ (AES-256-GCM) — gói Atlas M0 miễn phí
 * không có backup tự động nên cần chạy định kỳ (vd. mỗi tuần, trước khi demo).
 *
 *   cd backend
 *   node scripts/backup-db.js
 *
 * Cần trong backend/.env (hoặc biến môi trường):
 *   MONGODB_URI   chuỗi kết nối (user chỉ cần quyền read)
 *   BACKUP_KEY    64 ký tự hex — KHÁC DATA_ENCRYPTION_KEY, cất riêng
 *
 * File ra: backend/backups/nfttrace-<thời gian>.bak (thư mục đã .gitignore).
 * Dữ liệu nhạy cảm bên trong (SĐT, địa chỉ) vốn đã mã hoá bằng DATA_ENCRYPTION_KEY,
 * file backup được mã hoá THÊM một lớp nữa → lộ file backup cũng không đọc được.
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { pack, parseKey } = require("./lib/backupFormat");

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("Thiếu MONGODB_URI");
  parseKey(process.env.BACKUP_KEY); // kiểm tra khoá trước khi kết nối

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000, appName: "nfttrace-backup" });
  const db = mongoose.connection.db;
  const cols = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((c) => c.name)
    .filter((n) => !n.startsWith("system."));

  const dump = { createdAt: new Date(), database: db.databaseName, collections: {}, indexes: {} };
  for (const name of cols) {
    dump.collections[name] = await db.collection(name).find({}).toArray();
    dump.indexes[name] = (await db.collection(name).indexes()).filter((ix) => ix.name !== "_id_");
    console.log(`  ${name}: ${dump.collections[name].length} bản ghi`);
  }
  await mongoose.disconnect();

  const out = pack(dump, process.env.BACKUP_KEY, mongoose.mongo.BSON.EJSON);
  const dir = path.join(__dirname, "..", "backups");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `nfttrace-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.bak`);
  fs.writeFileSync(file, out);
  const sha = require("crypto").createHash("sha256").update(out).digest("hex");
  console.log(`\n✓ Đã sao lưu ${cols.length} collection → ${path.relative(process.cwd(), file)}`);
  console.log(`  Kích thước: ${(out.length / 1024).toFixed(1)} KB · SHA-256: ${sha.slice(0, 16)}…`);
  console.log("  Cất file này ra ngoài (Google Drive/ổ cứng). Khoá BACKUP_KEY cất ở chỗ KHÁC.");
}

main().catch((e) => {
  console.error("✗ " + String(e.message).replace(/\/\/[^@]+@/g, "//***@"));
  process.exit(1);
});

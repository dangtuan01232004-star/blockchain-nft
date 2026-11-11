/**
 * Khôi phục MongoDB từ file sao lưu đã mã hoá.
 *
 *   Xem trước (không ghi gì):   node scripts/restore-db.js backups/nfttrace-....bak
 *   Khôi phục thật:             node scripts/restore-db.js backups/nfttrace-....bak --yes
 *   Xoá dữ liệu hiện có trước:  thêm --drop  (CẨN THẬN: mất dữ liệu mới hơn bản backup)
 *
 * Cần: MONGODB_URI (DB đích), BACKUP_KEY (đúng khoá lúc sao lưu).
 * Bản ghi trùng _id được BỎ QUA (không ghi đè) nếu không dùng --drop.
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const mongoose = require("mongoose");
const { unpack } = require("./lib/backupFormat");

async function main() {
  const file = process.argv[2];
  const yes = process.argv.includes("--yes");
  const drop = process.argv.includes("--drop");
  if (!file || !fs.existsSync(file)) throw new Error("Cách dùng: node scripts/restore-db.js <file.bak> [--yes] [--drop]");

  const dump = unpack(fs.readFileSync(file), process.env.BACKUP_KEY, mongoose.mongo.BSON.EJSON);
  console.log(`File sao lưu lúc ${new Date(dump.createdAt).toLocaleString("vi-VN")} · DB gốc: ${dump.database}`);
  for (const [name, docs] of Object.entries(dump.collections)) console.log(`  ${name}: ${docs.length} bản ghi`);
  if (!yes) {
    console.log("\n(Chế độ xem trước — chưa ghi gì. Thêm --yes để khôi phục thật.)");
    return;
  }

  if (!process.env.MONGODB_URI) throw new Error("Thiếu MONGODB_URI");
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000, appName: "nfttrace-restore" });
  const db = mongoose.connection.db;
  for (const [name, docs] of Object.entries(dump.collections)) {
    const col = db.collection(name);
    if (drop) await col.deleteMany({});
    let inserted = 0;
    if (docs.length) {
      try {
        const r = await col.insertMany(docs, { ordered: false });
        inserted = r.insertedCount;
      } catch (e) {
        if (e.code !== 11000 && !(e.writeErrors || []).every((w) => w.code === 11000)) throw e;
        inserted = e.result ? e.result.insertedCount : (e.insertedCount || 0);
      }
    }
    for (const ix of dump.indexes[name] || []) {
      const { key, name: ixName, v, ns, ...opts } = ix;
      await col.createIndex(key, { name: ixName, ...opts }).catch(() => {});
    }
    console.log(`  ✓ ${name}: thêm ${inserted}/${docs.length}`);
  }
  await mongoose.disconnect();
  console.log("\n✓ Khôi phục xong.");
}

main().catch((e) => {
  console.error("✗ " + String(e.message).replace(/\/\/[^@]+@/g, "//***@"));
  process.exit(1);
});

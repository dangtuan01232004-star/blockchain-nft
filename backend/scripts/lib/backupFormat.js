/**
 * Định dạng file sao lưu: gzip(EJSON) rồi mã hoá AES-256-GCM.
 *   [ "NFTB1" (5 byte) | iv (12) | tag (16) | dữ liệu mã hoá ]
 * EJSON giữ đúng kiểu ObjectId / Date / Binary khi khôi phục.
 */
const crypto = require("crypto");
const zlib = require("zlib");

const MAGIC = Buffer.from("NFTB1");

function parseKey(hex) {
  const k = String(hex || "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(k)) {
    throw new Error(
      "BACKUP_KEY phải là 64 ký tự hex (32 byte). Tạo bằng:\n" +
        "  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"\n" +
        "Cất khoá này RIÊNG (trình quản lý mật khẩu), KHÔNG để chung chỗ với file backup."
    );
  }
  return Buffer.from(k, "hex");
}

function pack(dump, keyHex, EJSON) {
  const key = parseKey(keyHex);
  const json = EJSON.stringify(dump, { relaxed: false });
  const gz = zlib.gzipSync(Buffer.from(json, "utf8"));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(MAGIC);
  const enc = Buffer.concat([cipher.update(gz), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), enc]);
}

function unpack(buf, keyHex, EJSON) {
  const key = parseKey(keyHex);
  if (!buf.subarray(0, 5).equals(MAGIC)) throw new Error("Không phải file sao lưu NFTTrace (sai định dạng).");
  const iv = buf.subarray(5, 17);
  const tag = buf.subarray(17, 33);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);
  let gz;
  try {
    gz = Buffer.concat([decipher.update(buf.subarray(33)), decipher.final()]);
  } catch {
    throw new Error("Giải mã thất bại: SAI BACKUP_KEY hoặc file backup đã bị sửa/hỏng.");
  }
  return EJSON.parse(zlib.gunzipSync(gz).toString("utf8"), { relaxed: false });
}

module.exports = { pack, unpack, parseKey };

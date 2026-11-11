/**
 * Kiểm tra + làm sạch ảnh TRƯỚC khi đưa lên IPFS (công khai, không xoá được).
 *
 *  1. Chỉ nhận JPEG / PNG / WebP — xác định bằng "magic bytes" (nội dung thật
 *     của file), KHÔNG tin đuôi file hay mimetype trình duyệt gửi lên.
 *     → chặn upload HTML/SVG chứa script, file .exe đổi tên thành .jpg...
 *  2. Xoá metadata: EXIF (toạ độ GPS nơi chụp, đời máy, giờ chụp), XMP,
 *     ICC/IPTC, comment — ảnh chụp kho/xưởng bằng điện thoại không làm lộ vị trí.
 *
 * Không dùng thư viện ngoài, không nén lại ảnh (giữ nguyên chất lượng).
 */

class ImageRejectedError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function detectType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

// ---------------- JPEG ----------------
// Giữ: APP0 (JFIF), APP14 (Adobe — cần cho màu CMYK), mọi segment ảnh (DQT, SOF, DHT, SOS...).
// Bỏ: APP1 (EXIF/XMP), APP2 (ICC/FlashPix), APP3–APP13 (IPTC...), APP15, COM.
function stripJpeg(buf) {
  const out = [buf.subarray(0, 2)]; // SOI
  let i = 2;
  const removed = [];
  while (i < buf.length) {
    if (buf[i] !== 0xff) throw new ImageRejectedError("File JPEG bị hỏng hoặc không hợp lệ.");
    let marker = buf[i + 1];
    // bỏ qua byte đệm 0xFF
    while (marker === 0xff) { i++; marker = buf[i + 1]; }
    if (marker === 0xda) {
      // SOS: phần dữ liệu ảnh nén — chép nguyên phần còn lại
      out.push(buf.subarray(i));
      break;
    }
    if (marker === 0xd9) { out.push(buf.subarray(i, i + 2)); break; } // EOI
    // marker không có độ dài (RSTn, TEM)
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { out.push(buf.subarray(i, i + 2)); i += 2; continue; }
    if (i + 4 > buf.length) throw new ImageRejectedError("File JPEG bị cắt cụt.");
    const len = buf.readUInt16BE(i + 2);
    const end = i + 2 + len;
    if (len < 2 || end > buf.length) throw new ImageRejectedError("File JPEG bị hỏng (độ dài segment sai).");
    const isApp = marker >= 0xe0 && marker <= 0xef;
    const keep = !(isApp && marker !== 0xe0 && marker !== 0xee) && marker !== 0xfe;
    if (keep) out.push(buf.subarray(i, end));
    else removed.push(marker === 0xfe ? "COM" : `APP${marker - 0xe0}`);
    i = end;
  }
  return { buffer: Buffer.concat(out), removed };
}

// ---------------- PNG ----------------
// Bỏ các chunk metadata; giữ mọi chunk ảnh (IHDR, PLTE, IDAT, IEND, tRNS, gAMA...).
const PNG_DROP = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME", "iCCP"]);
function stripPng(buf) {
  const out = [buf.subarray(0, 8)];
  const removed = [];
  let i = 8;
  let sawEnd = false;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString("ascii", i + 4, i + 8);
    const end = i + 12 + len;
    if (end > buf.length) throw new ImageRejectedError("File PNG bị hỏng (độ dài chunk sai).");
    if (PNG_DROP.has(type)) removed.push(type);
    else out.push(buf.subarray(i, end));
    i = end;
    if (type === "IEND") { sawEnd = true; break; }
  }
  if (!sawEnd) throw new ImageRejectedError("File PNG bị cắt cụt.");
  return { buffer: Buffer.concat(out), removed };
}

// ---------------- WebP ----------------
// Bỏ chunk EXIF / XMP / ICCP, cập nhật cờ trong VP8X và kích thước RIFF.
function stripWebp(buf) {
  const chunks = [];
  const removed = [];
  let i = 12;
  while (i + 8 <= buf.length) {
    const fourcc = buf.toString("ascii", i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    const end = i + 8 + size + (size % 2); // chunk được đệm cho chẵn byte
    if (i + 8 + size > buf.length) throw new ImageRejectedError("File WebP bị hỏng (độ dài chunk sai).");
    if (fourcc === "EXIF" || fourcc === "XMP " || fourcc === "ICCP") removed.push(fourcc.trim());
    else chunks.push(Buffer.from(buf.subarray(i, Math.min(end, buf.length))));
    i = end;
  }
  for (const c of chunks) {
    if (c.toString("ascii", 0, 4) === "VP8X" && c.length >= 9) {
      // bit 5 = ICC, bit 3 = EXIF, bit 2 = XMP
      c[8] &= ~(0x20 | 0x08 | 0x04);
    }
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(4 + body.length, 4);
  header.write("WEBP", 8, "ascii");
  return { buffer: Buffer.concat([header, body]), removed };
}

const MIME = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
const EXT = { jpeg: "jpg", png: "png", webp: "webp" };

/**
 * @returns {{buffer: Buffer, type: string, mimetype: string, ext: string, removed: string[]}}
 * @throws {ImageRejectedError} nếu không phải ảnh JPEG/PNG/WebP hợp lệ
 */
function sanitizeImage(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  const type = detectType(buf);
  if (!type) {
    throw new ImageRejectedError("Chỉ chấp nhận ảnh JPEG, PNG hoặc WebP (đã kiểm tra nội dung file, không dựa vào đuôi file).");
  }
  const fn = { jpeg: stripJpeg, png: stripPng, webp: stripWebp }[type];
  const { buffer, removed } = fn(buf);
  return { buffer, type, mimetype: MIME[type], ext: EXT[type], removed };
}

module.exports = { sanitizeImage, detectType, ImageRejectedError };

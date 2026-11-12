/**
 * CHỐNG NoSQL INJECTION — tương đương "truy vấn tham số hoá" của SQL.
 *
 * MongoDB không ghép chuỗi truy vấn (không có SQL), nên kiểu tấn công
 * `' OR '1'='1` không áp dụng. Nguy cơ tương ứng là ĐƯA OBJECT vào chỗ
 * lẽ ra là giá trị: gửi {"id": {"$ne": ""}} thì findById(id) thành
 * "id khác rỗng" → khớp bản ghi BẤT KỲ.
 *
 * Quy tắc: mọi giá trị lấy từ request (body, query, params, dữ liệu
 * giải mã từ client) trước khi đưa vào điều kiện truy vấn phải đi qua
 * asId()/asText() — chỉ nhận CHUỖI (hoặc số), mọi object/mảng bị loại.
 */

const MAX_ID_LEN = 200;

/** Trả về chuỗi ID an toàn, hoặc null nếu không phải chuỗi/số hợp lệ */
function asId(v) {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  if (!v || v.length > MAX_ID_LEN || v.startsWith("$")) return null;
  return v;
}

/** Ép về chuỗi thuần (object → ""), dùng cho các trường văn bản */
function asText(v, max = 1000) {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return "";
  return v.slice(0, max);
}

module.exports = { asId, asText };

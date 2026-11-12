/**
 * KHÔNG LỘ CHI TIẾT LỖI NỘI BỘ RA NGOÀI.
 *
 * - Lỗi 5xx: LUÔN thay bằng câu chung + mã lỗi (chi tiết chỉ ghi log).
 * - Lỗi 4xx: giữ câu thông báo dành cho người dùng (vd "Sai mật khẩu"),
 *   NHƯNG nếu nội dung trông như lỗi kỹ thuật (TypeError, lỗi Mongo, lỗi
 *   mạng, đường dẫn file, mã lỗi Node/OpenSSL, stack trace...) thì cũng thay
 *   bằng câu chung. Kẻ dò lỗ hổng dựa vào các chi tiết này để biết server
 *   dùng gì, lỗi ở đâu — hệ thống không cho họ manh mối đó.
 */
const crypto = require("crypto");

const INTERNAL_RE = new RegExp(
  [
    "\\b(TypeError|ReferenceError|SyntaxError|RangeError|EvalError)\\b",
    "Cannot (read|set) propert",
    "is not a function",
    "is not defined",
    "\\bundefined\\b",
    "\\b(ECONN\\w*|ETIMEDOUT|ENOTFOUND|ENOENT|EACCES|EPIPE|EAI_AGAIN)\\b",
    "Mongo\\w*Error|MongoServer|E11000|Cast to \\w+ failed|ValidationError|buffering timed out",
    "\\bCBOR\\b",
    "\\bERR_[A-Z0-9_]{3,}",
    "error:[0-9A-F]{8}|routines::|DECODER|OpenSSL",
    "node_modules|/(home|opt|usr|var|app|srv|root)/|[A-Za-z]:\\\\",
    "\\bat \\S+ \\(.*:\\d+:\\d+\\)",
    "\\bstack\\b",
    "could not decode|execution reverted|missing revert data|CALL_EXCEPTION|invalid BigNumber|code=[A-Z_]+",
    "Unexpected token|in JSON at position|JSON\\.parse",
  ].join("|")
);

function newRef() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

/** Có phải thông báo kỹ thuật (không nên cho người ngoài xem) không */
function looksInternal(message) {
  return INTERNAL_RE.test(String(message || ""));
}

/**
 * Trả về body an toàn để gửi ra ngoài (hoặc null = giữ nguyên).
 * @param {number} status mã HTTP
 * @param {object} body   body JSON định gửi
 * @param {(ref:string, original:string)=>void} log ghi chi tiết thật vào log
 */
function maskErrorBody(status, body, log) {
  if (!body || typeof body !== "object" || typeof body.error !== "string") return null;
  if (status >= 500 && status !== 503) {
    const ref = newRef();
    log(ref, body.error);
    return { error: `Lỗi hệ thống, vui lòng thử lại sau. (Mã lỗi: ${ref})`, ref };
  }
  if (status >= 400 && looksInternal(body.error)) {
    const ref = newRef();
    log(ref, body.error);
    const { error, ...rest } = body; // giữ các trường an toàn khác (code, ...)
    return { ...rest, error: `Yêu cầu không hợp lệ hoặc không xử lý được. (Mã lỗi: ${ref})`, ref };
  }
  return null;
}

module.exports = { maskErrorBody, looksInternal, INTERNAL_RE };

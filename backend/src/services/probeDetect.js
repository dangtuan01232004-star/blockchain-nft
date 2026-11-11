/**
 * PHÁT HIỆN DÒ LỖ HỔNG (WAF mini) — XSS, SQL injection, NoSQL injection,
 * path traversal, command injection, template injection, công cụ quét tự động.
 *
 * Ứng dụng ĐÃ an toàn với các payload này (esc() chống XSS, ép kiểu chống NoSQL
 * injection, CSP chặn script lạ...). Lớp này để PHÁT HIỆN kẻ đang dò:
 *   - chặn request đó (400) và ghi nhật ký kèm mẫu payload,
 *   - báo Telegram cho admin "IP x đang dò lỗ hổng" (tối đa 1 tin / IP / 15 phút),
 *   - dò từ PROBE_BLOCK_AFTER lần trở lên (mặc định 3) trong 10 phút → TỰ CHẶN IP.
 * Không soi các trường bí mật (mật khẩu, mã 2FA, chữ ký...) để tránh báo nhầm và
 * không ghi lộ chúng vào nhật ký.
 */
const { securityEvent } = require("./alerts");

const RULES = [
  { cat: "XSS", re: /<\s*script\b|<\s*\/\s*script\s*>|javascript\s*:|\bon(error|load|click|mouseover|focus|toggle|animationstart)\s*=|<\s*(svg|iframe|object|embed)\b[^>]*>|<\s*img\b[^>]*\bon\w+\s*=|document\.cookie|alert\s*\(\s*\d*\s*\)/i },
  { cat: "SQL injection", re: /'\s*(or|and)\s*'?\d+'?\s*=\s*'?\d+|'\s*(or|and)\s*'[^']*'\s*=\s*'|\bunion\b[\s\S]{0,20}\bselect\b|;\s*(drop|delete|truncate|insert|update)\s+(table|from|into)?\b|\bsleep\s*\(\s*\d+\s*\)|\bwaitfor\s+delay\b|\binformation_schema\b|'\s*;\s*--|'\s*--\s*$|\bor\s+1\s*=\s*1\b/i },
  { cat: "NoSQL injection", re: /\$(ne|gt|gte|lt|lte|in|nin|regex|where|exists|expr|or|and)\b/ },
  { cat: "Path traversal", re: /(\.\.[\\/])|(%2e%2e(%2f|%5c|\/))|(\.\.%2f)|\/etc\/passwd|c:\\windows/i },
  { cat: "Command injection", re: /(;|\||&&|`|\$\()\s*(cat|ls|id|whoami|curl|wget|nc|bash|sh|powershell)\b/i },
  { cat: "Template injection", re: /\{\{\s*\d+\s*\*\s*\d+\s*\}\}|\$\{\s*\d+\s*\*\s*\d+\s*\}/ },
];
const SCANNER_UA = /(sqlmap|nikto|nmap|acunetix|nessus|wpscan|dirbuster|gobuster|ffuf|nuclei|masscan|zgrab|havij|w3af|burp\s*suite)/i;
const SECRET_KEYS = /^(password|currentPassword|newPassword|code|mfaToken|credential|signature|message|authSig|token|ownerToken)$/i;

const WINDOW_MS = 10 * 60 * 1000;
const BLOCK_AFTER = Number(process.env.PROBE_BLOCK_AFTER || 3);
const hitsByIp = new Map(); // ip -> { start, count }

function safeDecode(s) {
  let out = String(s || "");
  for (let i = 0; i < 2; i++) {
    try {
      const d = decodeURIComponent(out.replace(/\+/g, " "));
      if (d === out) break;
      out = d;
    } catch {
      break;
    }
  }
  return out;
}

/** Duyệt object: trả về [đường dẫn, giá trị] của mọi chuỗi + phát hiện key bắt đầu bằng $ */
function* walk(obj, path = "", depth = 0) {
  if (depth > 6 || obj === null || obj === undefined) return;
  if (typeof obj === "string") {
    yield [path, obj];
    return;
  }
  if (typeof obj !== "object") return;
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_KEYS.test(k)) continue;
    if (k.startsWith("$")) yield [`${path}.${k}`, k]; // {"username":{"$ne":""}}
    yield* walk(v, path ? `${path}.${k}` : k, depth + 1);
  }
}

function inspect(req) {
  const ua = String(req.headers["user-agent"] || "");
  if (SCANNER_UA.test(ua)) return { cat: "Công cụ quét tự động", where: "User-Agent", sample: ua };
  const sources = [["URL", safeDecode(req.originalUrl)]];
  for (const [p, v] of walk(req.query)) sources.push([`query.${p}`, safeDecode(v)]);
  for (const [p, v] of walk(req.body)) sources.push([`body.${p}`, String(v)]);
  for (const [where, text] of sources) {
    for (const r of RULES) {
      if (r.re.test(text)) return { cat: r.cat, where, sample: text };
    }
  }
  return null;
}

function probeDetectMiddleware(req, res, next) {
  // Webhook Telegram: tin nhắn người dùng gõ tự do, đã xác thực bằng secret riêng
  if (req.path.startsWith("/telegram/")) return next();
  let hit;
  try {
    hit = inspect(req);
  } catch {
    return next();
  }
  if (!hit) return next();

  const ip = req.ip || "";
  const now = Date.now();
  let rec = hitsByIp.get(ip);
  if (!rec || now - rec.start > WINDOW_MS) {
    rec = { start: now, count: 0, cats: new Set() };
    hitsByIp.set(ip, rec);
  }
  rec.count += 1;
  rec.cats.add(hit.cat);
  if (hitsByIp.size > 5000) for (const [k, v] of hitsByIp) if (now - v.start > WINDOW_MS) hitsByIp.delete(k);

  const sample = String(hit.sample).replace(/\s+/g, " ").slice(0, 160);
  (async () => {
    await securityEvent({
      type: "attack_probe",
      severity: "warning",
      message: `IP ${ip} đang DÒ LỖ HỔNG (${[...rec.cats].join(", ")}) — lần ${rec.count}: ${req.method} ${req.path} · ${hit.where} = "${sample}"`,
      ip,
      meta: { category: hit.cat, where: hit.where, sample, path: req.path, count: rec.count },
      // Telegram tối đa 1 tin / IP / 15 phút — các lần sau vẫn ghi nhật ký
      dedupeKey: `probe:${ip}:${Math.floor(now / (15 * 60 * 1000))}`,
    }).then(async (fresh) => {
      if (!fresh) {
        await securityEvent({
          type: "attack_probe_repeat",
          severity: "info",
          message: `Dò lỗ hổng lần ${rec.count} (${hit.cat}): ${req.method} ${req.path} · ${hit.where} = "${sample}"`,
          ip,
        });
      }
    });
    if (rec.count === BLOCK_AFTER) {
      let ipBlock = null;
      try {
        ipBlock = require("./ipBlock"); // có tính năng chặn IP thì tự chặn, không có thì chỉ cảnh báo
      } catch {
        return;
      }
      await ipBlock.blockIp(ip, {
        auto: true,
        reason: `dò lỗ hổng ${rec.count} lần trong 10 phút (${[...rec.cats].join(", ")})`,
      });
    }
  })().catch(() => {});

  return res.status(400).json({
    error: "Yêu cầu chứa nội dung có dấu hiệu tấn công nên đã bị chặn và ghi lại.",
    code: "ATTACK_PATTERN",
  });
}

module.exports = { probeDetectMiddleware, inspect, RULES };

/**
 * CHỐNG DÒ MẬT KHẨU MÀ KHÔNG KHOÁ NHẦM CHÍNH CHỦ.
 *
 * Vấn đề của cách cũ: khoá theo TÀI KHOẢN. Kẻ tấn công cố tình nhập sai 5 lần
 * là khoá được tài khoản nhà sản xuất thật — chính chủ ở máy khác cũng không
 * vào được (một kiểu quấy rối / DoS).
 *
 * Cách mới: đếm số lần sai theo (IP + tài khoản) và CHẶN THEO IP, có leo thang:
 *   - Sai đủ ngưỡng (mặc định 5) trong 15 phút  → chặn IP 15 phút (lần 1),
 *                                                   1 giờ (lần 2), 24 giờ (lần 3),
 *                                                   rồi CHẶN VĨNH VIỄN.
 *   - Tài khoản KHÔNG bị khoá, nên chính chủ ở IP/thiết bị khác vẫn đăng nhập
 *     bình thường. IP trong IP_ALLOWLIST không bao giờ bị chặn.
 *
 * Việc chặn IP do services/ipBlock.js thực hiện (lưu MongoDB, middleware chặn
 * mọi request từ IP đó ngay từ đầu). Bộ đếm giữ trong bộ nhớ, đủ cho 1 instance.
 */
const blockIp = (ip, opts) => require("./ipBlock").blockIp(ip, opts);

const THRESHOLD = Number(process.env.LOGIN_FAIL_THRESHOLD || 5);
const WINDOW_MS = 15 * 60 * 1000;
// Thời lượng chặn IP theo số lần đã chạm ngưỡng (phút); hết bảng → vĩnh viễn
const STEP_MINUTES = (process.env.LOGIN_BLOCK_STEPS || "15,60,1440").split(",").map((n) => Number(n.trim()));
const PERMANENT_MINUTES = 100 * 365 * 24 * 60;
const PRUNE_MS = 24 * 60 * 60 * 1000;
// Dò mật khẩu PHÂN TÁN: 1 tài khoản bị sai từ >= ngần này IP khác nhau trong 15 phút
const DISTRIBUTED_IPS = Number(process.env.LOGIN_DISTRIBUTED_IPS || 8);

const byIp = new Map(); // ip -> { round, lastSeen, accounts: Map(user -> {count, start}) }
const byAccount = new Map(); // user -> { start, ips: Set, alerted }

function label(minutes) {
  if (minutes >= PERMANENT_MINUTES) return "vĩnh viễn";
  if (minutes >= 1440) return `${Math.round(minutes / 1440)} ngày`;
  if (minutes >= 60) return `${Math.round(minutes / 60)} giờ`;
  return `${minutes} phút`;
}

/**
 * Ghi nhận một lần đăng nhập SAI vào `username` từ `ip`.
 * @returns {Promise<{blocked:boolean, minutes?:number, permanent?:boolean, label?:string, remaining?:number}>}
 */
async function recordFailure(ip, username) {
  if (!ip) return { blocked: false, remaining: THRESHOLD };
  const user = String(username || "").toLowerCase().slice(0, 64);
  const now = Date.now();

  let rec = byIp.get(ip);
  if (!rec) {
    rec = { round: 0, lastSeen: now, accounts: new Map() };
    byIp.set(ip, rec);
  }
  rec.lastSeen = now;

  let a = rec.accounts.get(user);
  if (!a || now - a.start > WINDOW_MS) a = { count: 0, start: now };
  a.count += 1;
  rec.accounts.set(user, a);

  // Theo dõi dò phân tán: 1 tài khoản bị sai từ nhiều IP khác nhau
  let acc = byAccount.get(user);
  if (!acc || now - acc.start > WINDOW_MS) acc = { start: now, ips: new Set(), alerted: false };
  acc.ips.add(ip);
  byAccount.set(user, acc);
  let distributed = false;
  if (!acc.alerted && acc.ips.size >= DISTRIBUTED_IPS) {
    acc.alerted = true;
    distributed = true;
  }
  if (byAccount.size > 5000) {
    for (const [k, v] of byAccount) if (now - v.start > WINDOW_MS) byAccount.delete(k);
  }

  // dọn bộ nhớ các IP im lặng lâu
  if (byIp.size > 5000) {
    for (const [k, v] of byIp) if (now - v.lastSeen > PRUNE_MS) byIp.delete(k);
  }

  if (a.count < THRESHOLD) {
    return { blocked: false, remaining: THRESHOLD - a.count, distributed };
  }

  // Chạm ngưỡng → leo thang mức chặn IP
  a.count = 0;
  a.start = now;
  rec.round += 1;
  const minutes = rec.round <= STEP_MINUTES.length ? STEP_MINUTES[rec.round - 1] : PERMANENT_MINUTES;
  const permanent = minutes >= PERMANENT_MINUTES;
  const ok = await blockIp(ip, {
    minutes,
    auto: true,
    reason: `dò mật khẩu tài khoản "${user}" (lần ${rec.round})`,
  });
  // IP nằm trong allowlist → blockIp trả false, coi như chỉ cảnh báo
  return { blocked: ok, minutes, permanent, label: label(minutes), remaining: 0, distributed };
}

/** Đăng nhập THÀNH CÔNG từ (ip, username) → xoá bộ đếm của cặp đó */
function clearFailures(ip, username) {
  const user = String(username || "").toLowerCase().slice(0, 64);
  const rec = ip && byIp.get(ip);
  if (rec) rec.accounts.delete(user);
  byAccount.delete(user);
}

module.exports = { recordFailure, clearFailures, THRESHOLD, _byIp: byIp };

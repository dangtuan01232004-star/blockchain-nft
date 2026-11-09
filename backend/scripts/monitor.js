/**
 * monitor.js — Giám sát sự kiện on-chain của ProductNFT và cảnh báo admin.
 *
 * Vì sao là script chạy định kỳ chứ không phải listener trong backend:
 * Render gói Free "ngủ" khi không có truy cập → listener chạy nền sẽ bỏ lỡ
 * sự kiện. Script này được GitHub Actions chạy mỗi ~5 phút
 * (.github/workflows/security-monitor.yml), độc lập với Render.
 *
 * Mỗi lần chạy: đọc các block mới kể từ lần trước (lưu mốc trong MongoDB),
 * áp luật phát hiện bất thường, ghi AuditLog (chống trùng theo txHash:logIndex)
 * và gửi Telegram cho mức warning/critical.
 *
 * Biến môi trường cần có (GitHub → Settings → Secrets and variables → Actions):
 *   RPC_URL, MONGODB_URI, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 * Tuỳ chọn:
 *   CONTRACT_ADDRESS          (mặc định đọc từ src/data/contract.json)
 *   MINT_ALERT_THRESHOLD=20   (số lần mint của 1 ví trong 1 lần quét → cảnh báo)
 *   LOG_CHUNK_BLOCKS=10       (Alchemy gói free giới hạn eth_getLogs ~10 block/lần)
 *   MAX_BLOCKS_PER_RUN=500    (nếu bị bỏ xa quá, chỉ quét 500 block gần nhất và cảnh báo)
 *
 * Chạy tay: cd backend && node scripts/monitor.js
 */
require("dotenv").config();
const path = require("path");
const fs = require("fs");
const mongoose = require("mongoose");
const { ethers } = require("ethers");
const User = require("../src/models/User");
const { securityEvent } = require("../src/services/alerts");

const CHUNK = Number(process.env.LOG_CHUNK_BLOCKS || 10);
const MAX_BLOCKS = Number(process.env.MAX_BLOCKS_PER_RUN || 500);
const MINT_THRESHOLD = Number(process.env.MINT_ALERT_THRESHOLD || 20);

const stateSchema = new mongoose.Schema({ _id: String, lastBlock: Number }, { timestamps: true });
const MonitorState = mongoose.models.MonitorState || mongoose.model("MonitorState", stateSchema);

function loadContract(provider) {
  const info = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "src", "data", "contract.json"), "utf8"));
  const address = process.env.CONTRACT_ADDRESS || info.address;
  return new ethers.Contract(address, info.abi, provider);
}

function loadPartnerWallets() {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "src", "data", "partners.json"), "utf8"));
    return new Set(list.map((p) => String(p.walletAddress).toLowerCase()));
  } catch {
    return new Set();
  }
}

async function main() {
  for (const k of ["RPC_URL", "MONGODB_URI"]) {
    if (!process.env[k]) throw new Error(`Thiếu biến môi trường ${k}`);
  }
  await mongoose.connect(process.env.MONGODB_URI);
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const contract = loadContract(provider);
  const contractAddress = (await contract.getAddress()).toLowerCase();
  const stateId = `monitor:${contractAddress}`;

  // Tên vai trò từ hash
  const roleNames = {};
  for (const name of ["DEFAULT_ADMIN_ROLE", "OPERATOR_ROLE", "GUARDIAN_ROLE", "MANUFACTURER_ROLE", "DISTRIBUTOR_ROLE"]) {
    try {
      roleNames[(await contract[name]()).toLowerCase()] = name;
    } catch {
      /* contract cũ có thể thiếu OPERATOR/GUARDIAN */
    }
  }

  // Ví "được biết" = ví đã liên kết bằng chữ ký trong tài khoản + danh bạ đối tác
  const users = await User.find({ walletAddress: { $ne: "" } }).select("username walletAddress roleStatus role").lean();
  const userByWallet = new Map(users.map((u) => [u.walletAddress.toLowerCase(), u]));
  const partnerWallets = loadPartnerWallets();
  const isKnown = (w) => userByWallet.has(w) || partnerWallets.has(w);

  const latest = await provider.getBlockNumber();
  const state = await MonitorState.findById(stateId);
  // Lần chạy đầu: quét 50 block gần nhất (không âm khi chain còn ngắn)
  let from = state ? state.lastBlock + 1 : Math.max(0, latest - 50);
  if (latest - from > MAX_BLOCKS) {
    await securityEvent({
      type: "monitor_gap",
      severity: "warning",
      message: `Bộ giám sát bị bỏ lỡ ${latest - from} block (lần chạy trước quá lâu). Chỉ quét ${MAX_BLOCKS} block gần nhất — nên kiểm tra tay trên Etherscan.`,
      dedupeKey: `gap:${contractAddress}:${from}`,
    });
    from = Math.max(0, latest - MAX_BLOCKS);
  }
  if (from > latest) {
    console.log("Không có block mới.");
    await mongoose.disconnect();
    return;
  }

  console.log(`Quét block ${from} → ${latest} của ${contractAddress}`);
  const logs = [];
  for (let start = from; start <= latest; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, latest);
    logs.push(...(await provider.getLogs({ address: contractAddress, fromBlock: start, toBlock: end })));
  }

  const mintsByWallet = new Map();
  let alerts = 0;

  for (const log of logs) {
    let ev;
    try {
      ev = contract.interface.parseLog(log);
    } catch {
      continue;
    }
    if (!ev) continue;
    const key = `${log.transactionHash}:${log.index ?? log.logIndex}`;
    const base = { txHash: log.transactionHash, dedupeKey: key, meta: { block: log.blockNumber, event: ev.name } };
    let e = null;

    switch (ev.name) {
      case "RoleGranted": {
        const role = roleNames[ev.args.role.toLowerCase()] || ev.args.role;
        const who = ev.args.account.toLowerCase();
        const u = userByWallet.get(who);
        const highRole = ["DEFAULT_ADMIN_ROLE", "OPERATOR_ROLE", "GUARDIAN_ROLE"].includes(role);
        e = {
          type: "onchain_role_granted",
          severity: highRole || !u ? "critical" : "warning",
          message:
            `Cấp ${role} cho ví ${who}` +
            (u ? ` (tài khoản ${u.username})` : " — VÍ KHÔNG THUỘC TÀI KHOẢN NÀO ĐÃ XÁC MINH") +
            `, người ký: ${ev.args.sender}`,
          wallet: who,
        };
        break;
      }
      case "RoleRevoked":
        e = {
          type: "onchain_role_revoked",
          severity: "warning",
          message: `Thu hồi ${roleNames[ev.args.role.toLowerCase()] || ev.args.role} của ví ${ev.args.account}, người ký: ${ev.args.sender}`,
          wallet: ev.args.account,
        };
        break;
      case "RoleAdminChanged":
        e = { type: "onchain_role_admin_changed", severity: "critical", message: "Cấu trúc phân quyền của contract bị thay đổi" };
        break;
      case "Paused":
        e = { type: "onchain_paused", severity: "critical", message: `Hệ thống bị TẠM DỪNG khẩn cấp bởi ${ev.args.account}`, wallet: ev.args.account };
        break;
      case "Unpaused":
        e = { type: "onchain_unpaused", severity: "warning", message: `Hệ thống được mở lại bởi ${ev.args.account}`, wallet: ev.args.account };
        break;
      case "WalletCompromised":
        e = {
          type: "onchain_wallet_compromised",
          severity: "critical",
          message: `Ví ${ev.args.wallet} bị gắn cờ BỊ XÂM PHẠM từ ${new Date(Number(ev.args.since) * 1000).toISOString()}`,
          wallet: ev.args.wallet,
        };
        break;
      case "WalletCleared":
        e = { type: "onchain_wallet_cleared", severity: "warning", message: `Gỡ cờ xâm phạm cho ví ${ev.args.wallet}`, wallet: ev.args.wallet };
        break;
      case "ProductRevoked":
        e = { type: "onchain_product_revoked", severity: "warning", message: `Thu hồi xác thực sản phẩm #${ev.args.tokenId}: ${ev.args.reason}` };
        break;
      case "ProductMinted": {
        const who = ev.args.manufacturer.toLowerCase();
        mintsByWallet.set(who, (mintsByWallet.get(who) || 0) + 1);
        if (!userByWallet.has(who)) {
          e = {
            type: "onchain_mint_unknown_wallet",
            severity: "critical",
            message: `Sản phẩm #${ev.args.tokenId} được mint bởi ví ${who} KHÔNG thuộc tài khoản nhà sản xuất nào đã xác minh`,
            wallet: who,
          };
        }
        break;
      }
      case "CustodyTransferred": {
        const to = ev.args.to.toLowerCase();
        if (!isKnown(to)) {
          e = {
            type: "onchain_transfer_unknown_wallet",
            severity: "warning",
            message: `Sản phẩm #${ev.args.tokenId} (${ev.args.action}) được chuyển tới ví lạ ${to} không có trong danh bạ/tài khoản`,
            wallet: to,
          };
        }
        break;
      }
      default:
        break;
    }

    if (e && (await securityEvent({ ...base, ...e }))) alerts++;
  }

  for (const [wallet, count] of mintsByWallet) {
    if (count >= MINT_THRESHOLD) {
      const u = userByWallet.get(wallet);
      if (
        await securityEvent({
          type: "onchain_mint_burst",
          severity: "critical",
          message: `Ví ${wallet}${u ? ` (${u.username})` : ""} mint ${count} sản phẩm trong block ${from}–${latest} — vượt ngưỡng ${MINT_THRESHOLD}. Nghi ví bị hack: cân nhắc Guardian pause / flagCompromised.`,
          wallet,
          dedupeKey: `burst:${wallet}:${from}`,
        })
      )
        alerts++;
    }
  }

  await MonitorState.updateOne({ _id: stateId }, { lastBlock: latest }, { upsert: true });

  // Chạy bù việc xoá thông tin đơn hàng quá hạn (Render Free có thể đang ngủ)
  if (process.env.DATA_ENCRYPTION_KEY) {
    try {
      const { runOrderPrivacyMaintenance } = require("../src/services/orderPrivacy");
      await runOrderPrivacyMaintenance();
    } catch (err) {
      console.error("Không chạy được bảo trì dữ liệu đơn hàng:", err.message);
    }
  }
  console.log(`Xong: ${logs.length} log, ${alerts} sự kiện mới được ghi.`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("Monitor lỗi:", err);
  try {
    await securityEvent({ type: "monitor_error", severity: "warning", message: `Bộ giám sát on-chain lỗi: ${err.message}` });
  } catch {
    /* bỏ qua */
  }
  process.exitCode = 1;
  await mongoose.disconnect().catch(() => {});
});

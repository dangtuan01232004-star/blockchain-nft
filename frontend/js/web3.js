/**
 * web3.js — Kết nối ví MetaMask và tương tác trực tiếp với smart contract
 * ngay trên trình duyệt. Không có private key nào được backend giữ hộ:
 * mỗi vai trò (nhà sản xuất, phân phối, admin) tự ký giao dịch bằng ví
 * của chính họ, đúng tinh thần phi tập trung của blockchain.
 */
// Tự nhận diện host của backend dựa theo cách trang này đang được truy cập
// (localhost khi test trên cùng máy, IP LAN khi truy cập từ điện thoại khác máy)
const API_BASE = window.API_BASE || `http://${window.location.hostname}:4000`;

let cachedConfig = null;
let cachedProvider = null;

/**
 * ---------------- GHIM CẤU HÌNH CONTRACT (chống backend bị chiếm) ----------------
 * Địa chỉ contract, chainId, ABI và RPC được GHI CỐ ĐỊNH trong js/contract-pin.js
 * (do smart-contracts/scripts/deploy.js tự sinh, đưa lên Vercel — hệ thống tách
 * riêng khỏi backend Render). Frontend KHÔNG BAO GIỜ dùng ABI/địa chỉ do backend
 * gửi để ký giao dịch; cấu hình backend chỉ dùng để ĐỐI CHIẾU — lệch là báo động.
 *
 * Kịch bản chặn được: hacker chiếm backend, sửa ABI để nút "Cấp quyền cho nhà sản
 * xuất X" thực chất ký lệnh cấp quyền cho ví của hắn, hoặc trỏ sang contract giả /
 * mạng khác.
 */
const IS_DEV_HOST = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(window.location.hostname);

function pinIsEnforced() {
  // Chạy local (npx hardhat node) thì contract đổi liên tục → không ép ghim
  return !IS_DEV_HOST;
}

function showPinAlarm(message) {
  console.error("[BẢO MẬT] " + message);
  if (document.getElementById("pinAlarm")) return;
  const bar = document.createElement("div");
  bar.id = "pinAlarm";
  bar.setAttribute("role", "alert");
  bar.style.cssText =
    "position:fixed;left:0;right:0;top:0;z-index:99999;background:#b91c1c;color:#fff;padding:12px 18px;" +
    "font:600 14px/1.5 system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.25)";
  bar.textContent =
    "⛔ CẢNH BÁO BẢO MẬT: " + message +
    " — Mọi thao tác ký giao dịch đã bị CHẶN. Không ký gì trong MetaMask, báo ngay cho quản trị viên.";
  document.body.appendChild(bar);
}

function abiSignatures(abi) {
  try {
    return new ethers.Interface(abi).fragments
      .filter((f) => f.type === "function" || f.type === "event")
      .map((f) => f.format("sighash"))
      .sort()
      .join("|");
  } catch {
    return "";
  }
}

async function getContractConfig() {
  if (cachedConfig) return cachedConfig;
  const res = await fetch(`${API_BASE}/api/contract/config`);
  if (!res.ok) throw new Error("Không lấy được cấu hình hợp đồng từ backend");
  const server = await res.json();

  if (!pinIsEnforced()) {
    cachedConfig = server;
    return cachedConfig;
  }

  const pin = window.CONTRACT_PIN;
  if (!pin || !pin.address || !pin.abi) {
    const msg = "Thiếu tệp ghim cấu hình contract (js/contract-pin.js)";
    showPinAlarm(msg);
    throw new Error(msg + " — chạy lại scripts/deploy.js rồi đưa tệp này lên Vercel.");
  }
  const problems = [];
  if (String(server.address || "").toLowerCase() !== pin.address.toLowerCase()) {
    problems.push(`backend trả địa chỉ contract ${server.address} khác địa chỉ đã ghim ${pin.address}`);
  }
  if (String(server.chainIdHex || "").toLowerCase() !== pin.chainIdHex.toLowerCase()) {
    problems.push(`backend trả mạng ${server.chainIdHex} khác mạng đã ghim ${pin.chainIdHex}`);
  }
  if (abiSignatures(server.abi) !== abiSignatures(pin.abi)) {
    problems.push("ABI backend trả về KHÁC ABI đã ghim (có thể đã bị sửa)");
  }
  if (problems.length) {
    const msg = "Cấu hình contract từ máy chủ không khớp bản ghim: " + problems.join("; ");
    showPinAlarm(msg);
    throw new Error(msg);
  }

  // Luôn dùng dữ liệu GHIM, không dùng dữ liệu backend
  cachedConfig = {
    address: pin.address,
    abi: pin.abi,
    chainIdHex: pin.chainIdHex,
    chainName: pin.chainName,
    rpcUrl: pin.rpcUrl || server.rpcUrl,
    pinned: true,
  };
  return cachedConfig;
}

function hasMetaMask() {
  return typeof window.ethereum !== "undefined";
}

/** Yêu cầu MetaMask chuyển (hoặc thêm mới nếu chưa có) đúng mạng blockchain của hệ thống */
async function ensureCorrectNetwork() {
  const cfg = await getContractConfig();
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: cfg.chainIdHex }],
    });
  } catch (switchError) {
    // Mã lỗi 4902 = mạng chưa tồn tại trong MetaMask, cần thêm mới
    if (switchError.code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: cfg.chainIdHex,
            chainName: cfg.chainName,
            rpcUrls: [cfg.rpcUrl],
            nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
          },
        ],
      });
    } else {
      throw switchError;
    }
  }
  // Kiểm tra lại: MetaMask có thật sự đang ở đúng mạng không
  const current = await window.ethereum.request({ method: "eth_chainId" });
  if (String(current).toLowerCase() !== String(cfg.chainIdHex).toLowerCase()) {
    throw new Error(`MetaMask đang ở mạng ${current}, không phải mạng của hệ thống (${cfg.chainIdHex}).`);
  }
}

/**
 * ---------------- XEM TRƯỚC GIAO DỊCH TRƯỚC KHI KÝ ----------------
 * Mọi lệnh GHI lên contract đi qua đây: (1) mô phỏng trước, (2) GIẢI MÃ LẠI
 * dữ liệu sắp ký bằng ABI ghim và hiện bằng chữ dễ đọc, (3) người dùng bấm
 * "Ký" thì MetaMask mới bật lên. MetaMask chỉ hiện mã hex — bước này cho người
 * dùng thấy CHÍNH XÁC mình sắp ký gì.
 */
const FN_INFO = {
  mintProduct: { title: "Phát hành NFT sản phẩm mới", risk: "normal" },
  mintProductAuthorized: { title: "Phát hành NFT sản phẩm mới (đã xác thực passkey/2FA)", risk: "normal" },
  setMintAuthorizer: { title: "ĐỔI KHOÁ UỶ QUYỀN MINT", risk: "high" },
  transferCustody: { title: "Chuyển giao sản phẩm (ghi 1 bước chuỗi cung ứng)", risk: "normal" },
  grantRole: { title: "CẤP QUYỀN trên smart contract", risk: "high" },
  revokeRole: { title: "TƯỚC QUYỀN trên smart contract", risk: "high" },
  renounceRole: { title: "TỪ BỎ quyền của chính ví này", risk: "high" },
  revokeAuthenticity: { title: "THU HỒI xác thực sản phẩm (không hoàn tác được)", risk: "high" },
  pause: { title: "DỪNG KHẨN CẤP toàn hệ thống", risk: "high" },
  unpause: { title: "Mở lại hệ thống", risk: "high" },
  flagCompromised: { title: "GẮN CỜ ví bị xâm phạm", risk: "high" },
  clearCompromised: { title: "Gỡ cờ ví", risk: "high" },
  setDailyMintLimit: { title: "Đổi giới hạn mint mỗi ngày", risk: "high" },
};
const PARAM_VI = {
  to: "Ví nhận", tokenURI_: "Metadata (IPFS)", productCode_: "Mã sản phẩm / lô", photoURI_: "Ảnh",
  gpsCoords_: "Toạ độ GPS", tokenId: "Mã sản phẩm (token)", role: "Quyền", account: "Ví",
  callerConfirmation: "Ví xác nhận", reason: "Lý do", wallet: "Ví", since: "Từ thời điểm",
  newLimit: "Giới hạn mới (sản phẩm/ngày/ví)", action: "Hành động", location: "Địa điểm",
  photoURI: "Ảnh", gpsCoords: "Toạ độ GPS", nonce: "Mã dùng 1 lần", deadline: "Hiệu lực đến",
  authSig: "Chữ ký uỷ quyền", newAuthorizer: "Khoá uỷ quyền mới",
};

function roleNameOf(bytes32) {
  const names = ["MANUFACTURER_ROLE", "DISTRIBUTOR_ROLE", "OPERATOR_ROLE", "GUARDIAN_ROLE"];
  if (bytes32 === ethers.ZeroHash) return "DEFAULT_ADMIN (quyền cao nhất)";
  for (const n of names) if (ethers.id(n) === bytes32) return n.replace("_ROLE", "");
  return null;
}

function describeValue(input, value, ctx) {
  const t = input.type;
  if (t === "address") {
    const a = ethers.getAddress(value);
    let note = "";
    if (a.toLowerCase() === ctx.me.toLowerCase()) note = " (chính ví của bạn)";
    else if (a.toLowerCase() === ctx.contract.toLowerCase()) note = " (contract hệ thống)";
    return { text: a, emph: "…" + a.slice(-4) + note };
  }
  if (t === "bytes") {
    return { text: value.slice(0, 18) + "…" + value.slice(-8), emph: "✓ Chữ ký thứ hai của hệ thống (cấp sau khi bạn xác thực lại)" };
  }
  if (t === "bytes32" && input.name !== "role") {
    return { text: value, emph: "" };
  }
  if (t === "bytes32") {
    const r = roleNameOf(value);
    return { text: r ? r : value, emph: r ? "" : "⚠ mã quyền KHÔNG xác định" };
  }
  if (t.startsWith("uint")) {
    if (/since|time|deadline/i.test(input.name)) {
      const n = Number(value);
      return { text: n === 0 ? "ngay bây giờ" : new Date(n * 1000).toLocaleString("vi-VN"), emph: "" };
    }
    return { text: value.toString(), emph: "" };
  }
  const s = String(value);
  return { text: s.length > 120 ? s.slice(0, 117) + "…" : s || "(trống)", emph: "" };
}

function confirmTxModal({ title, risk, rows, contract, me, simulated }) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.style.cssText =
      "position:fixed;inset:0;z-index:99998;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:16px";
    const box = document.createElement("div");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.style.cssText =
      "background:#fff;color:#0f172a;max-width:560px;width:100%;border-radius:14px;padding:22px 22px 18px;" +
      "box-shadow:0 20px 60px rgba(0,0,0,.3);font:15px/1.5 system-ui,sans-serif;max-height:90vh;overflow:auto";
    const h = document.createElement("h3");
    h.style.cssText = `margin:0 0 4px;font-size:18px;color:${risk === "high" ? "#b91c1c" : "#0f172a"}`;
    h.textContent = (risk === "high" ? "⚠ " : "") + title;
    const sub = document.createElement("p");
    sub.style.cssText = "margin:0 0 14px;color:#475569;font-size:13px";
    sub.textContent =
      "Đây là nội dung được GIẢI MÃ từ chính dữ liệu sắp ký. Kiểm tra kỹ — MetaMask chỉ hiện mã hex.";
    const table = document.createElement("table");
    table.style.cssText = "width:100%;border-collapse:collapse;font-size:14px";
    const addRow = (k, v, emph) => {
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      th.style.cssText = "text-align:left;vertical-align:top;padding:6px 10px 6px 0;color:#475569;font-weight:600;white-space:nowrap";
      th.textContent = k;
      const td = document.createElement("td");
      td.style.cssText = "padding:6px 0;word-break:break-all;font-family:ui-monospace,Consolas,monospace;font-size:13px";
      td.textContent = v;
      if (emph) {
        const b = document.createElement("div");
        b.style.cssText = "font-family:system-ui,sans-serif;font-weight:700;color:#0f172a;margin-top:2px";
        b.textContent = emph;
        td.appendChild(b);
      }
      tr.append(th, td);
      table.appendChild(tr);
    };
    rows.forEach((r) => addRow(r.label, r.text, r.emph));
    addRow("Gửi tới contract", contract, "…" + contract.slice(-4) + " ✓ khớp địa chỉ đã ghim");
    addRow("Ký bằng ví", me, "…" + me.slice(-4));
    const sim = document.createElement("p");
    sim.style.cssText = "margin:12px 0 0;font-size:13px;color:#15803d;font-weight:600";
    sim.textContent = simulated ? "✓ Đã chạy mô phỏng: giao dịch sẽ thành công." : "";
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:10px;justify-content:flex-end;margin-top:16px";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn btn-outline";
    cancel.textContent = "Huỷ";
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "btn btn-primary";
    ok.id = "txConfirmSign";
    ok.textContent = "Ký trong MetaMask";
    if (risk === "high") ok.style.background = "#b91c1c";
    actions.append(cancel, ok);
    box.append(h, sub, table, sim, actions);
    wrap.appendChild(box);
    const close = (v) => { wrap.remove(); document.removeEventListener("keydown", onKey); resolve(v); };
    const onKey = (e) => { if (e.key === "Escape") close(false); };
    cancel.addEventListener("click", () => close(false));
    ok.addEventListener("click", () => close(true));
    wrap.addEventListener("click", (e) => { if (e.target === wrap) close(false); });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(wrap);
    ok.focus();
  });
}

function guardContract(contract, signer, me, cfg) {
  const pinnedIface = new ethers.Interface(cfg.abi);
  const pinnedAddr = ethers.getAddress(cfg.address);
  return new Proxy(contract, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || !value.fragment || value.fragment.constant) return value;
      // Hàm GHI → bọc lại
      return async (...args) => {
        // 1) Mô phỏng: lỗi (thiếu quyền, đang tạm dừng...) báo ngay, chưa làm phiền MetaMask
        await value.staticCall(...args);
        // 2) Dựng giao dịch rồi GIẢI MÃ LẠI bằng ABI ghim
        const tx = await value.populateTransaction(...args);
        if (!tx.to || ethers.getAddress(tx.to) !== pinnedAddr) {
          showPinAlarm(`Giao dịch trỏ tới ${tx.to}, không phải contract đã ghim ${pinnedAddr}`);
          throw new Error("Giao dịch trỏ tới địa chỉ lạ — đã chặn.");
        }
        if (tx.value && BigInt(tx.value) > 0n) throw new Error("Giao dịch có gửi kèm ETH — hệ thống không bao giờ yêu cầu việc này, đã chặn.");
        const decoded = pinnedIface.parseTransaction({ data: tx.data });
        if (!decoded) throw new Error("Không giải mã được dữ liệu giao dịch bằng ABI đã ghim — đã chặn.");
        const info = FN_INFO[decoded.name] || { title: `Gọi hàm ${decoded.name}`, risk: "high" };
        const ctx = { me, contract: pinnedAddr };
        const rows = [{ label: "Hàm", text: decoded.signature, emph: "" }];
        decoded.fragment.inputs.forEach((input, i) => {
          const d = describeValue(input, decoded.args[i], ctx);
          rows.push({ label: PARAM_VI[input.name] || input.name, text: d.text, emph: d.emph });
        });
        const ok = await confirmTxModal({ title: info.title, risk: info.risk, rows, contract: pinnedAddr, me, simulated: true });
        if (!ok) {
          const e = new Error("Bạn đã huỷ giao dịch.");
          e.code = "ACTION_REJECTED";
          throw e;
        }
        // 3) Gửi ĐÚNG dữ liệu vừa hiển thị
        return signer.sendTransaction({ to: pinnedAddr, data: tx.data });
      };
    },
  });
}

/**
 * Kết nối ví MetaMask, đảm bảo đúng mạng, trả về { signer, address, contract }
 * — mọi hàm ghi của `contract` đều qua bước xem trước + kiểm tra ghim ở trên.
 */
async function connectWallet() {
  if (!hasMetaMask()) {
    throw new Error("Không tìm thấy MetaMask. Vui lòng cài đặt extension MetaMask trên trình duyệt.");
  }
  const cfg = await getContractConfig();
  await ensureCorrectNetwork();

  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
  const address = accounts[0];

  cachedProvider = new ethers.BrowserProvider(window.ethereum);
  const signer = await cachedProvider.getSigner();
  const raw = new ethers.Contract(cfg.address, cfg.abi, signer);
  const contract = guardContract(raw, signer, ethers.getAddress(address), cfg);

  return { signer, address, contract, config: cfg };
}

/** Tạo contract chỉ-đọc (không cần ví) — dùng để kiểm tra vai trò trước khi thao tác */
async function getReadOnlyContract() {
  const cfg = await getContractConfig();
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
  return new ethers.Contract(cfg.address, cfg.abi, provider);
}

/**
 * Kiểm tra một địa chỉ đang giữ những vai trò nào trên contract.
 * isOperator / isGuardian chỉ có ở contract bản bảo mật mới — contract cũ
 * trả về false thay vì báo lỗi.
 */
async function detectRoles(address) {
  const contract = await getReadOnlyContract();
  const [MANUFACTURER_ROLE, DISTRIBUTOR_ROLE, DEFAULT_ADMIN_ROLE] = await Promise.all([
    contract.MANUFACTURER_ROLE(),
    contract.DISTRIBUTOR_ROLE(),
    contract.DEFAULT_ADMIN_ROLE(),
  ]);
  const optionalRole = async (name) => {
    try {
      return await contract.hasRole(await contract[name](), address);
    } catch {
      return false;
    }
  };
  const [isManufacturer, isDistributor, isAdmin, isOperator, isGuardian] = await Promise.all([
    contract.hasRole(MANUFACTURER_ROLE, address),
    contract.hasRole(DISTRIBUTOR_ROLE, address),
    contract.hasRole(DEFAULT_ADMIN_ROLE, address),
    optionalRole("OPERATOR_ROLE"),
    optionalRole("GUARDIAN_ROLE"),
  ]);
  return { isManufacturer, isDistributor, isAdmin, isOperator, isGuardian };
}

/** Lấy mã hash (bytes32) của một role — cần để gọi grantRole()/revokeRole() */
async function getRoleHash(roleName) {
  const contract = await getReadOnlyContract();
  // roleName: "MANUFACTURER" | "DISTRIBUTOR" | "ADMIN"
  if (roleName === "ADMIN") return contract.DEFAULT_ADMIN_ROLE();
  return contract[`${roleName}_ROLE`]();
}

/** Bắt lỗi revert từ contract và trả về thông điệp tiếng Việt dễ hiểu hơn */
function explainContractError(err) {
  const raw = (err && (err.reason || err.shortMessage || err.message)) || "Lỗi không xác định";
  if (raw.includes("AccessControlUnauthorizedAccount") || raw.includes("missing role")) {
    return "Ví của bạn không có quyền thực hiện thao tác này trên smart contract.";
  }
  if (raw.includes("Bạn đã huỷ giao dịch")) return "Bạn đã huỷ giao dịch.";
  if (raw.includes("user rejected") || err.code === "ACTION_REJECTED") {
    return "Bạn đã từ chối xác nhận giao dịch trong MetaMask.";
  }
  if (raw.includes("EnforcedPause")) {
    return "Hệ thống đang TẠM DỪNG khẩn cấp để xử lý sự cố bảo mật — chưa thể mint/chuyển giao.";
  }
  if (raw.includes("Khong co quyen chuyen giao")) {
    return "Chỉ ví đang giữ sản phẩm này mới được chuyển giao nó.";
  }
  if (raw.includes("Can chu ky uy quyen mint")) {
    return "Contract yêu cầu chữ ký uỷ quyền thứ hai — hãy phát hành qua trang quản trị (có bước xác thực passkey/2FA).";
  }
  if (raw.includes("Chu ky uy quyen")) {
    return "Chữ ký uỷ quyền không hợp lệ hoặc đã hết hạn — thử phát hành lại.";
  }
  if (raw.includes("Vuot gioi han mint trong ngay")) {
    return "Ví này đã phát hành đủ số sản phẩm cho phép trong hôm nay (giới hạn chống ví bị lộ mint hàng loạt). Thử lại vào ngày mai, hoặc nhờ admin (Safe 2/3) nâng giới hạn.";
  }
  if (raw.includes("Chi chuyen giao qua transferCustody")) {
    return "Sản phẩm chỉ được chuyển qua chức năng Cập nhật chuỗi cung ứng.";
  }
  return raw;
}

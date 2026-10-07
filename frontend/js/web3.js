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

async function getContractConfig() {
  if (cachedConfig) return cachedConfig;
  const res = await fetch(`${API_BASE}/api/contract/config`);
  if (!res.ok) throw new Error("Không lấy được cấu hình hợp đồng từ backend");
  cachedConfig = await res.json();
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
}

/**
 * Kết nối ví MetaMask, đảm bảo đúng mạng, trả về { signer, address, contract }
 * — `contract` đã được connect() sẵn với signer, sẵn sàng gọi hàm ghi (mint,
 * transferCustody...) và MetaMask sẽ tự bật popup xác nhận giao dịch.
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
  const contract = new ethers.Contract(cfg.address, cfg.abi, signer);

  return { signer, address, contract, config: cfg };
}

/** Tạo contract chỉ-đọc (không cần ví) — dùng để kiểm tra vai trò trước khi thao tác */
async function getReadOnlyContract() {
  const cfg = await getContractConfig();
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
  return new ethers.Contract(cfg.address, cfg.abi, provider);
}

/** Kiểm tra một địa chỉ có đang giữ vai trò MANUFACTURER/DISTRIBUTOR/ADMIN hay không */
async function detectRoles(address) {
  const contract = await getReadOnlyContract();
  const [MANUFACTURER_ROLE, DISTRIBUTOR_ROLE, DEFAULT_ADMIN_ROLE] = await Promise.all([
    contract.MANUFACTURER_ROLE(),
    contract.DISTRIBUTOR_ROLE(),
    contract.DEFAULT_ADMIN_ROLE(),
  ]);
  const [isManufacturer, isDistributor, isAdmin] = await Promise.all([
    contract.hasRole(MANUFACTURER_ROLE, address),
    contract.hasRole(DISTRIBUTOR_ROLE, address),
    contract.hasRole(DEFAULT_ADMIN_ROLE, address),
  ]);
  return { isManufacturer, isDistributor, isAdmin };
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
  if (raw.includes("user rejected") || err.code === "ACTION_REJECTED") {
    return "Bạn đã từ chối xác nhận giao dịch trong MetaMask.";
  }
  return raw;
}

/**
 * Logic chuyển DEFAULT_ADMIN_ROLE sang ví Safe multisig — tách riêng để test được.
 * Dùng bởi scripts/transfer-admin-to-safe.js.
 */
const SAFE_ABI = [
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
];

/** Đọc thông tin Safe; ném lỗi nếu địa chỉ không phải contract hoặc không phải Safe */
async function inspectSafe(ethers, provider, safeAddress) {
  if (!ethers.isAddress(safeAddress)) throw new Error(`Địa chỉ Safe không hợp lệ: ${safeAddress}`);
  const code = await provider.getCode(safeAddress);
  if (!code || code === "0x") {
    throw new Error(
      `${safeAddress} KHÔNG phải contract (là ví thường hoặc sai mạng). ` +
        "Kiểm tra lại: Safe phải được tạo trên đúng mạng Sepolia, copy địa chỉ trong app.safe.global."
    );
  }
  const safe = new ethers.Contract(safeAddress, SAFE_ABI, provider);
  let owners, threshold;
  try {
    [owners, threshold] = await Promise.all([safe.getOwners(), safe.getThreshold()]);
  } catch {
    throw new Error(`${safeAddress} là contract nhưng không đọc được getOwners()/getThreshold() — có đúng là ví Safe không?`);
  }
  return { owners: owners.map((o) => o.toLowerCase()), threshold: Number(threshold) };
}

/**
 * Bước 1: cấp DEFAULT_ADMIN_ROLE cho Safe (ví hiện tại vẫn giữ admin → còn đường lui).
 * Bước 2 (renounce = true): ví hiện tại TỪ BỎ admin — chỉ chạy khi Safe chắc chắn đã có quyền.
 */
async function transferAdmin({ ethers, contract, signer, safeAddress, renounce = false, minThreshold = 2, log = console.log }) {
  const provider = signer.provider;
  const me = (await signer.getAddress()).toLowerCase();
  const ADMIN = await contract.DEFAULT_ADMIN_ROLE();

  const info = await inspectSafe(ethers, provider, safeAddress);
  log(`Safe ${safeAddress}: ngưỡng ${info.threshold}/${info.owners.length}`);
  info.owners.forEach((o, i) => log(`  chủ #${i + 1}: ${o}${o === me ? "  ← ví đang chạy script" : ""}`));
  if (info.threshold < minThreshold) {
    throw new Error(`Ngưỡng Safe chỉ ${info.threshold} chữ ký — cần tối thiểu ${minThreshold} thì multisig mới có ý nghĩa.`);
  }

  const safeHasAdmin = await contract.hasRole(ADMIN, safeAddress);
  const meHasAdmin = await contract.hasRole(ADMIN, me);
  const result = { granted: false, renounced: false, safeHasAdmin, meHasAdmin };

  if (!safeHasAdmin) {
    if (!meHasAdmin) throw new Error(`Ví ${me} không có quyền ADMIN trên contract — không cấp được cho Safe.`);
    log("→ Cấp DEFAULT_ADMIN_ROLE cho Safe...");
    const tx = await contract.connect(signer).grantRole(ADMIN, safeAddress);
    log(`  tx: ${tx.hash}`);
    await tx.wait();
    result.granted = true;
  } else {
    log("✓ Safe đã có DEFAULT_ADMIN_ROLE từ trước.");
  }
  result.safeHasAdmin = await contract.hasRole(ADMIN, safeAddress);
  if (!result.safeHasAdmin) throw new Error("Cấp quyền xong nhưng kiểm tra lại Safe vẫn CHƯA có admin — dừng, không từ bỏ quyền.");

  if (renounce) {
    if (!(await contract.hasRole(ADMIN, me))) {
      log("✓ Ví hiện tại đã không còn quyền admin.");
    } else {
      log("→ Ví hiện tại TỪ BỎ DEFAULT_ADMIN_ROLE...");
      const tx = await contract.connect(signer).renounceRole(ADMIN, me);
      log(`  tx: ${tx.hash}`);
      await tx.wait();
      result.renounced = true;
    }
  }
  result.meHasAdmin = await contract.hasRole(ADMIN, me);
  return result;
}

module.exports = { transferAdmin, inspectSafe };

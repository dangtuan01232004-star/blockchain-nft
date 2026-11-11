// API_BASE đã được khai báo sẵn trong web3.js (load trước file này)
let wallet = null; // { signer, address, contract, config }
let allProducts = []; // cache toàn bộ sản phẩm lấy từ backend, lọc lại ở client
let productLoadError = "";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
);

function showStatus(el, msg, ok) {
  el.textContent = msg;
  el.className = "status-msg show " + (ok ? "ok" : "err");
}

// --- Modal helpers ---
function openModal(id) { document.getElementById(id).classList.add("show"); }
function closeModal(id) { document.getElementById(id).classList.remove("show"); }
document.querySelectorAll("[data-close]").forEach((btn) => {
  btn.addEventListener("click", () => closeModal(btn.dataset.close));
});
document.querySelectorAll(".modal-overlay").forEach((overlay) => {
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.classList.remove("show");
  });
});

// --- Điều hướng sidebar (chuyển section, không cần load lại trang) ---
document.querySelectorAll(".dash-nav-item[data-section]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".dash-nav-item[data-section]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    ["products", "partners", "users", "orders", "security", "account"].forEach((s) => {
      document.getElementById(`section-${s}`).style.display = btn.dataset.section === s ? "block" : "none";
    });
    if (btn.dataset.section === "users") loadUsers();
    if (btn.dataset.section === "orders") loadOrders();
    if (btn.dataset.section === "security") loadSecurity();
    if (btn.dataset.section === "account") loadAccount();
  });
});

// --- Tài khoản đăng nhập (JWT) ---

const authUser = JSON.parse(localStorage.getItem("authUser") || "null");
const ROLE_LABEL_VI = { manufacturer: "Nhà sản xuất", distributor: "Đơn vị phân phối", admin: "Admin" };
if (authUser) {
  document.getElementById("loggedInUser").textContent = authUser.displayName || authUser.username;
  document.getElementById("loggedInRole").textContent = ROLE_LABEL_VI[authUser.role] || authUser.role;
  if (authUser.role === "admin") {
    document.getElementById("usersNavItem").style.display = "block";
    document.getElementById("securityNavItem").style.display = "block";
    document.getElementById("partnerFormPanel").style.display = "block";
  }
}
document.getElementById("logoutLink").addEventListener("click", async (e) => {
  e.preventDefault();
  // Thu hồi phiên trên server (token cũ không dùng lại được nữa), rồi mới xoá ở máy
  try {
    await fetch(`${API_BASE}/api/auth/me/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${localStorage.getItem("authToken")}` },
    });
  } catch { /* vẫn đăng xuất ở máy */ }
  localStorage.removeItem("authToken");
  localStorage.removeItem("authUser");
  window.location.href = "login.html";
});

function goToSection(name) {
  const btn = document.querySelector(`.dash-nav-item[data-section="${name}"]`);
  if (btn) btn.click();
}

/** fetch có tự gắn header Authorization — dùng cho mọi API cần đăng nhập */
async function authFetch(url, options = {}) {
  const token = localStorage.getItem("authToken");
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${token}` };
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    let reason = "Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.";
    try { reason = (await res.clone().json()).error || reason; } catch { /* giữ thông báo mặc định */ }
    localStorage.removeItem("authToken");
    localStorage.removeItem("authUser");
    alert(reason);
    window.location.href = "login.html";
    throw new Error("Chưa đăng nhập");
  }
  if (res.status === 403) {
    try {
      const body = await res.clone().json();
      if (body.code === "ADMIN_2FA_REQUIRED" && !window.__admin2faWarned) {
        window.__admin2faWarned = true;
        alert(body.error);
        goToSection("account");
      }
    } catch { /* bỏ qua */ }
  }
  return res;
}

// --- Kết nối ví ---

function roleBadgeHtml(label, active) {
  const style = active
    ? "background:var(--seal-verified-soft); color:var(--seal-verified)"
    : "background:var(--line); color:var(--muted)";
  return `<span class="pill" style="${style}">${active ? "✓ " : "— "}${esc(label)}</span>`;
}

async function refreshRoleBadges(address) {
  const badges = document.getElementById("roleBadges");
  const revokePanel = document.getElementById("revokePanel");
  badges.innerHTML = `<span class="pill">Đang kiểm tra...</span>`;
  try {
    const roles = await detectRoles(address);
    const { isManufacturer, isDistributor, isAdmin, isOperator, isGuardian } = roles;
    revokePanel.hidden = !(isAdmin || isGuardian);
    badges.innerHTML =
      roleBadgeHtml("Admin", isAdmin) +
      (isOperator ? roleBadgeHtml("Vận hành", true) : "") +
      (isGuardian ? roleBadgeHtml("Guardian", true) : "") +
      roleBadgeHtml("Sản xuất", isManufacturer) +
      roleBadgeHtml("Phân phối", isDistributor);
    return roles;
  } catch (err) {
    revokePanel.hidden = true;
    badges.innerHTML = `<span class="pill" style="background:var(--seal-danger-soft); color:var(--seal-danger)">Lỗi: ${esc(err.message)}</span>`;
    return null;
  }
}

async function handleConnect() {
  const btn = document.getElementById("connectBtn");
  btn.textContent = "Đang kết nối...";
  btn.disabled = true;
  try {
    wallet = await connectWallet();
    document.getElementById("walletDisconnected").style.display = "none";
    document.getElementById("walletConnected").style.display = "block";
    document.getElementById("walletAddress").textContent = wallet.address;
    await refreshRoleBadges(wallet.address);
    await renderProductGrid(); // lọc lại "sản phẩm đang giữ" theo ví vừa kết nối

    // Liên kết ví với tài khoản đăng nhập — để admin biết cấp quyền cho
    // đúng địa chỉ nào. Phải KÝ tin nhắn chứng minh sở hữu ví (SIWE), nên
    // kẻ chiếm được tài khoản web cũng không gắn được ví lạ vào.
    try {
      await linkWalletIfNeeded();
    } catch (err) {
      console.warn("Không liên kết được ví với tài khoản:", err);
      alert("Ví đã kết nối, nhưng chưa liên kết được với tài khoản: " + explainContractError(err));
    }
  } catch (err) {
    alert("Không kết nối được ví: " + err.message);
    btn.textContent = "Kết nối ví MetaMask";
    btn.disabled = false;
  }
}
document.getElementById("connectBtn").addEventListener("click", handleConnect);

/** Chỉ yêu cầu ký khi ví đang kết nối khác ví đã liên kết (hoặc chưa xác minh) */
async function linkWalletIfNeeded() {
  const meRes = await authFetch(`${API_BASE}/api/auth/me`);
  const me = await meRes.json();
  const current = wallet.address.toLowerCase();
  if (me.walletAddress === current && me.walletVerifiedAt) return;

  if (me.walletAddress && me.walletAddress !== current) {
    const ok = window.confirm(
      `Tài khoản của bạn đang liên kết với ví ${me.walletAddress}.\n\n` +
        `Đổi sang ví ${wallet.address}? Tài khoản sẽ chuyển về "Đang chờ duyệt" và admin sẽ nhận cảnh báo.`
    );
    if (!ok) return;
  }

  const nonceRes = await authFetch(`${API_BASE}/api/auth/me/wallet/nonce`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ walletAddress: wallet.address }),
  });
  const { message, error } = await nonceRes.json();
  if (!nonceRes.ok) throw new Error(error || "Không tạo được yêu cầu ký");

  const signature = await wallet.signer.signMessage(message);
  const linkRes = await authFetch(`${API_BASE}/api/auth/me/wallet`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ walletAddress: wallet.address, message, signature }),
  });
  const linked = await linkRes.json();
  if (!linkRes.ok) throw new Error(linked.error || "Liên kết ví thất bại");
}

function revokeErrorMessage(err) {
  const raw = [
    err && err.reason,
    err && err.shortMessage,
    err && err.message,
    err && err.info && err.info.error && err.info.error.message,
    err && err.cause && err.cause.message,
  ].filter(Boolean).join(" ").toLowerCase();
  const code = err && (err.code || (err.info && err.info.error && err.info.error.code));

  if (code === 4001 || code === "ACTION_REJECTED" || raw.includes("user rejected")) {
    return "Bạn đã từ chối ký giao dịch trong MetaMask.";
  }
  if (String(code).toUpperCase() === "INSUFFICIENT_FUNDS" || raw.includes("insufficient funds") || raw.includes("insufficient balance")) {
    return "Ví không đủ ETH trên Sepolia để trả phí gas. Hãy nạp Sepolia ETH rồi thử lại.";
  }
  if (raw.includes("không có quyền guardian/admin") || raw.includes("khong co quyen thu hoi")) {
    return "Ví đang kết nối không có quyền Guardian/Admin trên smart contract.";
  }
  if (raw.includes("accesscontrolunauthorizedaccount") || raw.includes("missing role")) {
    return "Ví đang kết nối không có quyền Guardian/Admin trên smart contract.";
  }
  if (raw.includes("không tồn tại trên smart contract")) {
    return "Token ID không tồn tại trên smart contract.";
  }
  if (raw.includes("erc721nonexistenttoken") || raw.includes("nonexistent token") || raw.includes("token khong ton tai")) {
    return "Token ID không tồn tại trên smart contract.";
  }
  if (raw.includes("đã bị thu hồi xác thực trước đó")) {
    return "Token này đã bị thu hồi xác thực trước đó.";
  }
  if (raw.includes("san pham da bi thu hoi xac thuc")) {
    return "Token này đã bị thu hồi xác thực trước đó.";
  }
  return "Không thể thực hiện giao dịch. Hãy kiểm tra kết nối Sepolia và thử lại.";
}

document.getElementById("revokeForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!requireWallet()) return;

  const form = e.currentTarget;
  const statusEl = document.getElementById("revokeStatus");
  const accessStatusEl = document.getElementById("revokeAccessStatus");
  const submitBtn = document.getElementById("revokeSubmitBtn");
  const txLink = document.getElementById("revokeTxLink");
  const tokenId = document.getElementById("revokeTokenId").value.trim();
  const reason = document.getElementById("revokeReason").value.trim();

  if (!/^\d+$/.test(tokenId)) {
    showStatus(statusEl, "Token ID phải là số nguyên không âm.", false);
    return;
  }
  if (!reason) {
    showStatus(statusEl, "Vui lòng nhập lý do thu hồi.", false);
    return;
  }
  if (!window.confirm(
    `Bạn sắp thu hồi xác thực token #${tokenId}.\n\n` +
    `Lý do: ${reason}\n\n` +
    "Thao tác này KHÔNG thể hoàn tác và sẽ chặn chuyển giao token. Bạn có chắc chắn muốn tiếp tục?"
  )) {
    return;
  }

  submitBtn.disabled = true;
  txLink.hidden = true;
  txLink.removeAttribute("href");
  accessStatusEl.className = "status-msg";
  accessStatusEl.textContent = "";

  try {
    showStatus(statusEl, "Đang kiểm tra quyền Admin và trạng thái token trên blockchain...", true);
    let roles;
    try {
      roles = await detectRoles(wallet.address);
    } catch (err) {
      document.getElementById("revokePanel").hidden = true;
      throw err;
    }
    if (!roles.isAdmin && !roles.isGuardian) {
      document.getElementById("revokePanel").hidden = true;
      throw new Error("Ví đang kết nối không có quyền Guardian/Admin trên smart contract.");
    }

    const readOnly = await getReadOnlyContract();
    const mintedCount = await readOnly.totalMinted();
    if (BigInt(tokenId) >= mintedCount) {
      throw new Error("Token ID không tồn tại trên smart contract.");
    }
    if (await readOnly.isRevoked(tokenId)) {
      throw new Error("Token này đã bị thu hồi xác thực trước đó.");
    }

    showStatus(statusEl, "Vui lòng xác nhận giao dịch trong MetaMask...", true);
    const tx = await wallet.contract.revokeAuthenticity(tokenId, reason);
    txLink.href = `https://sepolia.etherscan.io/tx/${tx.hash}`;
    txLink.textContent = `Xem giao dịch trên Sepolia Etherscan: ${tx.hash}`;
    txLink.hidden = false;
    showStatus(statusEl, "Đã gửi giao dịch. Đang chờ xác nhận trên blockchain...", true);

    await tx.wait();
    showStatus(statusEl, `Đã thu hồi xác thực token #${tokenId} thành công.`, true);
    form.reset();
  } catch (err) {
    console.error(err);
    const message = revokeErrorMessage(err);
    if (document.getElementById("revokePanel").hidden) {
      showStatus(accessStatusEl, message, false);
    } else {
      showStatus(statusEl, message, false);
    }
  } finally {
    submitBtn.disabled = false;
  }
});

if (window.ethereum) {
  window.ethereum.on("accountsChanged", () => window.location.reload());
  window.ethereum.on("chainChanged", () => window.location.reload());
}

function requireWallet() {
  if (!wallet) {
    alert("Vui lòng kết nối ví MetaMask trước.");
    return false;
  }
  return true;
}

// --- Quản lý người dùng (chỉ admin) ---

const USER_ROLE_TO_CONTRACT_ROLE = {
  manufacturer: "MANUFACTURER_ROLE",
  distributor: "DISTRIBUTOR_ROLE",
};
const STATUS_LABEL_VI = {
  chua_ket_noi_vi: "Chưa kết nối ví",
  cho_duyet: "Đang chờ duyệt",
  da_duyet: "Đã cấp quyền",
};

async function loadUsers() {
  const tbody = document.querySelector("#usersTable tbody");
  tbody.innerHTML = `<tr><td colspan="5">Đang tải...</td></tr>`;
  try {
    const res = await authFetch(`${API_BASE}/api/auth/users`);
    const users = await res.json();
    if (!res.ok) throw new Error(users.error || "Không tải được danh sách");

    tbody.innerHTML = "";
    users.forEach((u) => {
      const canApprove =
        u.walletAddress && u.walletVerifiedAt && u.roleStatus !== "da_duyet" && USER_ROLE_TO_CONTRACT_ROLE[u.role] && !u.disabled;
      // Cảnh báo nổi bật khi tài khoản ĐỔI VÍ — kịch bản kẻ chiếm tài khoản
      // đổi sang ví của họ rồi chờ admin bấm "Cấp quyền".
      const walletChange = u.previousWallet
        ? `<div style="margin-top:6px; padding:6px 8px; border-radius:8px; background:var(--seal-danger-soft); color:var(--seal-danger); font-size:0.75rem">
             ⚠ Đã đổi ví${u.walletChangedAt ? " lúc " + esc(new Date(u.walletChangedAt).toLocaleString("vi-VN")) : ""}<br>
             Ví cũ: <span class="mono">${esc(u.previousWallet)}</span><br>
             Gọi điện xác minh với đối tác TRƯỚC khi cấp quyền ví mới.
           </div>`
        : "";
      const unverified = u.walletAddress && !u.walletVerifiedAt
        ? `<div style="font-size:0.75rem; color:var(--seal-danger)">Chưa ký xác minh ví — yêu cầu người dùng kết nối lại ví</div>`
        : "";
      const isSelf = authUser && (u.username === authUser.username);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${esc(u.displayName || u.username)}${u.disabled ? ` <span class="pill" style="background:var(--seal-danger-soft); color:var(--seal-danger)">Đã khoá</span>` : ""}</td>
        <td>${esc(ROLE_LABEL_VI[u.role] || u.role)}</td>
        <td class="mono" style="font-size:0.78rem">${esc(u.walletAddress || "—")}${unverified}${walletChange}</td>
        <td><span class="pill" style="${u.roleStatus === "da_duyet" ? "background:var(--seal-verified-soft); color:var(--seal-verified)" : ""}">${esc(STATUS_LABEL_VI[u.roleStatus] || u.roleStatus)}</span></td>
        <td style="display:flex; gap:6px; flex-wrap:wrap">
          ${canApprove ? `<button class="btn btn-primary approve-btn" data-id="${esc(u._id)}" style="font-size:0.8rem; padding:6px 12px">Cấp quyền</button>` : ""}
          ${isSelf ? "" : `<button class="btn btn-outline disable-btn" data-id="${esc(u._id)}" data-disabled="${u.disabled ? "1" : "0"}" style="font-size:0.8rem; padding:6px 12px">${u.disabled ? "Mở khoá" : "Khoá tài khoản"}</button>`}
          ${isSelf ? "" : `<button class="btn btn-outline sessions-btn" data-id="${esc(u._id)}" style="font-size:0.8rem; padding:6px 12px">Đăng xuất mọi phiên</button>`}
        </td>
      `;
      tbody.appendChild(tr);
    });

    const byId = new Map(users.map((u) => [u._id, u]));
    tbody.querySelectorAll(".approve-btn").forEach((btn) => {
      btn.addEventListener("click", () => approveUser(byId.get(btn.dataset.id), btn));
    });
    tbody.querySelectorAll(".disable-btn").forEach((btn) => {
      btn.addEventListener("click", () => toggleDisableUser(byId.get(btn.dataset.id), btn));
    });
    tbody.querySelectorAll(".sessions-btn").forEach((btn) => {
      btn.addEventListener("click", () => revokeSessions(byId.get(btn.dataset.id), btn));
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:var(--seal-danger)">Lỗi: ${esc(err.message)}</td></tr>`;
  }
}

async function approveUser(user, btn) {
  if (!requireWallet()) return;
  const contractRoleName = USER_ROLE_TO_CONTRACT_ROLE[user.role];
  if (!contractRoleName) {
    alert("Vai trò này không có quyền on-chain tương ứng (ví dụ tài khoản admin).");
    return;
  }

  // Xác nhận lại bằng mắt: đúng người, đúng ví. Đây là điểm kẻ tấn công
  // nhắm tới nhất (lừa admin cấp quyền cho ví của họ).
  const confirmText =
    `Cấp ${contractRoleName} cho:\n\n` +
    `Tài khoản: ${user.displayName || user.username} (${user.username})\n` +
    `Ví: ${user.walletAddress}\n` +
    (user.previousWallet ? `\n⚠ TÀI KHOẢN NÀY VỪA ĐỔI VÍ (ví cũ ${user.previousWallet}).\nBạn đã gọi điện xác minh với đối tác chưa?\n` : "") +
    `\nKiểm tra 4 ký tự cuối ví với đối tác: ...${user.walletAddress.slice(-4)}`;
  if (!window.confirm(confirmText)) return;

  btn.disabled = true;
  btn.textContent = "Đang kiểm tra...";
  try {
    const roles = await detectRoles(wallet.address);
    if (!roles.isOperator && !roles.isAdmin) {
      throw new Error("Ví đang kết nối không có quyền Vận hành (OPERATOR_ROLE) để cấp quyền đối tác.");
    }
    // Đọc đúng giá trị bytes32 của role từ chính smart contract, tránh gõ tay sai
    const roleBytes = await wallet.contract[contractRoleName]();
    btn.textContent = "Đang ký...";
    const tx = await wallet.contract.grantRole(roleBytes, user.walletAddress);
    btn.textContent = "Đang xác nhận...";
    await tx.wait();

    // Backend tự đọc hasRole() trên chain trước khi đánh dấu đã duyệt
    const res = await authFetch(`${API_BASE}/api/auth/users/${user._id}/approve`, { method: "PATCH" });
    if (!res.ok) throw new Error((await res.json()).error || "Không cập nhật được trạng thái duyệt");
    await loadUsers();
  } catch (err) {
    console.error(err);
    alert("Lỗi khi cấp quyền: " + explainContractError(err));
    btn.disabled = false;
    btn.textContent = "Cấp quyền";
  }
}

async function toggleDisableUser(user, btn) {
  const disable = !user.disabled;
  const msg = disable
    ? `Khoá tài khoản ${user.username}? Mọi phiên đăng nhập của tài khoản này sẽ bị đăng xuất ngay.\n\n` +
      "Lưu ý: khoá tài khoản web KHÔNG tước quyền on-chain của ví. Nếu nghi ví bị hack, vào mục Bảo mật → Gắn cờ ví."
    : `Mở khoá tài khoản ${user.username}?`;
  if (!window.confirm(msg)) return;
  btn.disabled = true;
  try {
    const res = await authFetch(`${API_BASE}/api/auth/users/${user._id}/disable`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disabled: disable }),
    });
    if (!res.ok) throw new Error((await res.json()).error || "Thao tác thất bại");
    await loadUsers();
  } catch (err) {
    alert(err.message);
    btn.disabled = false;
  }
}

async function revokeSessions(user, btn) {
  if (!window.confirm(`Đăng xuất ${user.username} khỏi mọi thiết bị?`)) return;
  btn.disabled = true;
  try {
    const res = await authFetch(`${API_BASE}/api/auth/users/${user._id}/revoke-sessions`, { method: "POST" });
    if (!res.ok) throw new Error((await res.json()).error || "Thao tác thất bại");
    btn.textContent = "Đã đăng xuất ✓";
  } catch (err) {
    alert(err.message);
    btn.disabled = false;
  }
}

// --- Bảo mật & khẩn cấp (chỉ admin) ---

const SEVERITY_STYLE = {
  critical: "background:var(--seal-danger-soft); color:var(--seal-danger)",
  warning: "background:#fff4dc; color:#8a5a00",
  info: "",
};
const SEVERITY_LABEL = { critical: "Nghiêm trọng", warning: "Cảnh báo", info: "Thông tin" };

async function loadSecurity() {
  await Promise.all([loadContractSecurityState(), loadAuditLog(), loadCanaries(), loadBlockedIps()]);
}

async function loadCanaries() {
  const tbody = document.querySelector("#canaryTable tbody");
  try {
    const res = await authFetch(`${API_BASE}/api/shop/canary`);
    const list = await res.json();
    if (!res.ok) throw new Error(list.error || "Không tải được đơn bẫy");
    tbody.innerHTML = list.length
      ? list
          .map(
            (o) => `<tr>
          <td class="mono">#${esc(o.tokenId)}</td>
          <td>${esc(o.buyerName)} · <span class="mono">${esc(o.buyerPhone)}</span></td>
          <td style="font-size:0.8rem">${esc(new Date(o.createdAt).toLocaleString("vi-VN"))}</td>
          <td>${o.revealCount ? `<span class="pill" style="background:var(--seal-danger-soft); color:var(--seal-danger)">${o.revealCount} lần ⚠</span>` : "0"}</td>
          <td><button type="button" class="btn btn-outline canary-del" data-id="${esc(o._id)}" style="font-size:0.78rem; padding:5px 10px">Gỡ</button></td>
        </tr>`
          )
          .join("")
      : `<tr><td colspan="5">Chưa có đơn bẫy nào.</td></tr>`;
    tbody.querySelectorAll(".canary-del").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!window.confirm("Gỡ đơn bẫy này?")) return;
        await authFetch(`${API_BASE}/api/shop/canary/${b.dataset.id}`, { method: "DELETE" });
        loadCanaries();
      })
    );
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:var(--seal-danger)">Lỗi: ${esc(err.message)}</td></tr>`;
  }
}

document.getElementById("canaryForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("canaryStatus");
  try {
    const res = await authFetch(`${API_BASE}/api/shop/canary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tokenId: document.getElementById("cnToken").value,
        buyerName: document.getElementById("cnName").value.trim(),
        buyerPhone: document.getElementById("cnPhone").value.trim(),
        buyerAddress: document.getElementById("cnAddress").value.trim(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Không tạo được đơn bẫy");
    showStatus(statusEl, "Đã tạo đơn bẫy.", true);
    e.target.reset();
    loadCanaries();
  } catch (err) {
    showStatus(statusEl, err.message, false);
  }
});

async function loadContractSecurityState() {
  const el = document.getElementById("contractSecurityState");
  try {
    const c = await getReadOnlyContract();
    let paused = null;
    try { paused = await c.paused(); } catch { /* contract cũ */ }
    if (paused === null) {
      el.innerHTML = `⚠ Contract đang dùng là bản cũ, chưa có chức năng dừng khẩn cấp / gắn cờ ví. Cần deploy lại bản bảo mật.`;
      return;
    }
    el.innerHTML = paused
      ? `<strong style="color:var(--seal-danger)">⏸ HỆ THỐNG ĐANG TẠM DỪNG</strong> — không ai mint/chuyển giao được cho tới khi Admin (multisig) mở lại.`
      : `<strong style="color:var(--seal-verified)">● Đang hoạt động bình thường</strong>`;
  } catch (err) {
    el.textContent = "Không đọc được trạng thái contract: " + err.message;
  }
}

// Loại sự cố → hành động xử lý phù hợp
const ACCOUNT_EVENTS = new Set([
  "login", "login_new_ip", "account_locked", "mfa_failed_password_ok", "login_disabled_account", "wallet_changed",
  "wallet_signature_mismatch", "concurrent_sessions", "not_me_reported", "mfa_disabled",
  "mfa_backup_code_used", "order_reveal_burst", "order_reveal_blocked", "canary_triggered", "password_changed",
]);
const WALLET_FLAG_EVENTS = new Set([
  "wallet_changed", "onchain_role_granted", "onchain_mint_unknown_wallet", "onchain_mint_burst",
  "onchain_transfer_unknown_wallet",
]);
const PAUSE_EVENTS = new Set(["onchain_mint_burst", "onchain_mint_unknown_wallet", "onchain_role_granted", "onchain_role_admin_changed"]);
const STATUS_VI = { resolved: "Đã xử lý", false_positive: "Báo nhầm" };

function auditActions(l) {
  const isOpen = l.severity !== "info" && !["resolved", "false_positive"].includes(l.status);
  const tokenId = l.meta && l.meta.tokenId !== undefined ? String(l.meta.tokenId) : "";
  const b = (act, label, extra = "") =>
    `<button type="button" class="btn btn-outline audit-act" data-act="${act}" data-id="${esc(l._id)}" ${extra}
      style="font-size:0.74rem; padding:4px 9px; margin:0 4px 4px 0">${label}</button>`;
  if (l.severity === "info") return `<span style="color:var(--ink-3); font-size:0.78rem">—</span>`;

  let html = "";
  if (!isOpen) {
    html += `<div style="font-size:0.76rem; margin-bottom:4px"><span class="pill" style="${l.status === "resolved" ? "background:var(--seal-verified-soft); color:var(--seal-verified)" : ""}">${esc(STATUS_VI[l.status])}</span>
      ${l.handledBy ? ` bởi <b>${esc(l.handledBy)}</b>` : ""}${l.handledAt ? ` · ${esc(new Date(l.handledAt).toLocaleString("vi-VN"))}` : ""}
      ${l.resolutionNote ? `<br><i>${esc(l.resolutionNote)}</i>` : ""}</div>`;
    return html + b("reopen", "↺ Mở lại");
  }
  if (tokenId) {
    // Link thường (không dùng window.open) → không bao giờ bị chặn như popup
    html += `<a class="btn btn-outline" href="verify.html?tokenId=${encodeURIComponent(tokenId)}" target="_blank" rel="noopener noreferrer"
      style="font-size:0.74rem; padding:4px 9px; margin:0 4px 4px 0; text-decoration:none">🔍 Xem SP</a>`;
    html += b("revoke-product", "⛔ Thu hồi SP", `data-token="${esc(tokenId)}"`);
  }
  if (l.userId && ACCOUNT_EVENTS.has(l.type)) {
    html += b("lock-user", "🔒 Khoá TK", `data-user="${esc(l.userId)}" data-name="${esc(l.username)}"`);
    html += b("revoke-sessions", "⏏ Đăng xuất TK", `data-user="${esc(l.userId)}" data-name="${esc(l.username)}"`);
  }
  if (l.wallet && WALLET_FLAG_EVENTS.has(l.type)) {
    html += b("flag-wallet", "🚩 Gắn cờ ví", `data-wallet="${esc(l.wallet)}"`);
  }
  if (PAUSE_EVENTS.has(l.type)) html += b("pause", "⏸ Dừng khẩn cấp");
  if (l.ip) html += b("block-ip", "🚫 Chặn IP", `data-ip="${esc(l.ip)}"`);
  html += `<div>${b("resolve", "✓ Đã xử lý")}${b("false-positive", "✗ Báo nhầm")}</div>`;
  return html;
}

async function loadAuditLog() {
  const tbody = document.querySelector("#auditTable tbody");
  const filter = document.getElementById("auditFilter").value;
  tbody.innerHTML = `<tr><td colspan="5">Đang tải...</td></tr>`;
  try {
    const q = filter === "all" ? "" : filter === "open" ? "?status=open" : `?severity=${filter}`;
    const res = await authFetch(`${API_BASE}/api/auth/audit${q}`);
    const logs = await res.json();
    if (!res.ok) throw new Error(logs.error || "Không tải được nhật ký");
    if (!logs.length) {
      tbody.innerHTML = `<tr><td colspan="5">${filter === "open" ? "🎉 Không còn cảnh báo nào cần xử lý." : "Chưa có sự kiện nào."}</td></tr>`;
      return;
    }
    tbody.innerHTML = logs
      .map(
        (l) => `<tr>
          <td style="white-space:nowrap; font-size:0.8rem">${esc(new Date(l.createdAt).toLocaleString("vi-VN"))}</td>
          <td><span class="pill" style="${SEVERITY_STYLE[l.severity] || ""}">${esc(SEVERITY_LABEL[l.severity] || l.severity)}</span></td>
          <td style="font-size:0.85rem">${esc(l.message)}
            ${l.txHash ? `<br><a class="mono" style="font-size:0.75rem" target="_blank" rel="noopener noreferrer" href="https://sepolia.etherscan.io/tx/${esc(l.txHash)}">${esc(l.txHash.slice(0, 18))}…</a>` : ""}</td>
          <td class="mono" style="font-size:0.75rem">${esc(l.username || "")}${l.wallet ? `<br>${esc(l.wallet)}` : ""}${l.ip ? `<br>IP ${esc(l.ip)}` : ""}</td>
          <td>${auditActions(l)}</td>
        </tr>`
      )
      .join("");
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:var(--seal-danger)">Lỗi: ${esc(err.message)}</td></tr>`;
  }
}

// --- IP đang bị chặn ---
async function loadBlockedIps() {
  const tbody = document.querySelector("#blockedIpTable tbody");
  if (!tbody) return;
  try {
    const res = await authFetch(`${API_BASE}/api/auth/blocked-ips`);
    const list = await res.json();
    if (!res.ok) throw new Error(list.error || "Không tải được danh sách");
    tbody.innerHTML = list.length
      ? list
          .map(
            (b) => `<tr>
              <td class="mono">${esc(b.ip)}</td>
              <td style="font-size:0.85rem">${b.auto ? '<span class="pill">Tự động</span> ' : ""}${esc(b.reason)}${b.blockedBy ? ` — ${esc(b.blockedBy)}` : ""}</td>
              <td style="font-size:0.8rem; white-space:nowrap">${esc(new Date(b.until).toLocaleString("vi-VN"))}</td>
              <td><button type="button" class="btn btn-outline unblock-ip" data-ip="${esc(b.ip)}" style="font-size:0.74rem; padding:4px 9px">Bỏ chặn</button></td>
            </tr>`
          )
          .join("")
      : `<tr><td colspan="4">Không có IP nào đang bị chặn.</td></tr>`;
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" style="color:var(--seal-danger)">Lỗi: ${esc(err.message)}</td></tr>`;
  }
}

document.getElementById("blockedIpTable").addEventListener("click", async (e) => {
  const btn = e.target.closest(".unblock-ip");
  if (!btn) return;
  if (!window.confirm(`Bỏ chặn IP ${btn.dataset.ip}?`)) return;
  const res = await authFetch(`${API_BASE}/api/auth/blocked-ips/${encodeURIComponent(btn.dataset.ip)}`, { method: "DELETE" });
  if (!res.ok) alert((await res.json()).error || "Không bỏ chặn được");
  await loadBlockedIps();
});

document.getElementById("blockIpForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("blockIpStatus");
  const res = await authFetch(`${API_BASE}/api/auth/blocked-ips`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ip: document.getElementById("blockIpInput").value.trim(),
      minutes: Number(document.getElementById("blockIpMinutes").value),
      reason: "Admin chặn thủ công",
    }),
  });
  const r = await res.json();
  showStatus(statusEl, res.ok ? "Đã chặn." : "Lỗi: " + r.error, res.ok);
  if (res.ok) document.getElementById("blockIpInput").value = "";
  await loadBlockedIps();
});

async function setAuditStatus(id, status) {
  let note = "";
  if (status !== "open") {
    note = window.prompt(
      status === "resolved" ? "Ghi chú cách đã xử lý (ví dụ: đã gọi điện xác minh, đã thu hồi SP #3):" : "Vì sao là báo nhầm? (ví dụ: chính chủ đổi mạng 4G)",
      ""
    );
    if (note === null) return;
  }
  const res = await authFetch(`${API_BASE}/api/auth/audit/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status, note }),
  });
  if (!res.ok) alert((await res.json()).error || "Không cập nhật được");
  await Promise.all([loadAuditLog(), refreshSecurityBadge()]);
}

function scrollAndHighlight(el) {
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.style.outline = "3px solid var(--seal-danger)";
  el.style.outlineOffset = "4px";
  setTimeout(() => (el.style.outline = ""), 2500);
}

document.querySelector("#auditTable tbody").addEventListener("click", async (e) => {
  const btn = e.target.closest(".audit-act");
  if (!btn) return;
  const d = btn.dataset;
  switch (d.act) {
    case "resolve":
      return setAuditStatus(d.id, "resolved");
    case "false-positive":
      return setAuditStatus(d.id, "false_positive");
    case "reopen":
      return setAuditStatus(d.id, "open");
    case "revoke-product": {
      // Điền sẵn form thu hồi (ký bằng ví Guardian/Admin ở mục Sản phẩm)
      goToSection("products");
      const panel = document.getElementById("revokePanel");
      document.getElementById("revokeTokenId").value = d.token;
      document.getElementById("revokeReason").value = "Xử lý cảnh báo bảo mật: nghi hàng giả / tem bị sao chép";
      if (panel.hidden) {
        alert("Kết nối ví có quyền Guardian hoặc Admin để hiện khung Thu hồi xác thực, rồi bấm lại nút này.");
        return;
      }
      return scrollAndHighlight(panel);
    }
    case "lock-user": {
      if (!window.confirm(`Khoá tài khoản ${d.name}? Mọi phiên đăng nhập của tài khoản này bị đăng xuất ngay.`)) return;
      const res = await authFetch(`${API_BASE}/api/auth/users/${encodeURIComponent(d.user)}/disable`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disabled: true }),
      });
      const r = await res.json();
      alert(res.ok ? `Đã khoá tài khoản ${d.name}. Mở khoá lại ở mục Quản lý người dùng sau khi xác minh.` : r.error);
      return;
    }
    case "revoke-sessions": {
      if (!window.confirm(`Đăng xuất ${d.name} khỏi mọi thiết bị?`)) return;
      const res = await authFetch(`${API_BASE}/api/auth/users/${encodeURIComponent(d.user)}/revoke-sessions`, { method: "POST" });
      alert(res.ok ? `Đã đăng xuất ${d.name} khỏi mọi thiết bị.` : (await res.json()).error);
      return;
    }
    case "flag-wallet": {
      const input = document.getElementById("flagWallet");
      input.value = d.wallet;
      return scrollAndHighlight(document.getElementById("flagForm"));
    }
    case "pause":
      return scrollAndHighlight(document.getElementById("pauseBtn"));
    case "block-ip": {
      const hours = window.prompt(
        `Chặn IP ${d.ip} trong bao nhiêu GIỜ? (1 = 1 giờ, 24 = 1 ngày, 168 = 7 ngày)\n\nLưu ý: nhiều người có thể dùng chung IP này (cùng mạng trường/công ty).`,
        "24"
      );
      if (hours === null) return;
      const h = Number(hours);
      if (!(h > 0)) return alert("Số giờ không hợp lệ");
      const res = await authFetch(`${API_BASE}/api/auth/blocked-ips`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ip: d.ip, minutes: Math.round(h * 60), reason: "Admin chặn từ nhật ký bảo mật" }),
      });
      const r = await res.json();
      alert(res.ok ? `Đã chặn IP ${d.ip} trong ${h} giờ.` : r.error);
      await Promise.all([loadBlockedIps(), loadAuditLog()]);
      return;
    }
    default:
      return undefined;
  }
});

// Số cảnh báo chưa xử lý trên menu
async function refreshSecurityBadge() {
  if (!authUser || authUser.role !== "admin") return;
  const badge = document.getElementById("securityBadge");
  try {
    const res = await fetch(`${API_BASE}/api/auth/audit/summary`, {
      // Đếm cảnh báo chạy nền → không được tính là "đang thao tác" (không gia hạn phiên)
      headers: { Authorization: `Bearer ${localStorage.getItem("authToken")}`, "X-Background-Check": "1" },
    });
    if (!res.ok) return;
    const { open, critical } = await res.json();
    badge.hidden = !open;
    badge.textContent = open > 99 ? "99+" : String(open);
    badge.style.background = critical ? "var(--seal-danger)" : "#d97706";
    badge.title = `${open} cảnh báo chưa xử lý${critical ? `, trong đó ${critical} nghiêm trọng` : ""}`;
  } catch {
    /* bỏ qua */
  }
}
refreshSecurityBadge();
setInterval(refreshSecurityBadge, 60 * 1000);

// --- Tự thoát khi phiên bị thu hồi ---
// Admin bấm "Đăng xuất mọi phiên" / "Khoá tài khoản", hoặc chủ tài khoản bấm
// "Không phải tôi" → các tab đang mở phải văng ra NGAY, không chờ tới lần bấm nút kế tiếp.
// Kiểm tra mỗi 15 giây + mỗi khi quay lại tab. Không gia hạn thời gian chờ của phiên.
let sessionCheckBusy = false;
async function checkSessionAlive() {
  if (sessionCheckBusy || !localStorage.getItem("authToken")) return;
  sessionCheckBusy = true;
  try {
    await authFetch(`${API_BASE}/api/auth/session-check`, { headers: { "X-Background-Check": "1" } });
  } catch {
    /* 401 → authFetch đã báo lý do và chuyển về trang đăng nhập; lỗi mạng thì thử lại lần sau */
  } finally {
    sessionCheckBusy = false;
  }
}
setInterval(checkSessionAlive, 15 * 1000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") checkSessionAlive();
});
window.addEventListener("focus", checkSessionAlive);

// Mở thẳng mục Bảo mật khi vào từ link trong tin Telegram (admin.html#security)
if (window.location.hash === "#security" && authUser && authUser.role === "admin") {
  goToSection("security");
}

document.getElementById("auditFilter").addEventListener("change", loadAuditLog);

async function runSecurityTx(statusEl, requiredRole, confirmText, send) {
  if (!requireWallet()) return;
  if (!window.confirm(confirmText)) return;
  try {
    const roles = await detectRoles(wallet.address);
    const allowed = requiredRole === "guardian" ? roles.isGuardian : roles.isAdmin;
    if (!allowed) {
      throw new Error(
        requiredRole === "guardian"
          ? "Ví đang kết nối không có quyền Guardian."
          : "Ví đang kết nối không có quyền Admin. Nếu admin là ví multisig (Safe), hãy thực hiện thao tác này trong app.safe.global."
      );
    }
    showStatus(statusEl, "Vui lòng xác nhận giao dịch trong MetaMask...", true);
    const tx = await send();
    showStatus(statusEl, "Đang chờ xác nhận trên blockchain...", true);
    await tx.wait();
    showStatus(statusEl, `Thành công — Tx: ${tx.hash.slice(0, 14)}...`, true);
    await loadSecurity();
  } catch (err) {
    console.error(err);
    showStatus(statusEl, "Lỗi: " + explainContractError(err), false);
  }
}

document.getElementById("pauseBtn").addEventListener("click", () => {
  runSecurityTx(
    document.getElementById("pauseStatus"),
    "guardian",
    "DỪNG KHẨN CẤP toàn hệ thống?\n\nMọi thao tác mint/chuyển giao sẽ bị chặn cho tới khi Admin (multisig) mở lại. Người tiêu dùng vẫn quét QR xác thực bình thường.",
    () => wallet.contract.pause()
  );
});

document.getElementById("unpauseBtn").addEventListener("click", () => {
  runSecurityTx(
    document.getElementById("pauseStatus"),
    "admin",
    "Mở lại hệ thống? Chỉ làm khi đã xử lý xong sự cố (đã gắn cờ / thu hồi quyền các ví bị hack).",
    () => wallet.contract.unpause()
  );
});

document.getElementById("flagForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("flagStatus");
  const target = document.getElementById("flagWallet").value.trim();
  const sinceInput = document.getElementById("flagSince").value;
  if (!/^0x[a-fA-F0-9]{40}$/.test(target)) {
    showStatus(statusEl, "Địa chỉ ví không hợp lệ.", false);
    return;
  }
  const since = sinceInput ? Math.floor(new Date(sinceInput).getTime() / 1000) : 0;
  if (since && since > Date.now() / 1000) {
    showStatus(statusEl, "Thời điểm nghi lộ khoá không được ở tương lai.", false);
    return;
  }
  runSecurityTx(
    statusEl,
    "guardian",
    `Gắn cờ BỊ XÂM PHẠM cho ví ${target}?\n\n` +
      `• Tước ngay quyền sản xuất / phân phối / vận hành của ví này\n` +
      `• Mọi sản phẩm ví này mint/chuyển giao từ ${since ? new Date(since * 1000).toLocaleString("vi-VN") : "bây giờ"} sẽ hiện cảnh báo khi quét QR`,
    () => wallet.contract.flagCompromised(target, since)
  );
});

document.getElementById("clearFlagBtn").addEventListener("click", () => {
  const statusEl = document.getElementById("flagStatus");
  const target = document.getElementById("clearWallet").value.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(target)) {
    showStatus(statusEl, "Địa chỉ ví cần gỡ cờ không hợp lệ.", false);
    return;
  }
  runSecurityTx(
    statusEl,
    "admin",
    `Gỡ cờ xâm phạm cho ví ${target}?\n\nChỉ làm khi đã điều tra và chắc chắn là báo nhầm. Gỡ cờ KHÔNG tự cấp lại quyền.`,
    () => wallet.contract.clearCompromised(target)
  );
});

// --- Đơn hàng (do người tiêu dùng đặt ở shop.html, không cần ví) ---

const ORDER_STATUS_VI = { moi: "Mới đặt", da_xac_nhan: "Đã xác nhận", da_giao: "Đã giao hàng" };

async function loadOrders() {
  const tbody = document.querySelector("#ordersTable tbody");
  tbody.innerHTML = `<tr><td colspan="7">Đang tải...</td></tr>`;
  try {
    const res = await authFetch(`${API_BASE}/api/shop/orders`);
    const orders = await res.json();
    if (!res.ok) throw new Error(orders.error || "Không tải được danh sách đơn hàng");

    tbody.innerHTML = "";
    if (orders.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7">Chưa có đơn hàng nào.</td></tr>`;
      return;
    }
    orders.forEach((o) => {
      const tr = document.createElement("tr");
      tr.dataset.id = o._id;
      tr.innerHTML = `
        <td class="mono">#${esc(o.tokenId)}</td>
        <td>${esc(o.productName || "-")}</td>
        <td class="pii-name">${esc(o.buyerName)}</td>
        <td class="mono pii-phone">${esc(o.buyerPhone)}</td>
        <td style="max-width:200px" class="pii-address">${esc(o.buyerAddress)}</td>
        <td><span class="pill" style="${o.status === "da_giao" ? "background:var(--seal-verified-soft); color:var(--seal-verified)" : ""}">${esc(ORDER_STATUS_VI[o.status] || o.status)}</span></td>
        <td style="display:flex; gap:6px; flex-wrap:wrap; align-items:center">
          ${o.anonymized ? "" : `<button type="button" class="btn btn-outline reveal-btn" data-id="${esc(o._id)}" style="font-size:0.78rem; padding:5px 10px">👁 Xem đầy đủ</button>`}
          <select class="order-status-select" data-id="${esc(o._id)}" style="font-size:0.8rem; padding:6px">
            <option value="moi" ${o.status === "moi" ? "selected" : ""}>Mới đặt</option>
            <option value="da_xac_nhan" ${o.status === "da_xac_nhan" ? "selected" : ""}>Đã xác nhận</option>
            <option value="da_giao" ${o.status === "da_giao" ? "selected" : ""}>Đã giao hàng</option>
          </select>
        </td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll(".reveal-btn").forEach((btn) => {
      btn.addEventListener("click", () => revealOrderRow(btn));
    });
    tbody.querySelectorAll(".order-status-select").forEach((sel) => {
      sel.addEventListener("change", async () => {
        try {
          await authFetch(`${API_BASE}/api/shop/orders/${sel.dataset.id}/status`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: sel.value }),
          });
          await loadOrders();
        } catch (err) {
          alert("Lỗi khi cập nhật đơn hàng: " + err.message);
        }
      });
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" style="color:var(--seal-danger)">Lỗi: ${esc(err.message)}</td></tr>`;
  }
}

/** Mở xem đầy đủ 1 đơn — tự che lại sau 60 giây */
async function revealOrderRow(btn) {
  const tr = btn.closest("tr");
  btn.disabled = true;
  try {
    const res = await authFetch(`${API_BASE}/api/shop/orders/${btn.dataset.id}/reveal`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Không mở được thông tin");
    const cells = {
      name: tr.querySelector(".pii-name"),
      phone: tr.querySelector(".pii-phone"),
      address: tr.querySelector(".pii-address"),
    };
    const masked = { name: cells.name.textContent, phone: cells.phone.textContent, address: cells.address.textContent };
    cells.name.textContent = data.buyerName;
    cells.phone.textContent = data.buyerPhone;
    cells.address.textContent = data.buyerAddress + (data.note ? ` — Ghi chú: ${data.note}` : "");
    btn.textContent = "Đang hiện (60s)";
    setTimeout(() => {
      cells.name.textContent = masked.name;
      cells.phone.textContent = masked.phone;
      cells.address.textContent = masked.address;
      btn.textContent = "👁 Xem đầy đủ";
      btn.disabled = false;
    }, 60 * 1000);
  } catch (err) {
    alert(err.message);
    btn.disabled = false;
  }
}

// --- Danh sách "Sản phẩm của tôi" ---

function statusLabel(p, currentOwner) {
  if (currentOwner && wallet && currentOwner === wallet.address.toLowerCase()) {
    return p.mintedBy === wallet.address.toLowerCase() ? "Đã phát hành" : "Đang giữ (đã nhận)";
  }
  return "Đã chuyển đi";
}

function productQRCodeURL(product) {
  const apiRoot = `${API_BASE.replace(/\/+$/, "")}/`;
  return new URL(
    `api/products/${encodeURIComponent(product.tokenId)}/qr`,
    apiRoot
  ).href;
}

async function renderProductGrid() {
  const grid = document.getElementById("productGrid");
  const hint = document.getElementById("productsHint");
  grid.innerHTML = "";

  if (!wallet) {
    hint.textContent = "Kết nối ví để xem sản phẩm bạn đang giữ.";
    return;
  }
  if (productLoadError) {
    hint.textContent = `Lỗi tải danh sách sản phẩm: ${productLoadError}`;
    return;
  }
  if (allProducts.length === 0) {
    hint.textContent = "Chưa có sản phẩm nào được mint trên smart contract này.";
    return;
  }

  hint.textContent = "Đang kiểm tra chủ sở hữu hiện tại trên blockchain...";

  // Nguồn sự thật về "ai đang giữ sản phẩm" là smart contract (ownerOf), KHÔNG
  // phải trường mintedBy trong cache — vì mintedBy không đổi sau khi chuyển giao,
  // còn ownerOf thay đổi mỗi lần transferCustody(). Đây là lý do nhà phân phối
  // (chỉ nhận, không mint) vẫn phải thấy đúng sản phẩm họ đang giữ.
  const readOnly = await getReadOnlyContract();
  const withOwners = await Promise.all(
    allProducts.map(async (p) => {
      try {
        const owner = (await readOnly.ownerOf(p.tokenId)).toLowerCase();
        return { ...p, currentOwner: owner };
      } catch {
        return { ...p, currentOwner: null }; // token có thể đã bị revoke/không đọc được
      }
    })
  );

  const mine = withOwners.filter((p) => p.currentOwner === wallet.address.toLowerCase());
  grid.innerHTML = "";

  if (mine.length === 0) {
    hint.textContent = "Ví này chưa đang giữ sản phẩm nào — nhà sản xuất mint mới, hoặc chờ được chuyển giao từ bước trước.";
    return;
  }
  hint.textContent = `${mine.length} sản phẩm ví này đang giữ (đã mint hoặc đã nhận qua chuyển giao).`;

  mine.forEach((p) => {
    const card = document.createElement("div");
    card.className = "product-card";
    card.innerHTML = `
      <div class="product-card-top">
        <span class="mono" style="font-size:0.8rem; color:var(--muted)">#${esc(p.tokenId)}</span>
        <span class="pill">${statusLabel(p, p.currentOwner)}</span>
      </div>
        <h3>${esc(p.name || "(chưa đặt tên)")}</h3>
        <p class="product-card-meta">${p.batch ? "Lô " + esc(p.batch) : ""}${p.batch && p.productCode ? " · " : ""}${esc(p.productCode || "")}</p>
      <p class="product-card-date">${new Date(p.mintedAt).toLocaleString("vi-VN")}</p>
      <div class="product-card-actions">
          <a class="btn btn-outline" href="${esc(productQRCodeURL(p))}" target="_blank" rel="noopener noreferrer" style="font-size:0.82rem; padding:8px 12px">▦ Mã QR</a>
          <button class="btn btn-primary transfer-btn" data-token="${esc(p.tokenId)}" style="font-size:0.82rem; padding:8px 12px">➤ Chuyển giao</button>
          ${p.mintedBy === wallet.address.toLowerCase() ? `<button class="btn btn-outline regen-code-btn" data-token="${esc(p.tokenId)}" data-name="${esc(p.name || "")}" data-qr="${esc(productQRCodeURL(p))}" style="font-size:0.82rem; padding:8px 12px" title="Cấp lại mã cào (tem cũ mất hiệu lực)">🎟 Mã cào</button>` : ""}
          <a class="btn btn-outline" href="${esc(window.getProductVerifyURL(p.tokenId))}" target="_blank" rel="noopener noreferrer" style="font-size:0.82rem; padding:8px 10px">↗</a>
      </div>
    `;
    grid.appendChild(card);
  });

  grid.querySelectorAll(".regen-code-btn").forEach((btn) => {
    btn.addEventListener("click", () => regenerateClaimCode(btn));
  });
  grid.querySelectorAll(".transfer-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.getElementById("tTokenId").value = btn.dataset.token;
      document.getElementById("transferTokenLabel").textContent = `#${btn.dataset.token}`;
      openModal("transferModal");
    });
  });
}

async function loadProducts() {
  try {
    const res = await fetch(`${API_BASE}/api/products`);
    const products = await res.json();
    if (!res.ok) throw new Error(products.error || "Không tải được danh sách sản phẩm");
    allProducts = products.map((p) => ({ ...p, mintedBy: (p.mintedBy || "").toLowerCase() }));
    productLoadError = "";
  } catch (err) {
    allProducts = [];
    productLoadError = err.message;
  }
  await renderProductGrid();
}

// --- Danh bạ đối tác ---

const ROLE_LABELS = { DISTRIBUTOR: "Phân phối", RETAILER: "Bán lẻ", MANUFACTURER: "Sản xuất" };

async function loadPartners() {
  let partners = [];
  try {
    const res = await fetch(`${API_BASE}/api/partners`);
    partners = await res.json();
  } catch {
    // Backend chưa chạy — bỏ qua
  }

  const tbody = document.querySelector("#partnerTable tbody");
  tbody.innerHTML = "";
  partners.forEach((p) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${esc(p.name)}</td><td>${esc(ROLE_LABELS[p.role] || p.role)}</td><td class="mono">${esc(p.walletAddress)}</td>`;
    tbody.appendChild(tr);
  });

  const select = document.getElementById("tHolderSelect");
  const currentValue = select.value;
  select.innerHTML = `
    <option value="">-- Chọn đối tác từ danh bạ --</option>
    ${partners
      .map(
        (p) =>
          `<option value="${esc(p.walletAddress)}">${esc(p.name)} (${esc(ROLE_LABELS[p.role] || p.role)}) — ${esc(p.walletAddress.slice(0, 6))}...${esc(p.walletAddress.slice(-4))}</option>`
      )
      .join("")}
    <option value="__manual__">Nhập địa chỉ ví thủ công...</option>
  `;
  if ([...select.options].some((o) => o.value === currentValue)) select.value = currentValue;
}

document.getElementById("partnerForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("partnerStatus");
  const payload = {
    name: document.getElementById("pName").value,
    walletAddress: document.getElementById("pAddress").value.trim(),
    role: document.getElementById("pRole").value,
  };
  try {
    const res = await authFetch(`${API_BASE}/api/partners`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Lỗi khi thêm đối tác");
    showStatus(statusEl, `Đã thêm "${payload.name}" vào danh bạ`, true);
    document.getElementById("partnerForm").reset();
    loadPartners();
  } catch (err) {
    showStatus(statusEl, "Lỗi: " + err.message, false);
  }
});

document.getElementById("tHolderSelect").addEventListener("change", (e) => {
  const manualInput = document.getElementById("tHolder");
  if (e.target.value === "__manual__") {
    manualInput.style.display = "block";
    manualInput.value = "";
    manualInput.focus();
  } else {
    manualInput.style.display = "none";
    manualInput.value = e.target.value;
  }
});

// --- Phát hành sản phẩm (mint) ---

/**
 * Xin chữ ký uỷ quyền mint. Nếu máy chủ yêu cầu xác thực lại → hiện hộp
 * passkey / mã 6 số, xác thực xong tự xin lại.
 */
async function requestMintAuthorization(body, retried = false) {
  const res = await authFetch(`${API_BASE}/api/products/mint-authorization`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data;
  if (data.code === "STEP_UP_REQUIRED" && !retried) {
    const ok = await stepUpDialog("Xác thực lại để phát hành sản phẩm");
    if (!ok) throw new Error("Bạn đã huỷ xác thực — chưa phát hành.");
    return requestMintAuthorization(body, true);
  }
  if (data.code === "STRONG_AUTH_REQUIRED") goToSection("account");
  throw new Error(data.error || "Không được cấp phép phát hành");
}

/** Hộp xác thực lại: passkey (ưu tiên) hoặc mã 6 số. Trả về true nếu thành công. */
async function stepUpDialog(title) {
  const optRes = await authFetch(`${API_BASE}/api/auth/me/step-up/options`, { method: "POST" });
  const opts = await optRes.json();
  if (!optRes.ok) {
    if (opts.code === "STRONG_AUTH_REQUIRED") goToSection("account");
    throw new Error(opts.error || "Không xác thực lại được");
  }
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.style.cssText = "position:fixed;inset:0;z-index:99997;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:16px";
    const box = document.createElement("div");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.style.cssText = "background:#fff;max-width:420px;width:100%;border-radius:14px;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.3)";
    box.innerHTML = `<h3 style="margin:0 0 6px;font-size:18px"></h3>
      <p style="margin:0 0 14px;color:#475569;font-size:14px">Mật khẩu thôi là chưa đủ. Chứng minh bạn đang cầm thiết bị của chính chủ — hiệu lực ${esc(opts.minutes)} phút.</p>
      <div id="suPasskeyRow" hidden><button type="button" class="btn btn-primary" id="suPasskey" style="width:100%">🔑 Xác thực bằng passkey</button></div>
      <div id="suTotpRow" hidden style="margin-top:12px">
        <label for="suCode" style="font-size:13px;font-weight:600">Mã 6 số từ app Authenticator</label>
        <div style="display:flex;gap:8px;margin-top:6px"><input id="suCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" style="flex:1" class="input">
        <button type="button" class="btn btn-primary" id="suTotp">Xác nhận</button></div>
      </div>
      <p id="suErr" style="color:#b91c1c;font-size:13px;min-height:18px;margin:10px 0 0"></p>
      <div style="text-align:right;margin-top:8px"><button type="button" class="btn btn-outline" id="suCancel">Huỷ</button></div>`;
    box.querySelector("h3").textContent = title;
    wrap.appendChild(box);
    document.body.appendChild(wrap);
    const err = box.querySelector("#suErr");
    const done = (v) => { wrap.remove(); resolve(v); };
    const submit = async (payload) => {
      err.textContent = "Đang kiểm tra...";
      const r = await authFetch(`${API_BASE}/api/auth/me/step-up`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) return done(true);
      err.textContent = j.error || "Xác thực thất bại";
    };
    if (opts.methods.includes("passkey") && window.Passkey && Passkey.supported()) {
      box.querySelector("#suPasskeyRow").hidden = false;
      box.querySelector("#suPasskey").addEventListener("click", async () => {
        try {
          const credential = await Passkey.get(opts.passkey);
          await submit({ credential });
        } catch (e) {
          err.textContent = Passkey.friendlyError(e);
        }
      });
    }
    if (opts.methods.includes("totp")) {
      box.querySelector("#suTotpRow").hidden = false;
      const input = box.querySelector("#suCode");
      box.querySelector("#suTotp").addEventListener("click", () => submit({ code: input.value.trim() }));
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit({ code: input.value.trim() }); });
      setTimeout(() => input.focus(), 50);
    }
    box.querySelector("#suCancel").addEventListener("click", () => done(false));
  });
}

// --- Helper: lấy GPS + upload ảnh (dùng chung cho mint và transfer) ---

function wireGpsButton(buttonId, inputId) {
  document.getElementById(buttonId).addEventListener("click", () => {
    const input = document.getElementById(inputId);
    if (!navigator.geolocation) {
      alert("Trình duyệt này không hỗ trợ định vị GPS.");
      return;
    }
    input.value = "Đang lấy vị trí...";
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        input.value = `${pos.coords.latitude.toFixed(6)},${pos.coords.longitude.toFixed(6)}`;
      },
      (err) => {
        input.value = "";
        alert("Không lấy được vị trí: " + err.message + " (cần cho phép quyền định vị trong trình duyệt)");
      }
    );
  });
}
wireGpsButton("mintGpsBtn", "mintGps");
wireGpsButton("tGpsBtn", "tGps");

function wirePhotoPreview(fileInputId, previewId) {
  document.getElementById(fileInputId).addEventListener("change", (e) => {
    const file = e.target.files[0];
    const preview = document.getElementById(previewId);
    if (!file) { preview.innerHTML = ""; return; }
    preview.innerHTML = `<img src="${esc(URL.createObjectURL(file))}" alt="Xem trước ảnh">`;
  });
}
wirePhotoPreview("mintPhoto", "mintPhotoPreview");
wirePhotoPreview("tPhoto", "tPhotoPreview");

/** Upload file ảnh (nếu có chọn) lên IPFS qua backend, trả về "" nếu không chọn ảnh */
async function uploadPhotoIfAny(fileInputId) {
  const file = document.getElementById(fileInputId).files[0];
  if (!file) return "";
  const form = new FormData();
  form.append("photo", file);
  const res = await authFetch(`${API_BASE}/api/products/photo`, { method: "POST", body: form });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Lỗi khi tải ảnh lên");
  return data.url;
}

// --- Phát hành sản phẩm (mint) ---

document.getElementById("openMintModal").addEventListener("click", () => {
  if (!requireWallet()) return;
  openModal("mintModal");
});

document.getElementById("mintForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!requireWallet()) return;

  const statusEl = document.getElementById("mintStatus");
  const payload = {
    productCode: document.getElementById("productCode").value,
    name: document.getElementById("name").value,
    description: document.getElementById("description").value,
    image: document.getElementById("image").value,
    manufacturer: document.getElementById("manufacturer").value,
    batch: document.getElementById("batch").value,
  };
  const gpsCoords = document.getElementById("mintGps").value.trim();

  try {
    showStatus(statusEl, "Đang lưu metadata sản phẩm...", true);
    const metaRes = await authFetch(`${API_BASE}/api/products/metadata`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const metaData = await metaRes.json();
    if (!metaRes.ok) throw new Error(metaData.error || "Lỗi khi lưu metadata");

    showStatus(statusEl, "Đang tải ảnh lên IPFS (nếu có)...", true);
    const photoURI = await uploadPhotoIfAny("mintPhoto");

    // Contract đã bật MINT HAI CHỮ KÝ? → xin chữ ký thứ hai (cần xác thực lại passkey/2FA)
    const readOnly = await getReadOnlyContract();
    let authorizer = ethers.ZeroAddress;
    try { authorizer = await readOnly.mintAuthorizer(); } catch { /* contract cũ chưa có tính năng này */ }

    let tx;
    if (authorizer !== ethers.ZeroAddress) {
      showStatus(statusEl, "Đang xin phép phát hành (cần xác thực lại passkey / mã 2FA)...", true);
      const auth = await requestMintAuthorization({
        minter: wallet.address,
        to: wallet.address,
        tokenURI: metaData.tokenURI,
        productCode: payload.productCode,
        photoURI,
        gpsCoords,
      });
      if (auth.authorizer.toLowerCase() !== authorizer.toLowerCase()) {
        throw new Error("Khoá uỷ quyền của máy chủ không khớp khoá trên contract — dừng lại, báo quản trị viên.");
      }
      showStatus(statusEl, "Kiểm tra nội dung rồi xác nhận trong MetaMask...", true);
      tx = await wallet.contract.mintProductAuthorized(
        wallet.address,
        metaData.tokenURI,
        payload.productCode,
        photoURI,
        gpsCoords,
        auth.nonce,
        auth.deadline,
        auth.signature
      );
    } else {
      showStatus(statusEl, "Vui lòng xác nhận giao dịch trong MetaMask...", true);
      tx = await wallet.contract.mintProduct(wallet.address, metaData.tokenURI, payload.productCode, photoURI, gpsCoords);
    }
    showStatus(statusEl, "Đang chờ giao dịch được xác nhận trên blockchain...", true);
    const receipt = await tx.wait();

    const mintedEvent = receipt.logs
      .map((log) => {
        try { return wallet.contract.interface.parseLog(log); } catch { return null; }
      })
      .find((ev) => ev && ev.name === "ProductMinted");
    const tokenId = mintedEvent ? mintedEvent.args.tokenId.toString() : null;
    if (tokenId === null) throw new Error("Không đọc được tokenId từ sự kiện ProductMinted");

    showStatus(statusEl, "Đang sinh mã QR...", true);
    const recordRes = await authFetch(`${API_BASE}/api/products/record`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokenId, ...payload, tokenURI: metaData.tokenURI, txHash: tx.hash, mintedBy: wallet.address }),
    });
    const record = await recordRes.json();
    if (!recordRes.ok) throw new Error(record.error || "Lỗi khi ghi nhận sản phẩm");

    showStatus(statusEl, `Đã phát hành thành công — Token ID #${tokenId}`, true);
    document.getElementById("qrImg").src = productQRCodeURL(record);
    document.getElementById("qrTokenId").textContent = `Token #${tokenId} — ${tx.hash.slice(0, 14)}...`;
    document.getElementById("qrPreview").classList.add("show");
    showClaimCode(tokenId, record.claimCode, productQRCodeURL(record), payload.name);
    if (!record.claimCode && record.claimCodeError) {
      showStatus(statusEl, `Đã phát hành #${tokenId}, nhưng chưa tạo được mã cào: ${record.claimCodeError}`, false);
    }
    document.getElementById("mintForm").reset();
    document.getElementById("mintPhotoPreview").innerHTML = "";
    await loadProducts();
  } catch (err) {
    console.error(err);
    showStatus(statusEl, "Lỗi: " + explainContractError(err), false);
  }
});

// --- Cập nhật chuỗi cung ứng ---

document.getElementById("transferForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!requireWallet()) return;

  const statusEl = document.getElementById("transferStatus");
  const tokenId = document.getElementById("tTokenId").value;
  const newHolderAddress = document.getElementById("tHolder").value;
  const actorRole = document.getElementById("tRole").value;
  const location = document.getElementById("tLocation").value;
  const action = document.getElementById("tAction").value;
  const gpsCoords = document.getElementById("tGps").value.trim();

  if (!/^0x[a-fA-F0-9]{40}$/.test(newHolderAddress)) {
    showStatus(statusEl, "Địa chỉ ví người nhận không hợp lệ — phải có dạng 0x kèm 40 ký tự hex.", false);
    return;
  }

  try {
    showStatus(statusEl, "Đang tải ảnh lên IPFS (nếu có)...", true);
    const photoURI = await uploadPhotoIfAny("tPhoto");

    showStatus(statusEl, "Vui lòng xác nhận giao dịch trong MetaMask...", true);
    const tx = await wallet.contract.transferCustody(
      tokenId,
      newHolderAddress,
      actorRole,
      location,
      action,
      photoURI,
      gpsCoords
    );
    showStatus(statusEl, "Đang chờ giao dịch được xác nhận trên blockchain...", true);
    await tx.wait();

    showStatus(statusEl, `Đã cập nhật chuỗi cung ứng — Tx: ${tx.hash.slice(0, 14)}...`, true);
    document.getElementById("transferForm").reset();
    document.getElementById("tHolder").style.display = "none";
    document.getElementById("tPhotoPreview").innerHTML = "";
  } catch (err) {
    console.error(err);
    showStatus(statusEl, "Lỗi: " + explainContractError(err), false);
  }
});

loadProducts();
loadPartners();

// --- Tài khoản của tôi: 2FA, Telegram, phiên đăng nhập, đổi mật khẩu ---

let myAccount = null;

async function loadAccount() {
  try {
    const res = await authFetch(`${API_BASE}/api/auth/me`);
    myAccount = await res.json();
    if (!res.ok) throw new Error(myAccount.error || "Không tải được tài khoản");
    renderMfaState();
    renderTelegramState();
    document.getElementById("pwCodeField").hidden = !myAccount.twoFactorEnabled;
  } catch (err) {
    document.getElementById("mfaState").textContent = "Lỗi: " + err.message;
  }
  loadSessions();
  loadPasskeys();
}

function renderMfaState() {
  const on = myAccount.twoFactorEnabled;
  document.getElementById("mfaState").innerHTML = on
    ? `<strong style="color:var(--seal-verified)">● Đang bật</strong> — đăng nhập cần mã 6 số từ app trên điện thoại. Còn ${myAccount.backupCodesLeft} mã dự phòng.`
    : myAccount.passkeyCount
    ? `<strong>● Mã 6 số chưa bật</strong> — tài khoản đang được bảo vệ bằng <strong>passkey</strong>. Có thể bật thêm mã 6 số để có mã dự phòng khi mất thiết bị.`
    : `<strong style="color:var(--seal-danger)">● Chưa bật</strong> — lộ mật khẩu là người khác vào được tài khoản.` +
      (authUser && authUser.role === "admin" ? " <strong>Tài khoản admin nên bật ngay.</strong>" : "");
  document.getElementById("mfaStartBtn").hidden = on;
  document.getElementById("mfaDisableBtn").hidden = !on;
  document.getElementById("mfaNewBackupBtn").hidden = !on;
  if (on) document.getElementById("mfaSetup").hidden = true;
}

function showBackupCodes(codes) {
  document.getElementById("mfaBackupList").innerHTML = codes.map((c) => `<span>${esc(c)}</span>`).join("");
  document.getElementById("mfaBackup").hidden = false;
}

document.getElementById("mfaStartBtn").addEventListener("click", async () => {
  const statusEl = document.getElementById("mfaStatus");
  try {
    const res = await authFetch(`${API_BASE}/api/auth/me/2fa/setup`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    document.getElementById("mfaQr").src = data.qrDataUrl;
    document.getElementById("mfaSecret").textContent = data.secret.replace(/(.{4})/g, "$1 ").trim();
    document.getElementById("mfaSetup").hidden = false;
    document.getElementById("mfaEnableCode").focus();
  } catch (err) {
    showStatus(statusEl, err.message, false);
  }
});

document.getElementById("mfaEnableBtn").addEventListener("click", async () => {
  const statusEl = document.getElementById("mfaStatus");
  try {
    const res = await authFetch(`${API_BASE}/api/auth/me/2fa/enable`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: document.getElementById("mfaEnableCode").value.trim() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    showStatus(statusEl, "Đã bật xác thực 2 lớp.", true);
    showBackupCodes(data.backupCodes);
    await loadAccount();
  } catch (err) {
    showStatus(statusEl, err.message, false);
  }
});

document.getElementById("mfaNewBackupBtn").addEventListener("click", async () => {
  const statusEl = document.getElementById("mfaStatus");
  const code = window.prompt("Nhập mã 6 số từ app Authenticator để tạo bộ mã dự phòng mới (bộ cũ sẽ mất hiệu lực):");
  if (!code) return;
  try {
    const res = await authFetch(`${API_BASE}/api/auth/me/2fa/backup-codes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code.trim() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    showBackupCodes(data.backupCodes);
    await loadAccount();
  } catch (err) {
    showStatus(statusEl, err.message, false);
  }
});

document.getElementById("mfaDisableBtn").addEventListener("click", async () => {
  const statusEl = document.getElementById("mfaStatus");
  const password = window.prompt("Tắt xác thực 2 lớp làm tài khoản kém an toàn hơn.\nNhập MẬT KHẨU để tiếp tục:");
  if (!password) return;
  const code = window.prompt("Nhập mã 6 số từ app Authenticator:");
  if (!code) return;
  try {
    const res = await authFetch(`${API_BASE}/api/auth/me/2fa/disable`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, code: code.trim() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    showStatus(statusEl, "Đã tắt xác thực 2 lớp.", true);
    document.getElementById("mfaBackup").hidden = true;
    await loadAccount();
  } catch (err) {
    showStatus(statusEl, err.message, false);
  }
});

function renderTelegramState() {
  const linked = myAccount.telegramLinked;
  document.getElementById("tgState").innerHTML = linked
    ? `<strong style="color:var(--seal-verified)">● Đã liên kết</strong> — bạn sẽ nhận tin khi có đăng nhập từ nơi lạ, kèm nút "Không phải tôi" để khoá tài khoản ngay.`
    : `<strong>● Chưa liên kết</strong> — liên kết để nhận cảnh báo đăng nhập lạ ngay trên điện thoại.`;
  document.getElementById("tgLinkBtn").textContent = linked ? "Liên kết lại" : "Liên kết Telegram";
  document.getElementById("tgUnlinkBtn").hidden = !linked;
}

document.getElementById("tgLinkBtn").addEventListener("click", async () => {
  const statusEl = document.getElementById("tgStatus");
  try {
    let res = await authFetch(`${API_BASE}/api/auth/me/telegram/link`, { method: "POST" });
    let data = await res.json();
    if (!res.ok && data.code === "STEP_UP_REQUIRED") {
      if (!(await stepUpDialog("Xác thực lại để đổi Telegram nhận cảnh báo"))) throw new Error("Đã huỷ.");
      res = await authFetch(`${API_BASE}/api/auth/me/telegram/link`, { method: "POST" });
      data = await res.json();
    }
    if (!res.ok) throw new Error(data.error);
    window.open(data.url, "_blank", "noopener");
    statusEl.className = "status-msg show ok";
    statusEl.innerHTML =
      `Đã mở Telegram — bấm <strong>Start</strong> trong cuộc trò chuyện với bot (link hết hạn sau ${data.expiresInMinutes} phút). ` +
      `Không tự mở? <a href="${esc(data.url)}" target="_blank" rel="noopener noreferrer">Bấm vào đây</a>. Sau đó tải lại mục này.`;
  } catch (err) {
    showStatus(statusEl, err.message, false);
  }
});

document.getElementById("tgUnlinkBtn").addEventListener("click", async () => {
  if (!window.confirm("Huỷ liên kết Telegram? Bạn sẽ không nhận cảnh báo đăng nhập lạ nữa.")) return;
  let res = await authFetch(`${API_BASE}/api/auth/me/telegram`, { method: "DELETE" });
  let data = await res.json().catch(() => ({}));
  if (!res.ok && data.code === "STEP_UP_REQUIRED") {
    if (!(await stepUpDialog("Xác thực lại để gỡ Telegram"))) return;
    res = await authFetch(`${API_BASE}/api/auth/me/telegram`, { method: "DELETE" });
    data = await res.json().catch(() => ({}));
  }
  if (!res.ok) alert(data.error || "Không gỡ được liên kết");
  loadAccount();
});

const SESSION_STATE_VI = {
  active: "Đang hoạt động",
  idle: "Tự đăng xuất (không dùng)",
  revoked: "Đã đăng xuất",
  expired: "Hết hạn",
};
const REVOKE_REASON_VI = {
  logout: "Đã đăng xuất",
  user_revoked: "Bạn đã đăng xuất thiết bị này",
  logout_all: "Đăng xuất tất cả",
  password_changed: "Đổi mật khẩu",
  not_me: "Báo không phải tôi",
};

async function loadSessions() {
  const tbody = document.querySelector("#sessionsTable tbody");
  const hist = document.querySelector("#loginHistoryTable tbody");
  try {
    const res = await authFetch(`${API_BASE}/api/auth/me/sessions`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    const t = (d) => esc(new Date(d).toLocaleString("vi-VN"));
    tbody.innerHTML = data.active
      .map(
        (s) => `<tr>
        <td>${esc(s.device)}${s.current ? ` <span class="pill" style="background:var(--seal-verified-soft); color:var(--seal-verified)">Thiết bị này</span>` : ""}</td>
        <td class="mono" style="font-size:0.8rem">${esc(s.lastSeenIp)}${s.newIp ? ` <span class="pill" style="background:#fff4dc; color:#8a5a00">IP mới</span>` : ""}</td>
        <td style="font-size:0.8rem">${t(s.createdAt)}</td>
        <td style="font-size:0.8rem">${t(s.lastSeenAt)}</td>
        <td>${s.current ? "" : `<button type="button" class="btn btn-outline session-revoke" data-id="${esc(s.id)}" style="font-size:0.78rem; padding:5px 10px">Đăng xuất</button>`}</td>
      </tr>`
      )
      .join("");
    hist.innerHTML = data.history
      .map(
        (s) => `<tr>
        <td style="font-size:0.8rem">${t(s.createdAt)}</td>
        <td>${esc(s.device)}</td>
        <td class="mono" style="font-size:0.8rem">${esc(s.ip)}${s.newIp ? " ⚠" : ""}</td>
        <td style="font-size:0.8rem">${esc(s.state === "revoked" ? REVOKE_REASON_VI[s.revokedReason] || "Đã đăng xuất" : SESSION_STATE_VI[s.state])}</td>
      </tr>`
      )
      .join("");
    tbody.querySelectorAll(".session-revoke").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!window.confirm("Đăng xuất thiết bị này? Nếu bạn không nhận ra thiết bị, hãy đổi mật khẩu ngay sau đó.")) return;
        await authFetch(`${API_BASE}/api/auth/me/sessions/${encodeURIComponent(b.dataset.id)}`, { method: "DELETE" });
        loadSessions();
      })
    );
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:var(--seal-danger)">Lỗi: ${esc(err.message)}</td></tr>`;
  }
}

document.getElementById("logoutAllBtn").addEventListener("click", async () => {
  if (!window.confirm("Đăng xuất khỏi TẤT CẢ thiết bị, kể cả thiết bị này?")) return;
  await authFetch(`${API_BASE}/api/auth/me/logout-all`, { method: "POST" });
  localStorage.removeItem("authToken");
  localStorage.removeItem("authUser");
  window.location.href = "login.html";
});

document.getElementById("pwForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("pwStatus");
  try {
    const res = await authFetch(`${API_BASE}/api/auth/me/password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currentPassword: document.getElementById("pwCurrent").value,
        newPassword: document.getElementById("pwNew").value,
        code: document.getElementById("pwCode").value.trim(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    localStorage.setItem("authToken", data.token);
    showStatus(statusEl, "Đã đổi mật khẩu. Mọi thiết bị khác đã bị đăng xuất.", true);
    e.target.reset();
    loadSessions();
  } catch (err) {
    showStatus(statusEl, err.message, false);
  }
});

// --- Banner cảnh báo "đăng nhập từ nơi lạ" (hiện ngay khi mở trang) ---

async function loadSecurityNotices() {
  const box = document.getElementById("securityNotice");
  const list = document.getElementById("securityNoticeList");
  try {
    const res = await authFetch(`${API_BASE}/api/auth/me/security-notices`);
    const notices = await res.json();
    if (!res.ok || !notices.length) {
      box.hidden = true;
      return;
    }
    list.innerHTML = notices
      .map(
        (n) => `<div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; padding:8px 0; border-top:1px solid var(--line)">
        <div><strong>${esc(new Date(n.createdAt).toLocaleString("vi-VN"))}</strong> · ${esc(n.device)} · IP <span class="mono">${esc(n.ip)}</span>${n.state === "active" ? " · <em>vẫn đang đăng nhập</em>" : ""}</div>
        <div style="display:flex; gap:8px">
          <button type="button" class="btn btn-outline notice-ok" data-id="${esc(n.id)}" style="font-size:0.8rem; padding:6px 12px">Đúng là tôi</button>
          <button type="button" class="btn btn-danger notice-notme" data-id="${esc(n.id)}" style="font-size:0.8rem; padding:6px 12px">Không phải tôi</button>
        </div>
      </div>`
      )
      .join("");
    box.hidden = false;
    document.getElementById("noticeAckAllBtn").onclick = async () => {
      await authFetch(`${API_BASE}/api/auth/me/security-notices/ack`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: notices.map((n) => n.id) }),
      });
      loadSecurityNotices();
    };
    list.querySelectorAll(".notice-ok").forEach((b) =>
      b.addEventListener("click", async () => {
        await authFetch(`${API_BASE}/api/auth/me/security-notices/ack`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: [b.dataset.id] }),
        });
        loadSecurityNotices();
      })
    );
    list.querySelectorAll(".notice-notme").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!window.confirm("Xác nhận KHÔNG PHẢI BẠN? Mọi thiết bị khác sẽ bị đăng xuất ngay, quản trị viên được báo, và bạn cần đổi mật khẩu.")) return;
        await authFetch(`${API_BASE}/api/auth/me/not-me`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: b.dataset.id }),
        });
        alert("Đã đăng xuất mọi thiết bị khác và báo quản trị viên. Hãy ĐỔI MẬT KHẨU ngay ở mục Tài khoản của tôi.");
        loadSecurityNotices();
        goToSection("account");
        document.getElementById("pwCurrent").focus();
      })
    );
  } catch {
    box.hidden = true;
  }
}
loadSecurityNotices();

// --- Mã cào dùng 1 lần ---

let lastClaimLabel = null;

function showClaimCode(tokenId, code, qrUrl, name) {
  const box = document.getElementById("claimCodeBox");
  if (!code) {
    box.hidden = true;
    return;
  }
  lastClaimLabel = { tokenId, code, qrUrl, name };
  document.getElementById("claimCodeValue").textContent = code;
  box.hidden = false;
}

/** Mở trang in tem: QR + mã cào + hướng dẫn. Ô mã cào in khung để dán lớp bạc phủ lên. */
function printClaimLabel(label) {
  const w = window.open("", "_blank", "width=420,height=600");
  if (!w) {
    alert("Trình duyệt chặn cửa sổ in — cho phép pop-up rồi thử lại.");
    return;
  }
  const qr = new URL(label.qrUrl, window.location.href).href;
  w.document.write(`<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>Tem #${esc(label.tokenId)}</title>
  <style>
    body{font-family:Arial,sans-serif;margin:0;padding:16px}
    .tem{width:62mm;border:1px dashed #999;padding:4mm;text-align:center}
    .tem img{width:40mm;height:40mm}
    .name{font-size:9pt;font-weight:bold;margin:2mm 0 1mm}
    .id{font-size:7pt;color:#555}
    .scratch{margin:3mm auto 2mm;border:1.5px solid #000;border-radius:2mm;padding:2.5mm 1mm;font:bold 13pt "Courier New",monospace;letter-spacing:1px}
    .hd{font-size:6.5pt;line-height:1.35;text-align:left}
    @media print{.noprint{display:none}}
  </style></head><body>
  <div class="tem">
    <img src="${esc(qr)}" alt="QR">
    <div class="name">${esc(label.name || "")}</div>
    <div class="id">Token #${esc(label.tokenId)}</div>
    <div class="scratch">${esc(label.code)}</div>
    <div class="hd">① Cào lớp bạc ② Quét mã QR ③ Nhập mã để xác thực &amp; đăng ký chủ sở hữu.<br><b>KHÔNG MUA nếu lớp cào đã bị cào.</b></div>
  </div>
  <p class="noprint" style="font-size:12px;color:#555">Dán lớp phủ cào (scratch-off sticker) lên ô có viền đen.</p>
  <button class="noprint" type="button" id="printBtn">In</button>
  </body></html>`);
  w.document.close();

  // Gắn sự kiện TỪ trang này (không dùng onclick/<script> trong cửa sổ in) → tuân thủ CSP
  w.document.getElementById("printBtn").addEventListener("click", () => w.print());
  // Chỉ in khi ảnh QR đã tải xong — in sớm sẽ ra tem THIẾU mã QR
  const img = w.document.querySelector("img");
  const go = () => setTimeout(() => w.print(), 150);
  if (img.complete && img.naturalWidth) go();
  else {
    img.addEventListener("load", go);
    img.addEventListener("error", () => w.alert("Không tải được ảnh mã QR — kiểm tra kết nối rồi bấm In lại."));
  }
}

document.getElementById("printLabelBtn").addEventListener("click", () => {
  if (lastClaimLabel) printClaimLabel(lastClaimLabel);
});

async function regenerateClaimCode(btn) {
  if (
    !window.confirm(
      `Cấp lại mã cào cho sản phẩm #${btn.dataset.token}?\n\n` +
        "Mã/tem CŨ sẽ mất hiệu lực ngay — chỉ làm khi tem in hỏng hoặc nghi mã bị lộ, và sản phẩm CHƯA được người mua kích hoạt."
    )
  )
    return;
  btn.disabled = true;
  try {
    const res = await authFetch(`${API_BASE}/api/products/${encodeURIComponent(btn.dataset.token)}/claim-code`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Không cấp lại được mã");
    const label = { tokenId: btn.dataset.token, code: data.claimCode, qrUrl: btn.dataset.qr, name: btn.dataset.name };
    if (window.confirm(`Mã cào mới (chỉ hiện 1 lần):\n\n${data.claimCode}\n\nBấm OK để in tem ngay.`)) {
      printClaimLabel(label);
    }
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
}

document.getElementById("recoverForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("recoverStatus");
  const tokenId = document.getElementById("recoverToken").value;
  if (!window.confirm(`Bạn ĐÃ gọi điện xác minh đúng chủ sở hữu sản phẩm #${tokenId}?\nLink khôi phục cũ (nếu có) sẽ mất hiệu lực.`)) return;
  try {
    const res = await authFetch(`${API_BASE}/api/products/${encodeURIComponent(tokenId)}/claim/recover`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    statusEl.className = "status-msg show ok";
    statusEl.innerHTML =
      `Liên hệ khách đăng ký: <strong>${esc(data.contactMasked || "không có")}</strong> — chỉ gửi link nếu khớp.<br>` +
      `Link (gửi riêng cho khách, mở trên điện thoại mới): <span class="mono">${esc(data.link)}</span>`;
  } catch (err) {
    showStatus(statusEl, err.message, false);
  }
});

// --- Passkey ---

async function loadPasskeys() {
  const tbody = document.querySelector("#passkeyTable tbody");
  const addBtn = document.getElementById("passkeyAddBtn");
  if (!Passkey.supported()) {
    addBtn.disabled = true;
    addBtn.textContent = "Trình duyệt này không hỗ trợ passkey";
  }
  try {
    const res = await authFetch(`${API_BASE}/api/auth/me/passkeys`);
    const list = await res.json();
    if (!res.ok) throw new Error(list.error);
    const t = (d) => (d ? esc(new Date(d).toLocaleString("vi-VN")) : "—");
    tbody.innerHTML = list.length
      ? list
          .map(
            (p) => `<tr>
          <td>🔑 ${esc(p.name)}</td>
          <td style="font-size:0.8rem">${t(p.createdAt)}</td>
          <td style="font-size:0.8rem">${t(p.lastUsedAt)}</td>
          <td><button type="button" class="btn btn-outline passkey-del" data-id="${esc(p.id)}" data-name="${esc(p.name)}" style="font-size:0.78rem; padding:5px 10px">Xoá</button></td>
        </tr>`
          )
          .join("")
      : `<tr><td colspan="4">Chưa có passkey nào.</td></tr>`;
    tbody.querySelectorAll(".passkey-del").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!window.confirm(`Xoá passkey "${b.dataset.name}"? Thiết bị đó sẽ không đăng nhập bằng passkey được nữa.`)) return;
        const r = await authFetch(`${API_BASE}/api/auth/me/passkeys/${encodeURIComponent(b.dataset.id)}`, { method: "DELETE" });
        if (!r.ok) alert((await r.json()).error);
        loadPasskeys();
      })
    );
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" style="color:var(--seal-danger)">Lỗi: ${esc(err.message)}</td></tr>`;
  }
}

document.getElementById("passkeyAddBtn").addEventListener("click", async () => {
  const statusEl = document.getElementById("passkeyStatus");
  const password = window.prompt("Để thêm passkey, nhập lại MẬT KHẨU tài khoản (chống trường hợp người khác đang dùng phiên của bạn):");
  if (!password) return;
  try {
    const optRes = await authFetch(`${API_BASE}/api/auth/me/passkeys/options`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const options = await optRes.json();
    if (!optRes.ok) throw new Error(options.error);
    showStatus(statusEl, "Làm theo hướng dẫn trên màn hình: quét vân tay, khuôn mặt hoặc nhập PIN của máy...", true);
    const credential = await Passkey.create(options);
    const name = window.prompt("Đặt tên cho passkey này (để nhận biết thiết bị):", Passkey.guessDeviceName()) || Passkey.guessDeviceName();
    const res = await authFetch(`${API_BASE}/api/auth/me/passkeys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, credential }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    showStatus(statusEl, `Đã thêm passkey "${data.name}". Lần sau bấm "Đăng nhập bằng passkey" ở trang đăng nhập.`, true);
    loadPasskeys();
  } catch (err) {
    showStatus(statusEl, err && err.name && err.name !== "Error" ? Passkey.friendlyError(err) : err.message, false);
  }
});

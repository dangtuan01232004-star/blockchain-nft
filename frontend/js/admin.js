// API_BASE đã được khai báo sẵn trong web3.js (load trước file này)
let wallet = null; // { signer, address, contract, config }
let allProducts = []; // cache toàn bộ sản phẩm lấy từ backend, lọc lại ở client
let productLoadError = "";

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
    ["products", "partners", "users", "orders"].forEach((s) => {
      document.getElementById(`section-${s}`).style.display = btn.dataset.section === s ? "block" : "none";
    });
    if (btn.dataset.section === "users") loadUsers();
    if (btn.dataset.section === "orders") loadOrders();
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
  }
}
document.getElementById("logoutLink").addEventListener("click", (e) => {
  e.preventDefault();
  localStorage.removeItem("authToken");
  localStorage.removeItem("authUser");
  window.location.href = "login.html";
});

/** fetch có tự gắn header Authorization — dùng cho mọi API cần đăng nhập */
async function authFetch(url, options = {}) {
  const token = localStorage.getItem("authToken");
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${token}` };
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    localStorage.removeItem("authToken");
    localStorage.removeItem("authUser");
    alert("Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.");
    window.location.href = "login.html";
    throw new Error("Chưa đăng nhập");
  }
  return res;
}

// --- Kết nối ví ---

function roleBadgeHtml(label, active) {
  const style = active
    ? "background:var(--seal-verified-soft); color:var(--seal-verified)"
    : "background:var(--line); color:var(--muted)";
  return `<span class="pill" style="${style}">${active ? "✓ " : "— "}${label}</span>`;
}

async function refreshRoleBadges(address) {
  const badges = document.getElementById("roleBadges");
  badges.innerHTML = `<span class="pill">Đang kiểm tra...</span>`;
  try {
    const { isManufacturer, isDistributor, isAdmin } = await detectRoles(address);
    badges.innerHTML =
      roleBadgeHtml("Admin", isAdmin) +
      roleBadgeHtml("Sản xuất", isManufacturer) +
      roleBadgeHtml("Phân phối", isDistributor);
  } catch (err) {
    badges.innerHTML = `<span class="pill" style="background:var(--seal-danger-soft); color:var(--seal-danger)">Lỗi: ${err.message}</span>`;
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

    // Ghi lại địa chỉ ví này vào tài khoản đăng nhập — để admin biết cấp
    // quyền cho đúng địa chỉ nào ở mục "Quản lý người dùng".
    try {
      await authFetch(`${API_BASE}/api/auth/me/wallet`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: wallet.address }),
      });
    } catch {
      // Không chặn luồng chính nếu lưu ví thất bại — chỉ ảnh hưởng tính năng duyệt quyền
    }
  } catch (err) {
    alert("Không kết nối được ví: " + err.message);
    btn.textContent = "Kết nối ví MetaMask";
    btn.disabled = false;
  }
}
document.getElementById("connectBtn").addEventListener("click", handleConnect);

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
      const canApprove = u.walletAddress && u.roleStatus !== "da_duyet" && USER_ROLE_TO_CONTRACT_ROLE[u.role];
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${u.displayName || u.username}</td>
        <td>${ROLE_LABEL_VI[u.role] || u.role}</td>
        <td class="mono" style="font-size:0.78rem">${u.walletAddress || "—"}</td>
        <td><span class="pill" style="${u.roleStatus === "da_duyet" ? "background:var(--seal-verified-soft); color:var(--seal-verified)" : ""}">${STATUS_LABEL_VI[u.roleStatus] || u.roleStatus}</span></td>
        <td>${canApprove ? `<button class="btn btn-primary approve-btn" data-id="${u._id}" data-role="${u.role}" data-wallet="${u.walletAddress}" style="font-size:0.8rem; padding:6px 12px">Cấp quyền</button>` : ""}</td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll(".approve-btn").forEach((btn) => {
      btn.addEventListener("click", () => approveUser(btn.dataset.id, btn.dataset.role, btn.dataset.wallet, btn));
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:var(--seal-danger)">Lỗi: ${err.message}</td></tr>`;
  }
}

async function approveUser(userId, targetRole, targetWallet, btn) {
  if (!requireWallet()) return;
  const contractRoleName = USER_ROLE_TO_CONTRACT_ROLE[targetRole];
  if (!contractRoleName) {
    alert("Vai trò này không có quyền on-chain tương ứng (ví dụ tài khoản admin).");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Đang ký...";
  try {
    // Đọc đúng giá trị bytes32 của role từ chính smart contract, tránh gõ tay sai
    const roleBytes = await wallet.contract[contractRoleName]();
    const tx = await wallet.contract.grantRole(roleBytes, targetWallet);
    btn.textContent = "Đang xác nhận...";
    await tx.wait();

    // Giao dịch on-chain đã thành công — giờ ghi lại trạng thái ở MongoDB để hiển thị
    await authFetch(`${API_BASE}/api/auth/users/${userId}/approve`, { method: "PATCH" });
    await loadUsers();
  } catch (err) {
    console.error(err);
    alert("Lỗi khi cấp quyền: " + explainContractError(err));
    btn.disabled = false;
    btn.textContent = "Cấp quyền";
  }
}

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
      tr.innerHTML = `
        <td class="mono">#${o.tokenId}</td>
        <td>${o.productName || "-"}</td>
        <td>${o.buyerName}</td>
        <td class="mono">${o.buyerPhone}</td>
        <td style="max-width:200px">${o.buyerAddress}</td>
        <td><span class="pill" style="${o.status === "da_giao" ? "background:var(--seal-verified-soft); color:var(--seal-verified)" : ""}">${ORDER_STATUS_VI[o.status] || o.status}</span></td>
        <td>
          <select class="order-status-select" data-id="${o._id}" style="font-size:0.8rem; padding:6px">
            <option value="moi" ${o.status === "moi" ? "selected" : ""}>Mới đặt</option>
            <option value="da_xac_nhan" ${o.status === "da_xac_nhan" ? "selected" : ""}>Đã xác nhận</option>
            <option value="da_giao" ${o.status === "da_giao" ? "selected" : ""}>Đã giao hàng</option>
          </select>
        </td>
      `;
      tbody.appendChild(tr);
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
    tbody.innerHTML = `<tr><td colspan="7" style="color:var(--seal-danger)">Lỗi: ${err.message}</td></tr>`;
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
  return new URL(product.qrCodeUrl, `${API_BASE.replace(/\/+$/, "")}/`).href;
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
        <span class="mono" style="font-size:0.8rem; color:var(--muted)">#${p.tokenId}</span>
        <span class="pill">${statusLabel(p, p.currentOwner)}</span>
      </div>
      <h3>${p.name || "(chưa đặt tên)"}</h3>
      <p class="product-card-meta">${p.batch ? "Lô " + p.batch : ""}${p.batch && p.productCode ? " · " : ""}${p.productCode || ""}</p>
      <p class="product-card-date">${new Date(p.mintedAt).toLocaleString("vi-VN")}</p>
      <div class="product-card-actions">
        <a class="btn btn-outline" href="${productQRCodeURL(p)}" target="_blank" style="font-size:0.82rem; padding:8px 12px">▦ Mã QR</a>
        <button class="btn btn-primary transfer-btn" data-token="${p.tokenId}" style="font-size:0.82rem; padding:8px 12px">➤ Chuyển giao</button>
        <a class="btn btn-outline" href="${window.getProductVerifyURL(p.tokenId)}" target="_blank" rel="noopener noreferrer" style="font-size:0.82rem; padding:8px 10px">↗</a>
      </div>
    `;
    grid.appendChild(card);
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
    tr.innerHTML = `<td>${p.name}</td><td>${ROLE_LABELS[p.role] || p.role}</td><td class="mono">${p.walletAddress}</td>`;
    tbody.appendChild(tr);
  });

  const select = document.getElementById("tHolderSelect");
  const currentValue = select.value;
  select.innerHTML = `
    <option value="">-- Chọn đối tác từ danh bạ --</option>
    ${partners
      .map(
        (p) =>
          `<option value="${p.walletAddress}">${p.name} (${ROLE_LABELS[p.role] || p.role}) — ${p.walletAddress.slice(0, 6)}...${p.walletAddress.slice(-4)}</option>`
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
    preview.innerHTML = `<img src="${URL.createObjectURL(file)}" alt="Xem trước ảnh">`;
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

    showStatus(statusEl, "Vui lòng xác nhận giao dịch trong MetaMask...", true);
    const tx = await wallet.contract.mintProduct(
      wallet.address,
      metaData.tokenURI,
      payload.productCode,
      photoURI,
      gpsCoords
    );
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

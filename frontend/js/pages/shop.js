// Tách từ shop.html — để áp dụng CSP script-src 'self' (không cho chạy script viết thẳng trong HTML)
const API_BASE = window.API_BASE || `http://${window.location.hostname}:4000`;
let products = [];
let selectedProduct = null;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
);

function safeImageURL(value) {
  if (!value) return "";
  try {
    const url = new URL(value, API_BASE);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function imagePlaceholder() {
  const placeholder = document.createElement("div");
  placeholder.className = "shop-product-image-placeholder";
  placeholder.textContent = "Chưa có ảnh sản phẩm";
  return placeholder;
}

function openModal(id) { document.getElementById(id).classList.add("show"); }
function closeModal(id) { document.getElementById(id).classList.remove("show"); }
document.querySelectorAll("[data-close]").forEach((btn) => btn.addEventListener("click", () => closeModal(btn.dataset.close)));
document.querySelectorAll(".modal-overlay").forEach((overlay) => {
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.classList.remove("show"); });
});

function renderGrid(list) {
  const grid = document.getElementById("shopGrid");
  const hint = document.getElementById("shopHint");
  grid.innerHTML = "";
  if (list.length === 0) {
    hint.textContent = "Không tìm thấy sản phẩm nào phù hợp.";
    return;
  }
  hint.textContent = `${list.length} sản phẩm`;
  list.forEach((p) => {
    const card = document.createElement("div");
    card.className = "product-card";
    const imageURL = safeImageURL(p.image);
    card.innerHTML = `
      <div class="product-card-top">
        <span class="mono" style="font-size:0.8rem; color:var(--muted)">#${esc(p.tokenId)}</span>
        <span class="pill">Số lượng: ${esc(p.quantity)}</span>
      </div>
      <div class="shop-product-image">
        ${imageURL
          ? `<img src="${esc(imageURL)}" alt="${esc(p.name || "Ảnh sản phẩm")}" loading="lazy">`
          : `<span class="shop-product-image-placeholder">Chưa có ảnh sản phẩm</span>`}
      </div>
      <h3>${esc(p.name || "(chưa đặt tên)")}</h3>
      <p class="product-card-meta">${esc(p.productCode || "")}${p.manufacturer ? " · " + esc(p.manufacturer) : ""}</p>
      <div class="product-card-actions">
        <a class="btn btn-outline" href="${esc(window.getProductVerifyURL(p.tokenId))}" target="_blank" rel="noopener noreferrer" style="font-size:0.82rem; padding:8px 12px">🔍 Xác thực</a>
        <button class="btn btn-primary buy-btn" data-token="${esc(p.tokenId)}" style="font-size:0.82rem; padding:8px 12px">🛒 Mua ngay</button>
      </div>
    `;
    const image = card.querySelector(".shop-product-image img");
    if (image) {
      image.addEventListener("error", () => image.replaceWith(imagePlaceholder()), { once: true });
    }
    grid.appendChild(card);
  });
  grid.querySelectorAll(".buy-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedProduct = list.find((p) => p.tokenId === btn.dataset.token);
      document.getElementById("orderProductLabel").textContent =
        `Sản phẩm: ${selectedProduct.name} (#${selectedProduct.tokenId})`;
      openModal("orderModal");
    });
  });
}

async function loadAll() {
  try {
    const res = await fetch(`${API_BASE}/api/shop/products`);
    products = await res.json();
    renderGrid(products);
  } catch {
    document.getElementById("shopHint").textContent = "Không tải được danh sách sản phẩm — kiểm tra backend đã chạy chưa.";
  }
}

async function doSearch() {
  const q = document.getElementById("searchInput").value.trim();
  try {
    const res = await fetch(`${API_BASE}/api/shop/search?q=${encodeURIComponent(q)}`);
    const list = await res.json();
    renderGrid(list);
  } catch {
    document.getElementById("shopHint").textContent = "Lỗi khi tìm kiếm.";
  }
}
document.getElementById("searchBtn").addEventListener("click", doSearch);
document.getElementById("searchInput").addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });

document.getElementById("orderForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("orderStatus");
  const payload = {
    tokenId: selectedProduct.tokenId,
    productName: selectedProduct.name,
    productCode: selectedProduct.productCode,
    buyerName: document.getElementById("buyerName").value,
    buyerPhone: document.getElementById("buyerPhone").value,
    buyerAddress: document.getElementById("buyerAddress").value,
    note: document.getElementById("orderNote").value,
  };
  try {
    const res = await fetch(`${API_BASE}/api/shop/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Lỗi khi đặt hàng");
    statusEl.textContent = "Đặt hàng thành công! Bên bán sẽ liên hệ để xác nhận giao hàng.";
    statusEl.className = "status-msg show ok";
    document.getElementById("orderForm").reset();
    setTimeout(() => closeModal("orderModal"), 1800);
  } catch (err) {
    statusEl.textContent = "Lỗi: " + err.message;
    statusEl.className = "status-msg show err";
  }
});

loadAll();

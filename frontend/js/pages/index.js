// Tách từ index.html — để áp dụng CSP script-src 'self' (không cho chạy script viết thẳng trong HTML)
const API_BASE = window.API_BASE || `http://${window.location.hostname}:4000`;
fetch(`${API_BASE}/api/products`)
  .then((r) => {
    if (!r.ok) throw new Error("Không tải được danh sách sản phẩm");
    return r.json();
  })
  .then((list) => { document.getElementById("statProducts").textContent = list.length; })
  .catch(() => { document.getElementById("statProducts").textContent = "—"; });
fetch(`${API_BASE}/api/partners`)
  .then((r) => r.json())
  .then((list) => { document.getElementById("statPartners").textContent = list.length; })
  .catch(() => { document.getElementById("statPartners").textContent = "0"; });

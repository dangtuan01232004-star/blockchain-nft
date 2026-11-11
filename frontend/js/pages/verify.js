// Tách từ verify.html — để áp dụng CSP script-src 'self' (không cho chạy script viết thẳng trong HTML)
// Tự nhận diện host của backend dựa theo cách trang này đang được truy cập:
// mở bằng "localhost" thì gọi "localhost:4000"; mở bằng IP LAN (ví dụ từ
// điện thoại, 192.168.x.x) thì tự động gọi đúng IP đó — không hardcode
// cứng "localhost", nếu không điện thoại sẽ gọi nhầm vào chính nó.
const API_BASE = window.API_BASE || `http://${window.location.hostname}:4000`;
const resultEl = document.getElementById("result");
const errorNote = document.getElementById("errorNote");

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
);

function safeImageURL(value) {
  try {
    const url = new URL(value, window.location.href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function showError(msg) {
  errorNote.textContent = msg;
  errorNote.classList.add("show");
}
function clearError() {
  errorNote.classList.remove("show");
  errorNote.textContent = "";
}

// Mỗi trình duyệt tự sinh 1 mã thiết bị ngẫu nhiên, lưu cố định trong
// localStorage — KHÔNG phải thông tin cá nhân, chỉ dùng để backend đếm
// "có bao nhiêu thiết bị khác nhau từng quét mã QR này" nhằm phát hiện
// dấu hiệu mã QR bị sao chép sang nhiều sản phẩm giả.
function getDeviceId() {
  let id = localStorage.getItem("deviceId");
  if (!id) {
    id = "dev-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem("deviceId", id);
  }
  return id;
}

// --- Mã cào: lưu "chìa khoá chủ sở hữu" của từng sản phẩm trên máy này ---
function getOwnerToken(tokenId) {
  try { return localStorage.getItem(`ownerToken:${tokenId}`) || ""; } catch { return ""; }
}
function setOwnerToken(tokenId, token) {
  try { localStorage.setItem(`ownerToken:${tokenId}`, token); } catch { /* chế độ ẩn danh */ }
}
// Link khôi phục do admin gửi: verify.html?tokenId=5#owner=<token>
// (token để sau dấu # nên không bị gửi lên server hay lưu trong log)
(function readRecoveryLink() {
  const m = /[#&]owner=([A-Za-z0-9_-]{20,})/.exec(window.location.hash || "");
  const tid = new URLSearchParams(window.location.search).get("tokenId");
  if (m && tid) {
    setOwnerToken(tid, m[1]);
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }
})();

let currentTokenId = null;

function fmtDate(d) {
  return d ? new Date(d).toLocaleString("vi-VN") : "";
}

function renderClaim(data) {
  const box = document.getElementById("claimBox");
  const form = document.getElementById("claimForm");
  const reportBtn = document.getElementById("reportBtn");
  const title = document.getElementById("claimTitle");
  const text = document.getElementById("claimText");
  document.getElementById("claimMsg").textContent = "";
  currentTokenId = data.tokenId;
  const c = data.claim || {};
  box.hidden = true;
  form.hidden = true;
  reportBtn.hidden = true;
  box.className = "claim-box";
  if (!data.found || data.authentic === false || !c.status || c.status === "no_code" || c.status === "unknown") return;

  box.hidden = false;
  if (c.status === "unclaimed") {
    box.classList.add("claim-open");
    title.textContent = "🎟 Sản phẩm chưa có chủ sở hữu";
    text.innerHTML =
      "<b>Đã mua?</b> Cào lớp bạc trên tem rồi nhập mã để xác nhận bạn là chủ sở hữu.<br>" +
      "<b>Đang xem ở cửa hàng?</b> Kiểm tra lớp cào còn nguyên — <b>nếu đã bị cào, đừng mua</b>.";
    form.hidden = false;
  } else if (c.status === "owner") {
    box.classList.add("claim-owner");
    title.textContent = "✅ Đây là sản phẩm của bạn";
    text.textContent = `Bạn đã kích hoạt sản phẩm này lúc ${fmtDate(c.claimedAt)}. Mã cào đã được dùng — không ai khác kích hoạt lại được.`;
  } else if (c.status === "claimed_by_other") {
    box.classList.add("claim-taken");
    title.textContent = "⚠️ Sản phẩm này đã có chủ sở hữu";
    text.innerHTML =
      `Mã cào của sản phẩm đã được kích hoạt lúc <b>${fmtDate(c.claimedAt)}</b>.<br>` +
      "Nếu bạn <b>vừa mua hàng mới</b> và vừa tự cào tem, đây có thể là <b>hàng giả dùng lại mã QR của hàng thật</b> — đừng nhận hàng / liên hệ người bán và bấm báo cáo bên dưới.<br>" +
      "<span style='opacity:.8'>Nếu bạn mua lại đồ đã qua sử dụng hoặc đang xem giúp người khác thì thông báo này là bình thường.</span>";
    reportBtn.hidden = false;
  } else if (c.status === "locked") {
    box.classList.add("claim-taken");
    title.textContent = "🔒 Tạm khoá nhập mã";
    text.textContent = "Mã của sản phẩm này bị nhập sai quá nhiều lần nên tạm khoá 1 giờ để chống đoán mã. Vui lòng thử lại sau.";
  }
}

document.getElementById("claimForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("claimMsg");
  const btn = document.getElementById("claimSubmit");
  btn.disabled = true;
  msg.textContent = "Đang kiểm tra mã...";
  try {
    const res = await fetch(`${API_BASE}/api/products/${encodeURIComponent(currentTokenId)}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: document.getElementById("claimCode").value,
        contact: document.getElementById("claimContact").value,
      }),
    });
    const data = await res.json();
    if (res.ok && data.ownerToken) {
      setOwnerToken(currentTokenId, data.ownerToken);
      checkToken(currentTokenId);
      return;
    }
    msg.textContent = data.error || "Không kích hoạt được.";
    if (data.claimStatus === "claimed_by_other" || data.claimStatus === "locked") checkToken(currentTokenId);
  } catch {
    msg.textContent = "Không kết nối được máy chủ, vui lòng thử lại.";
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("reportBtn").addEventListener("click", async () => {
  const note = window.prompt("Mô tả ngắn (mua ở đâu, khi nào, tem thế nào...) — không bắt buộc:", "");
  if (note === null) return;
  const msg = document.getElementById("claimMsg");
  try {
    const res = await fetch(`${API_BASE}/api/products/${encodeURIComponent(currentTokenId)}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: note }),
    });
    const data = await res.json();
    msg.textContent = res.ok ? "Đã gửi báo cáo tới nhà sản xuất. Cảm ơn bạn!" : data.error || "Không gửi được báo cáo.";
    if (res.ok) document.getElementById("reportBtn").hidden = true;
  } catch {
    msg.textContent = "Không kết nối được máy chủ.";
  }
});

async function checkToken(tokenId) {
  clearError();
  resultEl.classList.remove("show", "authentic", "fake");
  if (!tokenId && tokenId !== "0") {
    showError("Vui lòng nhập Token ID hợp lệ.");
    return;
  }
  try {
    const deviceId = getDeviceId();
    const ownerToken = getOwnerToken(tokenId);
    const res = await fetch(`${API_BASE}/api/products/verify/${encodeURIComponent(tokenId)}?deviceId=${encodeURIComponent(deviceId)}`, {
      headers: ownerToken ? { "X-Owner-Token": ownerToken } : {},
    });
    const data = await res.json();
    document.getElementById("lookupStatus").hidden = true;
    if (res.status === 503 || data.found === null) {
      // Lỗi kết nối blockchain — KHÔNG kết luận hàng giả
      document.body.classList.remove("product-lookup");
      showError(data.message || "Tạm thời không kiểm tra được trên blockchain. Vui lòng thử lại sau.");
      return;
    }
    renderResult(data);
  } catch (err) {
    document.body.classList.remove("product-lookup");
    document.getElementById("lookupStatus").hidden = true;
    showError("Không thể kết nối tới máy chủ xác thực. Kiểm tra backend đã chạy chưa.");
  }
}

// Che bớt địa chỉ ví — chỉ hiện 6 ký tự đầu + 4 ký tự cuối, giống cách các
// ứng dụng blockchain phổ biến vẫn làm (không hiện đầy đủ để tránh lộ danh
// tính/liên kết ví với người dùng công khai trên trang xác thực này).
function truncateAddress(addr) {
  if (!addr || addr.length < 12) return addr || "-";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function renderResult(data) {
  resultEl.classList.add("show");

  const productName =
    (data.metadata && data.metadata.name) ||
    (data.found ? `Sản phẩm #${data.tokenId}` : "Không tìm thấy sản phẩm");
  document.getElementById("resultTitle").textContent = productName;

  const image = safeImageURL(data.metadata && data.metadata.image);
  document.getElementById("productVisual").innerHTML = image
    ? `<img src="${esc(image)}" alt="">`
    : `<span class="placeholder-icon">📦</span>`;

  if (!data.found || data.authentic === false) {
    resultEl.classList.remove("authentic");
    resultEl.classList.add("fake");
    document.getElementById("sealIcon").textContent = "✕";
    document.getElementById("resultSub").textContent = data.found
      ? "Đã bị thu hồi xác thực"
      : "Không tìm thấy trên blockchain — nghi ngờ hàng giả";
  } else if (data.security && data.security.suspect) {
    // Sản phẩm tồn tại, chưa bị thu hồi, nhưng có ít nhất 1 bước do một ví
    // ĐÃ BỊ GẮN CỜ "bị xâm phạm" ký → có thể là hàng giả do kẻ tấn công
    // mint/chuyển giao bằng ví bị hack. Chưa kết luận, đang kiểm tra.
    resultEl.classList.remove("authentic");
    resultEl.classList.add("fake");
    document.getElementById("sealIcon").textContent = "!";
    document.getElementById("resultSub").textContent =
      "Đang được kiểm tra — liên quan tới tài khoản bị xâm phạm. Chưa nên mua.";
  } else {
    resultEl.classList.remove("fake");
    resultEl.classList.add("authentic");
    document.getElementById("sealIcon").textContent = "✓";
    document.getElementById("resultSub").textContent = "Thông tin được xác thực qua Blockchain";
  }

  // Cảnh báo quét bất thường — sản phẩm vẫn chính hãng trên blockchain
  // (tokenId tồn tại, chưa bị thu hồi), nhưng mã QR này đã bị quét từ
  // quá nhiều thiết bị khác nhau, dấu hiệu cho thấy có thể đã bị sao chép
  // sang nhiều sản phẩm giả khác (xem backend/src/services/scanGuard.js).
  const warningEl = document.getElementById("suspiciousWarning");
  const warnings = [];
  if (data.security && data.security.suspect) {
    const since = data.security.compromisedSince
      ? new Date(data.security.compromisedSince).toLocaleString("vi-VN")
      : "";
    warnings.push(
      `Một bước trong hành trình của sản phẩm này (bước ${Number(data.security.suspectStep) + 1}) được thực hiện ` +
      `bởi tài khoản đã bị hệ thống xác định là bị xâm phạm${since ? ` (từ ${since})` : ""}. ` +
      `Sản phẩm có thể không chính hãng — nhà sản xuất đang kiểm tra lại.`
    );
  }
  if (data.scan && data.scan.suspicious) {
    warnings.push(
      `Mã QR này đã được quét từ ${data.scan.distinctDevices} thiết bị khác nhau (${data.scan.totalScans} lượt) — ` +
      `nhiều bất thường so với một sản phẩm vật lý duy nhất. Có thể mã QR đã bị sao chép sang hàng giả khác.`
    );
  }
  if (data.security && data.security.paused) {
    warnings.push("Hệ thống đang tạm dừng ghi dữ liệu để xử lý sự cố bảo mật. Thông tin hiển thị vẫn là dữ liệu gốc trên blockchain.");
  }
  if (warnings.length) {
    document.getElementById("suspiciousText").textContent = warnings.join(" ");
    warningEl.style.display = "block";
  } else {
    warningEl.style.display = "none";
  }

  renderClaim(data);

  document.getElementById("dCode").textContent = data.productCode || "-";
  document.getElementById("dManufacturer").textContent = (data.metadata && data.metadata.manufacturer) || "-";
  document.getElementById("dBatch").textContent = (data.metadata && data.metadata.batch) || "-";
  document.getElementById("dDescription").textContent = (data.metadata && data.metadata.description) || "-";
  document.getElementById("dIssuer").textContent = (data.metadata && data.metadata.manufacturer) || "Không rõ";

  const stepCountEl = document.getElementById("stepCount");
  const list = document.getElementById("timelineList");
  list.innerHTML = "";
  const history = data.history || [];
  stepCountEl.textContent = history.length;

  const ACTION_LABEL_VI = {
    MINTED: "Phát hành sản phẩm",
    SHIPPED: "Xuất kho / vận chuyển",
    RECEIVED: "Nhập hàng",
    SOLD: "Bán ra",
  };
  const ACTION_ICONS = {
  MINTED: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10.5 12 4l9 6.5V20H3z"/><path d="M8 20v-6h8v6M7 10h.01M12 10h.01M17 10h.01"/></svg>',
  SHIPPED: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h11v11H3zM14 11h4l3 3v4h-7z"/><circle cx="7.5" cy="19" r="1.5"/><circle cx="18" cy="19" r="1.5"/></svg>',
  RECEIVED: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 9 5v8l-9 5-9-5V8z"/><path d="M12 12v9M3.5 8.5 12 13l8.5-4.5M12 3v10"/></svg>',
  SOLD: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10h16v10H4zM3 10l2-6h14l2 6M8 20v-5h8v5"/><path d="M8 7h.01M12 7h.01M16 7h.01"/></svg>',
  };

  if (!history.length) {
  const empty = document.createElement("p");
  empty.className = "timeline-empty";
  empty.textContent = "Chưa có dữ liệu hành trình sản phẩm.";
  list.appendChild(empty);
  }

  const ROLE_LABEL_VI = {
    MANUFACTURER: "Nhà sản xuất",
    DISTRIBUTOR: "Đơn vị phân phối",
    RETAILER: "Cửa hàng bán lẻ",
    CONSUMER: "Người tiêu dùng",
  };

  history.slice().reverse().forEach((h, index) => {
  const item = document.createElement("div");
  item.className = "timeline-item";

  const date = new Date(h.timestamp);
  const dateColumn = document.createElement("div");
  dateColumn.className = "timeline-date";
  if (Number.isNaN(date.getTime())) {
    dateColumn.textContent = "—";
  } else {
    const datePart = document.createElement("span");
    datePart.textContent = date.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" });
    const yearPart = document.createElement("span");
    yearPart.textContent = date.toLocaleDateString("vi-VN", { year: "numeric" });
    dateColumn.append(datePart, yearPart);
  }
  item.appendChild(dateColumn);

  const track = document.createElement("span");
  track.className = "timeline-track";
  track.setAttribute("aria-hidden", "true");
  item.appendChild(track);

  const card = document.createElement("button");
  card.className = "timeline-event";
  card.type = "button";
  card.setAttribute("aria-expanded", "false");
  card.setAttribute("aria-label", `Xem chi tiết: ${ACTION_LABEL_VI[h.action] || h.action}`);

  const icon = document.createElement("span");
  icon.className = "timeline-event-icon";
  icon.innerHTML = Object.hasOwn(ACTION_ICONS, h.action) ? ACTION_ICONS[h.action] : ACTION_ICONS.RECEIVED;
  const content = document.createElement("span");
  content.className = "timeline-event-content";
  const title = document.createElement("span");
  title.className = "timeline-event-title";
  title.textContent = ACTION_LABEL_VI[h.action] || h.action || "Cập nhật hành trình";
  const location = document.createElement("span");
  location.className = "timeline-event-location";
  location.textContent = h.location || h.actorRole || "Chưa cập nhật địa điểm";
  content.append(title, location);
  card.append(icon, content);

  const chevron = document.createElement("span");
  chevron.className = "timeline-chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = "›";
  card.appendChild(chevron);
  item.appendChild(card);

  const detail = document.createElement("div");
  detail.className = "timeline-detail";
  detail.id = `timeline-detail-${index}`;
  detail.setAttribute("aria-hidden", "true");
  card.setAttribute("aria-controls", detail.id);

  const detailsGrid = document.createElement("dl");
  detailsGrid.className = "timeline-detail-grid";
  const addDetail = (labelText, valueText) => {
    const row = document.createElement("div");
    row.className = "timeline-detail-row";
    const label = document.createElement("dt");
    label.textContent = labelText;
    const value = document.createElement("dd");
    value.textContent = valueText || "Chưa cập nhật";
    row.append(label, value);
    detailsGrid.appendChild(row);
  };
  const eventTitle = ACTION_LABEL_VI[h.action] || h.action || "Cập nhật hành trình";
  addDetail("Bước", eventTitle);
  addDetail("Kho / địa điểm", h.location);
  addDetail(
    "Ngày ghi nhận",
    Number.isNaN(date.getTime())
      ? ""
      : date.toLocaleString("vi-VN", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
  );
  addDetail("Vai trò ghi nhận", ROLE_LABEL_VI[String(h.actorRole || "").toUpperCase()] || h.actorRole);

  if (h.gpsCoords) {
    const row = document.createElement("div");
    row.className = "timeline-detail-row";
    const label = document.createElement("dt");
    label.textContent = "Vị trí GPS";
    const value = document.createElement("dd");
    const coordinates = document.createElement("span");
    coordinates.textContent = h.gpsCoords;
    const gpsLink = document.createElement("a");
    gpsLink.href = `https://www.google.com/maps?q=${encodeURIComponent(h.gpsCoords)}`;
    gpsLink.target = "_blank";
    gpsLink.rel = "noopener noreferrer";
    gpsLink.textContent = "Xem bản đồ";
    value.append(coordinates, gpsLink);
    row.append(label, value);
    detailsGrid.appendChild(row);
  } else {
    addDetail("Vị trí GPS", "");
  }
  detail.appendChild(detailsGrid);

  if (h.action === "MINTED") {
    const identityHeading = document.createElement("h4");
    identityHeading.className = "timeline-detail-section-title";
    identityHeading.textContent = "Thông tin định danh sản phẩm";
    detail.appendChild(identityHeading);

    const identityGrid = document.createElement("dl");
    identityGrid.className = "timeline-detail-grid";
    const addIdentityDetail = (labelText, valueId, valueText) => {
      const row = document.createElement("div");
      row.className = "timeline-detail-row";
      const label = document.createElement("dt");
      label.textContent = labelText;
      const value = document.createElement("dd");
      value.id = valueId;
      value.textContent = valueText || "-";
      row.append(label, value);
      identityGrid.appendChild(row);
    };
    addIdentityDetail("Token ID", "dTokenId", data.tokenId);
    addIdentityDetail("Chủ sở hữu hiện tại", "dOwner", data.owner ? truncateAddress(data.owner) : "-");
    addIdentityDetail("Metadata (IPFS)", "dUri", data.tokenURI);
    detail.appendChild(identityGrid);
  }

  if (h.photoURI) {
    const photo = document.createElement("img");
    photo.src = h.photoURI;
    photo.alt = `Ảnh ghi nhận bước: ${eventTitle}`;
    photo.className = "timeline-detail-photo";
    detail.appendChild(photo);
  }

  card.addEventListener("click", () => {
    const expanded = card.getAttribute("aria-expanded") === "true";
    card.setAttribute("aria-expanded", String(!expanded));
    detail.setAttribute("aria-hidden", String(expanded));
    detail.classList.toggle("show", !expanded);
  });
  item.appendChild(detail);
  list.appendChild(item);
  });

  // Xác thực xong luôn quay về tab "Thông tin sản phẩm" đầu tiên
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
  document.querySelector('.tab-btn[data-tab="info"]').classList.add("active");
  document.getElementById("tabInfo").classList.add("active");
}

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab === "info" ? "tabInfo" : "tabTrace").classList.add("active");
  });
});

document.getElementById("checkBtn").addEventListener("click", () => {
  checkToken(document.getElementById("tokenInput").value.trim());
});
document.getElementById("tokenInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") checkToken(e.target.value.trim());
});

const params = new URLSearchParams(window.location.search);
const qrTokenId = params.get("tokenId");

// --- Quét QR bằng camera ---
let qrScanner = null;
let cameraOn = false;

function startCamera() {
  qrScanner = new Html5Qrcode("qr-reader");
  Html5Qrcode.getCameras().then((devices) => {
    if (!devices || !devices.length) return;
    qrScanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: 240 },
      (decodedText) => {
        const tid = decodeVerifyResult(decodedText);
        document.getElementById("tokenInput").value = tid;
        checkToken(tid);
      },
      () => {}
    ).then(() => { cameraOn = true; }).catch(() => {
      showError("Không thể mở camera. Bạn có thể nhập Token ID thủ công.");
    });
  }).catch(() => {
    showError("Không tìm thấy camera trên thiết bị này. Hãy nhập Token ID thủ công.");
  });
}

function stopCamera() {
  if (qrScanner && cameraOn) {
    qrScanner.stop().then(() => qrScanner.clear());
    cameraOn = false;
  }
}

document.getElementById("toggleCam").addEventListener("click", () => {
  if (cameraOn) {
    stopCamera();
    document.getElementById("toggleCam").textContent = "Bật camera quét QR";
  } else {
    startCamera();
    document.getElementById("toggleCam").textContent = "Tắt camera / nhập mã thủ công";
  }
});

// --- Đọc QR từ ảnh tải lên (giống cơ chế "tải ảnh lên" của Google Lens) ---
// Hữu ích khi test trên cùng một máy: chụp màn hình mã QR ở admin.html
// rồi tải file ảnh lên đây, không cần điện thoại hay camera thật.
function decodeVerifyResult(decodedText) {
  try {
    const url = new URL(decodedText);
    const tid = url.searchParams.get("tokenId");
    if (tid !== null) return tid;
  } catch {
    // Không phải URL — coi luôn chuỗi quét được là tokenId
  }
  return decodedText;
}

document.getElementById("qrFileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  clearError();

  // Dùng một instance Html5Qrcode RIÊNG BIỆT cho việc đọc file, độc lập
  // hoàn toàn với instance đang dùng cho camera — tránh xung đột trạng thái
  // nội bộ giữa 2 chế độ (đã gặp lỗi "transition" nếu dùng chung 1 instance).
  const fileScanner = new Html5Qrcode("qr-file-reader");
  try {
    const decodedText = await fileScanner.scanFile(file, false);
    const tid = decodeVerifyResult(decodedText);
    document.getElementById("tokenInput").value = tid;
    checkToken(tid);
  } catch (err) {
    console.error("Lỗi đọc QR từ ảnh:", err);
    showError(
      "Không đọc được mã QR từ ảnh này (" + (err && err.message ? err.message : String(err)) +
      "). Thử chụp lại rõ nét hơn, đủ viền trắng quanh mã, hoặc nhập Token ID thủ công."
    );
  } finally {
    try { await fileScanner.clear(); } catch {}
    e.target.value = ""; // cho phép chọn lại cùng 1 file lần sau
  }
});

if (qrTokenId !== null && qrTokenId.trim()) {
  document.body.classList.add("product-lookup");
  document.getElementById("tokenInput").value = qrTokenId;
  document.getElementById("lookupStatus").hidden = false;
  checkToken(qrTokenId);
} else {
  startCamera();
}

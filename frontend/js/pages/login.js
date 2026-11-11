// Tách từ login.html — để áp dụng CSP script-src 'self' (không cho chạy script viết thẳng trong HTML)
const API_BASE = window.API_BASE || `http://${window.location.hostname}:4000`;
let mode = "login"; // hoặc "register"
let mfaToken = null; // có khi tài khoản bật 2FA và đã qua bước mật khẩu

const errorNote = document.getElementById("errorNote");
function showError(msg) { errorNote.textContent = msg; errorNote.classList.add("show"); }
function clearError() { errorNote.classList.remove("show"); errorNote.textContent = ""; }

document.getElementById("toggleMode").addEventListener("click", () => {
  mode = mode === "login" ? "register" : "login";
  resetMfa();
  document.getElementById("passkeyLoginBox").style.display = mode === "login" && Passkey.supported() ? "block" : "none";
  document.getElementById("formTitle").textContent = mode === "login" ? "Đăng nhập quản trị" : "Đăng ký tài khoản mới";
  document.getElementById("registerFields").style.display = mode === "register" ? "block" : "none";
  document.getElementById("submitBtn").textContent = mode === "login" ? "Đăng nhập" : "Đăng ký";
  document.getElementById("toggleMode").textContent = mode === "login" ? "Chưa có tài khoản? Đăng ký ngay" : "Đã có tài khoản? Đăng nhập";
  clearError();
});

document.getElementById("authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  clearError();
  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value;

  const payload = { username, password };
  if (mode === "register") {
    payload.displayName = document.getElementById("displayName").value.trim();
    payload.role = document.getElementById("role").value;
  }

  const submitBtn = document.getElementById("submitBtn");
  if (submitBtn.disabled) return; // đang gửi — chặn bấm nhiều lần tạo nhiều phiên
  const submitLabel = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = "Đang xử lý... (máy chủ có thể mất ~1 phút để khởi động)";
  try {
    // Bước 2: đã qua mật khẩu, đang nhập mã 2FA
    const isMfaStep = mode === "login" && mfaToken;
    const res = await fetch(`${API_BASE}/api/auth/${isMfaStep ? "login/2fa" : mode}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(isMfaStep ? { mfaToken, code: document.getElementById("mfaCode").value.trim() } : payload),
    });
    const data = await res.json();
    if (!res.ok) {
      if (isMfaStep && res.status === 401 && /hết hạn|đăng nhập lại/.test(data.error || "")) resetMfa();
      throw new Error(data.error || "Lỗi không xác định");
    }

    if (data.twoFactorRequired) {
      mfaToken = data.mfaToken;
      const methods = data.methods || ["totp"];
      const hasTotp = methods.includes("totp");
      const hasPasskey = methods.includes("passkey") && Passkey.supported();
      document.getElementById("passkeyLoginBox").style.display = "none";
      document.getElementById("mfaPasskeyBtn").hidden = !hasPasskey;
      if (!hasTotp) {
        // Chỉ có passkey làm lớp 2 → mời xác nhận passkey luôn
        submitBtn.disabled = false;
        submitBtn.hidden = true;
        document.getElementById("username").readOnly = true;
        document.getElementById("password").readOnly = true;
        if (hasPasskey) passkeyLogin(mfaToken);
        else showError("Tài khoản yêu cầu passkey nhưng trình duyệt này không hỗ trợ.");
        return;
      }
      document.getElementById("mfaField").style.display = "block";
      document.getElementById("username").readOnly = true;
      document.getElementById("password").readOnly = true;
      submitBtn.disabled = false;
      submitBtn.textContent = "Xác nhận mã";
      document.getElementById("mfaCode").focus();
      return;
    }

    finishLogin(data);
  } catch (err) {
    submitBtn.disabled = false;
    submitBtn.textContent = submitLabel;
    showError(err.message);
  }
});

function finishLogin(data) {
  localStorage.setItem("authToken", data.token);
  localStorage.setItem("authUser", JSON.stringify(data.user));
  window.location.href = "admin.html";
}

/** Đăng nhập bằng passkey — không có mfaToken = 1 chạm; có = bước 2 sau mật khẩu */
async function passkeyLogin(withMfaToken) {
  clearError();
  const btn = document.getElementById(withMfaToken ? "mfaPasskeyBtn" : "passkeyLoginBtn");
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "Đang chờ xác nhận trên thiết bị...";
  try {
    const optRes = await fetch(`${API_BASE}/api/auth/passkey/login-options`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(withMfaToken ? { mfaToken: withMfaToken } : {}),
    });
    const options = await optRes.json();
    if (!optRes.ok) throw new Error(options.error || "Không tạo được yêu cầu passkey");
    const credential = await Passkey.get(options);
    const res = await fetch(`${API_BASE}/api/auth/login/passkey`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(withMfaToken ? { credential, mfaToken: withMfaToken } : { credential }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Đăng nhập passkey thất bại");
    finishLogin(data);
  } catch (err) {
    showError(err && err.name ? Passkey.friendlyError(err) : err.message);
    btn.disabled = false;
    btn.textContent = label;
  }
}

document.getElementById("passkeyLoginBtn").addEventListener("click", () => passkeyLogin(null));
document.getElementById("mfaPasskeyBtn").addEventListener("click", () => passkeyLogin(mfaToken));
if (!Passkey.supported()) document.getElementById("passkeyLoginBox").style.display = "none";

function resetMfa() {
  mfaToken = null;
  document.getElementById("mfaPasskeyBtn").hidden = true;
  document.getElementById("submitBtn").hidden = false;
  document.getElementById("passkeyLoginBox").style.display = mode === "login" && Passkey.supported() ? "block" : "none";
  document.getElementById("mfaField").style.display = "none";
  document.getElementById("mfaCode").value = "";
  document.getElementById("username").readOnly = false;
  document.getElementById("password").readOnly = false;
  document.getElementById("submitBtn").textContent = "Đăng nhập";
}

// Nếu đã đăng nhập rồi, vào thẳng admin.html luôn không cần đăng nhập lại
if (localStorage.getItem("authToken")) {
  window.location.href = "admin.html";
}

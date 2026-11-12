/**
 * Đăng nhập an toàn: token nằm trong COOKIE HttpOnly do máy chủ đặt — JavaScript
 * (kể cả script độc hại nếu lọt XSS) KHÔNG đọc được. Trang chỉ giữ:
 *   - authUser (tên, vai trò — để hiển thị) trong localStorage
 *   - mã CSRF trong BỘ NHỚ (lấy lại từ máy chủ khi cần)
 * Trình duyệt quá cũ không nhận cookie phân vùng → chế độ dự phòng: token Bearer
 * trong sessionStorage của đúng tab đó (tự xoá khi đóng tab).
 */
(function () {
  // Dọn token kiểu cũ (localStorage) nếu còn sót lại
  try { localStorage.removeItem("authToken"); } catch { /* bỏ qua */ }

  const UNSAFE = /^(POST|PUT|PATCH|DELETE)$/i;
  let csrf = null;

  const mode = () => {
    try { return sessionStorage.getItem("authMode") || "cookie"; } catch { return "cookie"; }
  };
  const bearer = () => {
    try { return sessionStorage.getItem("authBearer"); } catch { return null; }
  };

  async function getCsrf(force = false) {
    if (csrf && !force) return csrf;
    const r = await fetch(`${API_BASE}/api/auth/csrf`, { credentials: "include", cache: "no-store" });
    if (!r.ok) return null;
    csrf = (await r.json()).csrfToken || null;
    return csrf;
  }

  /** fetch có xác thực: gửi cookie, gắn mã CSRF cho yêu cầu thay đổi dữ liệu */
  async function authFetchRaw(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    const method = (options.method || "GET").toUpperCase();
    if (mode() === "bearer" && bearer()) headers.Authorization = `Bearer ${bearer()}`;
    else if (UNSAFE.test(method)) {
      const t = await getCsrf();
      if (t) headers["X-CSRF-Token"] = t;
    }
    let res = await fetch(url, { ...options, headers, credentials: "include" });
    // Mã CSRF cũ (vd. vừa đổi mật khẩu → phiên mới) → lấy mã mới, thử lại 1 lần
    if (res.status === 403 && mode() !== "bearer" && UNSAFE.test(method)) {
      let code = null;
      try { code = (await res.clone().json()).code; } catch { /* bỏ qua */ }
      if (code === "CSRF") {
        const t = await getCsrf(true);
        if (t) {
          headers["X-CSRF-Token"] = t;
          res = await fetch(url, { ...options, headers, credentials: "include" });
        }
      }
    }
    return res;
  }

  /** Trình duyệt có nhận cookie HttpOnly bên thứ ba (phân vùng) không */
  async function cookiesWork() {
    try {
      await fetch(`${API_BASE}/api/auth/cookie-check`, { method: "POST", credentials: "include" });
      const r = await fetch(`${API_BASE}/api/auth/cookie-check`, { credentials: "include", cache: "no-store" });
      return Boolean((await r.json()).cookies);
    } catch {
      return true; // lỗi mạng: cứ thử chế độ cookie
    }
  }

  /** Lưu kết quả đăng nhập (gọi sau /login, /login/2fa, /login/passkey, /register) */
  function saveLogin(data) {
    try {
      localStorage.setItem("authUser", JSON.stringify(data.user));
      if (data.authMode === "bearer" && data.token) {
        sessionStorage.setItem("authMode", "bearer");
        sessionStorage.setItem("authBearer", data.token);
      } else {
        sessionStorage.setItem("authMode", "cookie");
        sessionStorage.removeItem("authBearer");
      }
    } catch { /* bỏ qua */ }
    csrf = data.csrfToken || null;
  }

  function clear() {
    csrf = null;
    try {
      localStorage.removeItem("authUser");
      sessionStorage.removeItem("authMode");
      sessionStorage.removeItem("authBearer");
    } catch { /* bỏ qua */ }
  }

  /** Chỉ là gợi ý cho giao diện — máy chủ mới là nơi quyết định còn đăng nhập hay không */
  function looksLoggedIn() {
    try { return Boolean(localStorage.getItem("authUser")); } catch { return false; }
  }

  window.Auth = { fetch: authFetchRaw, cookiesWork, saveLogin, clear, looksLoggedIn, resetCsrf: () => { csrf = null; } };
})();

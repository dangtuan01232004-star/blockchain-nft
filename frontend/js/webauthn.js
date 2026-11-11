/**
 * Tiện ích passkey (WebAuthn) phía trình duyệt — dùng chung cho login.html và admin.html.
 * Server gửi/nhận dữ liệu dạng base64url; trình duyệt cần ArrayBuffer → chuyển đổi ở đây.
 */
(function () {
  function b64uToBuf(s) {
    const pad = "=".repeat((4 - (s.length % 4)) % 4);
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  function bufToB64u(buf) {
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function credToJSON(cred) {
    const r = cred.response;
    const out = { id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type, response: {} };
    out.response.clientDataJSON = bufToB64u(r.clientDataJSON);
    if (r.attestationObject) out.response.attestationObject = bufToB64u(r.attestationObject);
    if (r.authenticatorData) out.response.authenticatorData = bufToB64u(r.authenticatorData);
    if (r.signature) out.response.signature = bufToB64u(r.signature);
    if (r.userHandle) out.response.userHandle = bufToB64u(r.userHandle);
    if (typeof r.getTransports === "function") {
      try { out.response.transports = r.getTransports(); } catch { /* bỏ qua */ }
    }
    return out;
  }

  function friendlyError(err) {
    const name = err && err.name;
    if (name === "NotAllowedError") return "Bạn đã huỷ, hoặc hết thời gian xác nhận passkey.";
    if (name === "InvalidStateError") return "Thiết bị này đã có passkey cho tài khoản này rồi.";
    if (name === "SecurityError") return "Passkey chỉ dùng được trên tên miền chính thức của hệ thống (HTTPS).";
    if (name === "NotSupportedError") return "Thiết bị/trình duyệt này không hỗ trợ passkey.";
    return (err && err.message) || "Passkey thất bại.";
  }

  /** Tạo passkey mới từ options server trả về */
  async function create(options) {
    const publicKey = {
      ...options,
      challenge: b64uToBuf(options.challenge),
      user: { ...options.user, id: b64uToBuf(options.user.id) },
      excludeCredentials: (options.excludeCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })),
    };
    const cred = await navigator.credentials.create({ publicKey });
    return credToJSON(cred);
  }

  /** Ký thử thách đăng nhập bằng passkey */
  async function get(options) {
    const publicKey = {
      ...options,
      challenge: b64uToBuf(options.challenge),
      allowCredentials: (options.allowCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })),
    };
    const cred = await navigator.credentials.get({ publicKey });
    return credToJSON(cred);
  }

  /** Đoán tên thiết bị để đặt tên passkey mặc định */
  function guessDeviceName() {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return "iPhone";
    if (/iPad/.test(ua)) return "iPad";
    if (/Android/.test(ua)) return "Điện thoại Android";
    if (/Windows/.test(ua)) return "Windows Hello";
    if (/Mac OS/.test(ua)) return "Mac (Touch ID)";
    return "Passkey";
  }

  window.Passkey = {
    supported: () => !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create),
    create,
    get,
    friendlyError,
    guessDeviceName,
  };
})();

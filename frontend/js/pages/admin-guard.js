// Tách từ admin.html — để áp dụng CSP script-src 'self' (không cho chạy script viết thẳng trong HTML)
// Gác cổng: chưa đăng nhập thì đá thẳng về trang login, không cho vào admin
if (!window.Auth || !Auth.looksLoggedIn()) {
  window.location.href = "login.html";
}

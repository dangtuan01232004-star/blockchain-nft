/**
 * Cấu hình địa chỉ backend cho toàn bộ frontend.
 *
 * — Đang phát triển/test trên local hoặc qua IP LAN: để nguyên chuỗi rỗng,
 *   hệ thống tự nhận diện theo host hiện tại (localhost:4000 hoặc
 *   <IP-LAN>:4000).
 * — Sau khi deploy backend thật lên Render (hoặc hosting khác), THAY chuỗi
 *   rỗng bằng đúng URL backend, ví dụ:
 *   const PROD_API_BASE = "https://traceability-backend.onrender.com";
 *   Đây là nơi DUY NHẤT cần sửa — mọi trang (verify.html, admin.html) đều
 *   đọc từ đây, không cần sửa nhiều nơi.
 */
const PROD_API_BASE = "https://blockchain-nft-216z.onrender.com";

window.API_BASE = PROD_API_BASE || `http://${window.location.hostname}:4000`;
window.getProductVerifyURL = (tokenId) => {
  const url = new URL("/verify.html", window.location.origin);
  url.searchParams.set("tokenId", String(tokenId));
  return url.href;
};

// Tách từ index.html — để áp dụng CSP script-src 'self' (không cho chạy script viết thẳng trong HTML)
const productTokenId = new URLSearchParams(window.location.search).get("tokenId");
if (productTokenId !== null && productTokenId.trim()) {
  const verifyUrl = new URL("/verify.html", window.location.origin);
  verifyUrl.searchParams.set("tokenId", productTokenId);
  window.location.replace(verifyUrl.href);
}

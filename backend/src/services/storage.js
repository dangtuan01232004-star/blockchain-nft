/**
 * Service lưu trữ metadata NFT lên IPFS.
 *
 * Ứng với mục 1.3 trong đề cương ("Công nghệ lưu trữ phi tập trung IPFS"):
 * mỗi metadata sản phẩm (tên, mô tả, ảnh, thuộc tính...) được đóng gói dạng
 * JSON chuẩn NFT rồi ghim (pin) lên mạng IPFS thông qua dịch vụ Pinata
 * (https://pinata.cloud) — một pinning service phổ biến, có gói miễn phí.
 * IPFS trả về một CID (Content Identifier) — mã băm nội dung duy nhất —
 * dùng làm tokenURI dạng `ipfs://<cid>` lưu trên smart contract.
 *
 * Vì sao cần "pinning service" thay vì chỉ chạy IPFS node cục bộ: một node
 * IPFS đơn lẻ chỉ giữ dữ liệu khi nó online; pinning service đảm bảo dữ
 * liệu luôn có sẵn trên mạng IPFS công cộng, giống vai trò "hosting" cho
 * nội dung phi tập trung.
 *
 * CHƯA CÓ TÀI KHOẢN PINATA? Hệ thống tự động dùng bản lưu cục bộ (file JSON
 * phục vụ qua /metadata/:id) làm phương án dự phòng cho môi trường dev —
 * xem hướng dẫn lấy API key miễn phí trong backend/.env.example.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config();

const METADATA_DIR = path.join(__dirname, "..", "data", "metadata");
fs.mkdirSync(METADATA_DIR, { recursive: true });

const PHOTOS_DIR = path.join(__dirname, "..", "data", "photos");
fs.mkdirSync(PHOTOS_DIR, { recursive: true });

const PINATA_JWT = process.env.PINATA_JWT;
const PINATA_GATEWAY = process.env.PINATA_GATEWAY || "https://gateway.pinata.cloud/ipfs";
const PUBLIC_IPFS_GATEWAY = "https://ipfs.io/ipfs";

function isIpfsEnabled() {
  return Boolean(PINATA_JWT);
}

/** Ghim metadata lên IPFS thật qua Pinata, trả về { id: cid, url: "ipfs://<cid>" } */
async function saveToPinata(metadata) {
  const res = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${PINATA_JWT}`,
    },
    body: JSON.stringify({
      pinataContent: metadata,
      pinataMetadata: { name: `product-${metadata.productCode || Date.now()}.json` },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Pinata trả lỗi ${res.status}: ${text || "không rõ nguyên nhân"}`);
  }
  const data = await res.json();
  const cid = data.IpfsHash;
  return { id: cid, url: `ipfs://${cid}`, gatewayUrl: `${PINATA_GATEWAY}/${cid}` };
}

/** Phương án dự phòng: lưu metadata thành file JSON cục bộ, phục vụ qua /metadata/:id */
function saveLocally(metadata) {
  const id = crypto.randomUUID();
  const filePath = path.join(METADATA_DIR, `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(metadata, null, 2));
  const baseUrl = process.env.PUBLIC_BASE_URL || "http://localhost:4000";
  return { id, url: `${baseUrl}/metadata/${id}` };
}

/** Lưu metadata — dùng IPFS thật nếu đã cấu hình PINATA_JWT, ngược lại lưu cục bộ */
async function saveMetadata(metadata) {
  if (isIpfsEnabled()) {
    return saveToPinata(metadata);
  }
  return saveLocally(metadata);
}

/**
 * Lưu ảnh chụp tại một bước chuỗi cung ứng (ví dụ ảnh lúc thu hoạch, ảnh
 * lúc xuất kho...). Dùng IPFS thật (Pinata pinFileToIPFS) nếu đã cấu hình,
 * ngược lại lưu file cục bộ, phục vụ qua /photos/:filename.
 *
 * @param {Buffer} buffer Nội dung file ảnh
 * @param {string} mimetype Ví dụ "image/jpeg"
 * @param {string} originalname Tên file gốc, chỉ dùng để đặt tên gợi nhớ
 * @returns {Promise<{url: string}>} url dạng "ipfs://<cid>" hoặc URL cục bộ
 */
async function savePhoto(buffer, mimetype, originalname) {
  if (isIpfsEnabled()) {
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: mimetype }), originalname || "photo.jpg");
    form.append("pinataMetadata", JSON.stringify({ name: originalname || `photo-${Date.now()}` }));

    const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
      method: "POST",
      headers: { Authorization: `Bearer ${PINATA_JWT}` },
      body: form,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Pinata trả lỗi ${res.status}: ${text || "không rõ nguyên nhân"}`);
    }
    const data = await res.json();
    return { url: `ipfs://${data.IpfsHash}` };
  }

  // Fallback: lưu file cục bộ
  const ext = (originalname || "").split(".").pop() || "jpg";
  const filename = `${crypto.randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(PHOTOS_DIR, filename), buffer);
  const baseUrl = process.env.PUBLIC_BASE_URL || "http://localhost:4000";
  return { url: `${baseUrl}/photos/${filename}` };
}

/** Convert "ipfs://<cid>" thành link gateway xem được trực tiếp bằng <img>; giữ nguyên nếu đã là URL http thường */
function resolvePhotoURL(uri) {
  if (!uri) return "";
  if (uri.startsWith("ipfs://")) {
    return `${PINATA_GATEWAY}/${uri.replace("ipfs://", "")}`;
  }
  return uri;
}

function getMetadataById(id) {
  const filePath = path.join(METADATA_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

/**
 * Đọc lại metadata từ tokenURI lưu trên smart contract — tự nhận diện là
 * CID trên IPFS thật (`ipfs://...`) hay file lưu cục bộ (`.../metadata/<id>`).
 */
async function getMetadataByTokenURI(tokenURI) {
  if (!tokenURI) return null;

  if (tokenURI.startsWith("ipfs://")) {
    const cid = tokenURI.replace("ipfs://", "");
    for (const gateway of [PINATA_GATEWAY, PUBLIC_IPFS_GATEWAY]) {
      try {
        const res = await fetch(`${gateway}/${cid}`, { signal: AbortSignal.timeout(8000) });
        if (res.ok) return await res.json();
      } catch {
        // thử gateway kế tiếp
      }
    }
    return null;
  }

  const id = tokenURI.split("/metadata/")[1];
  if (!id) return null;
  return getMetadataById(id);
}

module.exports = {
  saveMetadata,
  savePhoto,
  getMetadataById,
  getMetadataByTokenURI,
  resolvePhotoURL,
  isIpfsEnabled,
  METADATA_DIR,
  PHOTOS_DIR,
};

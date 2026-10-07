const { getReadOnlyContract } = require("./blockchain");
const { listProducts: listCachedProducts } = require("./cache");
const { getMetadataByTokenURI } = require("./storage");
const { getProductVerifyURL } = require("./qrcode");

const RPC_BATCH_SIZE = 10;
const CATALOG_CACHE_TTL_MS = 60 * 1000;
let cachedCatalog;
let pendingCatalog;

async function getProductFromChain(contract, tokenId, cachedProduct) {
  const [tokenURI, onChainProductCode, history] = await Promise.all([
    contract.tokenURI(tokenId),
    contract.productCode(tokenId),
    contract.getHistory(tokenId),
  ]);
  const metadata = await getMetadataByTokenURI(tokenURI);
  const firstStep = history[0];
  const mintedAt = metadata?.mintedAt || cachedProduct?.mintedAt ||
    (firstStep ? new Date(Number(firstStep.timestamp ?? firstStep[4]) * 1000).toISOString() : "");
  return {
    ...cachedProduct,
    tokenId,
    productCode: onChainProductCode || cachedProduct?.productCode || "",
    name: metadata?.name || cachedProduct?.name || onChainProductCode || `Sản phẩm #${tokenId}`,
    manufacturer: metadata?.manufacturer || cachedProduct?.manufacturer || "",
    batch: metadata?.batch || cachedProduct?.batch || "",
    tokenURI,
    mintedBy: String(firstStep?.actor || firstStep?.[0] || cachedProduct?.mintedBy || "").toLowerCase(),
    mintedAt,
    qrCodeUrl: `/api/products/${tokenId}/qr`,
    verifyUrl: getProductVerifyURL(tokenId),
  };
}

async function listProductsFromBlockchain() {
  const contract = getReadOnlyContract();
  const totalMinted = await contract.totalMinted();
  const cacheKey = `${contract.target.toLowerCase()}:${totalMinted}`;
  if (
    cachedCatalog?.key === cacheKey &&
    Date.now() - cachedCatalog.cachedAt < CATALOG_CACHE_TTL_MS
  ) {
    return cachedCatalog.products;
  }
  if (pendingCatalog?.key === cacheKey) return pendingCatalog.promise;

  const promise = buildProductCatalog(contract, totalMinted).then((products) => {
    cachedCatalog = { key: cacheKey, cachedAt: Date.now(), products };
    return products;
  });
  pendingCatalog = { key: cacheKey, promise };
  try {
    return await promise;
  } finally {
    if (pendingCatalog?.promise === promise) pendingCatalog = null;
  }
}

async function buildProductCatalog(contract, totalMinted) {
  const cachedProducts = new Map(
    listCachedProducts().map((product) => [String(product.tokenId), product])
  );
  const products = [];

  for (let start = 0n; start < totalMinted; start += BigInt(RPC_BATCH_SIZE)) {
    const end = start + BigInt(RPC_BATCH_SIZE) < totalMinted
      ? start + BigInt(RPC_BATCH_SIZE)
      : totalMinted;
    const batch = [];

    for (let tokenId = start; tokenId < end; tokenId += 1n) {
      const id = tokenId.toString();
      batch.push(getProductFromChain(contract, id, cachedProducts.get(id)));
    }

    products.push(...await Promise.all(batch));
  }

  return products.reverse();
}

module.exports = { listProductsFromBlockchain };

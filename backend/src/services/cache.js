const fs = require("fs");
const path = require("path");

const CACHE_PATH = path.join(__dirname, "..", "data", "products.json");
if (!fs.existsSync(CACHE_PATH)) fs.writeFileSync(CACHE_PATH, "[]");

function listProducts() {
  return JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8"));
}

function addProduct(entry) {
  const products = listProducts();
  products.unshift(entry);
  fs.writeFileSync(CACHE_PATH, JSON.stringify(products, null, 2));
}

module.exports = { listProducts, addProduct };

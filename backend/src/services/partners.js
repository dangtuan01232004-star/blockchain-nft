const fs = require("fs");
const path = require("path");

const PARTNERS_PATH = path.join(__dirname, "..", "data", "partners.json");
if (!fs.existsSync(PARTNERS_PATH)) fs.writeFileSync(PARTNERS_PATH, "[]");

function listPartners() {
  return JSON.parse(fs.readFileSync(PARTNERS_PATH, "utf-8"));
}

function addPartner(entry) {
  const partners = listPartners();
  partners.unshift(entry);
  fs.writeFileSync(PARTNERS_PATH, JSON.stringify(partners, null, 2));
  return entry;
}

module.exports = { listPartners, addPartner };

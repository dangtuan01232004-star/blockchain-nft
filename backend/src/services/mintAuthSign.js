/**
 * Ký "uỷ quyền mint" chuẩn EIP-712 — dùng chung cho backend và test contract.
 * Phải khớp TUYỆT ĐỐI với MINT_AUTH_TYPEHASH + EIP712("NFTTrace","1") trong ProductNFT.sol.
 */
const { ethers } = require("ethers");

const TYPES = {
  MintAuth: [
    { name: "minter", type: "address" },
    { name: "to", type: "address" },
    { name: "tokenURIHash", type: "bytes32" },
    { name: "productCodeHash", type: "bytes32" },
    { name: "photoURIHash", type: "bytes32" },
    { name: "gpsHash", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
};

const h = (s) => ethers.keccak256(ethers.toUtf8Bytes(String(s || "")));

/** @param signer ethers.Wallet của khoá uỷ quyền */
async function signMintAuth(signer, { chainId, contract, minter, to, tokenURI, productCode, photoURI, gps, nonce, deadline }) {
  const domain = { name: "NFTTrace", version: "1", chainId, verifyingContract: contract };
  const value = {
    minter,
    to,
    tokenURIHash: h(tokenURI),
    productCodeHash: h(productCode),
    photoURIHash: h(photoURI),
    gpsHash: h(gps),
    nonce,
    deadline,
  };
  return signer.signTypedData(domain, TYPES, value);
}

module.exports = { signMintAuth, TYPES };

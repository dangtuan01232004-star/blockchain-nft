const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");
const path = require("path");
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args) => ({ compilerPath: path.join(__dirname, "node_modules", "solc", "soljson.js"), isSolcJs: true, version: args.solcVersion, longVersion: require("solc/package.json").version }));
const base = require("./hardhat.config.js"); base.solidity.version = "0.8.26"; module.exports = base;

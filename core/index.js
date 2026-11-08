/**
 * index.js — Entry point for SparkCore module imports in Node / Bun environments
 */

const GeminiFleet = require("./src/GeminiFleet.js");
const DriveMetadata = require("./src/DriveMetadata.js");
const DriveUtils = require("./src/DriveUtils.js");
const SheetKit = require("./src/SheetKit.js");
const Harness = require("./src/Harness.js");
const SparkCore = require("./src/SparkCore.js");

module.exports = {
  SparkCore: SparkCore.SparkCore || SparkCore,
  GeminiFleet,
  DriveMetadata,
  DriveUtils,
  SheetKit,
  Harness,
};

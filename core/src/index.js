/**
 * index.js — Entry point for SparkCore module imports
 */

const GeminiFleet = require("./GeminiFleet.js");
const DriveMetadata = require("./DriveMetadata.js");
const DriveUtils = require("./DriveUtils.js");
const SheetKit = require("./SheetKit.js");
const Harness = require("./Harness.js");

const SparkCore = {
  version: "1.0.0",
  GeminiFleet,
  DriveMetadata,
  DriveUtils,
  SheetKit,
  Harness,

  // Facades
  callGeminiAPI: GeminiFleet.callGeminiAPI,
  discoverAvailableModels: GeminiFleet.discoverAvailableModels,
  isDailyQuotaError: GeminiFleet.isDailyQuotaError,

  parseMetadata: DriveMetadata.parseMetadata,
  formatMetadata: DriveMetadata.formatMetadata,
  isAlreadyClassified: DriveMetadata.isAlreadyClassified,
  updateFileMetadata: DriveMetadata.updateFileMetadata,

  createDocInFolder: DriveUtils.createDocInFolder,
  extractFileId: DriveUtils.extractFileId,
  crawlFolderTree: DriveUtils.crawlFolderTree,
  extractFileTextSnippet: DriveUtils.extractFileTextSnippet,

  getQueuedFileIds: SheetKit.getQueuedFileIds,
  getIndexedFileIds: SheetKit.getIndexedFileIds,
  normalizeYearOrDateCell: SheetKit.normalizeYearOrDateCell,
  normalizeYear: SheetKit.normalizeYear,
  normalizeDate: SheetKit.normalizeDate,
  applyApprovedTaxonomyMerges: SheetKit.applyApprovedTaxonomyMerges,
  batchAppendRows: SheetKit.batchAppendRows,

  createExecutionBudget: Harness.createExecutionBudget,
  dispatchError: Harness.dispatchError,
  safeExecute: Harness.safeExecute,
};

module.exports = {
  SparkCore,
  GeminiFleet,
  DriveMetadata,
  DriveUtils,
  SheetKit,
  Harness,
};

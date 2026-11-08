/**
 * SparkCore.js — Reusable Google Apps Script Core Library for Gemini Spark Automations
 *
 * Consolidates shared infrastructure across all pipelines:
 * - GeminiFleet: Dynamic model discovery, Flash-first ladder, 429 daily quota tracking & failover
 * - DriveMetadata: Direct-to-storage Schema v1 JSONL file descriptions (zero-token screening)
 * - DriveUtils: Safe doc creation, BFS recursive crawler, 25+ char ID extraction
 * - SheetKit: Queue deduplication, float year & Excel date normalizers, chunked appends
 * - Harness: 4-minute execution timer budget supervisor & error dispatching
 */

var SparkCore = (function() {
  return {
    version: "1.0.0",

    // Modular Subsystems
    GeminiFleet: typeof GeminiFleet !== "undefined" ? GeminiFleet : null,
    DriveMetadata: typeof DriveMetadata !== "undefined" ? DriveMetadata : null,
    DriveUtils: typeof DriveUtils !== "undefined" ? DriveUtils : null,
    SheetKit: typeof SheetKit !== "undefined" ? SheetKit : null,
    Harness: typeof Harness !== "undefined" ? Harness : null,

    // Direct Convenience Facades: Gemini
    callGeminiAPI: function(payload, apiKey, modelOrLadder, options) {
      return GeminiFleet.callGeminiAPI(payload, apiKey, modelOrLadder, options);
    },
    discoverAvailableModels: function(apiKey, options) {
      return GeminiFleet.discoverAvailableModels(apiKey, options);
    },
    isDailyQuotaError: function(statusCode, responseText) {
      return GeminiFleet.isDailyQuotaError(statusCode, responseText);
    },

    // Direct Convenience Facades: Drive Metadata
    parseMetadata: function(description) {
      return DriveMetadata.parseMetadata(description);
    },
    formatMetadata: function(data) {
      return DriveMetadata.formatMetadata(data);
    },
    isAlreadyClassified: function(fileOrDescription) {
      return DriveMetadata.isAlreadyClassified(fileOrDescription);
    },
    updateFileMetadata: function(fileOrId, metadata) {
      return DriveMetadata.updateFileMetadata(fileOrId, metadata);
    },

    // Direct Convenience Facades: Drive Utils
    createDocInFolder: function(name, content, targetFolder) {
      return DriveUtils.createDocInFolder(name, content, targetFolder);
    },
    extractFileId: function(urlOrId) {
      return DriveUtils.extractFileId(urlOrId);
    },
    crawlFolderTree: function(rootFolder, options) {
      return DriveUtils.crawlFolderTree(rootFolder, options);
    },
    extractFileTextSnippet: function(file, wordLimit) {
      return DriveUtils.extractFileTextSnippet(file, wordLimit);
    },

    // Direct Convenience Facades: Sheet Kit
    getQueuedFileIds: function(sheet, colIndex) {
      return SheetKit.getQueuedFileIds(sheet, colIndex);
    },
    getIndexedFileIds: function(ss, sheetMap) {
      return SheetKit.getIndexedFileIds(ss, sheetMap);
    },
    normalizeYearOrDateCell: function(val, fullDate) {
      return SheetKit.normalizeYearOrDateCell(val, fullDate);
    },
    normalizeYear: function(val) {
      return SheetKit.normalizeYear(val);
    },
    normalizeDate: function(val) {
      return SheetKit.normalizeDate(val);
    },
    applyApprovedTaxonomyMerges: function(tags, mergeMap) {
      return SheetKit.applyApprovedTaxonomyMerges(tags, mergeMap);
    },
    batchAppendRows: function(sheet, rows, chunkSize) {
      return SheetKit.batchAppendRows(sheet, rows, chunkSize);
    },

    // Direct Convenience Facades: Harness
    createExecutionBudget: function(maxRunTimeMs) {
      return Harness.createExecutionBudget(maxRunTimeMs);
    },
    dispatchError: function(contextName, error, options) {
      return Harness.dispatchError(contextName, error, options);
    },
    safeExecute: function(contextName, fn, fallbackValue, options) {
      return Harness.safeExecute(contextName, fn, fallbackValue, options);
    }
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    SparkCore: SparkCore,
    GeminiFleet: typeof GeminiFleet !== "undefined" ? GeminiFleet : null,
    DriveMetadata: typeof DriveMetadata !== "undefined" ? DriveMetadata : null,
    DriveUtils: typeof DriveUtils !== "undefined" ? DriveUtils : null,
    SheetKit: typeof SheetKit !== "undefined" ? SheetKit : null,
    Harness: typeof Harness !== "undefined" ? Harness : null
  };
}

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

var _GeminiFleet = typeof GeminiFleet !== "undefined" ? GeminiFleet : null;
var _DriveMetadata = typeof DriveMetadata !== "undefined" ? DriveMetadata : null;
var _DriveUtils = typeof DriveUtils !== "undefined" ? DriveUtils : null;
var _SheetKit = typeof SheetKit !== "undefined" ? SheetKit : null;
var _Harness = typeof Harness !== "undefined" ? Harness : null;

function _resolveSubsystem(current, globalName, reqPath) {
  if (current) return current;
  if (typeof globalThis !== "undefined" && globalThis[globalName]) return globalThis[globalName];
  if (typeof global !== "undefined" && global[globalName]) return global[globalName];
  if (typeof require !== "undefined") {
    try {
      return require(reqPath);
    } catch (_) {
      return null;
    }
  }
  return null;
}

function _getFleet() {
  _GeminiFleet = _resolveSubsystem(_GeminiFleet, "GeminiFleet", "./GeminiFleet.js");
  return _GeminiFleet;
}
function _getDriveMetadata() {
  _DriveMetadata = _resolveSubsystem(_DriveMetadata, "DriveMetadata", "./DriveMetadata.js");
  return _DriveMetadata;
}
function _getDriveUtils() {
  _DriveUtils = _resolveSubsystem(_DriveUtils, "DriveUtils", "./DriveUtils.js");
  return _DriveUtils;
}
function _getSheetKit() {
  _SheetKit = _resolveSubsystem(_SheetKit, "SheetKit", "./SheetKit.js");
  return _SheetKit;
}
function _getHarness() {
  _Harness = _resolveSubsystem(_Harness, "Harness", "./Harness.js");
  return _Harness;
}

var SparkCore = (function() {
  var core = {
    version: "1.0.0",

    // Modular Subsystems
    GeminiFleet: null,
    DriveMetadata: null,
    DriveUtils: null,
    SheetKit: null,
    Harness: null,

    // Direct Convenience Facades: Gemini
    callGeminiAPI: function(payload, apiKey, modelOrLadder, options) {
      var fleet = _getFleet();
      if (!fleet) throw new ReferenceError("GeminiFleet subsystem is unavailable");
      return fleet.callGeminiAPI(payload, apiKey, modelOrLadder, options);
    },
    discoverAvailableModels: function(apiKey, options) {
      var fleet = _getFleet();
      if (!fleet) throw new ReferenceError("GeminiFleet subsystem is unavailable");
      return fleet.discoverAvailableModels(apiKey, options);
    },
    getDynamicModelLadder: function(apiKey, configLadder) {
      var fleet = _getFleet();
      if (!fleet) throw new ReferenceError("GeminiFleet subsystem is unavailable");
      return fleet.getDynamicModelLadder(apiKey, configLadder);
    },
    isDailyQuotaError: function(statusCode, responseText) {
      var fleet = _getFleet();
      if (!fleet) throw new ReferenceError("GeminiFleet subsystem is unavailable");
      return fleet.isDailyQuotaError(statusCode, responseText);
    },
    isModelDailyExhausted: function(model) {
      var fleet = _getFleet();
      if (!fleet) throw new ReferenceError("GeminiFleet subsystem is unavailable");
      return fleet.isModelDailyExhausted(model);
    },
    markModelDailyExhausted: function(model) {
      var fleet = _getFleet();
      if (!fleet) throw new ReferenceError("GeminiFleet subsystem is unavailable");
      return fleet.markModelDailyExhausted(model);
    },
    getSecondsUntilUtcMidnight: function() {
      var fleet = _getFleet();
      if (!fleet) throw new ReferenceError("GeminiFleet subsystem is unavailable");
      return fleet.getSecondsUntilUtcMidnight();
    },

    // Direct Convenience Facades: Drive Metadata
    parseMetadata: function(description) {
      var dm = _getDriveMetadata();
      if (!dm) throw new ReferenceError("DriveMetadata subsystem is unavailable");
      return dm.parseMetadata(description);
    },
    formatMetadata: function(data) {
      var dm = _getDriveMetadata();
      if (!dm) throw new ReferenceError("DriveMetadata subsystem is unavailable");
      return dm.formatMetadata(data);
    },
    isAlreadyClassified: function(fileOrDescription) {
      var dm = _getDriveMetadata();
      if (!dm) throw new ReferenceError("DriveMetadata subsystem is unavailable");
      return dm.isAlreadyClassified(fileOrDescription);
    },
    updateFileMetadata: function(fileOrId, metadata) {
      var dm = _getDriveMetadata();
      if (!dm) throw new ReferenceError("DriveMetadata subsystem is unavailable");
      return dm.updateFileMetadata(fileOrId, metadata);
    },

    // Direct Convenience Facades: Drive Utils
    createDocInFolder: function(name, content, targetFolder) {
      var du = _getDriveUtils();
      if (!du) throw new ReferenceError("DriveUtils subsystem is unavailable");
      return du.createDocInFolder(name, content, targetFolder);
    },
    extractFileId: function(urlOrId) {
      var du = _getDriveUtils();
      if (!du) throw new ReferenceError("DriveUtils subsystem is unavailable");
      return du.extractFileId(urlOrId);
    },
    crawlFolderTree: function(rootFolder, options) {
      var du = _getDriveUtils();
      if (!du) throw new ReferenceError("DriveUtils subsystem is unavailable");
      return du.crawlFolderTree(rootFolder, options);
    },
    extractFileTextSnippet: function(file, wordLimit) {
      var du = _getDriveUtils();
      if (!du) throw new ReferenceError("DriveUtils subsystem is unavailable");
      return du.extractFileTextSnippet(file, wordLimit);
    },
    getPrimaryParentId: function(file) {
      var du = _getDriveUtils();
      if (!du) throw new ReferenceError("DriveUtils subsystem is unavailable");
      return du.getPrimaryParentId(file);
    },
    isFolderExcluded: function(file, excludedFolderIds) {
      var du = _getDriveUtils();
      if (!du) throw new ReferenceError("DriveUtils subsystem is unavailable");
      return du.isFolderExcluded(file, excludedFolderIds);
    },
    isTitleExcluded: function(title, keywords) {
      var du = _getDriveUtils();
      if (!du) throw new ReferenceError("DriveUtils subsystem is unavailable");
      return du.isTitleExcluded(title, keywords);
    },

    // Direct Convenience Facades: Sheet Kit
    sanitizeCellValue: function(val) {
      var sk = _getSheetKit();
      if (!sk) throw new ReferenceError("SheetKit subsystem is unavailable");
      return sk.sanitizeCellValue(val);
    },
    getQueuedFileIds: function(sheet, colIndex) {
      var sk = _getSheetKit();
      if (!sk) throw new ReferenceError("SheetKit subsystem is unavailable");
      return sk.getQueuedFileIds(sheet, colIndex);
    },
    getIndexedFileIds: function(ss, sheetMap) {
      var sk = _getSheetKit();
      if (!sk) throw new ReferenceError("SheetKit subsystem is unavailable");
      return sk.getIndexedFileIds(ss, sheetMap);
    },
    normalizeYearOrDateCell: function(val, fullDate) {
      var sk = _getSheetKit();
      if (!sk) throw new ReferenceError("SheetKit subsystem is unavailable");
      return sk.normalizeYearOrDateCell(val, fullDate);
    },
    normalizeYear: function(val) {
      var sk = _getSheetKit();
      if (!sk) throw new ReferenceError("SheetKit subsystem is unavailable");
      return sk.normalizeYear(val);
    },
    normalizeDate: function(val) {
      var sk = _getSheetKit();
      if (!sk) throw new ReferenceError("SheetKit subsystem is unavailable");
      return sk.normalizeDate(val);
    },
    applyApprovedTaxonomyMerges: function(tags, mergeMap) {
      var sk = _getSheetKit();
      if (!sk) throw new ReferenceError("SheetKit subsystem is unavailable");
      return sk.applyApprovedTaxonomyMerges(tags, mergeMap);
    },
    batchAppendRows: function(sheet, rows, chunkSize) {
      var sk = _getSheetKit();
      if (!sk) throw new ReferenceError("SheetKit subsystem is unavailable");
      return sk.batchAppendRows(sheet, rows, chunkSize);
    },
    deduplicateRowsByColumn: function(sheet, colIndex, options) {
      var sk = _getSheetKit();
      if (!sk) throw new ReferenceError("SheetKit subsystem is unavailable");
      return sk.deduplicateRowsByColumn(sheet, colIndex, options);
    },
    normalizeDateColumn: function(sheet, colIndex, options) {
      var sk = _getSheetKit();
      if (!sk) throw new ReferenceError("SheetKit subsystem is unavailable");
      return sk.normalizeDateColumn(sheet, colIndex, options);
    },
    backfillEmptyCells: function(sheet, targetColIndex, options) {
      var sk = _getSheetKit();
      if (!sk) throw new ReferenceError("SheetKit subsystem is unavailable");
      return sk.backfillEmptyCells(sheet, targetColIndex, options);
    },

    // Direct Convenience Facades: Harness
    createExecutionBudget: function(maxRunTimeMs) {
      var harness = _getHarness();
      if (!harness) throw new ReferenceError("Harness subsystem is unavailable");
      return harness.createExecutionBudget(maxRunTimeMs);
    },
    dispatchError: function(contextName, error, options) {
      var harness = _getHarness();
      if (!harness) throw new ReferenceError("Harness subsystem is unavailable");
      return harness.dispatchError(contextName, error, options);
    },
    safeExecute: function(contextName, fn, fallbackValue, options) {
      var harness = _getHarness();
      if (!harness) throw new ReferenceError("Harness subsystem is unavailable");
      return harness.safeExecute(contextName, fn, fallbackValue, options);
    },
    clearTriggers: function(handlerNames) {
      var harness = _getHarness();
      if (!harness) throw new ReferenceError("Harness subsystem is unavailable");
      return harness.clearTriggers(handlerNames);
    },
    installDailyTrigger: function(handlerName, hour, minute) {
      var harness = _getHarness();
      if (!harness) throw new ReferenceError("Harness subsystem is unavailable");
      return harness.installDailyTrigger(handlerName, hour, minute);
    },
    installIntervalTrigger: function(handlerName, intervalMinutes) {
      var harness = _getHarness();
      if (!harness) throw new ReferenceError("Harness subsystem is unavailable");
      return harness.installIntervalTrigger(handlerName, intervalMinutes);
    },
    installWeeklyTrigger: function(handlerName, dayOfWeek, hour) {
      var harness = _getHarness();
      if (!harness) throw new ReferenceError("Harness subsystem is unavailable");
      return harness.installWeeklyTrigger(handlerName, dayOfWeek, hour);
    },
    createTaskAlert: function(title, notes, options) {
      var harness = _getHarness();
      if (!harness) throw new ReferenceError("Harness subsystem is unavailable");
      return harness.createTaskAlert(title, notes, options);
    },
    sendEmailDigest: function(options) {
      var harness = _getHarness();
      if (!harness) throw new ReferenceError("Harness subsystem is unavailable");
      return harness.sendEmailDigest(options);
    }
  };

  // Modular Subsystem Property Getters
  Object.defineProperty(core, "DEFAULT_MODEL_LADDER", {
    get: function() {
      var fleet = _getFleet();
      return fleet && fleet.DEFAULT_MODEL_LADDER ? fleet.DEFAULT_MODEL_LADDER.slice() : [];
    },
    enumerable: true,
    configurable: true
  });
  Object.defineProperty(core, "GeminiFleet", {
    get: function() { return _getFleet(); },
    enumerable: true,
    configurable: true
  });
  Object.defineProperty(core, "DriveMetadata", {
    get: function() { return _getDriveMetadata(); },
    enumerable: true,
    configurable: true
  });
  Object.defineProperty(core, "DriveUtils", {
    get: function() { return _getDriveUtils(); },
    enumerable: true,
    configurable: true
  });
  Object.defineProperty(core, "SheetKit", {
    get: function() { return _getSheetKit(); },
    enumerable: true,
    configurable: true
  });
  Object.defineProperty(core, "Harness", {
    get: function() { return _getHarness(); },
    enumerable: true,
    configurable: true
  });

  return core;
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    SparkCore: SparkCore,
    get GeminiFleet() { return _getFleet(); },
    get DriveMetadata() { return _getDriveMetadata(); },
    get DriveUtils() { return _getDriveUtils(); },
    get SheetKit() { return _getSheetKit(); },
    get Harness() { return _getHarness(); }
  };
}

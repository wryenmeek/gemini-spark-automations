/**
 * SheetKit.js — Queue Deduplication, Taxonomy Reconciliation & Spreadsheet Normalizers
 * Part of SparkCore (Google Apps Script Shared Library)
 *
 * Provides utilities to eliminate spreadsheet anti-patterns:
 * - Pre-flight queue deduplication using extracted 25+ char File IDs
 * - Safe date & year normalizers (handling float years like 2025.0 and Excel serials like 46241.0)
 * - Dynamic taxonomy synonym merging
 * - Safe chunked batch appending to prevent memory exhaustion
 */

var SheetKit = (function() {
  /**
   * Normalizes a cell value containing either a 4-digit year or a date.
   * Handles:
   * - Native Date objects
   * - Float years (e.g. '2025.0' -> '2025')
   * - Excel serial date numbers (e.g. '46241.0' -> '2026' or '2026-08-07')
   *
   * @param {*} val - Cell value
   * @param {boolean} fullDate - If true returns 'YYYY-MM-DD'; if false returns 'YYYY'
   * @returns {string} Clean formatted year or date string
   */
  function normalizeYearOrDateCell(val, fullDate) {
    if (val instanceof Date) {
      if (typeof Utilities !== "undefined" && Utilities.formatDate) {
        return Utilities.formatDate(val, "UTC", fullDate ? "yyyy-MM-dd" : "yyyy");
      }
      return fullDate ? val.toISOString().slice(0, 10) : val.toISOString().slice(0, 4);
    }

    const str = String(val || "").trim();
    if (!str) return "";

    // 1. Match 4-digit year with optional '.0' (e.g., '2025.0' -> '2025')
    if (/^(19|20)\d{2}(\.0+)?$/.test(str)) {
      return str.substring(0, 4);
    }

    // 2. Match Excel serial date between 40000 and 55000 (e.g., '46241.0' -> 2026-08-07)
    if (/^\d{5}(\.\d+)?$/.test(str)) {
      const serial = parseFloat(str);
      if (serial >= 40000 && serial <= 55000) {
        const utcDays = Math.floor(serial - 25569);
        const d = new Date(utcDays * 86400 * 1000);
        if (typeof Utilities !== "undefined" && Utilities.formatDate) {
          return Utilities.formatDate(d, "UTC", fullDate ? "yyyy-MM-dd" : "yyyy");
        }
        return fullDate ? d.toISOString().slice(0, 10) : d.toISOString().slice(0, 4);
      }
    }

    return str;
  }

  function normalizeYear(val) {
    return normalizeYearOrDateCell(val, false);
  }

  function normalizeDate(val) {
    return normalizeYearOrDateCell(val, true);
  }

  /**
   * Scans a specific column of a sheet and extracts unique Google Drive File IDs.
   * Strips full URLs (e.g., https://docs.google.com/document/d/.../edit) down to pure 25+ char IDs.
   *
   * @param {Sheet} sheet - SpreadsheetApp Sheet object
   * @param {number} colIndex - 1-based column index (default: 1)
   * @returns {Set<string>} Set of extracted File IDs
   */
  function getQueuedFileIds(sheet, colIndex) {
    colIndex = typeof colIndex === "number" ? colIndex : 1;
    const ids = new Set();
    if (!sheet) return ids;

    const lastRow = typeof sheet.getLastRow === "function" ? sheet.getLastRow() : 0;
    if (lastRow < 2) return ids;

    try {
      const values = sheet.getRange(2, colIndex, lastRow - 1, 1).getValues();
      for (let i = 0; i < values.length; i++) {
        const raw = String(values[i][0] || "").trim();
        if (!raw) continue;
        const match = raw.match(/([-\w]{25,})/);
        if (match) {
          ids.add(match[1]);
        } else {
          ids.add(raw);
        }
      }
    } catch (e) {
      if (typeof Logger !== "undefined") {
        Logger.log("[WARN] getQueuedFileIds error: " + e.toString());
      }
    }

    return ids;
  }

  /**
   * Aggregates indexed file IDs across multiple tabs and columns in a master spreadsheet.
   *
   * @param {Spreadsheet} ss - SpreadsheetApp Spreadsheet object
   * @param {Array<{name: string, col: number}>} sheetMap - Array of sheet names and 1-based columns
   * @returns {Set<string>} Set of all indexed File IDs
   */
  function getIndexedFileIds(ss, sheetMap) {
    const ids = new Set();
    if (!ss || !Array.isArray(sheetMap)) return ids;

    sheetMap.forEach(function(item) {
      try {
        const sheet = ss.getSheetByName(item.name);
        if (sheet && sheet.getLastRow() > 1) {
          const col = item.col || 1;
          const vals = sheet.getRange(2, col, sheet.getLastRow() - 1, 1).getValues();
          for (let i = 0; i < vals.length; i++) {
            const raw = String(vals[i][0] || "").trim();
            if (!raw) continue;
            const match = raw.match(/([-\w]{25,})/);
            if (match) {
              ids.add(match[1]);
            } else {
              ids.add(raw);
            }
          }
        }
      } catch (e) {
        if (typeof Logger !== "undefined") {
          Logger.log('[WARN] Error indexing sheet "' + item.name + '": ' + e.toString());
        }
      }
    });

    return ids;
  }

  /**
   * Applies approved taxonomy synonym replacements to an array of tags, eliminating duplicates.
   *
   * @param {Array<string>} tags - List of tags to consolidate
   * @param {Object} mergeMap - Mapping of deprecated synonyms to canonical tags { "Old Tag": "Canonical Tag" }
   * @returns {Array<string>} Consolidated, deduplicated tags
   */
  function applyApprovedTaxonomyMerges(tags, mergeMap) {
    if (!Array.isArray(tags)) return [];
    if (!mergeMap || typeof mergeMap !== "object") return tags.slice();

    const seen = new Set();
    const result = [];

    tags.forEach(function(tag) {
      if (!tag || typeof tag !== "string") return;
      const trimmed = tag.trim();
      const canonical = mergeMap[trimmed] || trimmed;
      if (!seen.has(canonical)) {
        seen.add(canonical);
        result.push(canonical);
      }
    });

    return result;
  }

  /**
   * Appends an array of rows to a sheet in chunks to prevent network timeouts and cell boundary errors.
   *
   * @param {Sheet} sheet - SpreadsheetApp Sheet object
   * @param {Array<Array<*>>} rows - 2D array of rows
   * @param {number} chunkSize - Max rows per append call (default: 50)
   */
  function batchAppendRows(sheet, rows, chunkSize) {
    if (!sheet || !Array.isArray(rows) || rows.length === 0) return 0;
    chunkSize = chunkSize || 50;

    const totalNewRows = rows.length;
    let currentRow = sheet.getLastRow() + 1;
    const requiredMaxRows = currentRow + totalNewRows - 1;

    if (typeof sheet.getMaxRows === "function" && typeof sheet.insertRowsAfter === "function") {
      const currentMaxRows = sheet.getMaxRows();
      if (requiredMaxRows > currentMaxRows) {
        sheet.insertRowsAfter(currentMaxRows, requiredMaxRows - currentMaxRows);
      }
    }

    let appendedCount = 0;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const numCols = chunk[0].length;
      sheet.getRange(currentRow, 1, chunk.length, numCols).setValues(chunk);
      currentRow += chunk.length;
      appendedCount += chunk.length;
    }

    return appendedCount;
  }

  return {
    normalizeYearOrDateCell: normalizeYearOrDateCell,
    normalizeYear: normalizeYear,
    normalizeDate: normalizeDate,
    getQueuedFileIds: getQueuedFileIds,
    getIndexedFileIds: getIndexedFileIds,
    applyApprovedTaxonomyMerges: applyApprovedTaxonomyMerges,
    batchAppendRows: batchAppendRows
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = SheetKit;
}

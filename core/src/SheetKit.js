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

    // 2. Match ISO date string (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss...)
    const isoMatch = str.match(/^((?:19|20)\d{2})[-/](\d{1,2})[-/](\d{1,2})/);
    if (isoMatch) {
      if (!fullDate) {
        return isoMatch[1];
      }
      const yyyy = isoMatch[1];
      const mm = isoMatch[2].length === 1 ? "0" + isoMatch[2] : isoMatch[2];
      const dd = isoMatch[3].length === 1 ? "0" + isoMatch[3] : isoMatch[3];
      return yyyy + "-" + mm + "-" + dd;
    }

    // 3. Match Excel serial date between 40000 and 55000 (e.g., '46241.0' -> 2026-08-07)
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
   * Sanitizes potential formula injection characters (=, +, -, @, \t, \r)
   * to protect against CSV / formula injection vulnerabilities.
   */
  function sanitizeCellValue(val) {
    if (typeof val === "string" && val.length > 0) {
      const firstChar = val.charAt(0);
      if (firstChar === "=" || firstChar === "+" || firstChar === "-" || firstChar === "@" || firstChar === "\t" || firstChar === "\r") {
        return "'" + val;
      }
    }
    return val;
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

    const maxColsNeeded = rows.reduce(function(acc, r) {
      return Math.max(acc, Array.isArray(r) ? r.length : 0);
    }, 0);

    if (maxColsNeeded > 0 && typeof sheet.getMaxColumns === "function" && typeof sheet.insertColumnsAfter === "function") {
      const currentMaxCols = sheet.getMaxColumns();
      if (maxColsNeeded > currentMaxCols) {
        sheet.insertColumnsAfter(currentMaxCols, maxColsNeeded - currentMaxCols);
      }
    }

    let appendedCount = 0;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const numCols = chunk[0].length;
      const sanitizedChunk = chunk.map(function(row) {
        return row.map(sanitizeCellValue);
      });
      sheet.getRange(currentRow, 1, sanitizedChunk.length, numCols).setValues(sanitizedChunk);
      currentRow += sanitizedChunk.length;
      appendedCount += sanitizedChunk.length;
    }

    return appendedCount;
  }

  /**
   * Scans a specific column and deletes duplicate rows sharing the same identifier,
   * deleting from bottom to top to preserve row indexing.
   *
   * @param {Sheet} sheet - SpreadsheetApp Sheet object
   * @param {number} colIndex - 1-based column index
   * @param {Object} [options] - Configuration options { startRow: 2, extractId: true }
   * @returns {number} Number of duplicate rows deleted
   */
  function deduplicateRowsByColumn(sheet, colIndex, options) {
    if (!sheet || typeof sheet.getLastRow !== "function") return 0;
    options = options || {};
    const startRow = typeof options.startRow === "number" ? options.startRow : 2;
    const lastRow = sheet.getLastRow();
    if (lastRow < startRow) return 0;

    colIndex = typeof colIndex === "number" ? colIndex : 1;
    const extractId = options.extractId !== false;
    const numRows = lastRow - startRow + 1;
    const values = sheet.getRange(startRow, colIndex, numRows, 1).getValues();

    const seen = new Set();
    const rowsToDelete = [];

    for (let i = 0; i < values.length; i++) {
      const raw = String(values[i][0] || "").trim();
      if (!raw) continue;
      let idKey = raw;
      if (extractId) {
        const match = raw.match(/([-\w]{25,})/);
        if (match) idKey = match[1];
      }
      const actualRowIndex = startRow + i;
      if (seen.has(idKey)) {
        rowsToDelete.push(actualRowIndex);
      } else {
        seen.add(idKey);
      }
    }

    if (typeof sheet.deleteRow === "function") {
      for (let d = rowsToDelete.length - 1; d >= 0; d--) {
        sheet.deleteRow(rowsToDelete[d]);
      }
    }

    return rowsToDelete.length;
  }

  /**
   * Cleans and normalizes all date or year cells in a column in place.
   *
   * @param {Sheet} sheet - SpreadsheetApp Sheet object
   * @param {number} colIndex - 1-based column index
   * @param {Object} [options] - Configuration options { startRow: 2, fullDate: false }
   * @returns {number} Number of modified cells
   */
  function normalizeDateColumn(sheet, colIndex, options) {
    if (!sheet || typeof sheet.getLastRow !== "function") return 0;
    options = options || {};
    const startRow = typeof options.startRow === "number" ? options.startRow : 2;
    const lastRow = sheet.getLastRow();
    if (lastRow < startRow) return 0;

    colIndex = typeof colIndex === "number" ? colIndex : 1;
    const fullDate = Boolean(options.fullDate);
    const numRows = lastRow - startRow + 1;
    const range = sheet.getRange(startRow, colIndex, numRows, 1);
    const values = range.getValues();
    let modifiedCount = 0;

    for (let i = 0; i < values.length; i++) {
      const current = values[i][0];
      const cleaned = normalizeYearOrDateCell(current, fullDate);
      if (cleaned !== "" && cleaned !== String(current)) {
        values[i][0] = cleaned;
        modifiedCount++;
      }
    }

    if (modifiedCount > 0 && typeof range.setValues === "function") {
      range.setValues(values);
    }

    return modifiedCount;
  }

  /**
   * Backfills empty cells in targetColIndex based on terms present in keyColIndex.
   *
   * @param {Sheet} sheet - SpreadsheetApp Sheet object
   * @param {number} targetColIndex - 1-based target column index
   * @param {Object} [options] - Configuration options { startRow: 2, keyColIndex: 1, defaultValueFn: (keyVal) => string }
   * @returns {number} Number of backfilled cells
   */
  function backfillEmptyCells(sheet, targetColIndex, options) {
    if (!sheet || typeof sheet.getLastRow !== "function") return 0;
    options = options || {};
    const startRow = typeof options.startRow === "number" ? options.startRow : 2;
    const lastRow = sheet.getLastRow();
    if (lastRow < startRow) return 0;

    targetColIndex = typeof targetColIndex === "number" ? targetColIndex : 2;
    const keyColIndex = typeof options.keyColIndex === "number" ? options.keyColIndex : 1;
    const defaultValueFn = typeof options.defaultValueFn === "function"
      ? options.defaultValueFn
      : function(term) { return "Default (" + term + ")"; };

    const width = Math.max(targetColIndex, keyColIndex);
    const numRows = lastRow - startRow + 1;
    const range = sheet.getRange(startRow, 1, numRows, width);
    const values = range.getValues();
    let backfilledCount = 0;

    for (let i = 0; i < values.length; i++) {
      const keyVal = String(values[i][keyColIndex - 1] || "").trim();
      const targetVal = String(values[i][targetColIndex - 1] || "").trim();
      if (keyVal && !targetVal) {
        values[i][targetColIndex - 1] = defaultValueFn(keyVal, startRow + i);
        backfilledCount++;
      }
    }

    if (backfilledCount > 0 && typeof range.setValues === "function") {
      range.setValues(values);
    }

    return backfilledCount;
  }

  return {
    sanitizeCellValue: sanitizeCellValue,
    normalizeYearOrDateCell: normalizeYearOrDateCell,
    normalizeYear: normalizeYear,
    normalizeDate: normalizeDate,
    getQueuedFileIds: getQueuedFileIds,
    getIndexedFileIds: getIndexedFileIds,
    applyApprovedTaxonomyMerges: applyApprovedTaxonomyMerges,
    batchAppendRows: batchAppendRows,
    deduplicateRowsByColumn: deduplicateRowsByColumn,
    normalizeDateColumn: normalizeDateColumn,
    backfillEmptyCells: backfillEmptyCells
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = SheetKit;
}

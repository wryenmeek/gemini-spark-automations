/**
 * DriveMetadata.js — Schema v1 JSONL Direct-to-Storage Metadata Management
 * Part of SparkCore (Google Apps Script Shared Library)
 *
 * Persists machine-readable JSONL metadata directly in Google Drive file descriptions,
 * enabling zero-token pre-flight screening and persistent taxonomy tagging without external databases.
 */

var DriveMetadata = (function() {
  const SCHEMA_VERSION = 1;
  const MAX_DESCRIPTION_LENGTH = 1024;

  /**
   * Safely parses a Schema v1 JSONL payload from a file's description string.
   * Returns null if the description does not contain valid metadata.
   */
  function parseMetadata(description) {
    if (!description || typeof description !== "string") {
      return null;
    }

    const trimmed = description.trim();
    if (!trimmed.includes('"schema_v"') && !trimmed.startsWith("{")) {
      return null;
    }

    try {
      // Find JSON object bounds in case description has surrounding text
      const firstBrace = trimmed.indexOf("{");
      const lastBrace = trimmed.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        const jsonStr = trimmed.substring(firstBrace, lastBrace + 1);
        const parsed = JSON.parse(jsonStr);
        if (typeof parsed === "object" && parsed !== null) {
          return parsed;
        }
      }
    } catch (e) {
      if (typeof Logger !== "undefined") {
        Logger.log("[WARN] Failed to parse Drive metadata JSON: " + e.toString());
      }
    }

    return null;
  }

  /**
   * Serializes a metadata object into a compact, single-line Schema v1 JSON string.
   * Guarantees length <= 1024 bytes (Google Drive API limit).
   */
  function formatMetadata(data) {
    if (!data || typeof data !== "object") {
      throw new Error("Metadata must be a non-null object");
    }

    const payload = Object.assign({}, data);
    if (!payload.schema_v) {
      payload.schema_v = SCHEMA_VERSION;
    }
    if (!payload.updated_at) {
      payload.updated_at = new Date().toISOString();
    }

    let jsonStr = JSON.stringify(payload);
    if (jsonStr.length > MAX_DESCRIPTION_LENGTH) {
      // If payload exceeds 1024 chars, trim tags array to fit
      if (Array.isArray(payload.tags) && payload.tags.length > 1) {
        while (payload.tags.length > 1 && jsonStr.length > MAX_DESCRIPTION_LENGTH) {
          payload.tags.pop();
          jsonStr = JSON.stringify(payload);
        }
      }
    }

    if (jsonStr.length > MAX_DESCRIPTION_LENGTH) {
      throw new Error("Metadata exceeds Google Drive description limit (" + jsonStr.length + " > " + MAX_DESCRIPTION_LENGTH + " chars)");
    }

    return jsonStr;
  }

  /**
   * Zero-token pre-flight check: determines if a file has already been classified.
   * Accepts either a Drive file object or a raw description string.
   */
  function isAlreadyClassified(fileOrDescription) {
    let desc = "";
    if (fileOrDescription && typeof fileOrDescription.getDescription === "function") {
      desc = fileOrDescription.getDescription() || "";
    } else if (typeof fileOrDescription === "string") {
      desc = fileOrDescription;
    } else {
      return false;
    }

    return desc.includes('"schema_v"');
  }

  /**
   * Writes Schema v1 metadata to a Google Drive file's description.
   * Leverages Advanced Drive Service (Drive.Files.patch) if available, falling back to DriveApp.
   */
  function updateFileMetadata(fileOrId, metadata) {
    const formatted = formatMetadata(metadata);
    let fileId = "";
    let fileObj = null;

    if (typeof fileOrId === "string") {
      fileId = fileOrId;
      if (typeof DriveApp !== "undefined") {
        fileObj = DriveApp.getFileById(fileId);
      }
    } else if (fileOrId && typeof fileOrId.getId === "function") {
      fileObj = fileOrId;
      fileId = fileObj.getId();
    } else {
      throw new Error("Invalid fileOrId parameter: expected Drive file object or ID string");
    }

    // Try Advanced Drive API v2/v3 patch first for atomic update
    try {
      if (typeof Drive !== "undefined" && Drive.Files && typeof Drive.Files.patch === "function") {
        Drive.Files.patch({ description: formatted }, fileId);
        return formatted;
      }
    } catch (e) {
      if (typeof Logger !== "undefined") {
        Logger.log("[WARN] Drive.Files.patch failed, falling back to DriveApp: " + e.toString());
      }
    }

    // Standard DriveApp fallback
    if (fileObj && typeof fileObj.setDescription === "function") {
      fileObj.setDescription(formatted);
      return formatted;
    }

    throw new Error("Unable to update description for file: " + fileId);
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    MAX_DESCRIPTION_LENGTH: MAX_DESCRIPTION_LENGTH,
    parseMetadata: parseMetadata,
    formatMetadata: formatMetadata,
    isAlreadyClassified: isAlreadyClassified,
    updateFileMetadata: updateFileMetadata
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = DriveMetadata;
}

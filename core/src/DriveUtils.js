/**
 * DriveUtils.js — Safe Drive Operations, Recursive BFS Traversal & ID Utilities
 * Part of SparkCore (Google Apps Script Shared Library)
 *
 * Provides battle-tested utilities that avoid classic Apps Script traps:
 * - Safe Google Doc creation without MIME type errors
 * - Robust recursive BFS folder traversal with loop protection and budget guards
 * - Accurate 25+ character Drive File ID extraction from full URLs
 * - Safe text snippet extraction that avoids raw PDF binary context blowup
 */

var DriveUtils = (function() {
  /**
   * Extracts a 25+ character Google Drive File/Folder ID from a URL or raw ID string.
   */
  function extractFileId(urlOrId) {
    if (!urlOrId || typeof urlOrId !== "string") {
      return null;
    }
    const match = urlOrId.match(/([-\w]{25,})/);
    return match ? match[1] : null;
  }

  /**
   * Safely creates a Google Doc in a designated Drive folder.
   * Resolves the trap where DriveApp.Folder.createFile(name, content, MimeType.GOOGLE_DOCS)
   * throws "Invalid argument: mimeType".
   */
  function createDocInFolder(name, content, targetFolder) {
    if (typeof DocumentApp === "undefined") {
      throw new Error("DocumentApp service is not available in current context");
    }

    const doc = DocumentApp.create(name);
    if (content) {
      doc.getBody().setText(content);
    }
    doc.saveAndClose();

    let file = null;
    if (typeof DriveApp !== "undefined") {
      file = DriveApp.getFileById(doc.getId());
      if (targetFolder) {
        let destFolder = targetFolder;
        if (typeof targetFolder === "string" && typeof DriveApp.getFolderById === "function") {
          destFolder = DriveApp.getFolderById(targetFolder);
        }
        if (destFolder) {
          if (typeof file.moveTo === "function") {
            file.moveTo(destFolder);
          } else if (typeof destFolder.addFile === "function") {
            destFolder.addFile(file);
            try {
              DriveApp.getRootFolder().removeFile(file);
            } catch (_) {}
          }
        }
      }
    }

    return file || { getId: function() { return doc.getId(); }, getName: function() { return name; } };
  }

  /**
   * Recursive Breadth-First Search (BFS) crawler across nested Google Drive folders.
   * Includes visited-set loop detection and execution budget supervisor checks.
   *
   * @param {Folder|string} rootFolder - Drive Folder object or folder ID.
   * @param {Object} options - { maxDepth: 10, maxFiles: 500, isTimeExpiring: fn, mimeTypeFilter: [] }
   * @returns {Array<File>} Discovered files
   */
  function crawlFolderTree(rootFolder, options) {
    options = options || {};
    const maxDepth = typeof options.maxDepth === "number" ? options.maxDepth : 10;
    const maxFiles = typeof options.maxFiles === "number" ? options.maxFiles : 500;
    const isTimeExpiring = typeof options.isTimeExpiring === "function" ? options.isTimeExpiring : function() { return false; };
    const mimeFilter = options.mimeTypeFilter ? (Array.isArray(options.mimeTypeFilter) ? options.mimeTypeFilter : [options.mimeTypeFilter]) : null;

    let folderObj = rootFolder;
    if (typeof rootFolder === "string" && typeof DriveApp !== "undefined") {
      folderObj = DriveApp.getFolderById(rootFolder);
    }

    if (!folderObj || typeof folderObj.getId !== "function") {
      throw new Error("Invalid root folder provided for traversal");
    }

    const discoveredFiles = [];
    const visitedFolderIds = new Set();
    const queue = [{ folder: folderObj, depth: 0 }];

    while (queue.length > 0) {
      if (isTimeExpiring()) {
        if (typeof Logger !== "undefined") {
          Logger.log("[WARN] Folder traversal halted early due to execution budget expiration.");
        }
        break;
      }
      if (discoveredFiles.length >= maxFiles) {
        break;
      }

      const current = queue.shift();
      const folderId = current.folder.getId();

      if (visitedFolderIds.has(folderId)) {
        continue; // Cycle detection
      }
      visitedFolderIds.add(folderId);

      // Collect files in current folder
      try {
        const fileIter = current.folder.getFiles();
        while (fileIter.hasNext()) {
          if (isTimeExpiring() || discoveredFiles.length >= maxFiles) break;
          const file = fileIter.next();
          if (mimeFilter) {
            const mime = file.getMimeType();
            if (mimeFilter.includes(mime)) {
              discoveredFiles.push(file);
            }
          } else {
            discoveredFiles.push(file);
          }
        }
      } catch (e) {
        if (typeof Logger !== "undefined") {
          Logger.log('[WARN] Error reading files in folder "' + folderId + '": ' + e.toString());
        }
      }

      // Discover child folders if below maxDepth
      if (current.depth < maxDepth) {
        try {
          const subFolderIter = current.folder.getFolders();
          while (subFolderIter.hasNext()) {
            if (isTimeExpiring()) break;
            const subFolder = subFolderIter.next();
            if (!visitedFolderIds.has(subFolder.getId())) {
              queue.push({ folder: subFolder, depth: current.depth + 1 });
            }
          }
        } catch (e) {
          if (typeof Logger !== "undefined") {
            Logger.log('[WARN] Error reading subfolders in folder "' + folderId + '": ' + e.toString());
          }
        }
      }
    }

    return discoveredFiles;
  }

  /**
   * Safely extracts text from a Drive file for LLM processing, avoiding raw PDF byte blowup.
   */
  function extractFileTextSnippet(file, wordLimit) {
    wordLimit = wordLimit || 1500;
    if (!file || typeof file.getMimeType !== "function") {
      return "";
    }

    const mime = file.getMimeType();
    let text = "";

    try {
      if (typeof MimeType !== "undefined" && mime === MimeType.GOOGLE_DOCS) {
        if (typeof DocumentApp !== "undefined") {
          text = DocumentApp.openById(file.getId()).getBody().getText();
        }
      } else if (mime === "application/pdf") {
        // Warning: Avoid getBlob().getDataAsString() on PDFs as it dumps unparsed binary streams.
        // Signal that multimodal inlineData or separate OCR is required.
        text = "[PDF document: " + file.getName() + " (size: " + file.getSize() + " bytes). Multimodal inlineData processing required.]";
      } else if (
        mime.includes("text") ||
        mime === "application/json" ||
        mime === "application/javascript" ||
        mime.includes("csv")
      ) {
        text = file.getBlob().getDataAsString();
      } else {
        text = "[Non-text file: " + file.getName() + " (" + mime + ")]";
      }
    } catch (e) {
      if (typeof Logger !== "undefined") {
        Logger.log('[WARN] Text extraction failed for file "' + file.getId() + '": ' + e.toString());
      }
      text = "[Text extraction failed: " + e.toString() + "]";
    }

    const words = text.split(/\s+/).filter(Boolean);
    if (words.length > wordLimit) {
      return words.slice(0, wordLimit).join(" ") + "\n... [TRUNCATED at " + wordLimit + " words]";
    }
    return text;
  }

  return {
    extractFileId: extractFileId,
    createDocInFolder: createDocInFolder,
    crawlFolderTree: crawlFolderTree,
    extractFileTextSnippet: extractFileTextSnippet
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = DriveUtils;
}

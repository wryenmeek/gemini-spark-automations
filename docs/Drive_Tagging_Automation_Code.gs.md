# Google Apps Script: Drive Tagging Automation (`Code.gs`)

**System Location:** Google Drive / `gemini-spark`  
**Filename:** `Drive_Tagging_Automation_Code.gs.md`  
**Live Apps Script Project:** [Drive-Tagging-Automation](https://script.google.com/d/1F2-pZJZ1jzfoNS7EgnQOYXOwii5YEU7rFOMKOWN52k2GQcWrBpPbp2-w/edit) (`1F2-pZJZ1jzfoNS7EgnQOYXOwii5YEU7rFOMKOWN52k2GQcWrBpPbp2-w`)  
**Target Spreadsheet:** [Drive Tagging Master Index](https://docs.google.com/spreadsheets/d/1XE78-Gae0a5DfkuC0lJcy62XjreqPIPovy8LuoAT3gA/edit) (`1XE78-Gae0a5DfkuC0lJcy62XjreqPIPovy8LuoAT3gA`)  
**Effective Date:** October 30, 2026  
**Runtime:** Google Apps Script (V8 Engine) + `gemini-2.5-flash`

---

## 1. Overview & Configuration

This script implements background file detection in `My Drive` root, Gemini 2.5 Flash structured JSON classification against `Tag_Taxonomy_Master`, confidence-based auto-approval (>= 0.90), deduplicated human queueing in `Review_Queue` with enforced dropdown validation (`Pending`, `Approved`, `Approved with Corrections`, `Rejected`), native multimodal PDF inspection (avoiding binary stream corruption), JSONL file description writing, and closed-loop evaluation logging.

### Setup Instructions
1. Open the [Drive Tagging Master Index](https://docs.google.com/spreadsheets/d/1XE78-Gae0a5DfkuC0lJcy62XjreqPIPovy8LuoAT3gA/edit) and click **Extensions > Apps Script** (or open [Drive-Tagging-Automation](https://script.google.com/d/1F2-pZJZ1jzfoNS7EgnQOYXOwii5YEU7rFOMKOWN52k2GQcWrBpPbp2-w/edit)).
2. In **Project Settings** (gear icon) > **Script Properties**, add `GEMINI_API_KEY` with your Google AI Studio API key.
3. Run `testDriveTaggingDryRun` once to verify permissions and enforce QA dropdown validation and taxonomy uniqueness on the Master Sheet.
4. Run `setupTaggingTriggers` once to install the recurring scan, approval sync, and weekly email digest triggers.

---

## 2. Complete Production Source Code (`Code.gs`)

```javascript
/**
 * DRIVE TAGGING AUTOMATION SYSTEM (Code.gs v2.1)
 * Master Sheet ID: 1XE78-Gae0a5DfkuC0lJcy62XjreqPIPovy8LuoAT3gA
 */

const CONFIG = {
  SPREADSHEET_ID: '1XE78-Gae0a5DfkuC0lJcy62XjreqPIPovy8LuoAT3gA',
  GEMINI_MODEL: 'gemini-2.5-flash',
  CONFIDENCE_THRESHOLD: 0.90, // Auto-approve if >= 0.90 and no new tags proposed
  BATCH_SIZE: 10,             // Max files processed per execution
  WORD_LIMIT: 1500,           // Max words sent to Gemini API for text/docs
  MAX_PDF_BYTES: 8 * 1024 * 1024 // 8 MB max inline PDF payload
};

/**
 * 0. TRIGGER SETUP: Installs recurring scan, approval sync, and weekly digest triggers
 */
function setupTaggingTriggers() {
  const handlers = [
    'scanAndTagDriveFiles',
    'syncApprovedTagsFromSheet',
    'sendWeeklyReviewDigest'
  ];
  ScriptApp.getProjectTriggers().forEach(t => {
    if (handlers.includes(t.getHandlerFunction())) {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('scanAndTagDriveFiles')
    .timeBased()
    .everyHours(6)
    .create();

  ScriptApp.newTrigger('syncApprovedTagsFromSheet')
    .timeBased()
    .everyHours(2)
    .create();

  ScriptApp.newTrigger('sendWeeklyReviewDigest')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(8)
    .create();

  Logger.log('Installed Drive Tagging triggers (scan every 6h, sync every 2h, weekly Monday digest).');
}

/**
 * QA ENFORCEMENT HELPER: Enforces Review_Queue dropdown validation and Tag_Taxonomy_Master uniqueness
 */
function ensureMasterSheetSchema(ss) {
  ss = ss || SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const queueSheet = ss.getSheetByName('Review_Queue');
  const taxonomySheet = ss.getSheetByName('Tag_Taxonomy_Master');

  // 1. Enforce dropdown validation on Review_Queue Column H (Human Action)
  if (queueSheet && typeof SpreadsheetApp.newDataValidation === 'function') {
    const rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(['Pending', 'Approved', 'Approved with Corrections', 'Rejected'], true)
      .setAllowInvalid(false)
      .build();
    queueSheet.getRange('H2:H500').setDataValidation(rule);
  }

  // 2. Deduplicate Tag_Taxonomy_Master entries (case-insensitive)
  if (taxonomySheet && taxonomySheet.getLastRow() > 1) {
    const rows = taxonomySheet.getDataRange().getValues();
    const seen = new Set();
    for (let i = rows.length - 1; i >= 1; i--) {
      const tag = String(rows[i][0] || '').trim().toLowerCase();
      if (!tag) continue;
      if (seen.has(tag)) {
        taxonomySheet.deleteRow(i + 1);
      } else {
        seen.add(tag);
      }
    }
  }
}

/**
 * 1. MAIN TRIGGER FUNCTION: Scans Drive Root for loose files without JSONL descriptions
 */
function scanAndTagDriveFiles() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  ensureMasterSheetSchema(ss);

  const queueSheet = ss.getSheetByName('Review_Queue');
  const taxonomySheet = ss.getSheetByName('Tag_Taxonomy_Master');

  const taxonomyList = getCanonicalTaxonomy(taxonomySheet);
  const queuedFileIds = getQueuedFileIds(queueSheet);

  // Search Drive Root for loose text/doc/PDF/markdown files
  const rootFolder = DriveApp.getRootFolder();
  const query =
    "title != '' and trashed = false and (" +
    "mimeType = 'application/vnd.google-apps.document' or " +
    "mimeType = 'text/plain' or " +
    "mimeType = 'application/pdf' or " +
    "mimeType = 'text/markdown')";
  const files = rootFolder.searchFiles(query);

  let processedCount = 0;

  while (files.hasNext() && processedCount < CONFIG.BATCH_SIZE) {
    const file = files.next();
    const fileId = file.getId();
    const currentDescription = file.getDescription() || '';

    // Skip if description already contains JSONL tag payload OR if already in Review_Queue
    if (currentDescription.includes('"schema_v"') || queuedFileIds.has(fileId)) {
      continue;
    }

    const aiResult = classifyFileWithGemini(file, taxonomyList);
    if (!aiResult) continue;

    queuedFileIds.add(fileId);

    // Auto-Approve if high confidence and only uses existing canonical tags
    if (
      aiResult.confidence >= CONFIG.CONFIDENCE_THRESHOLD &&
      (!aiResult.new_tags || aiResult.new_tags.length === 0)
    ) {
      const jsonlPayload = {
        schema_v: 1,
        doc_type: aiResult.doc_type,
        tags: aiResult.existing_tags,
        confidence: aiResult.confidence,
        tagged_by: 'gemini_auto',
        updated_at: new Date().toISOString()
      };
      file.setDescription(JSON.stringify(jsonlPayload));
      Logger.log('Auto-tagged file: ' + file.getName());
    } else {
      // Queue for Human Review in Review_Queue
      const allSuggestedTags = [].concat(aiResult.existing_tags || [], aiResult.new_tags || []);
      queueSheet.appendRow([
        file.getName(),
        file.getUrl(),
        fileId,
        aiResult.doc_type,
        (aiResult.existing_tags || []).join(', '),
        (aiResult.new_tags || []).join(', '),
        aiResult.confidence,
        'Pending',
        aiResult.doc_type,              // Editable Final Approved Doc Type
        allSuggestedTags.join(', '),    // Editable Final Approved Tags
        aiResult.reasoning,
        'PENDING_REVIEW'
      ]);
      Logger.log('Queued file for human review: ' + file.getName());
    }

    processedCount++;
  }
}

/**
 * 2. SYNC APPROVED TAGS: Writes JSONL description for approved items in Review_Queue and updates Taxonomy
 */
function syncApprovedTagsFromSheet() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const queueSheet = ss.getSheetByName('Review_Queue');
  const taxonomySheet = ss.getSheetByName('Tag_Taxonomy_Master');
  const evalsSheet = ss.getSheetByName('Evals_and_Corrections_Log');

  if (!queueSheet || queueSheet.getLastRow() < 2) return;
  const data = queueSheet.getDataRange().getValues();
  const existingTaxonomy = new Set(getCanonicalTaxonomy(taxonomySheet).map(t => t.toLowerCase()));

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const fileId = String(row[2] || '').trim();
    const humanAction = String(row[7] || '').trim();
    const finalDocType = String(row[8] || '').trim();
    const finalTagsString = String(row[9] || '').trim();
    const status = String(row[11] || '').trim();

    if (
      status === 'PENDING_REVIEW' &&
      (humanAction === 'Approved' || humanAction === 'Approved with Corrections')
    ) {
      try {
        const file = DriveApp.getFileById(fileId);
        const finalTagsArray = finalTagsString
          ? finalTagsString.split(',').map(t => t.trim()).filter(Boolean)
          : [];

        const jsonlPayload = {
          schema_v: 1,
          doc_type: finalDocType,
          tags: finalTagsArray,
          approved_by: 'human_review',
          updated_at: new Date().toISOString()
        };

        file.setDescription(JSON.stringify(jsonlPayload));
        queueSheet.getRange(i + 1, 12).setValue('COMPLETED');

        // Add any newly approved tags to Tag_Taxonomy_Master
        finalTagsArray.forEach(tag => {
          if (!existingTaxonomy.has(tag.toLowerCase())) {
            taxonomySheet.appendRow([tag, 'Approved Extension', 'Added via Review_Queue approval']);
            existingTaxonomy.add(tag.toLowerCase());
          }
        });

        // Log to Evals_and_Corrections_Log if human modified the AI suggestions
        const aiSuggestedTags = String(row[4] || '').trim();
        if (humanAction === 'Approved with Corrections' || aiSuggestedTags !== finalTagsString || row[3] !== finalDocType) {
          evalsSheet.appendRow([
            fileId,
            row[0],
            String(row[10] || ''),
            JSON.stringify({ doc_type: row[3], existing_tags: row[4], new_tags: row[5] }),
            JSON.stringify({ doc_type: finalDocType, tags: finalTagsArray }),
            humanAction === 'Approved with Corrections' ? 'Correction' : 'Tag Refinement',
            new Date()
          ]);
        }
      } catch (err) {
        Logger.log('Error syncing file ' + fileId + ': ' + err.toString());
      }
    } else if (status === 'PENDING_REVIEW' && humanAction === 'Rejected') {
      queueSheet.getRange(i + 1, 12).setValue('REJECTED');
    }
  }
}

/**
 * 3. WEEKLY EMAIL DIGEST: Sends email if review items are pending
 */
function sendWeeklyReviewDigest() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const queueSheet = ss.getSheetByName('Review_Queue');
  if (!queueSheet || queueSheet.getLastRow() < 2) return;
  const data = queueSheet.getDataRange().getValues();

  let pendingCount = 0;
  for (let i = 1; i < data.length; i++) {
    if (data[i][11] === 'PENDING_REVIEW') pendingCount++;
  }

  if (pendingCount > 0) {
    const userEmail = Session.getActiveUser().getEmail() || 'wryenmeek@gmail.com';
    const subject = `Drive Tagging Review Needed: ${pendingCount} Item(s) Pending`;
    const body =
      `Hello,\n\nYou have ${pendingCount} document(s) in your Google Drive pending tag review.\n\n` +
      `Please review and approve them here:\n${ss.getUrl()}\n\n` +
      `Best regards,\nDrive Tagging Automation`;
    GmailApp.sendEmail(userEmail, subject, body);
  }
}

/**
 * HELPER: Classify file with Gemini 2.5 Flash (supports text snippets AND native inline PDF inspection)
 */
function classifyFileWithGemini(file, taxonomyList) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    Logger.log('Missing GEMINI_API_KEY in Script Properties.');
    return null;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const mime = file.getMimeType();
  const parts = [];

  if (mime === 'application/pdf') {
    const blob = file.getBlob();
    const bytes = blob.getBytes();
    if (bytes.length <= CONFIG.MAX_PDF_BYTES) {
      parts.push({
        inlineData: {
          mimeType: 'application/pdf',
          data: Utilities.base64Encode(bytes)
        }
      });
    }
    parts.push({
      text: buildClassificationPrompt(file.getName(), '[Attached PDF Document]', taxonomyList)
    });
  } else {
    const textSnippet = extractFileTextSnippet(file, CONFIG.WORD_LIMIT);
    if (!textSnippet || textSnippet.trim().length === 0) return null;
    parts.push({
      text: buildClassificationPrompt(file.getName(), textSnippet, taxonomyList)
    });
  }

  const responseSchema = {
    type: 'OBJECT',
    properties: {
      doc_type: { type: 'STRING' },
      existing_tags: { type: 'ARRAY', items: { type: 'STRING' } },
      new_tags: { type: 'ARRAY', items: { type: 'STRING' } },
      confidence: { type: 'NUMBER' },
      reasoning: { type: 'STRING' }
    },
    required: ['doc_type', 'existing_tags', 'new_tags', 'confidence', 'reasoning']
  };

  const payload = {
    contents: [{ parts: parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: responseSchema,
      temperature: 0.1
    }
  };

  try {
    const response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    if (response.getResponseCode() !== 200) {
      Logger.log('Gemini API HTTP Error: ' + response.getContentText());
      return null;
    }
    const json = JSON.parse(response.getContentText());
    return JSON.parse(json.candidates[0].content.parts[0].text);
  } catch (e) {
    Logger.log('Gemini API Error: ' + e.toString());
    return null;
  }
}

/**
 * HELPER: Builds the classification prompt
 */
function buildClassificationPrompt(fileName, textSnippet, taxonomyList) {
  return `You are an expert file classification system. Analyze the document below and return a structured JSON response.

DOCUMENT TITLE: "${fileName}"
CANONICAL TAXONOMY LIST: ${JSON.stringify(taxonomyList)}

TEXT SNIPPET:
"""
${textSnippet}
"""

INSTRUCTIONS:
1. Select the single best 'doc_type' from the taxonomy or assign a concise category.
2. Select all applicable 'existing_tags' strictly from the CANONICAL TAXONOMY LIST.
3. Only if necessary, suggest concise 'new_tags' missing from the taxonomy (leave empty array [] if existing tags suffice).
4. Estimate your classification 'confidence' between 0.00 and 1.00.
5. Provide brief 'reasoning' (1 sentence).`;
}

/**
 * HELPER: Extract text snippet from Google Doc or plain text/markdown file
 */
function extractFileTextSnippet(file, wordLimit) {
  try {
    let text = '';
    const mime = file.getMimeType();
    if (mime === 'application/vnd.google-apps.document') {
      text = DocumentApp.openById(file.getId()).getBody().getText();
    } else if (mime === 'text/plain' || mime === 'text/markdown') {
      text = file.getBlob().getDataAsString();
    } else {
      text = file.getName();
    }
    const words = text.split(/\s+/);
    return words.slice(0, wordLimit).join(' ');
  } catch (e) {
    return file.getName();
  }
}

/**
 * HELPER: Read canonical taxonomy from Tag_Taxonomy_Master
 */
function getCanonicalTaxonomy(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  const data = sheet.getDataRange().getValues();
  const taxonomy = [];
  for (let i = 1; i < data.length; i++) {
    if (data[i][0]) taxonomy.push(String(data[i][0]).trim());
  }
  return taxonomy;
}

/**
 * HELPER: Read all File IDs already present in Review_Queue so they are never queued twice
 */
function getQueuedFileIds(queueSheet) {
  const ids = new Set();
  if (!queueSheet || queueSheet.getLastRow() < 2) return ids;
  const values = queueSheet.getRange(2, 3, queueSheet.getLastRow() - 1, 1).getValues();
  values.forEach(r => {
    const id = String(r[0] || '').trim();
    if (id) ids.add(id);
  });
  return ids;
}

/**
 * DRY-RUN TEST: Verifies sheet access, enforces QA schema/dropdowns, and checks GEMINI_API_KEY
 */
function testDriveTaggingDryRun() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  ensureMasterSheetSchema(ss);
  const taxonomySheet = ss.getSheetByName('Tag_Taxonomy_Master');
  const queueSheet = ss.getSheetByName('Review_Queue');
  const taxonomy = getCanonicalTaxonomy(taxonomySheet);
  const queued = getQueuedFileIds(queueSheet);
  const hasKey = Boolean(PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY'));
  Logger.log(`[PASS] Sheet: ${ss.getName()} | Taxonomy terms: ${taxonomy.length} | Queued IDs: ${queued.size} | API Key set: ${hasKey}`);
}
```

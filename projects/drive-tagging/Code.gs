/**
 * DRIVE TAGGING AUTOMATION SYSTEM (Code.gs v2.1)
 * Master Sheet ID: 1XE78-Gae0a5DfkuC0lJcy62XjreqPIPovy8LuoAT3gA
 */

const CONFIG = {
  SPREADSHEET_ID: '1XE78-Gae0a5DfkuC0lJcy62XjreqPIPovy8LuoAT3gA',
  GEMINI_MODEL: 'gemini-2.5-flash',
  MODEL_LADDER: [
    "gemini-2.5-flash",              // Tier 1: Primary workhorse (optimal extraction & reasoning)
    "gemini-2.5-flash-lite",         // Tier 2: Separate high-speed rate-limit quota bucket
    "gemini-flash-latest",          // Tier 3: Rolling latest production flash release
    "gemini-flash-lite-latest",     // Tier 4: Rolling latest lite flash release
    "gemini-3.5-flash",             // Tier 5: Next-gen 3.5 flash cluster
    "gemini-3.5-flash-lite",        // Tier 6: Next-gen 3.5 lite cluster
    "gemini-3.1-flash-lite",        // Tier 7: Gen 3.1 lite cluster
    "gemini-3.1-flash-lite-preview",// Tier 8: Gen 3.1 preview cluster
    "gemini-3-flash-preview",       // Tier 9: Gen 3 preview cluster
    "gemini-3.6-flash",             // Tier 10: Gen 3.6 flash cluster
    "gemini-3.7-flash",             // Tier 11: Gen 3.7 flash cluster
    "gemini-3.8-flash",             // Tier 12: Gen 3.8 flash cluster
    "gemini-omni-flash-preview",    // Tier 13: Omni multimodal preview cluster
    "gemini-omni-1.1-flash",        // Tier 14: Omni 1.1 flash cluster
    "gemini-2.5-pro",               // Tier 15: Deep reasoning pro cluster
    "gemini-pro-latest",            // Tier 16: Rolling latest production pro release
    "gemini-3.1-pro-preview",       // Tier 17: Gen 3.1 pro preview cluster
    "gemini-4-argon"                // Tier 18: Advanced flagship frontier cluster
  ],
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
        tagged_by: aiResult._modelUsed || 'gemini_auto',
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
 * HELPER: Classify file with Gemini Multi-Tier Model Fleet (supports text snippets AND native inline PDF inspection)
 */
function classifyFileWithGemini(file, taxonomyList) {
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    Logger.log('Missing GEMINI_API_KEY in Script Properties.');
    return null;
  }

  const customLadder = props.getProperty('GEMINI_MODEL_LADDER');
  const ladder = customLadder
    ? customLadder.split(',').map(m => m.trim()).filter(Boolean)
    : CONFIG.MODEL_LADDER;

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

  return callGeminiAPI(payload, apiKey, ladder);
}

/**
 * Checks whether an HTTP 429 response is due to exceeding the daily quota (RPD)
 * vs a transient per-minute rate limit (RPM).
 */
function isDailyQuotaError(statusCode, responseText) {
  if (statusCode !== 429) return false;
  if (!responseText) return false;
  const text = responseText.toLowerCase();
  return (
    text.includes("per day") ||
    text.includes("perday") ||
    text.includes("requests per day") ||
    text.includes("daily") ||
    text.includes("free tier per day") ||
    text.includes("quota exceeded for quota metric 'generatecontent requests' and limit 'generatecontent requests per day")
  );
}

/**
 * Calculates remaining seconds until the next UTC midnight (when Google AI Studio daily quotas reset).
 */
function getSecondsUntilUtcMidnight() {
  const now = new Date();
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
  return Math.max(60, Math.floor((tomorrow.getTime() - now.getTime()) / 1000));
}

/**
 * Marks a model as daily-exhausted across CacheService (fast memory) and ScriptProperties (durable).
 */
function markModelDailyExhausted(model) {
  const secondsLeft = getSecondsUntilUtcMidnight();
  const resetTimestamp = Date.now() + secondsLeft * 1000;

  try {
    const cache = CacheService.getScriptCache();
    if (cache) {
      cache.put(`DAILY_EXHAUSTED_${model}`, "true", Math.min(21600, secondsLeft));
    }
  } catch (e) {
    Logger.log(`[WARN] Could not update CacheService: ${e.toString()}`);
  }

  try {
    const props = PropertiesService.getScriptProperties();
    if (props) {
      props.setProperty(`DAILY_EXHAUSTED_${model}`, String(resetTimestamp));
    }
  } catch (e) {
    Logger.log(`[WARN] Could not update ScriptProperties: ${e.toString()}`);
  }

  const hoursLeft = (secondsLeft / 3600).toFixed(1);
  Logger.log(`[DAILY_LIMIT_EXCEEDED] Model "${model}" hit daily quota limit. Banned until UTC midnight (~${hoursLeft}h remaining).`);
}

/**
 * Checks if a model is currently flagged as having exceeded its daily quota limit.
 */
function isModelDailyExhausted(model) {
  try {
    const cache = CacheService.getScriptCache();
    if (cache && cache.get(`DAILY_EXHAUSTED_${model}`) === "true") {
      return true;
    }

    const props = PropertiesService.getScriptProperties();
    if (props) {
      const resetTimeStr = props.getProperty(`DAILY_EXHAUSTED_${model}`);
      if (resetTimeStr) {
        const resetTime = parseInt(resetTimeStr, 10);
        if (Date.now() < resetTime) {
          return true;
        } else {
          props.deleteProperty(`DAILY_EXHAUSTED_${model}`);
          return false;
        }
      }
    }
  } catch (e) {
    Logger.log(`[WARN] Error checking model exhaustion status for "${model}": ${e.toString()}`);
  }
  return false;
}

/**
 * Dynamically queries the Gemini API to discover all available models supporting generateContent,
 * filtering and prioritizing fast multimodal models (Flash tier -> Lite -> Pro).
 * Results are cached in ScriptCache for up to 6 hours.
 */
function discoverAvailableModels(apiKey) {
  const cacheKey = "DISCOVERED_GEMINI_MODELS";
  try {
    const cache = CacheService.getScriptCache();
    if (cache) {
      const cached = cache.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    }
  } catch (e) {
    Logger.log(`[WARN] CacheService lookup failed: ${e.toString()}`);
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
  try {
    const response = UrlFetchApp.fetch(url, { method: "get", muteHttpExceptions: true });
    if (response.getResponseCode() === 200) {
      const json = JSON.parse(response.getContentText());
      const rawModels = json.models || [];

      // Priority scoring dictionary
      const priorityMap = {
        "gemini-2.5-flash": 10,
        "gemini-2.5-flash-lite": 15,
        "gemini-flash-latest": 20,
        "gemini-flash-lite-latest": 25,
        "gemini-3.5-flash": 30,
        "gemini-3.5-flash-lite": 35,
        "gemini-3.1-flash-lite": 40,
        "gemini-3.1-flash-lite-preview": 45,
        "gemini-3-flash-preview": 50,
        "gemini-3.6-flash": 55,
        "gemini-3.7-flash": 60,
        "gemini-3.8-flash": 65,
        "gemini-omni-flash-preview": 70,
        "gemini-omni-1.1-flash": 75,
        "gemini-2.5-pro": 100,
        "gemini-pro-latest": 105,
        "gemini-3.1-pro-preview": 110,
        "gemini-3.1-pro-preview-customtools": 115,
        "gemini-4-argon": 120
      };

      const excludedKeywords = [
        "tts", "image", "lyria", "transcribe", "robotics",
        "computer-use", "deep-research", "banana", "embed", "aqa"
      ];

      const discovered = rawModels
        .filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes("generateContent"))
        .map(m => m.name.replace(/^models\//, ""))
        .filter(name => {
          const lower = name.toLowerCase();
          return !excludedKeywords.some(keyword => lower.includes(keyword));
        })
        .sort((a, b) => {
          const rankA = priorityMap[a] || 200;
          const rankB = priorityMap[b] || 200;
          return rankA - rankB;
        });

      if (discovered.length > 0) {
        try {
          const cache = CacheService.getScriptCache();
          if (cache) {
            cache.put(cacheKey, JSON.stringify(discovered), 21600); // 6 hours
          }
        } catch (e) {}
        Logger.log(`[MODEL_DISCOVERY] Discovered ${discovered.length} available Gemini models: [${discovered.join(", ")}]`);
        return discovered;
      }
    }
  } catch (e) {
    Logger.log(`[WARN] Dynamic model discovery failed (${e.toString()}). Falling back to static ladder.`);
  }

  return CONFIG.MODEL_LADDER;
}

/**
 * Assembles the active dynamic model ladder:
 * 1. Discovers candidate models from API (or uses explicit custom ladder if configured).
 * 2. Filters out any models that have hit their daily limit.
 */
function getDynamicModelLadder(apiKey, configLadder) {
  let candidates = [];
  if (typeof configLadder === 'string') {
    configLadder = [configLadder];
  }

  if (Array.isArray(configLadder) && configLadder.length > 0 && configLadder !== CONFIG.MODEL_LADDER) {
    candidates = configLadder;
  } else {
    candidates = discoverAvailableModels(apiKey);
  }

  const activeLadder = candidates.filter(m => !isModelDailyExhausted(m));

  if (activeLadder.length > 0) {
    return activeLadder;
  }

  Logger.log(`[WARN] All models in candidate list have hit daily quota limits! Attempting primary model as last resort.`);
  return candidates.slice(0, 1);
}

/**
 * Invokes the Gemini API via UrlFetchApp with Dynamic Model Discovery, Daily Limit Tracking,
 * and Exponential Backoff.
 */
function callGeminiAPI(payload, apiKey, modelOrLadder) {
  const ladder = getDynamicModelLadder(apiKey, modelOrLadder);
  Logger.log(`[MODEL_LADDER_ACTIVE] Running with active ladder (${ladder.length} models): [${ladder.join(" -> ")}]`);

  for (let i = 0; i < ladder.length; i++) {
    const model = ladder[i];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const options = {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };

    try {
      let response = UrlFetchApp.fetch(url, options);
      let code = response.getResponseCode();
      let responseText = response.getContentText();

      // Check for Daily Limit Quota Exhaustion (RPD)
      if (isDailyQuotaError(code, responseText)) {
        markModelDailyExhausted(model);
        const nextModel = ladder[i + 1];
        if (nextModel) {
          Logger.log(`[MODEL_LADDER_ROTATE] Daily quota exceeded for "${model}". Falling back immediately to "${nextModel}"...`);
          continue;
        } else {
          Logger.log(`[MODEL_LADDER_EXHAUSTED] All models in dynamic ladder (${ladder.join(" -> ")}) have exhausted their quotas.`);
          return null;
        }
      }

      // Check for Transient Rate Limits (RPM / 503)
      if (code === 429 || code === 503) {
        Logger.log(`[QUOTA_TRANSIENT] Model "${model}" temporarily throttled (HTTP ${code}). Pausing 1.5s for recovery...`);
        Utilities.sleep(1500);
        response = UrlFetchApp.fetch(url, options);
        code = response.getResponseCode();
        responseText = response.getContentText();

        if (isDailyQuotaError(code, responseText)) {
          markModelDailyExhausted(model);
        }
      }

      // Persistent error on current model: Rotate to next candidate
      if (code === 429 || code === 503) {
        const nextModel = ladder[i + 1];
        if (nextModel) {
          Logger.log(`[MODEL_LADDER_ROTATE] Model "${model}" quota exhausted (HTTP ${code}). Rotating down to "${nextModel}"...`);
          continue;
        } else {
          Logger.log(`[MODEL_LADDER_EXHAUSTED] All models in ladder (${ladder.join(" -> ")}) exhausted.`);
          return null;
        }
      }

      if (code !== 200) {
        Logger.log(`[ERROR] Model "${model}" returned HTTP ${code}: ${responseText}`);
        continue;
      }

      const json = JSON.parse(responseText);
      const candidateText = json.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!candidateText) {
        Logger.log(`[WARN] Model "${model}" returned no candidate parts.`);
        continue;
      }

      Logger.log(`[SUCCESS] Extracted tags using model: "${model}"`);
      const parsedData = JSON.parse(candidateText);
      if (parsedData && typeof parsedData === "object") {
        parsedData._modelUsed = model;
      }
      return parsedData;
    } catch (e) {
      Logger.log(`[ERROR] Exception calling model "${model}": ${e.toString()}`);
    }
  }

  return null;
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
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  const hasKey = Boolean(apiKey);
  let ladderInfo = 'None';
  if (hasKey) {
    const ladder = getDynamicModelLadder(apiKey, CONFIG.MODEL_LADDER);
    ladderInfo = ladder.join(' -> ');
  }
  Logger.log(`[PASS] Sheet: ${ss.getName()} | Taxonomy terms: ${taxonomy.length} | Queued IDs: ${queued.size} | API Key set: ${hasKey} | Active Ladder: ${ladderInfo}`);
}

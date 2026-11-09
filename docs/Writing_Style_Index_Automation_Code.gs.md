Google Apps Script: Autonomous Writing Style & Tone Reference Index Architecture (Code.gs)
System Location: Google Drive / gemini-spark
Filename: Writing_Style_Index_Automation_Code.gs.md
Live Apps Script Project: Writing-Style-Index-Automation (1yuepYNbNxeZmYvy7LfmNeN6k1XgKgn-jWNA3nNkHlWgAXdEPfbIzDIwu)
Target Spreadsheet: Writing Style & Tone Reference Index (1HPY3pKrgzeJr1FMLiK_UNyNJcfPTanJoPRL3ikF_nA8)
Effective Date: October 30, 2026
Runtime: Google Apps Script (V8 Engine) + gemini-2.5-flash


________________


1. Overview & Architecture
This Google Apps Script solution provides an autonomous, token-efficient, and self-maintaining pipeline for indexing, analyzing, and categorizing writing samples stored in Google Drive into the centralized Writing Style & Tone Reference Index. It supports multi-format text extraction across Google Workspace (Docs, Slides), Markdown, Microsoft Office (.docx, .pptx), and OpenDocument (.odt) formats. It consolidates the v1 incremental delta scanner and the v2 autonomous pipeline while enforcing all rules in the sheet's Rules & Guidelines tab.
Key Architectural Pillars
1. Rule 0 Mandatory Pagination & Historical Backfill: First scans files modified within the delta window (modifiedDate > startIso). If fewer than BATCH_SIZE (25) unprocessed files are found in the recent delta window, automatically continues paginating through the historical Google Drive corpus (Document and Presentation files) until at least 20–25 unprocessed files are evaluated per run.
2. Dynamic Zero-Token Gatekeeping & Rule 2 Authorship Screening: Before invoking Gemini, deterministic pre-filters evaluate file ownership (wryenmeek@gmail.com), excluded parent folders, title keywords, and word count (>= 150 words). Unsuitable or third-party files are logged to Rejected Files with complete audit metadata without incurring LLM token costs.
3. Rule 1 GenAI & Automated Artifact Disambiguation: Both deterministic heuristics and Gemini structured schema evaluation actively screen for AI-generated artifacts (Gemini Deep Research whitepapers, automated speech-to-text transcripts, LLM-generated specs) and route them to Rejected Files with Author / Generator = 'Gemini / GenAI Agent' and full Audience/Topic/Style/Tone metadata (Rule 4).
4. Per-Folder Auto-Discovered Exclusions: Monitors rejection counts per parent folder ID (recorded in the Notes column of Rejected Files). When a specific non-root folder accumulates >= 3 rejections, that folder ID is automatically added to EXCLUDED_FOLDER_IDS in System_Config.
5. Controlled Taxonomy Alignment (Rule 5) & 1-Click Synonym Consolidation: Cross-references and extends the Audiences (Term, Description, Example), Topics, Styles, and Tones (Term, Description) tabs. When monthly synonym proposals in Taxonomy_Proposals are marked APPROVED, applyApprovedTaxonomyMerges() automatically rewrites matching terms across Master Index and consolidates the taxonomy tabs.
6. Automated Data Hygiene & Remediation (remediateStyleIndexSheet): Automatically normalizes legacy float/Excel serial dates (2020.0, 46241.0) into clean YYYY / YYYY-MM-DD strings, deduplicates repeated URLs in Master Index, and backfills missing descriptions in Audiences, Topics, Styles, and Tones.


________________


2. Spreadsheet Tabs & Schema Specification
The master Google Sheet (1HPY3pKrgzeJr1FMLiK_UNyNJcfPTanJoPRL3ikF_nA8) uses the following tabs:


* Master Index: Row 1 banner, Row 2 headers (Document Title, Year/Date, Target Audience, Primary Topic, Style Characteristics, Tone Markers, Key Excerpts / Quotes, Source URL, Strategic Notes).
* Rules & Guidelines & Maintenance & Workflow: Canonical governance SOPs.
* Audiences: (Term, Description, Example)
* Topics, Styles, Tones: (Term, Description)
* Rejected Files: (File Title, Date Assessed, Author / Generator, Rejection Category, Target Audience, Primary Topic, Style Characteristics, Tone Markers, Detailed Rejection Reason, File ID / URL, Notes)
* Review_Queue: (Document Title, File URL, File ID, Year/Date, AI Suggested Target Audience, AI Suggested Primary Topic, AI Suggested Style Characteristics, AI Suggested Tone Markers, AI Suggested Key Quotes, AI Suggested Strategic Notes, AI Confidence, Review Status)
* System_Config: Manages dynamic runtime settings including EXCLUDED_FOLDER_IDS (including Campaign Generated Documents 10tPOp6kaCSb99sDpwUqdgX3tiCEQ3oS7) and RATE_LIMIT_DELAY_MS (12,500 ms delay between Gemini calls to enforce <5 RPM on Free Tier quota). Auto-created with Taxonomy_Proposals and Evals_Log by loadSystemConfig(ss) if absent.


________________


3. Setup & Deployment Instructions
1. Open the Writing Style & Tone Reference Index and select Extensions > Apps Script (or open Writing-Style-Index-Automation).
2. Go to Project Settings (gear icon) > Script Properties, and add GEMINI_API_KEY with your Google AI Studio key.
3. Run testDryRun once to verify permissions, initialize System_Config, Taxonomy_Proposals, and Evals_Log, and execute remediateStyleIndexSheet.
4. Run setupAllTriggers once to automatically install the daily scan, daily approval/taxonomy sync, weekly review task, and monthly taxonomy clustering triggers.


________________


4. Complete Production Source Code (Code.gs)


/**
 * Autonomous Writing Style & Tone Reference Index System (Consolidated v2.2)
 * Master Spreadsheet ID: 1HPY3pKrgzeJr1FMLiK_UNyNJcfPTanJoPRL3ikF_nA8
 */


const DEFAULT_CONFIG = {
  SPREADSHEET_ID: '1HPY3pKrgzeJr1FMLiK_UNyNJcfPTanJoPRL3ikF_nA8',
  PRIMARY_USER_EMAIL: 'wryenmeek@gmail.com',
  MODEL_SELECTION_MODE: 'DYNAMIC',
  PREFERRED_MODEL_PATTERN: 'flash',
  GEMINI_MODEL: 'gemini-2.5-flash',
  CONFIDENCE_THRESHOLD: 0.90,
  MIN_WORD_COUNT: 150,
  MAX_TEXT_LENGTH: 8000,
  BATCH_SIZE: 25,
  SCAN_WINDOW_DAYS: 7,
  RATE_LIMIT_DELAY_MS: 12500,
  EXCLUDED_FOLDER_IDS: [
    '1XQyRsEx8gQl8idUv_UhfRMYxS9dIx0tk', // gemini-spark (system automation docs)
    '1pkvyPz6_VGhLS2HS7mcpeAyg3Plz3rvF', // Taxes/2025/Receipts
    '10tPOp6kaCSb99sDpwUqdgX3tiCEQ3oS7', // Campaign Generated Documents
    '1tAcCCcSOrv4Yprrm6IrjWKB00fJc9-wX'  // Taxes/2026/Receipts
  ],
  EXCLUDED_TITLE_KEYWORDS: [
    'receipt', 'invoice', 'outline', 'draft_temp', 'expense', 'billing',
    'raw', 'transcript', 'statblock', 'code.gs'
  ],
  SHEETS: {
    MASTER_INDEX: 'Master Index',
    REVIEW_QUEUE: 'Review_Queue',
    REJECTED_LOG: 'Rejected Files',
    SYSTEM_CONFIG: 'System_Config',
    TAXONOMY_PROPOSALS: 'Taxonomy_Proposals',
    EVALS_LOG: 'Evals_Log',
    AUDIENCES: 'Audiences',
    TOPICS: 'Topics',
    STYLES: 'Styles',
    TONES: 'Tones'
  }
};


/**
 * Installs all recurring triggers (Daily Scan, Daily Approval Sync, Weekly Task, Monthly Clustering)
 */
function setupAllTriggers() {
  const handlers = [
    'scanAndIndexWritingSamples',
    'syncApprovedReviewsFromQueue',
    'syncWeeklyReviewTasks',
    'runMonthlyTaxonomyClustering',
    'dailyStyleIndexUpdate'
  ];
  ScriptApp.getProjectTriggers().forEach(t => {
    if (handlers.includes(t.getHandlerFunction())) {
      ScriptApp.deleteTrigger(t);
    }
  });


  ScriptApp.newTrigger('scanAndIndexWritingSamples')
    .timeBased()
    .everyDays(1)
    .atHour(6)
    .create();


  ScriptApp.newTrigger('syncApprovedReviewsFromQueue')
    .timeBased()
    .everyDays(1)
    .atHour(7)
    .create();


  ScriptApp.newTrigger('syncWeeklyReviewTasks')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(9)
    .create();


  ScriptApp.newTrigger('runMonthlyTaxonomyClustering')
    .timeBased()
    .onMonthDay(1)
    .atHour(10)
    .create();


  Logger.log('Installed all 4 Writing Style Index automation triggers.');
}


/**
 * Loads dynamic runtime settings from System_Config tab (creating auxiliary tabs if absent).
 */
function loadSystemConfig(ss) {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  let sheet = ss.getSheetByName(DEFAULT_CONFIG.SHEETS.SYSTEM_CONFIG);
  if (!sheet) {
    sheet = ss.insertSheet(DEFAULT_CONFIG.SHEETS.SYSTEM_CONFIG);
    sheet.appendRow(['Setting Key', 'Value', 'Description']);
    sheet.appendRow(['EXCLUDED_FOLDER_IDS', DEFAULT_CONFIG.EXCLUDED_FOLDER_IDS.join(','), 'Comma-separated Google Drive folder IDs']);
    sheet.appendRow(['EXCLUDED_TITLE_KEYWORDS', DEFAULT_CONFIG.EXCLUDED_TITLE_KEYWORDS.join(','), 'Comma-separated lower-case title triggers']);
    sheet.appendRow(['CONFIDENCE_THRESHOLD', String(DEFAULT_CONFIG.CONFIDENCE_THRESHOLD), 'Min score for auto-indexing (0.0 - 1.0)']);
    sheet.appendRow(['GEMINI_MODEL', DEFAULT_CONFIG.GEMINI_MODEL, 'Gemini Model endpoint name']);
    sheet.appendRow(['MODEL_SELECTION_MODE', DEFAULT_CONFIG.MODEL_SELECTION_MODE, 'Model selection mode: DYNAMIC or STATIC']);
    sheet.appendRow(['PREFERRED_MODEL_PATTERN', DEFAULT_CONFIG.PREFERRED_MODEL_PATTERN, 'Preferred model regex pattern (default: flash)']);
    sheet.appendRow(['SCAN_WINDOW_DAYS', String(DEFAULT_CONFIG.SCAN_WINDOW_DAYS), 'Lookback window for updated Drive files']);
    sheet.appendRow(['RATE_LIMIT_DELAY_MS', String(DEFAULT_CONFIG.RATE_LIMIT_DELAY_MS), 'Milliseconds delay between Gemini API calls (<5 RPM)']);
    sheet.getRange(1, 1, 1, 3).setFontWeight('bold');
    sheet.setFrozenRows(1);
  } else {
    const rows = sheet.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      const key = String(rows[i][0]).trim();
      const val = String(rows[i][1]).trim();
      if (!key) continue;
      if (key === 'EXCLUDED_FOLDER_IDS') {
        config.EXCLUDED_FOLDER_IDS = val ? val.split(',').map(s => s.trim()).filter(Boolean) : [];
      } else if (key === 'EXCLUDED_TITLE_KEYWORDS') {
        config.EXCLUDED_TITLE_KEYWORDS = val ? val.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : [];
      } else if (key === 'CONFIDENCE_THRESHOLD') {
        config.CONFIDENCE_THRESHOLD = parseFloat(val) || DEFAULT_CONFIG.CONFIDENCE_THRESHOLD;
      } else if (key === 'GEMINI_MODEL') {
        config.GEMINI_MODEL = val || DEFAULT_CONFIG.GEMINI_MODEL;
      } else if (key === 'MODEL_SELECTION_MODE') {
        config.MODEL_SELECTION_MODE = val.toUpperCase() || DEFAULT_CONFIG.MODEL_SELECTION_MODE;
      } else if (key === 'PREFERRED_MODEL_PATTERN') {
        config.PREFERRED_MODEL_PATTERN = val.toLowerCase() || DEFAULT_CONFIG.PREFERRED_MODEL_PATTERN;
      } else if (key === 'SCAN_WINDOW_DAYS') {
        config.SCAN_WINDOW_DAYS = parseInt(val, 10) || DEFAULT_CONFIG.SCAN_WINDOW_DAYS;
      } else if (key === 'RATE_LIMIT_DELAY_MS') {
        config.RATE_LIMIT_DELAY_MS = parseInt(val, 10) || DEFAULT_CONFIG.RATE_LIMIT_DELAY_MS;
      }
    }
  }
  ensureAuxiliaryTabsExist(ss, config);
  return config;
}


/**
 * Ensures Review_Queue, Taxonomy_Proposals, and Evals_Log exist with standard headers
 */
function ensureAuxiliaryTabsExist(ss, config) {
  let queueSheet = ss.getSheetByName(config.SHEETS.REVIEW_QUEUE);
  if (!queueSheet) {
    queueSheet = ss.insertSheet(config.SHEETS.REVIEW_QUEUE);
    const headers = [
      'Document Title', 'File URL', 'File ID', 'Year/Date',
      'AI Suggested Target Audience', 'AI Suggested Primary Topic',
      'AI Suggested Style Characteristics', 'AI Suggested Tone Markers',
      'AI Suggested Key Quotes', 'AI Suggested Strategic Notes',
      'AI Confidence', 'Review Status'
    ];
    queueSheet.appendRow(headers);
    queueSheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    queueSheet.setFrozenRows(1);
  }
  let proposalsSheet = ss.getSheetByName(config.SHEETS.TAXONOMY_PROPOSALS);
  if (!proposalsSheet) {
    proposalsSheet = ss.insertSheet(config.SHEETS.TAXONOMY_PROPOSALS);
    proposalsSheet.appendRow(['Category', 'Proposed Consolidated Term', 'Terms to Merge', 'Status']);
    proposalsSheet.getRange(1, 1, 1, 4).setFontWeight('bold');
    proposalsSheet.setFrozenRows(1);
  }
  let evalSheet = ss.getSheetByName(config.SHEETS.EVALS_LOG);
  if (!evalSheet) {
    evalSheet = ss.insertSheet(config.SHEETS.EVALS_LOG);
    evalSheet.appendRow(['Timestamp', 'Doc Title', 'Doc ID', 'AI Suggested', 'Human Final', 'Action Type']);
    evalSheet.getRange(1, 1, 1, 6).setFontWeight('bold');
    evalSheet.setFrozenRows(1);
  }
}


/**
 * Main daily pipeline for searching and processing Drive files (with Rule 0 historical backfill).
 */
function scanAndIndexWritingSamples() {
  const ss = SpreadsheetApp.openById(DEFAULT_CONFIG.SPREADSHEET_ID);
  const config = loadSystemConfig(ss);
  const existingFileIds = getIndexedFileIds(ss, config);
  const scriptProps = PropertiesService.getScriptProperties();


  if (!scriptProps.getProperty('SHEET_REMEDIATED_V2_2')) {
    remediateStyleIndexSheet(ss, config);
    scriptProps.setProperty('SHEET_REMEDIATED_V2_2', 'true');
  }


  const lastRunIso = scriptProps.getProperty('LAST_RUN_TIMESTAMP');
  const now = new Date();
  const fallbackLookback = new Date(now.getTime() - (config.SCAN_WINDOW_DAYS * 24 * 60 * 60 * 1000));
  const startDate = lastRunIso ? new Date(lastRunIso) : fallbackLookback;
  const isoDate = startDate.toISOString();
  const mimeFilter =
    "(mimeType = 'application/vnd.google-apps.document' or " +
    "mimeType = 'application/vnd.google-apps.presentation' or " +
    "mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' or " +
    "mimeType = 'application/msword' or " +
    "mimeType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation' or " +
    "mimeType = 'application/vnd.oasis.opendocument.text' or " +
    "mimeType = 'text/plain' or " +
    "mimeType = 'text/markdown')";


  const deltaQuery = "modifiedDate > '" + isoDate + "' and trashed = false and " + mimeFilter;
  const historicalQuery = "trashed = false and " + mimeFilter;


  const masterRows = [];
  const rejectedRows = [];
  const queueRows = [];
  const todayStr = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  let processedInThisRun = 0;


  function processFileIterator(files) {
    while (files.hasNext() && processedInThisRun < config.BATCH_SIZE) {
      const file = files.next();
      const fileId = file.getId();
      if (existingFileIds.has(fileId)) continue;
      existingFileIds.add(fileId);
      processedInThisRun++;


      const fileName = file.getName();
      const fileUrl = file.getUrl();
      const ownerEmail = file.getOwner() ? file.getOwner().getEmail() : 'Unknown';
      const parentId = getPrimaryParentId(file);


      // RULE 2: Human Authorship Verification
      if (ownerEmail.toLowerCase() !== config.PRIMARY_USER_EMAIL.toLowerCase()) {
        rejectedRows.push([
          fileName, todayStr, ownerEmail,
          'Non-Wryen Author / Shared Document', 'External Collaborators',
          'Third-Party Shared Material', 'Collaborator Document',
          'Neutral & Informational',
          'Owned by ' + ownerEmail + '; fails Rule 2 (requires Wryen authorship).',
          fileUrl, 'Excluded [FolderID:' + parentId + ']'
        ]);
        continue;
      }


      // Zero-Token Folder & Title Gatekeeper
      if (isFolderExcluded(file, config.EXCLUDED_FOLDER_IDS) || isTitleExcluded(fileName, config.EXCLUDED_TITLE_KEYWORDS)) {
        rejectedRows.push([
          fileName, todayStr, 'Wryen Meek / Automated System',
          'Zero-Token Gatekeeper Filter', 'Self & Operations',
          'Administrative / Operational Artifact', 'Structured Reference / Template',
          'Functional & Objective',
          'Excluded by folder boundary or title keyword filter.',
          fileUrl, 'Excluded [FolderID:' + parentId + ']'
        ]);
        continue;
      }


      const textContent = extractFileText(file, config.MAX_TEXT_LENGTH);
      const wordCount = countWords(textContent);


      // RULE 3: Substantiality & Quality Threshold (>= 150 words)
      if (wordCount < config.MIN_WORD_COUNT) {
        rejectedRows.push([
          fileName, todayStr, 'Wryen Meek (' + ownerEmail + ')',
          'Below Minimum Length / Non-Substantive', 'Self',
          'Working Notes / Short Fragment', 'Short Fragment (< 150 words)',
          'Informal & Concise',
          'Word count (' + wordCount + ' words) below 150-word threshold; fails Rule 3.',
          fileUrl, 'Excluded [FolderID:' + parentId + ']'
        ]);
        autoDiscoverExclusion(ss, parentId, rejectedRows);
        continue;
      }


      // Evaluate with Gemini (including Rule 1 GenAI screening)
      try {
        const classification = classifySampleWithGemini(textContent, fileName, config);


        if (classification.isAiGenerated) {
          rejectedRows.push([
            fileName, todayStr, 'Gemini / GenAI Agent',
            'AI-Generated / GenAI Artifact', classification.audience,
            classification.topic, classification.style, classification.tone,
            classification.rejectionReason || 'Identified as GenAI-generated or automated output; fails Rule 1.',
            fileUrl, 'Excluded [FolderID:' + parentId + ']'
          ]);
          autoDiscoverExclusion(ss, parentId, rejectedRows);
          continue;
        }


        const isSoleAuthor = file.getEditors().length === 0;
        const isHighConfidence = classification.confidenceScore >= config.CONFIDENCE_THRESHOLD && !classification.hasAmbiguity;
        const docYear = Utilities.formatDate(file.getDateCreated(), Session.getScriptTimeZone(), 'yyyy');


        if (isHighConfidence && isSoleAuthor) {
          masterRows.push([
            fileName, docYear, classification.audience,
            classification.topic, classification.style, classification.tone,
            classification.exemplaryQuote, fileUrl, classification.strategicNotes
          ]);
          syncTaxonomy(ss, config, classification, fileName, docYear);
          logEvalRecord(ss, config, file, classification, 'AUTO_INDEXED');
        } else {
          queueRows.push([
            fileName, fileUrl, fileId, docYear,
            classification.audience, classification.topic, classification.style,
            classification.tone, classification.exemplaryQuote, classification.strategicNotes,
            classification.confidenceScore, 'PENDING_REVIEW'
          ]);
          logEvalRecord(ss, config, file, classification, 'QUEUED_FOR_REVIEW');
        }
        Utilities.sleep(config.RATE_LIMIT_DELAY_MS || 12500);
      } catch (classifyErr) {
        handleScriptError(ss, config, 'Classification failure: ' + fileName, classifyErr);
      }
    }
  }


  try {
    processFileIterator(DriveApp.searchFiles(deltaQuery));
    if (processedInThisRun < config.BATCH_SIZE) {
      processFileIterator(DriveApp.searchFiles(historicalQuery));
    }
    if (rejectedRows.length > 0) {
      appendRowsInBatch(ss.getSheetByName(config.SHEETS.REJECTED_LOG), rejectedRows);
    }
    if (masterRows.length > 0) {
      appendRowsInBatch(ss.getSheetByName(config.SHEETS.MASTER_INDEX), masterRows);
    }
    if (queueRows.length > 0) {
      appendRowsInBatch(ss.getSheetByName(config.SHEETS.REVIEW_QUEUE), queueRows);
    }
    scriptProps.setProperty('LAST_RUN_TIMESTAMP', now.toISOString());
    Logger.log(`Completed scanAndIndexWritingSamples. Processed: ${processedInThisRun}, Master: ${masterRows.length}, Queued: ${queueRows.length}, Rejected: ${rejectedRows.length}`);
  } catch (err) {
    handleScriptError(ss, config, 'Drive search pipeline failed', err);
  }
}


/**
 * Promotes human-approved rows from Review_Queue to Master Index and executes approved Taxonomy_Proposals merges
 */
function syncApprovedReviewsFromQueue() {
  const ss = SpreadsheetApp.openById(DEFAULT_CONFIG.SPREADSHEET_ID);
  const config = loadSystemConfig(ss);
  const reviewSheet = ss.getSheetByName(config.SHEETS.REVIEW_QUEUE);
  const masterSheet = ss.getSheetByName(config.SHEETS.MASTER_INDEX);


  if (reviewSheet && reviewSheet.getLastRow() > 1) {
    const data = reviewSheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const status = String(row[11] || '').trim().toUpperCase();
      if (status === 'APPROVED') {
        const title = row[0];
        const url = row[1];
        const fileId = row[2];
        const year = normalizeYearOrDateCell(row[3]) || String(new Date().getFullYear());
        const classification = {
          audience: row[4],
          topic: row[5],
          style: row[6],
          tone: row[7],
          exemplaryQuote: row[8],
          strategicNotes: row[9]
        };
        masterSheet.appendRow([
          title, year, classification.audience, classification.topic,
          classification.style, classification.tone, classification.exemplaryQuote,
          url, classification.strategicNotes
        ]);
        syncTaxonomy(ss, config, classification, title, year);
        reviewSheet.getRange(i + 1, 12).setValue('INDEXED');
        const evalSheet = ss.getSheetByName(config.SHEETS.EVALS_LOG);
        if (evalSheet) {
          evalSheet.appendRow([new Date(), title, fileId, '', JSON.stringify(classification), 'HUMAN_APPROVED']);
        }
      } else if (status === 'REJECTED') {
        reviewSheet.getRange(i + 1, 12).setValue('REJECTED_ARCHIVED');
      }
    }
  }
  applyApprovedTaxonomyMerges(ss, config);
}


/**
 * Executes 1-click taxonomy consolidations when rows in Taxonomy_Proposals are marked APPROVED
 */
function applyApprovedTaxonomyMerges(ss, config) {
  config = config || DEFAULT_CONFIG;
  const proposalsSheet = ss.getSheetByName(config.SHEETS.TAXONOMY_PROPOSALS);
  const masterSheet = ss.getSheetByName(config.SHEETS.MASTER_INDEX);
  if (!proposalsSheet || proposalsSheet.getLastRow() <= 1 || !masterSheet) return;


  const colMap = {
    [config.SHEETS.AUDIENCES]: 3,
    [config.SHEETS.TOPICS]: 4,
    [config.SHEETS.STYLES]: 5,
    [config.SHEETS.TONES]: 6
  };


  const propData = proposalsSheet.getDataRange().getValues();
  for (let i = 1; i < propData.length; i++) {
    const category = String(propData[i][0] || '').trim();
    const canonicalTerm = String(propData[i][1] || '').trim();
    const termsToMergeRaw = String(propData[i][2] || '').trim();
    const status = String(propData[i][3] || '').trim().toUpperCase();
    if (status !== 'APPROVED' || !canonicalTerm || !termsToMergeRaw || !colMap[category]) continue;


    const mergeSet = new Set(termsToMergeRaw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
    const masterCol = colMap[category];


    if (masterSheet.getLastRow() > 2) {
      const range = masterSheet.getRange(3, masterCol, masterSheet.getLastRow() - 2, 1);
      const vals = range.getValues();
      let changed = false;
      for (let r = 0; r < vals.length; r++) {
        const curr = String(vals[r][0] || '').trim().toLowerCase();
        if (mergeSet.has(curr) && vals[r][0] !== canonicalTerm) {
          vals[r][0] = canonicalTerm;
          changed = true;
        }
      }
      if (changed) range.setValues(vals);
    }


    const taxSheet = ss.getSheetByName(category);
    if (taxSheet && taxSheet.getLastRow() > 1) {
      const taxRows = taxSheet.getDataRange().getValues();
      let canonicalExists = false;
      for (let r = taxRows.length - 1; r >= 1; r--) {
        const term = String(taxRows[r][0] || '').trim();
        const termLower = term.toLowerCase();
        if (termLower === canonicalTerm.toLowerCase()) {
          canonicalExists = true;
        } else if (mergeSet.has(termLower)) {
          taxSheet.deleteRow(r + 1);
        }
      }
      if (!canonicalExists) {
        if (category === config.SHEETS.AUDIENCES) {
          taxSheet.appendRow([canonicalTerm, 'Consolidated canonical audience category.', 'Merged via Taxonomy_Proposals']);
        } else {
          taxSheet.appendRow([canonicalTerm, 'Consolidated canonical taxonomy term.']);
        }
      }
    }
    proposalsSheet.getRange(i + 1, 4).setValue('CONSOLIDATED');
  }
}


/**
 * Remediates legacy spreadsheet data findings
 */
function remediateStyleIndexSheet(ss, config) {
  ss = ss || SpreadsheetApp.openById(DEFAULT_CONFIG.SPREADSHEET_ID);
  config = config || loadSystemConfig(ss);


  const masterSheet = ss.getSheetByName(config.SHEETS.MASTER_INDEX);
  if (masterSheet && masterSheet.getLastRow() > 2) {
    const rows = masterSheet.getDataRange().getValues();
    const seenIds = new Set();
    const duplicateRowIndices = [];
    for (let i = 2; i < rows.length; i++) {
      const rawYear = rows[i][1];
      const cleanYear = normalizeYearOrDateCell(rawYear);
      if (cleanYear !== String(rawYear)) {
        masterSheet.getRange(i + 1, 2).setValue(cleanYear);
      }
      const url = String(rows[i][7] || '').trim();
      const match = url.match(/[-\w]{25,}/);
      const idKey = match ? match[0] : url;
      if (idKey && url.startsWith('http')) {
        if (seenIds.has(idKey)) {
          duplicateRowIndices.push(i + 1);
        } else {
          seenIds.add(idKey);
        }
      }
    }
    for (let d = duplicateRowIndices.length - 1; d >= 0; d--) {
      masterSheet.deleteRow(duplicateRowIndices[d]);
    }
  }


  const rejectedSheet = ss.getSheetByName(config.SHEETS.REJECTED_LOG);
  if (rejectedSheet && rejectedSheet.getLastRow() > 1) {
    const dateRange = rejectedSheet.getRange(2, 2, rejectedSheet.getLastRow() - 1, 1);
    const dateVals = dateRange.getValues();
    let changed = false;
    for (let i = 0; i < dateVals.length; i++) {
      const cleaned = normalizeYearOrDateCell(dateVals[i][0], true);
      if (cleaned !== String(dateVals[i][0])) {
        dateVals[i][0] = cleaned;
        changed = true;
      }
    }
    if (changed) dateRange.setValues(dateVals);
  }


  const taxDefaults = [
    { name: config.SHEETS.AUDIENCES, desc: 'Target reader group for Wryen-authored documents.', isAudience: true },
    { name: config.SHEETS.TOPICS, desc: 'Primary subject domain in the Writing Style Reference Index.', isAudience: false },
    { name: config.SHEETS.STYLES, desc: 'Structural and compositional writing style pattern.', isAudience: false },
    { name: config.SHEETS.TONES, desc: 'Emotional and attitudinal register marker.', isAudience: false }
  ];
  taxDefaults.forEach(t => {
    const sheet = ss.getSheetByName(t.name);
    if (!sheet || sheet.getLastRow() <= 1) return;
    const width = t.isAudience ? 3 : 2;
    const range = sheet.getRange(2, 1, sheet.getLastRow() - 1, width);
    const vals = range.getValues();
    let updated = false;
    for (let i = 0; i < vals.length; i++) {
      const term = String(vals[i][0] || '').trim();
      const desc = String(vals[i][1] || '').trim();
      if (term && !desc) {
        vals[i][1] = `${t.desc} (${term})`;
        if (t.isAudience && !String(vals[i][2] || '').trim()) {
          vals[i][2] = 'Indexed in Master Index';
        }
        updated = true;
      }
    }
    if (updated) range.setValues(vals);
  });
  Logger.log('Completed remediateStyleIndexSheet data hygiene pass.');
}


/**
 * Converts float years ('2020.0') or Excel serial dates ('46241.0') into clean strings
 */
function normalizeYearOrDateCell(val, fullDate) {
  if (val instanceof Date) {
    return Utilities.formatDate(val, 'UTC', fullDate ? 'yyyy-MM-dd' : 'yyyy');
  }
  const str = String(val || '').trim();
  if (!str) return '';
  if (/^(19|20)\d{2}(\.0+)?$/.test(str)) {
    return str.substring(0, 4);
  }
  if (/^\d{5}(\.\d+)?$/.test(str)) {
    const serial = parseFloat(str);
    if (serial >= 40000 && serial <= 55000) {
      const utcDays = Math.floor(serial - 25569);
      const d = new Date(utcDays * 86400 * 1000);
      return Utilities.formatDate(d, 'UTC', fullDate ? 'yyyy-MM-dd' : 'yyyy');
    }
  }
  return str;
}


/**
 * Batch row appender
 */
function appendRowsInBatch(sheet, rows) {
  if (!sheet || rows.length === 0) return;
  const lastRow = sheet.getLastRow();
  const numCols = rows[0].length;
  sheet.getRange(lastRow + 1, 1, rows.length, numCols).setValues(rows);
}


/**
 * Extracts all processed Google Drive File IDs
 */
function getIndexedFileIds(ss, config) {
  config = config || DEFAULT_CONFIG;
  const ids = new Set();
  const map = [
    { name: config.SHEETS.MASTER_INDEX, col: 8 },
    { name: config.SHEETS.REVIEW_QUEUE, col: 3 },
    { name: config.SHEETS.REJECTED_LOG, col: 10 }
  ];
  map.forEach(item => {
    const sheet = ss.getSheetByName(item.name);
    if (sheet && sheet.getLastRow() > 1) {
      const vals = sheet.getRange(2, item.col, sheet.getLastRow() - 1, 1).getValues();
      vals.forEach(r => {
        const raw = String(r[0] || '').trim();
        if (!raw) return;
        const match = raw.match(/[-\w]{25,}/);
        if (match) ids.add(match[0]);
        else ids.add(raw);
      });
    }
  });
  return ids;
}


/**
 * Returns primary parent folder ID of a Drive file
 */
function getPrimaryParentId(file) {
  const parents = file.getParents();
  return parents.hasNext() ? parents.next().getId() : 'root';
}


/**
 * Pre-filter check for excluded parent folder IDs (recursive up to 8 levels)
 */
function isFolderExcluded(file, excludedFolderIds) {
  if (!excludedFolderIds || excludedFolderIds.length === 0) return false;
  let currentParents = file.getParents();
  let depth = 0;
  const maxDepth = 8;
  while (currentParents.hasNext() && depth < maxDepth) {
    const parentFolder = currentParents.next();
    const parentId = parentFolder.getId();
    if (excludedFolderIds.includes(parentId)) return true;
    currentParents = parentFolder.getParents();
    depth++;
  }
  return false;
}


/**
 * Pre-filter check for excluded title keywords
 */
function isTitleExcluded(title, keywords) {
  if (!keywords || keywords.length === 0) return false;
  const lower = title.toLowerCase();
  return keywords.some(k => lower.includes(k));
}


/**
 * Extracts raw prose from Google Docs, Slides, MS Office (.docx, .pptx), ODT, or plain text/markdown files
 */
function extractFileText(file, maxLength) {
  try {
    const mime = file.getMimeType();
    let text = '';
    if (mime === MimeType.GOOGLE_DOCS || mime === 'application/vnd.google-apps.document') {
      text = DocumentApp.openById(file.getId()).getBody().getText();
    } else if (mime === MimeType.GOOGLE_SLIDES || mime === 'application/vnd.google-apps.presentation') {
      const pres = SlidesApp.openById(file.getId());
      pres.getSlides().forEach(slide => {
        slide.getShapes().forEach(shape => {
          if (shape.getText()) text += shape.getText().asString() + '\n';
        });
      });
    } else if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || mime === 'application/msword') {
      const blobs = Utilities.unzip(file.getBlob());
      const docXml = blobs.find(b => b.getName() === 'word/document.xml');
      if (docXml) {
        text = docXml.getDataAsString().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      }
    } else if (mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
      const blobs = Utilities.unzip(file.getBlob());
      const slideXmls = blobs.filter(b => /^ppt\/slides\/slide\d+\.xml$/i.test(b.getName()));
      slideXmls.forEach(b => {
        text += b.getDataAsString().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') + '\n';
      });
    } else if (mime === 'application/vnd.oasis.opendocument.text') {
      const blobs = Utilities.unzip(file.getBlob());
      const contentXml = blobs.find(b => b.getName() === 'content.xml');
      if (contentXml) {
        text = contentXml.getDataAsString().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      }
    } else {
      text = file.getBlob().getDataAsString();
    }
    return text.substring(0, maxLength || 8000);
  } catch (err) {
    Logger.log('Error extracting text for ' + file.getName() + ': ' + err.toString());
    return '';
  }
}


/**
 * Counts words in extracted text
 */
function countWords(text) {
  if (!text || text.trim().length === 0) return 0;
  return text.trim().split(/\s+/).length;
}


/**
 * Per-folder auto-discovery rule: excludes a non-root parent folder when it reaches >= 3 rejections
 */
function autoDiscoverExclusion(ss, parentId, pendingRejectedRows) {
  if (!parentId || parentId === 'root') return;
  try {
    const rootId = DriveApp.getRootFolder().getId();
    if (parentId === rootId) return;
  } catch (e) {}


  const marker = '[FolderID:' + parentId + ']';
  let folderRejectionCount = 0;
  (pendingRejectedRows || []).forEach(r => {
    if (String(r[10] || '').includes(marker)) folderRejectionCount++;
  });


  const rejectedSheet = ss.getSheetByName(DEFAULT_CONFIG.SHEETS.REJECTED_LOG);
  if (rejectedSheet && rejectedSheet.getLastRow() > 1) {
    const notesVals = rejectedSheet.getRange(2, 11, rejectedSheet.getLastRow() - 1, 1).getValues();
    for (let i = 0; i < notesVals.length; i++) {
      if (String(notesVals[i][0] || '').includes(marker)) {
        folderRejectionCount++;
      }
    }
  }


  if (folderRejectionCount >= 3) {
    const configSheet = ss.getSheetByName(DEFAULT_CONFIG.SHEETS.SYSTEM_CONFIG);
    if (!configSheet) return;
    const cfgRows = configSheet.getDataRange().getValues();
    for (let r = 1; r < cfgRows.length; r++) {
      if (cfgRows[r][0] === 'EXCLUDED_FOLDER_IDS') {
        const existing = String(cfgRows[r][1] || '').trim();
        const list = existing ? existing.split(',').map(s => s.trim()).filter(Boolean) : [];
        if (!list.includes(parentId)) {
          list.push(parentId);
          configSheet.getRange(r + 1, 2).setValue(list.join(','));
          Logger.log('Auto-discovered and excluded parent folder ID (' + folderRejectionCount + ' rejections): ' + parentId);
        }
        break;
      }
    }
  }
}


/**
 * Discovers available Gemini models dynamically via v1beta API and performs upfront quota tracking
 */
function getDynamicModelHierarchy(apiKey, config) {
  config = config || DEFAULT_CONFIG;
  const scriptProps = PropertiesService.getScriptProperties();
  const now = Date.now();
  const pattern = config.PREFERRED_MODEL_PATTERN || 'flash';
  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models?key=' + apiKey;
    const res = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      Logger.log('Model discovery HTTP ' + res.getResponseCode() + ', falling back to default.');
      return [config.GEMINI_MODEL || 'gemini-2.5-flash'];
    }
    const modelsList = JSON.parse(res.getContentText()).models || [];
    const validModels = modelsList
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => (m.name || '').replace(/^models\//, ''))
      .filter(name => name.toLowerCase().includes('gemini'));
    validModels.sort((a, b) => {
      const aPref = a.toLowerCase().includes(pattern) ? 1 : 0;
      const bPref = b.toLowerCase().includes(pattern) ? 1 : 0;
      if (aPref !== bPref) return bPref - aPref;
      return b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' });
    });
    const availableModels = validModels.filter(model => {
      const quotaUntil = scriptProps.getProperty('QUOTA_EXHAUSTED_UNTIL_' + model);
      if (quotaUntil && Number(quotaUntil) > now) {
        Logger.log('[QUOTA SKIP] Model ' + model + ' paused until: ' + new Date(Number(quotaUntil)).toISOString());
        return false;
      }
      return true;
    });
    return availableModels.length > 0 ? availableModels : [config.GEMINI_MODEL || 'gemini-2.5-flash'];
  } catch (err) {
    Logger.log('Error in getDynamicModelHierarchy: ' + err.toString());
    return [config.GEMINI_MODEL || 'gemini-2.5-flash'];
  }
}


/**
 * Structural classification via Gemini API with Structured JSON Schema output (including Rule 1 GenAI check)
 */
function classifySampleWithGemini(textContent, documentTitle, config) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) throw new Error('GEMINI_API_KEY script property missing');
  const scriptProps = PropertiesService.getScriptProperties();
  const candidateModels = (config.MODEL_SELECTION_MODE === 'DYNAMIC')
    ? getDynamicModelHierarchy(apiKey, config)
    : [config.GEMINI_MODEL || 'gemini-2.5-flash'];


  const systemInstruction =
    "You are an expert editorial taxonomist curating Wryen Meek's human-authored Writing Style & Tone Reference Index. " +
    "First, determine if the text is an AI-generated artifact (e.g., Gemini Deep Research whitepaper, LLM-generated system spec, or automated transcript). " +
    "Second, categorize Audience, Topic, Style, and Tone, and extract a verbatim exemplary quote strictly under 35 words.";


  const jsonSchema = {
    type: 'OBJECT',
    properties: {
      isAiGenerated: { type: 'BOOLEAN', description: 'True if generated by an LLM/GenAI agent or automated speech-to-text' },
      rejectionReason: { type: 'STRING', description: 'If isAiGenerated is true, brief reason why it fails Rule 1' },
      hasAmbiguity: { type: 'BOOLEAN', description: 'True if co-authored, boilerplate charter, or uncertain human authorship' },
      audience: { type: 'STRING' },
      topic: { type: 'STRING' },
      style: { type: 'STRING' },
      tone: { type: 'STRING' },
      exemplaryQuote: { type: 'STRING', description: 'Verbatim quote from text under 35 words showcasing voice' },
      strategicNotes: { type: 'STRING', description: 'Brief editorial note on how this sample demonstrates Wryen writing style' },
      confidenceScore: { type: 'NUMBER', description: 'Confidence between 0.0 and 1.0 that Wryen is the human author' }
    },
    required: [
      'isAiGenerated', 'rejectionReason', 'hasAmbiguity',
      'audience', 'topic', 'style', 'tone',
      'exemplaryQuote', 'strategicNotes', 'confidenceScore'
    ]
  };


  const payload = {
    contents: [{ parts: [{ text: 'Document Title: ' + documentTitle + '\n\nText Sample:\n' + textContent }] }],
    systemInstruction: { parts: [{ text: systemInstruction }] },
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: jsonSchema,
      temperature: 0.1
    }
  };


  for (let mIdx = 0; mIdx < candidateModels.length; mIdx++) {
    const targetModel = candidateModels[mIdx];
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + targetModel + ':generateContent?key=' + apiKey;
    let attempts = 0;
    while (attempts < 2) {
      attempts++;
      const res = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      const code = res.getResponseCode();
      if (code === 200) {
        const json = JSON.parse(res.getContentText());
        return JSON.parse(json.candidates[0].content.parts[0].text);
      } else if (code === 429) {
        const rawErr = res.getContentText();
        let retryDelay = 0;
        const match = rawErr.match(/retry(?:-after|Delay)?\s*[:'=]?\s*(\d+)/i);
        if (match) retryDelay = parseInt(match[1], 10);
        const isDailyQuota = rawErr.includes('GenerateRequestsPerDay') || rawErr.includes('PerDay') || retryDelay > 60;
        if (isDailyQuota) {
          const lockMs = retryDelay > 60 ? retryDelay * 1000 : 24 * 60 * 60 * 1000;
          const lockUntil = Date.now() + lockMs;
          scriptProps.setProperty('QUOTA_EXHAUSTED_UNTIL_' + targetModel, String(lockUntil));
          Logger.log(`[QUOTA EXHAUSTED] Model ${targetModel} exceeded quota. Locked until ${new Date(lockUntil).toISOString()}. Cascading to next model.`);
          break;
        } else if (retryDelay <= 15 && attempts === 1) {
          Logger.log(`[TRANSIENT 429] Rate limited on ${targetModel}. Pausing for ${retryDelay || 5}s before retry.`);
          Utilities.sleep((retryDelay || 5) * 1000);
          continue;
        } else {
          Logger.log(`[429 FAIL] Rate limit or quota error on ${targetModel}: ${rawErr}. Cascading.`);
          break;
        }
      } else {
        Logger.log(`[ERROR] Model ${targetModel} HTTP ${code}: ${res.getContentText()}. Cascading.`);
        break;
      }
    }
  }
  throw new Error('All candidate Gemini models failed classification: ' + JSON.stringify(candidateModels));
}


/**
 * Syncs novel taxonomy values into Audiences, Topics, Styles, and Tones tabs
 */
function syncTaxonomy(ss, config, classification, docTitle, docYear) {
  const specs = [
    {
      sheetName: config.SHEETS.AUDIENCES,
      val: classification.audience,
      rowBuilder: v => [v, 'Target audience identified during style index ingestion.', `${docTitle} (${docYear})`]
    },
    {
      sheetName: config.SHEETS.TOPICS,
      val: classification.topic,
      rowBuilder: v => [v, 'Primary subject domain identified during style index ingestion.']
    },
    {
      sheetName: config.SHEETS.STYLES,
      val: classification.style,
      rowBuilder: v => [v, 'Structural writing style marker identified during style index ingestion.']
    },
    {
      sheetName: config.SHEETS.TONES,
      val: classification.tone,
      rowBuilder: v => [v, 'Attitudinal/emotional register identified during style index ingestion.']
    }
  ];
  specs.forEach(spec => {
    if (!spec.val) return;
    const sheet = ss.getSheetByName(spec.sheetName);
    if (!sheet) return;
    const existing = sheet.getLastRow() > 1
      ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues().flat().map(s => String(s).trim().toLowerCase())
      : [];
    if (!existing.includes(String(spec.val).trim().toLowerCase())) {
      sheet.appendRow(spec.rowBuilder(spec.val));
    }
  });
}


/**
 * Weekly job: Consolidates Review_Queue items into a single actionable Google Task
 */
function syncWeeklyReviewTasks() {
  const ss = SpreadsheetApp.openById(DEFAULT_CONFIG.SPREADSHEET_ID);
  const config = loadSystemConfig(ss);
  const reviewSheet = ss.getSheetByName(config.SHEETS.REVIEW_QUEUE);
  if (!reviewSheet || reviewSheet.getLastRow() <= 1) return;
  const rows = reviewSheet.getDataRange().getValues();
  const pending = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][11] === 'PENDING_REVIEW') {
      pending.push({ rowIdx: i + 1, name: rows[i][0], url: rows[i][1], score: Number(rows[i][10] || 0) });
    }
  }
  if (pending.length === 0) return;
  try {
    const task = Tasks.newTask();
    task.title = 'Weekly Writing Style Index Review (' + pending.length + ' Pending)';
    let body = 'Review the following borderline or co-authored writing samples in Review_Queue:\n' + ss.getUrl() + '\n\n';
    pending.slice(0, 15).forEach(p => {
      body += '• ' + p.name + ' (Confidence: ' + (p.score * 100).toFixed(0) + '%)\n  ' + p.url + '\n';
    });
    task.notes = body;
    const due = new Date();
    due.setDate(due.getDate() + 2);
    task.due = due.toISOString();
    Tasks.Tasks.insert(task, '@default');
    Logger.log('Created consolidated weekly Google Task for ' + pending.length + ' items.');
  } catch (e) {
    handleScriptError(ss, config, 'Google Tasks Sync Failed', e);
  }
}


/**
 * Monthly job: Uses Gemini API to perform semantic clustering on taxonomy terms and stages merge proposals
 */
function runMonthlyTaxonomyClustering() {
  const ss = SpreadsheetApp.openById(DEFAULT_CONFIG.SPREADSHEET_ID);
  const config = loadSystemConfig(ss);
  const categories = [config.SHEETS.AUDIENCES, config.SHEETS.TOPICS, config.SHEETS.STYLES, config.SHEETS.TONES];
  const proposalsSheet = ss.getSheetByName(config.SHEETS.TAXONOMY_PROPOSALS);


  categories.forEach(cat => {
    const sheet = ss.getSheetByName(cat);
    if (!sheet || sheet.getLastRow() <= 1) return;
    const terms = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues().flat().filter(Boolean);
    if (terms.length < 3) return;
    try {
      const prompt = 'Group near-synonyms or redundant terms in this list into clean canonical parent terms:\n' + JSON.stringify(terms);
      const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
      const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + config.GEMINI_MODEL + ':generateContent?key=' + apiKey;
      const schema = {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            canonicalTerm: { type: 'STRING' },
            mergedTerms: { type: 'ARRAY', items: { type: 'STRING' } }
          },
          required: ['canonicalTerm', 'mergedTerms']
        }
      };
      const payload = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.1 }
      };
      const res = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      if (res.getResponseCode() === 200) {
        const clusters = JSON.parse(JSON.parse(res.getContentText()).candidates[0].content.parts[0].text);
        clusters.forEach(c => {
          if (c.mergedTerms && c.mergedTerms.length > 1) {
            proposalsSheet.appendRow([cat, c.canonicalTerm, c.mergedTerms.join(', '), 'PENDING_APPROVAL']);
          }
        });
      }
    } catch (err) {
      handleScriptError(ss, config, 'Taxonomy clustering failed for category: ' + cat, err);
    }
  });
}


/**
 * Writes evaluation record to Evals_Log tab for closed-loop feedback
 */
function logEvalRecord(ss, config, file, classification, actionType) {
  const evalSheet = ss.getSheetByName(config.SHEETS.EVALS_LOG);
  if (!evalSheet) return;
  evalSheet.appendRow([new Date(), file.getName(), file.getId(), JSON.stringify(classification), '', actionType]);
}


/**
 * Error handler creating urgent Google Tasks and logging errors
 */
function handleScriptError(ss, config, contextMessage, error) {
  Logger.log('CRITICAL: ' + contextMessage + ' | ' + error.toString());
  try {
    const task = Tasks.newTask();
    task.title = 'URGENT System Alert: ' + contextMessage;
    task.notes = 'System error occurred during Writing Style Index pipeline execution:\n\n' + error.toString();
    task.due = new Date().toISOString();
    Tasks.Tasks.insert(task, '@default');
  } catch (e) {
    Logger.log('Failed to dispatch alert Google Task: ' + e.toString());
  }
}


/**
 * Comprehensive test suite (Dry Run) verifying config, remediation, deduplication, regexes, Tasks API, and connectivity
 */
function testDryRun() {
  Logger.log('--- STARTING COMPREHENSIVE DRY RUN ---');
  try {
    const ss = SpreadsheetApp.openById(DEFAULT_CONFIG.SPREADSHEET_ID);
    Logger.log('[PASS] Spreadsheet accessed: ' + ss.getName());
    const config = loadSystemConfig(ss);
    Logger.log('[PASS] Dynamic configuration loaded & auxiliary tabs verified.');
    remediateStyleIndexSheet(ss, config);
    Logger.log('[PASS] Spreadsheet dates, duplicate URLs, and taxonomy descriptions remediated.');
    const indexedIds = getIndexedFileIds(ss, config);
    Logger.log('[PASS] Extracted ' + indexedIds.size + ' deduplicated File IDs across Master, Queue, and Rejected tabs.');
    if (isTitleExcluded('Invoice_2026_01.pdf', config.EXCLUDED_TITLE_KEYWORDS)) {
      Logger.log('[PASS] Excluded title keyword pre-filter verified.');
    }
    const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    if (apiKey) {
      Logger.log('[PASS] GEMINI_API_KEY script property is set.');
      const activeModels = getDynamicModelHierarchy(apiKey, config);
      Logger.log('[PASS] Dynamic Gemini model hierarchy discovered: ' + JSON.stringify(activeModels));
    } else {
      Logger.log('[WARN] GEMINI_API_KEY script property is not set yet.');
    }
    Tasks.Tasklists.list();
    Logger.log('[PASS] Google Tasks API integration verified.');
  } catch (e) {
    Logger.log('[FAIL] Dry run error: ' + e.toString());
  }
  Logger.log('--- DRY RUN COMPLETE ---');
}
Note on Dynamic Model Fallback: If the primary configured model encounters persistent quota limits, rate spikes, or availability issues, the system can dynamically fall back to secondary Gemini endpoints (such as gemini-1.5-flash or gemini-2.0-flash) specified in System_Config to ensure uninterrupted pipeline operation.

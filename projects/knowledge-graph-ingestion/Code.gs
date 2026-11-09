/**
 * ==============================================================================
 * Production Semantic Knowledge Graph Ingestion Pipeline
 * ==============================================================================
 * Autonomous Google Apps Script pipeline monitoring Drive for documents and PDFs,
 * performing zero-token pre-flight filtering, extracting entities/relations via
 * Gemini 2.5 Flash with structured responseSchema, and persisting idempotent
 * OpenCypher seed files (using MERGE semantics) directly into version control.
 *
 * Implements:
 *   1. Zero-Token Pre-Flight Screening (Direct-to-Storage schema_v metadata in Drive).
 *   2. Idempotent OpenCypher statements (MERGE instead of CREATE) to prevent ArcadeDB
 *      unique index collisions.
 *   3. Multimodal PDF & Document extraction handling.
 *   4. PropertiesService secret isolation (No hardcoded credentials).
 *
 * Governing Standard: gemini-spark/Automation_Architecture_Learnings_and_Best_Practices.md
 */

// Default configuration constants (overridable via Script Properties)
const KG_DEFAULTS = {
  MODEL_NAME: "gemini-2.5-flash",
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
  DEFAULT_SOURCE_FOLDER_ID: "1AYeQE47BeJdxwAAa3x5_Z2_hTmyq9NVz", // MCDM Archive
  DEFAULT_SEEDS_FOLDER_ID: "1v9uyJ_rnGGUsuytisYKH6YcM1nF60dkT",   // assets/seeds in MCDM_Archive_Knowledge_Graph
  BATCH_SIZE: 5,                                                   // Maximum files processed per trigger run
  MAX_RUNTIME_MS: 4 * 60 * 1000,                                   // 4-minute runtime safety budget (avoids 6-min hard timeout)
  MAX_PDF_BYTES: 15 * 1024 * 1024                                  // 15 MB maximum inline PDF payload limit
};

/**
 * Retrieves configuration values securely from ScriptProperties with safe defaults.
 */
function getKGConfig() {
  const props = PropertiesService.getScriptProperties();
  const customLadder = props.getProperty("GEMINI_MODEL_LADDER");
  const ladderList = customLadder
    ? customLadder.split(",").map(m => m.trim()).filter(Boolean)
    : KG_DEFAULTS.MODEL_LADDER;

  return {
    apiKey: props.getProperty("GEMINI_API_KEY") || "",
    sourceFolderId: props.getProperty("SOURCE_FOLDER_ID") || KG_DEFAULTS.DEFAULT_SOURCE_FOLDER_ID,
    seedsFolderId: props.getProperty("SEEDS_FOLDER_ID") || KG_DEFAULTS.DEFAULT_SEEDS_FOLDER_ID,
    modelName: props.getProperty("GEMINI_MODEL") || KG_DEFAULTS.MODEL_NAME,
    modelLadder: ladderList
  };
}

/**
 * Real-time Model Discovery Diagnostic:
 * Queries the Gemini API models.list endpoint, logs all available models to the console,
 * and saves the catalog to Drive.
 */
function discoverModelsAndSaveToSeeds(config) {
  config = config || getKGConfig();
  if (!config.apiKey) {
    Logger.log("[ERROR] GEMINI_API_KEY is not configured in Script Properties.");
    return null;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${config.apiKey}&pageSize=100`;
  Logger.log(`[DISCOVERY] Querying Gemini models endpoint: ${url.replace(config.apiKey, "HIDDEN_KEY")}`);

  let response;
  try {
    response = UrlFetchApp.fetch(url, { method: "get", muteHttpExceptions: true });
  } catch (netErr) {
    Logger.log(`[ERROR] Network error querying models: ${netErr.toString()}`);
    return null;
  }

  const code = response.getResponseCode();
  const rawText = response.getContentText();
  Logger.log(`[DISCOVERY] Endpoint response code: HTTP ${code}`);

  if (code !== 200) {
    Logger.log(`[ERROR] Gemini API returned HTTP ${code}: ${rawText}`);
    return rawText;
  }

  try {
    const json = JSON.parse(rawText);
    const models = json.models || [];
    Logger.log(`=== [DISCOVERED MODELS: ${models.length} TOTAL] ===`);

    const generateModels = models
      .filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes("generateContent"))
      .map(m => m.name.replace(/^models\//, ""));

    Logger.log(`Models supporting generateContent (${generateModels.length}):\n${generateModels.join("\n")}`);

    const seedsFolder = DriveApp.getFolderById(config.seedsFolderId);
    const fileName = "00_discovered_gemini_models.json";
    const existing = seedsFolder.getFilesByName(fileName);
    if (existing.hasNext()) {
      existing.next().setContent(rawText);
    } else {
      seedsFolder.createFile(fileName, rawText);
    }
    Logger.log(`[SUCCESS] Saved full JSON catalog to assets/seeds/${fileName}`);
  } catch (err) {
    Logger.log(`[WARN] Error parsing or saving models: ${err.toString()}`);
  }

  return rawText;
}

/**
 * Web App Endpoint: Exposes live model discovery output directly over HTTP.
 */
function doGet(e) {
  const config = getKGConfig();
  if (!config.apiKey) {
    return ContentService.createTextOutput(JSON.stringify({ error: "Missing GEMINI_API_KEY" }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  const rawText = discoverModelsAndSaveToSeeds(config);
  return ContentService.createTextOutput(rawText)
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Main Trigger Function: Run on a 10-minute time-driven trigger or manual invocation.
 */
function runIngestionPipeline() {
  Logger.log(">>> [Knowledge Graph] Starting Autonomous Ingestion Run...");
  const config = getKGConfig();

  if (!config.apiKey) {
    Logger.log("[ERROR] GEMINI_API_KEY is not configured in Script Properties. Exiting.");
    return { status: "ERROR", message: "Missing GEMINI_API_KEY" };
  }

  // Live model discovery audit & catalog persist
  try {
    discoverModelsAndSaveToSeeds(config);
  } catch (_e) {}

  if (!config.sourceFolderId) {
    Logger.log("[WARN] SOURCE_FOLDER_ID not set. Please set SOURCE_FOLDER_ID in Script Properties.");
    return { status: "WARN", message: "Missing SOURCE_FOLDER_ID" };
  }

  let sourceFolder;
  let seedsFolder;
  try {
    sourceFolder = DriveApp.getFolderById(config.sourceFolderId);
    seedsFolder = DriveApp.getFolderById(config.seedsFolderId);
  } catch (e) {
    Logger.log(`[ERROR] Unable to access source or seeds folder: ${e.toString()}`);
    return { status: "ERROR", message: e.toString() };
  }

  const startTime = Date.now();
  let processedCount = 0;
  let skippedCount = 0;
  const folderQueue = [sourceFolder];
  const visitedFolderIds = new Set();

  while (folderQueue.length > 0 && processedCount < KG_DEFAULTS.BATCH_SIZE) {
    // Time-budget safety guard: exit cleanly before hitting Apps Script 6-minute hard timeout
    if (Date.now() - startTime > KG_DEFAULTS.MAX_RUNTIME_MS) {
      Logger.log(`[TIME BUDGET] Reached 4-minute execution threshold. Exiting cleanly to avoid timeout. Processed: ${processedCount}, Skipped: ${skippedCount}. Remaining files will be processed in the next scheduled execution.`);
      break;
    }

    const currentFolder = folderQueue.shift();
    const folderId = currentFolder.getId();
    if (visitedFolderIds.has(folderId)) {
      continue;
    }
    visitedFolderIds.add(folderId);

    const folderName = currentFolder.getName ? currentFolder.getName() : folderId;
    Logger.log(`[CRAWL] Scanning folder: "${folderName}" (${folderId})`);

    // 1. Process files in currentFolder
    const files = currentFolder.getFiles();
    while (files.hasNext() && processedCount < KG_DEFAULTS.BATCH_SIZE) {
      if (Date.now() - startTime > KG_DEFAULTS.MAX_RUNTIME_MS) {
        Logger.log(`[TIME BUDGET] Reached 4-minute execution threshold while processing files. Exiting cleanly.`);
        break;
      }

      try {
        const file = files.next();
        const fileId = file.getId();
        const fileName = file.getName();
        const mimeType = file.getMimeType();

        // 1. Zero-Token Pre-Flight Screening (Filter already ingested or oversized files)
        if (isAlreadyIngested(file)) {
          Logger.log(`[SKIP] Already processed (schema_v marker present): ${fileName} (${fileId})`);
          skippedCount++;
          continue;
        }

        // 2. Validate supported mime types
        const isDoc = (mimeType === MimeType.GOOGLE_DOCS || mimeType === "application/vnd.google-apps.document");
        const isText = (mimeType === MimeType.PLAIN_TEXT || fileName.endsWith(".md") || fileName.endsWith(".txt"));
        const isPdf = (mimeType === "application/pdf" || fileName.endsWith(".pdf"));

        if (!isDoc && !isText && !isPdf) {
          Logger.log(`[SKIP] Unsupported file type '${mimeType}': ${fileName}`);
          continue;
        }

        Logger.log(`[PROCESS] Ingesting file: ${fileName} (${mimeType}) in "${folderName}"`);

        // 3. Extract content or prepare multimodal payload
        const payload = buildGeminiPayload(file, mimeType, isDoc, isText, isPdf);
        if (!payload) {
          Logger.log(`[WARN] File content empty, oversized, or unextractable for ${fileName}`);
          continue;
        }

        // 4. Call Gemini API with structured schema and dynamic model discovery / quota failover
        const graphData = callGeminiAPI(payload, config.apiKey, config.modelLadder);
        if (!graphData || (!graphData.entities && !graphData.relationships)) {
          Logger.log(`[WARN] No entities extracted from ${fileName}`);
          continue;
        }

        // 5. Generate idempotent OpenCypher statements with MERGE
        const cypherContent = generateCypherSeed(fileName, graphData);
        if (!cypherContent) {
          Logger.log(`[WARN] No valid Cypher statements generated for ${fileName}`);
          continue;
        }

        // 6. Save seed file in seeds/ folder in Drive
        const timestamp = Utilities.formatDate(new Date(), "UTC", "yyyyMMdd_HHmmss");
        const seedFileName = `03_ingested_${timestamp}.cypher`;
        seedsFolder.createFile(seedFileName, cypherContent, MimeType.PLAIN_TEXT);
        Logger.log(`[SUCCESS] Created OpenCypher seed file: ${seedFileName}`);

        // 7. Mark file as ingested in Drive description (Schema v1 JSONL)
        const entityCount = (graphData.entities || []).length;
        const relCount = (graphData.relationships || []).length;
        markFileAsIngested(file, entityCount, relCount, seedFileName, graphData._modelUsed);
        processedCount++;
      } catch (fileErr) {
        Logger.log(`[ERROR] Recoverable error processing file: ${fileErr.toString()}`);
      }
    }

    // 2. Discover and enqueue child subfolders
    if (processedCount < KG_DEFAULTS.BATCH_SIZE && (Date.now() - startTime < KG_DEFAULTS.MAX_RUNTIME_MS)) {
      try {
        if (currentFolder.getFolders) {
          const subFolders = currentFolder.getFolders();
          while (subFolders.hasNext()) {
            folderQueue.push(subFolders.next());
          }
        }
      } catch (subErr) {
        Logger.log(`[WARN] Could not retrieve subfolders for "${folderName}": ${subErr.toString()}`);
      }
    }
  }

  Logger.log(`>>> [Knowledge Graph] Ingestion run completed. Processed: ${processedCount}, Skipped: ${skippedCount}`);
  return { status: "SUCCESS", processed: processedCount, skipped: skippedCount };
}

/**
 * Checks whether a file has already been ingested by inspecting its Drive description.
 * Implements the Zero-Token metadata screening pattern.
 * Delegates to SparkCore.DriveMetadata.parseMetadata.
 */
function isAlreadyIngested(file) {
  try {
    const desc = typeof file.getDescription === "function" ? (file.getDescription() || "") : (file.description || "");
    if (!desc) return false;
    if (typeof SparkCore !== "undefined" && SparkCore.parseMetadata) {
      const parsed = SparkCore.parseMetadata(desc);
      return Boolean(parsed && (parsed.kg_ingested === true || parsed.status === "EXCEEDS_INLINE_PDF_LIMIT"));
    }
    if (desc.includes('"schema_v"')) {
      const parsed = JSON.parse(desc);
      return parsed.kg_ingested === true || parsed.status === "EXCEEDS_INLINE_PDF_LIMIT";
    }
  } catch (_e) {
    // If not JSON, treat as not ingested
  }
  return false;
}

/**
 * Updates the Drive file's description with a canonical schema_v JSONL payload.
 * Delegates to SparkCore.DriveMetadata.updateFileMetadata.
 */
function markFileAsIngested(file, entityCount, relCount, seedFileName, modelUsed) {
  const metadata = {
    schema_v: 1,
    kg_ingested: true,
    entities_count: entityCount,
    relationships_count: relCount,
    seed_file: seedFileName,
    model_used: modelUsed || "gemini-auto",
    updated_at: new Date().toISOString()
  };
  if (typeof SparkCore !== "undefined" && SparkCore.updateFileMetadata) {
    SparkCore.updateFileMetadata(file, metadata);
  } else {
    file.setDescription(JSON.stringify(metadata));
  }
}

/**
 * Sanitizes an entity name into a clean variable identifier for Cypher.
 */
function sanitizeCypherVar(name) {
  if (!name) return "entity";
  const cleaned = name.replace(/[^a-zA-Z0-9_]/g, "").toLowerCase();
  return cleaned || "entity";
}

/**
 * Sanitizes a string for inclusion in Cypher single-quoted literals.
 */
function sanitizeCypherString(text) {
  if (!text) return "";
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

/**
 * Generates version-controlled OpenCypher DML using idempotent MERGE semantics.
 * Resolves the unique index crash where CREATE causes duplicate key collisions in ArcadeDB.
 */
function generateCypherSeed(fileName, graphData) {
  const modelInfo = (graphData && graphData._modelUsed) ? graphData._modelUsed : "Gemini Multimodal Fleet";
  const lines = [
    `// ==============================================================================`,
    `// Auto-generated OpenCypher Migration Script: ${fileName}`,
    `// Engine: Gemini Spark Semantic Ingestion Pipeline`,
    `// Model: ${modelInfo}`,
    `// Generation Timestamp: ${new Date().toISOString()}`,
    `// ==============================================================================`
  ];

  const entities = graphData.entities || [];
  const relationships = graphData.relationships || [];

  if (entities.length === 0 && relationships.length === 0) {
    return "";
  }

  const entityTypeMap = {};

  // 1. Generate Idempotent Entity MERGE statements
  lines.push("\n// 1. Vertices (MERGE prevents UNIQUE constraint collision on name)");
  entities.forEach((entity) => {
    const rawName = (entity.name || "").trim();
    if (!rawName) return;

    let eType = (entity.type || "Entity").trim();
    // Normalize type to PascalCase
    eType = eType.charAt(0).toUpperCase() + eType.slice(1).replace(/[^a-zA-Z0-9_]/g, "");
    if (!eType) eType = "Entity";

    const varName = sanitizeCypherVar(rawName);
    const sanitizedName = sanitizeCypherString(rawName);
    entityTypeMap[rawName.toLowerCase()] = eType;

    const propItems = [`name: '${sanitizedName}'`];
    if (entity.description) {
      propItems.push(`description: '${sanitizeCypherString(entity.description)}'`);
    }

    lines.push(`MERGE (${varName}:${eType} {${propItems.join(", ")}})`);
  });

  // 2. Generate Relationship MATCH ... MERGE statements
  if (relationships.length > 0) {
    lines.push("\n// 2. Relationships (Idempotent Edge MERGE)");
    relationships.forEach((rel) => {
      const sourceName = (rel.source || "").trim();
      const targetName = (rel.target || "").trim();
      let relType = (rel.type || "RELATED_TO").toUpperCase().replace(/[^A-Z0-9_]/g, "_");

      if (!sourceName || !targetName) return;

      const srcType = entityTypeMap[sourceName.toLowerCase()] || "";
      const tgtType = entityTypeMap[targetName.toLowerCase()] || "";

      const srcMatch = srcType ? `(src:${srcType} {name: '${sanitizeCypherString(sourceName)}'})` : `(src {name: '${sanitizeCypherString(sourceName)}'})`;
      const tgtMatch = tgtType ? `(tgt:${tgtType} {name: '${sanitizeCypherString(targetName)}'})` : `(tgt {name: '${sanitizeCypherString(targetName)}'})`;

      lines.push(
        `MATCH ${srcMatch}, ${tgtMatch}\n` +
        `MERGE (src)-[:${relType}]->(tgt);`
      );
    });
  }

  return lines.join("\n");
}

/**
 * Constructs the Gemini API JSON payload, handling Docs, Text, and multimodal PDFs.
 */
function buildGeminiPayload(file, mimeType, isDoc, isText, isPdf) {
  let textContent = "";

  if (isDoc) {
    const doc = DocumentApp.openById(file.getId());
    textContent = doc.getBody().getText();
  } else if (isText) {
    textContent = file.getBlob().getDataAsString();
  }

  const systemInstruction =
    "You are an expert Knowledge Graph Ontologist for fantasy RPG campaign archives, technical documentation, and lore. " +
    "Extract all named entities (Character, Location, Faction, Session, Item, Event) and relationships " +
    "(LOCATED_IN, ALLIED_WITH, HOSTILE_TO, FEATURED_IN, MEMBER_OF, PARTICIPATED_IN). " +
    "Return strict JSON matching the schema.";

  const schema = {
    type: "OBJECT",
    properties: {
      entities: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            name: { type: "STRING" },
            type: { type: "STRING" },
            description: { type: "STRING" }
          },
          required: ["name", "type"]
        }
      },
      relationships: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            source: { type: "STRING" },
            target: { type: "STRING" },
            type: { type: "STRING" }
          },
          required: ["source", "target", "type"]
        }
      }
    },
    required: ["entities", "relationships"]
  };

  const parts = [];

  if (isPdf) {
    const fileSize = file.getSize ? file.getSize() : 0;
    if (fileSize > KG_DEFAULTS.MAX_PDF_BYTES) {
      Logger.log(`[SKIP_OVERSIZED_PDF] File "${file.getName()}" (${(fileSize / (1024 * 1024)).toFixed(1)} MB) exceeds maximum inline PDF limit of ${(KG_DEFAULTS.MAX_PDF_BYTES / (1024 * 1024))} MB. Skipping inline LLM extraction to prevent out-of-memory crashes.`);
      const metadata = {
        schema_v: 1,
        kg_ingested: false,
        status: "EXCEEDS_INLINE_PDF_LIMIT",
        file_size_mb: Number((fileSize / (1024 * 1024)).toFixed(1)),
        note: "Process locally via Gemini Spark Python compute",
        updated_at: new Date().toISOString()
      };
      if (file.setDescription) {
        file.setDescription(JSON.stringify(metadata));
      }
      return null;
    }

    // Binary PDF: Base64 encode and stream via multimodal inlineData
    const blob = file.getBlob();
    const base64Bytes = Utilities.base64Encode(blob.getBytes());
    parts.push({
      inlineData: {
        mimeType: "application/pdf",
        data: base64Bytes
      }
    });
    parts.push({
      text: "Analyze this PDF document and extract the complete semantic knowledge graph of entities and relationships."
    });
  } else {
    if (!textContent || textContent.trim().length < 50) {
      return null;
    }
    // Truncate to safe token window if necessary (first 100k chars ~ 25k tokens)
    const truncatedText = textContent.length > 100000 ? textContent.substring(0, 100000) : textContent;
    parts.push({ text: truncatedText });
  }

  return {
    contents: [{ parts: parts }],
    systemInstruction: { parts: [{ text: systemInstruction }] },
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: schema,
      temperature: 0.1
    }
  };
}

/**
 * Checks whether an HTTP 429 response is due to exceeding the daily quota (RPD)
 * vs a transient per-minute rate limit (RPM).
 * Delegates to SparkCore.GeminiFleet.isDailyQuotaError.
 */
function isDailyQuotaError(statusCode, responseText) {
  if (typeof SparkCore !== "undefined" && SparkCore.isDailyQuotaError) {
    return SparkCore.isDailyQuotaError(statusCode, responseText);
  }
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
 * Delegates to SparkCore.GeminiFleet.getSecondsUntilUtcMidnight.
 */
function getSecondsUntilUtcMidnight() {
  if (typeof SparkCore !== "undefined" && SparkCore.GeminiFleet) {
    return SparkCore.GeminiFleet.getSecondsUntilUtcMidnight();
  }
  const now = new Date();
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
  return Math.max(60, Math.floor((tomorrow.getTime() - now.getTime()) / 1000));
}

/**
 * Marks a model as daily-exhausted across CacheService and ScriptProperties.
 * Delegates to SparkCore.GeminiFleet.markModelDailyExhausted.
 */
function markModelDailyExhausted(model) {
  if (typeof SparkCore !== "undefined" && SparkCore.GeminiFleet) {
    return SparkCore.GeminiFleet.markModelDailyExhausted(model);
  }
}

/**
 * Checks if a model is currently flagged as having exceeded its daily quota limit.
 * Delegates to SparkCore.GeminiFleet.isModelDailyExhausted.
 */
function isModelDailyExhausted(model) {
  if (typeof SparkCore !== "undefined" && SparkCore.GeminiFleet) {
    return SparkCore.GeminiFleet.isModelDailyExhausted(model);
  }
  return false;
}

/**
 * Dynamically queries the Gemini API to discover all available models supporting generateContent.
 * Delegates to SparkCore.discoverAvailableModels.
 */
function discoverAvailableModels(apiKey) {
  if (typeof SparkCore !== "undefined" && SparkCore.discoverAvailableModels) {
    return SparkCore.discoverAvailableModels(apiKey);
  }
  return KG_DEFAULTS.MODEL_LADDER;
}

/**
 * Assembles the active dynamic model ladder.
 * Delegates to SparkCore.GeminiFleet.getDynamicModelLadder.
 */
function getDynamicModelLadder(apiKey, configLadder) {
  if (typeof SparkCore !== "undefined" && SparkCore.GeminiFleet) {
    return SparkCore.GeminiFleet.getDynamicModelLadder(apiKey, configLadder);
  }
  return [];
}

/**
 * Invokes the Gemini API via UrlFetchApp with Dynamic Model Discovery, Daily Limit Tracking,
 * and Exponential Backoff.
 * Delegates to SparkCore.callGeminiAPI.
 */
function callGeminiAPI(payload, apiKey, modelOrLadder) {
  if (typeof SparkCore !== "undefined" && SparkCore.callGeminiAPI) {
    const res = SparkCore.callGeminiAPI(payload, apiKey, modelOrLadder);
    if (res && res._modelUsed) {
      Logger.log('[SUCCESS] Extracted graph entities using model: "' + res._modelUsed + '"');
    }
    return res;
  }
  return null;
}

/**
 * Diagnostic Validation Function:
 * Tests the top models in the ladder with a minimal probe to verify real-time connectivity,
 * quotas, and dynamic failover behavior.
 */
function validateDynamicLadder() {
  Logger.log("=== [DYNAMIC LADDER VALIDATION] ===");
  const config = getKGConfig();
  if (!config.apiKey) {
    Logger.log("[ERROR] Missing GEMINI_API_KEY");
    return;
  }

  const ladder = getDynamicModelLadder(config.apiKey);
  Logger.log(`Discovered & Active Ladder (${ladder.length} models):`);
  ladder.forEach((m, idx) => Logger.log(`  ${idx + 1}. ${m}`));

  const testPayload = {
    contents: [{
      parts: [{ text: "Extract named entities: Matthew Colville founded MCDM in California." }]
    }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          entities: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: { name: { type: "STRING" }, type: { type: "STRING" } },
              required: ["name", "type"]
            }
          }
        },
        required: ["entities"]
      }
    }
  };

  Logger.log("Executing test callGeminiAPI with full dynamic fleet failover...");
  const result = callGeminiAPI(testPayload, config.apiKey);
  if (result) {
    Logger.log(`>>> [PASS] Validation successful! Model used: "${result._modelUsed}"`);
    Logger.log(`Extracted: ${JSON.stringify(result.entities)}`);
  } else {
    Logger.log(">>> [FAIL] All models in ladder failed or exhausted.");
  }
  return result;
}

/**
 * Diagnostic Dry-Run Test Function:
 * Inspects source folder, seed folder, API key configuration, dynamically discovers models,
 * reports daily exhaustion status, and counts pending vs ingested files.
 */
function testKGIngestionDryRun() {
  Logger.log("=== [Knowledge Graph Ingestion Dry-Run] ===");
  const config = getKGConfig();
  const hasKey = Boolean(config.apiKey);
  Logger.log(`API Key configured: ${hasKey} | Configured Model: ${config.modelName}`);

  let discoveredModels = [];
  let activeLadder = [];
  if (hasKey) {
    discoveredModels = discoverAvailableModels(config.apiKey);
    activeLadder = getDynamicModelLadder(config.apiKey, config.modelLadder);
    Logger.log(`Discovered Models: [${discoveredModels.join(", ")}]`);
    Logger.log(`Active (Unexhausted) Ladder: [${activeLadder.join(" -> ")}]`);
  }

  let sourceFolder = null;
  let totalFolders = 0;
  let sourceFileCount = 0;
  let pendingCount = 0;
  let ingestedCount = 0;
  let oversizedCount = 0;
  let unsupportedCount = 0;

  try {
    sourceFolder = DriveApp.getFolderById(config.sourceFolderId);
    Logger.log(`[PASS] Source Folder found: "${sourceFolder.getName()}" (${config.sourceFolderId})`);

    const folderQueue = [sourceFolder];
    const visited = new Set();

    while (folderQueue.length > 0) {
      const current = folderQueue.shift();
      const fId = current.getId();
      if (visited.has(fId)) continue;
      visited.add(fId);
      totalFolders++;

      const files = current.getFiles();
      while (files.hasNext()) {
        sourceFileCount++;
        const file = files.next();
        if (isAlreadyIngested(file)) {
          ingestedCount++;
        } else {
          const mimeType = file.getMimeType ? file.getMimeType() : "";
          const name = file.getName ? file.getName() : "";
          const isDoc = (mimeType === MimeType.GOOGLE_DOCS || mimeType === "application/vnd.google-apps.document");
          const isText = (mimeType === MimeType.PLAIN_TEXT || name.endsWith(".md") || name.endsWith(".txt"));
          const isPdf = (mimeType === "application/pdf" || name.endsWith(".pdf"));

          if (!isDoc && !isText && !isPdf) {
            unsupportedCount++;
          } else if (isPdf && file.getSize && file.getSize() > KG_DEFAULTS.MAX_PDF_BYTES) {
            oversizedCount++;
          } else {
            pendingCount++;
          }
        }
      }

      if (current.getFolders) {
        const subFolders = current.getFolders();
        while (subFolders.hasNext()) {
          folderQueue.push(subFolders.next());
        }
      }
    }
    Logger.log(`Recursive Tree Stats: ${totalFolders} folders, ${sourceFileCount} total files (${pendingCount} pending eligible, ${ingestedCount} already ingested, ${oversizedCount} oversized >15MB, ${unsupportedCount} non-document/media)`);
  } catch (e) {
    Logger.log(`[FAIL] Source folder recursive crawl error: ${e.toString()}`);
  }

  let seedsFolder = null;
  try {
    seedsFolder = DriveApp.getFolderById(config.seedsFolderId);
    Logger.log(`[PASS] Seeds Folder found: "${seedsFolder.getName()}" (${config.seedsFolderId})`);
  } catch (e) {
    Logger.log(`[FAIL] Seeds folder error: ${e.toString()}`);
  }

  return {
    apiKeyConfigured: hasKey,
    discoveredModels: discoveredModels,
    activeLadder: activeLadder,
    sourceFolder: sourceFolder ? sourceFolder.getName() : null,
    totalFolders: totalFolders,
    totalFiles: sourceFileCount,
    pendingFiles: pendingCount,
    ingestedFiles: ingestedCount,
    oversizedFiles: oversizedCount,
    unsupportedFiles: unsupportedCount,
    seedsFolder: seedsFolder ? seedsFolder.getName() : null
  };
}

/**
 * Installs the recurring background time-driven trigger.
 * Deletes any existing triggers for runIngestionPipeline before creating a fresh 30-minute interval trigger.
 */
function setupKGTriggers() {
  const handler = 'runIngestionPipeline';
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === handler) {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger(handler)
    .timeBased()
    .everyMinutes(30)
    .create();

  Logger.log('[SUCCESS] Installed 30-minute recurring time trigger for runIngestionPipeline');
}

import { describe, expect, test } from "bun:test";
import * as path from "path";
import * as vm from "vm";

// Pre-read all core library files via Bun file API per CLAUDE.md standards
const coreDir = path.join(import.meta.dir, "..", "core", "src");
const coreFiles = [
  "GeminiFleet.js",
  "DriveMetadata.js",
  "DriveUtils.js",
  "SheetKit.js",
  "Harness.js",
  "SparkCore.js",
];

const coreCodeMap: Record<string, string> = {};
for (const file of coreFiles) {
  coreCodeMap[file] = await Bun.file(path.join(coreDir, file)).text();
}

// Load the compiled core modules in a Gas-compatible VM context
function loadCoreContext(mocks: Record<string, any> = {}) {
  const logs: string[] = [];
  const scriptCacheStore: Record<string, string> = {};
  const scriptPropsStore: Record<string, string> = {};

  const context: Record<string, any> = {
    Logger: {
      log: (msg: string) => logs.push(msg),
    },
    Utilities: {
      formatDate: (d: Date, _tz: string, fmt: string) =>
        fmt === "yyyy-MM-dd" ? d.toISOString().slice(0, 10) : d.toISOString().slice(0, 4),
      sleep: (_ms: number) => {},
      base64Encode: (b: number[]) => Buffer.from(b).toString("base64"),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k: string) => scriptCacheStore[k] || null,
        put: (k: string, v: string) => {
          scriptCacheStore[k] = v;
        },
        remove: (k: string) => {
          delete scriptCacheStore[k];
        },
      }),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k: string) => scriptPropsStore[k] || null,
        setProperty: (k: string, v: string) => {
          scriptPropsStore[k] = v;
        },
        deleteProperty: (k: string) => {
          delete scriptPropsStore[k];
        },
        getProperties: () => ({ ...scriptPropsStore }),
      }),
    },
    MimeType: {
      GOOGLE_DOCS: "application/vnd.google-apps.document",
      PDF: "application/pdf",
    },
    console,
    Date,
    Set,
    Map,
    JSON,
    Math,
    RegExp,
    parseFloat,
    parseInt,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Error,
    ...mocks,
  };

  vm.createContext(context);

  for (const file of coreFiles) {
    if (coreCodeMap[file]) {
      vm.runInContext(coreCodeMap[file], context);
    }
  }

  return { context, logs, scriptCacheStore, scriptPropsStore };
}

describe("SparkCore — Shared Library Test Suite", () => {
  // -------------------------------------------------------------
  // 1. GeminiFleet
  // -------------------------------------------------------------
  describe("1. GeminiFleet", () => {
    test("isDailyQuotaError identifies daily quota exhaustion vs transient RPM rate limits", () => {
      const { context } = loadCoreContext();
      const fleet = context.GeminiFleet;

      // Daily limit signals
      expect(fleet.isDailyQuotaError(429, "Per-day limit: 0 requests")).toBe(true);
      expect(fleet.isDailyQuotaError(429, "quota metric 'generateContent requests' and limit 'generateContent requests per day' exceeded")).toBe(true);
      expect(fleet.isDailyQuotaError(429, "Resource has been exhausted: free tier per day limit reached")).toBe(true);
      expect(fleet.isDailyQuotaError(429, "RESOURCE_EXHAUSTED: daily quota exceeded")).toBe(true);

      // Transient RPM limit signals (should NOT ban model)
      expect(fleet.isDailyQuotaError(429, "Rate limit exceeded. Please wait 15s (RPM limit).")).toBe(false);
      expect(fleet.isDailyQuotaError(429, "RESOURCE_EXHAUSTED: Please retry after a brief pause")).toBe(false);

      // Other HTTP status codes
      expect(fleet.isDailyQuotaError(503, "Service unavailable")).toBe(false);
      expect(fleet.isDailyQuotaError(200, "OK")).toBe(false);
    });

    test("discoverAvailableModels filters specialized endpoints, sorts Flash-first, and uses header auth", () => {
      const mockRawModels = {
        models: [
          { name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-2.5-flash-lite", supportedGenerationMethods: ["generateContent"] },
          { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] },
          { name: "models/imagen-3.0-generate", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-deep-research", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-3.5-flash", supportedGenerationMethods: ["generateContent"] },
        ],
      };

      let capturedUrl = "";
      let capturedHeaders: Record<string, string> = {};

      const { context } = loadCoreContext({
        UrlFetchApp: {
          fetch: (url: string, options: any) => {
            capturedUrl = url;
            capturedHeaders = options?.headers || {};
            return {
              getResponseCode: () => 200,
              getContentText: () => JSON.stringify(mockRawModels),
            };
          },
        },
      });

      const discovered = context.GeminiFleet.discoverAvailableModels("test_key_123", { bypassCache: true });
      expect(discovered).toEqual([
        "gemini-2.5-flash",
        "gemini-2.5-flash-lite",
        "gemini-3.5-flash",
        "gemini-2.5-pro",
      ]);
      expect(capturedUrl).not.toContain("?key=");
      expect(capturedHeaders["x-goog-api-key"]).toBe("test_key_123");
    });

    test("markModelDailyExhausted bans model across CacheService and ScriptProperties until reset", () => {
      const { context, scriptCacheStore, scriptPropsStore } = loadCoreContext();
      const fleet = context.GeminiFleet;

      expect(fleet.isModelDailyExhausted("gemini-2.5-flash")).toBe(false);

      fleet.markModelDailyExhausted("gemini-2.5-flash");
      expect(fleet.isModelDailyExhausted("gemini-2.5-flash")).toBe(true);
      expect(scriptCacheStore["DAILY_EXHAUSTED_gemini-2.5-flash"]).toBe("true");
      expect(scriptPropsStore["DAILY_EXHAUSTED_gemini-2.5-flash"]).toBeDefined();

      fleet.clearModelBans();
      expect(fleet.isModelDailyExhausted("gemini-2.5-flash")).toBe(false);
    });

    test("clearModelBans purges dynamically discovered model bans as well as default ladder", () => {
      const { context, scriptPropsStore } = loadCoreContext();
      const fleet = context.GeminiFleet;

      // Ban a dynamically discovered model not in DEFAULT_MODEL_LADDER
      fleet.markModelDailyExhausted("gemini-custom-experimental");
      expect(scriptPropsStore["DAILY_EXHAUSTED_gemini-custom-experimental"]).toBeDefined();

      fleet.clearModelBans();
      expect(scriptPropsStore["DAILY_EXHAUSTED_gemini-custom-experimental"]).toBeUndefined();
      expect(fleet.isModelDailyExhausted("gemini-custom-experimental")).toBe(false);
    });

    test("callGeminiAPI supports single model name string in modelOrLadder", () => {
      let requestedUrl = "";
      const { context } = loadCoreContext({
        UrlFetchApp: {
          fetch: (url: string) => {
            requestedUrl = url;
            return {
              getResponseCode: () => 200,
              getContentText: () => JSON.stringify({
                candidates: [
                  { content: { parts: [{ text: '{"result": "success"}' }] } },
                ],
              }),
            };
          },
        },
      });

      const res = context.GeminiFleet.callGeminiAPI({ prompt: "Hello" }, "test_key", "gemini-2.5-pro");
      expect(res).toBeDefined();
      expect(res._modelUsed).toBe("gemini-2.5-pro");
      expect(requestedUrl).toContain("/models/gemini-2.5-pro:generateContent");
    });

    test("callGeminiAPI fast-exits immediately on HTTP 400 without failover cascade", () => {
      const callLog: string[] = [];
      const { context } = loadCoreContext({
        UrlFetchApp: {
          fetch: (url: string) => {
            callLog.push(url);
            return {
              getResponseCode: () => 400,
              getContentText: () => JSON.stringify({
                error: { code: 400, message: "Invalid JSON payload" },
              }),
            };
          },
        },
      });

      const res = context.GeminiFleet.callGeminiAPI(
        { prompt: "Bad Payload" },
        "test_key",
        ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro"]
      );

      expect(res).toBeNull();
      // Must terminate on first model without trying remaining ladder
      expect(callLog.length).toBe(1);
    });

    test("callGeminiAPI cascades through model ladder on 429 quota exhaustion and records _modelUsed", () => {
      const callLog: string[] = [];
      const { context } = loadCoreContext({
        UrlFetchApp: {
          fetch: (url: string) => {
            if (url.includes("gemini-2.5-flash:")) {
              callLog.push("gemini-2.5-flash: 429 Daily");
              return {
                getResponseCode: () => 429,
                getContentText: () => JSON.stringify({
                  error: { code: 429, message: "Resource has been exhausted: generateContent requests per day limit: 0" },
                }),
              };
            }
            if (url.includes("gemini-2.5-flash-lite:")) {
              callLog.push("gemini-2.5-flash-lite: 200 OK");
              return {
                getResponseCode: () => 200,
                getContentText: () => JSON.stringify({
                  candidates: [
                    { content: { parts: [{ text: '{"doc_type": "Invoice", "confidence": 0.98}' }] } },
                  ],
                }),
              };
            }
            return {
              getResponseCode: () => 500,
              getContentText: () => "Unknown",
            };
          },
        },
      });

      const result = context.GeminiFleet.callGeminiAPI(
        { prompt: "Classify this doc" },
        "mock_api_key",
        ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro"]
      );

      expect(result).toBeDefined();
      expect(result.doc_type).toBe("Invoice");
      expect(result._modelUsed).toBe("gemini-2.5-flash-lite");
      expect(callLog).toEqual([
        "gemini-2.5-flash: 429 Daily",
        "gemini-2.5-flash-lite: 200 OK",
      ]);
    });
  });

  // -------------------------------------------------------------
  // 2. DriveMetadata
  // -------------------------------------------------------------
  describe("2. DriveMetadata", () => {
    test("parseMetadata extracts Schema v1 JSON from Drive description or returns null", () => {
      const { context } = loadCoreContext();
      const meta = context.DriveMetadata;

      // Valid Schema v1
      const valid = meta.parseMetadata('{"schema_v": 1, "doc_type": "Invoice", "tags": ["Financial", "2026"]}');
      expect(valid).not.toBeNull();
      expect(valid.schema_v).toBe(1);
      expect(valid.doc_type).toBe("Invoice");
      expect(valid.tags).toEqual(["Financial", "2026"]);

      // Embedded JSON
      const embedded = meta.parseMetadata('User note:\n{"schema_v": 1, "doc_type": "Tax Form"}\nThanks!');
      expect(embedded).not.toBeNull();
      expect(embedded.doc_type).toBe("Tax Form");

      // Non-v1 / unparseable strings
      expect(meta.parseMetadata("Just a plain description")).toBeNull();
      expect(meta.parseMetadata(null)).toBeNull();
    });

    test("formatMetadata enforces schema_v, timestamp, and <= 1024 character limit", () => {
      const { context } = loadCoreContext();
      const meta = context.DriveMetadata;

      const formatted = meta.formatMetadata({
        doc_type: "Tax Form",
        tags: ["2026 Taxes", "W-2"],
        confidence: 0.99,
      });

      expect(formatted).toContain('"schema_v":1');
      expect(formatted).toContain('"updated_at"');
      expect(formatted.length).toBeLessThanOrEqual(1024);

      const parsed = JSON.parse(formatted);
      expect(parsed.doc_type).toBe("Tax Form");
      expect(parsed.schema_v).toBe(1);
    });

    test("formatMetadata preserves caller tags array without mutating in place", () => {
      const { context } = loadCoreContext();
      const meta = context.DriveMetadata;

      // Construct an oversized tags list that triggers truncation to fit <= 1024 bytes
      const originalTags = Array.from({ length: 150 }, (_, i) => `Tag-Number-${i}-Long-Category-Identifier`);
      const originalLength = originalTags.length;

      const callerData = {
        doc_type: "MassiveDocument",
        tags: originalTags,
      };

      const formatted = meta.formatMetadata(callerData);
      expect(formatted.length).toBeLessThanOrEqual(1024);

      // Caller's original tags array must remain completely untouched
      expect(callerData.tags.length).toBe(originalLength);
      expect(callerData.tags[0]).toBe("Tag-Number-0-Long-Category-Identifier");
    });

    test("isAlreadyClassified checks file object and description string for schema_v", () => {
      const { context } = loadCoreContext();
      const meta = context.DriveMetadata;

      expect(meta.isAlreadyClassified('{"schema_v": 1, "doc_type": "Invoice"}')).toBe(true);
      expect(meta.isAlreadyClassified("Random notes")).toBe(false);

      const mockFile = {
        getDescription: () => '{"schema_v": 1, "tags": ["Archival"]}',
      };
      expect(meta.isAlreadyClassified(mockFile)).toBe(true);
    });

    test("updateFileMetadata updates Drive file description", () => {
      let savedDescription = "";
      const { context } = loadCoreContext({
        DriveApp: {
          getFileById: (_id: string) => ({
            getId: () => "test_file_id",
            setDescription: (d: string) => {
              savedDescription = d;
            },
          }),
        },
      });

      const result = context.DriveMetadata.updateFileMetadata("test_file_id", {
        doc_type: "Invoice",
        tags: ["Receipts"],
      });

      expect(result).toContain('"schema_v":1');
      expect(savedDescription).toContain('"doc_type":"Invoice"');
    });
  });

  // -------------------------------------------------------------
  // 3. DriveUtils
  // -------------------------------------------------------------
  describe("3. DriveUtils", () => {
    test("extractFileId extracts 25+ char ID from diverse Google Drive URL patterns", () => {
      const { context } = loadCoreContext();
      const utils = context.DriveUtils;

      expect(utils.extractFileId("https://docs.google.com/document/d/1gYEGX8SMZ0tQd4pLB6MgWnYROOAn1A6uHXgmwp0HI9U/edit")).toBe("1gYEGX8SMZ0tQd4pLB6MgWnYROOAn1A6uHXgmwp0HI9U");
      expect(utils.extractFileId("https://drive.google.com/drive/folders/1XQyRsEx8gQl8idUv_UhfRMYxS9dIx0tk")).toBe("1XQyRsEx8gQl8idUv_UhfRMYxS9dIx0tk");
      expect(utils.extractFileId("1XE78-Gae0a5DfkuC0lJcy62XjreqPIPovy8LuoAT3gA")).toBe("1XE78-Gae0a5DfkuC0lJcy62XjreqPIPovy8LuoAT3gA");
      expect(utils.extractFileId("short-id")).toBeNull();
      expect(utils.extractFileId("")).toBeNull();
    });

    test("createDocInFolder creates Google Doc and moves to folder without MIME type error", () => {
      let docCreatedName = "";
      let docText = "";
      let movedToTarget = false;

      const mockFolder = {
        getId: () => "target_folder_id",
        addFile: () => {},
      };

      const { context } = loadCoreContext({
        DocumentApp: {
          create: (name: string) => ({
            getId: () => "mock_doc_123",
            getName: () => name,
            getBody: () => ({
              setText: (txt: string) => {
                docText = txt;
              },
            }),
            saveAndClose: () => {
              docCreatedName = name;
            },
          }),
        },
        DriveApp: {
          getFileById: (_id: string) => ({
            getId: () => "mock_doc_123",
            moveTo: (dest: any) => {
              if (dest === mockFolder) movedToTarget = true;
            },
          }),
        },
      });

      const file = context.DriveUtils.createDocInFolder("Test Doc", "Sample content", mockFolder);
      expect(file).toBeDefined();
      expect(docCreatedName).toBe("Test Doc");
      expect(docText).toBe("Sample content");
      expect(movedToTarget).toBe(true);
    });

    test("createDocInFolder resolves string folder ID via DriveApp.getFolderById", () => {
      let resolvedFolderId = "";
      let movedToResolvedFolder = false;

      const mockFolder = {
        getId: () => "string_folder_id_xyz",
      };

      const { context } = loadCoreContext({
        DocumentApp: {
          create: (name: string) => ({
            getId: () => "mock_doc_456",
            getName: () => name,
            getBody: () => ({
              setText: () => {},
            }),
            saveAndClose: () => {},
          }),
        },
        DriveApp: {
          getFileById: (_id: string) => ({
            getId: () => "mock_doc_456",
            moveTo: (dest: any) => {
              if (dest === mockFolder) movedToResolvedFolder = true;
            },
          }),
          getFolderById: (id: string) => {
            resolvedFolderId = id;
            return mockFolder;
          },
        },
      });

      context.DriveUtils.createDocInFolder("String Folder Doc", "content", "string_folder_id_xyz");
      expect(resolvedFolderId).toBe("string_folder_id_xyz");
      expect(movedToResolvedFolder).toBe(true);
    });

    test("crawlFolderTree discovers files recursively using BFS and respects maxDepth", () => {
      const fileA = { getId: () => "file_a", getName: () => "A.pdf", getMimeType: () => "application/pdf" };
      const fileB = { getId: () => "file_b", getName: () => "B.docx", getMimeType: () => "application/vnd.google-apps.document" };

      const subFolder = {
        getId: () => "sub_1",
        getName: () => "Sub 1",
        getFiles: () => {
          let yielded = false;
          return {
            hasNext: () => !yielded,
            next: () => {
              yielded = true;
              return fileB;
            },
          };
        },
        getFolders: () => ({ hasNext: () => false, next: () => null }),
      };

      const rootFolder = {
        getId: () => "root",
        getName: () => "Root",
        getFiles: () => {
          let yielded = false;
          return {
            hasNext: () => !yielded,
            next: () => {
              yielded = true;
              return fileA;
            },
          };
        },
        getFolders: () => {
          let yielded = false;
          return {
            hasNext: () => !yielded,
            next: () => {
              yielded = true;
              return subFolder;
            },
          };
        },
      };

      const { context } = loadCoreContext({
        DriveApp: {
          getFolderById: (_id: string) => rootFolder,
        },
      });

      const discovered = context.DriveUtils.crawlFolderTree(rootFolder, { maxDepth: 3 });
      expect(discovered.length).toBe(2);
      expect(discovered.map((f: any) => f.getId())).toEqual(["file_a", "file_b"]);
    });

    test("extractFileTextSnippet handles Docs and PDFs within word limits", () => {
      const mockDoc = {
        getId: () => "doc_1",
        getMimeType: () => "application/vnd.google-apps.document",
      };

      const { context } = loadCoreContext({
        DocumentApp: {
          openById: (_id: string) => ({
            getBody: () => ({
              getText: () => "The quick brown fox jumps over the lazy dog. Additional sentence for testing snippet bounds.",
            }),
          }),
        },
      });

      const snippet = context.DriveUtils.extractFileTextSnippet(mockDoc, 5);
      expect(snippet).toContain("The quick brown fox jumps");
      expect(snippet).toContain("[TRUNCATED at 5 words]");
    });
  });

  // -------------------------------------------------------------
  // 4. SheetKit
  // -------------------------------------------------------------
  describe("4. SheetKit", () => {
    test("normalizeYearOrDateCell and helpers sanitize float years and Excel serial dates", () => {
      const { context } = loadCoreContext();
      const kit = context.SheetKit;

      expect(kit.normalizeYear("2025.0")).toBe("2025");
      expect(kit.normalizeYear(2025.0)).toBe("2025");
      expect(kit.normalizeYear("46241.0")).toBe("2026");
      expect(kit.normalizeDate("46237.0")).toBe("2026-08-03");

      const d = new Date("2026-11-07T12:00:00Z");
      expect(kit.normalizeYear(d)).toBe("2026");
      expect(kit.normalizeDate(d)).toBe("2026-11-07");
    });

    test("getQueuedFileIds extracts unique File IDs and ignores URLs and empty rows", () => {
      const mockSheet = {
        getLastRow: () => 4,
        getRange: () => ({
          getValues: () => [
            ["https://docs.google.com/document/d/1HPY3pKrgzeJr1FMLiK_UNyNJcfPTanJoPRL3ikF_nA8/edit"],
            ["1XE78-Gae0a5DfkuC0lJcy62XjreqPIPovy8LuoAT3gA"],
            [""],
          ],
        }),
      };

      const { context } = loadCoreContext();
      const ids = context.SheetKit.getQueuedFileIds(mockSheet, 1);
      expect(Array.from(ids)).toEqual([
        "1HPY3pKrgzeJr1FMLiK_UNyNJcfPTanJoPRL3ikF_nA8",
        "1XE78-Gae0a5DfkuC0lJcy62XjreqPIPovy8LuoAT3gA",
      ]);
    });

    test("applyApprovedTaxonomyMerges maps historical aliases to canonical terms", () => {
      const { context } = loadCoreContext();
      const kit = context.SheetKit;

      const mergeMap = {
        "TTRPG Players": "TTRPG Players & Game Masters",
        "TTRPG Campaign Players": "TTRPG Players & Game Masters",
        "Receipt": "Invoice / Receipt",
      };

      const merged = kit.applyApprovedTaxonomyMerges(
        ["TTRPG Players", "TTRPG Campaign Players", "Game Design", "Receipt"],
        mergeMap
      );

      expect(merged).toEqual([
        "TTRPG Players & Game Masters",
        "Game Design",
        "Invoice / Receipt",
      ]);
    });

    test("batchAppendRows writes rows in chunked batches, tracks offsets, and expands grid", () => {
      let appendedRanges: any[] = [];
      let currentRowCount = 10;
      let insertedRows: { afterIndex: number; count: number }[] = [];

      const mockSheet = {
        getLastRow: () => currentRowCount,
        getMaxRows: () => 15,
        insertRowsAfter: (afterIndex: number, count: number) => {
          insertedRows.push({ afterIndex, count });
          currentRowCount += count;
        },
        getRange: (startRow: number, startCol: number, numRows: number, numCols: number) => ({
          setValues: (vals: any[][]) => {
            appendedRanges.push({ startRow, startCol, numRows, numCols, vals });
            currentRowCount = Math.max(currentRowCount, startRow + numRows - 1);
          },
        }),
      };

      const { context } = loadCoreContext();
      const rows = [
        ["A1", "B1"],
        ["A2", "B2"],
        ["A3", "B3"],
        ["A4", "B4"],
        ["A5", "B5"],
        ["A6", "B6"],
        ["A7", "B7"],
        ["A8", "B8"],
      ];

      // 8 rows starting at row 11 -> needs rows through row 18.
      // maxRows is 15, so it must call insertRowsAfter(15, 3) to expand grid.
      const count = context.SheetKit.batchAppendRows(mockSheet, rows, 3);
      expect(count).toBe(8);
      expect(insertedRows.length).toBe(1);
      expect(insertedRows[0]).toEqual({ afterIndex: 15, count: 3 });
      expect(appendedRanges.length).toBe(3);
      expect(appendedRanges[0].startRow).toBe(11);
      expect(appendedRanges[0].vals.length).toBe(3);
      expect(appendedRanges[1].startRow).toBe(14);
      expect(appendedRanges[1].vals.length).toBe(3);
      expect(appendedRanges[2].startRow).toBe(17);
      expect(appendedRanges[2].vals.length).toBe(2);
    });
  });

  // -------------------------------------------------------------
  // 5. Harness
  // -------------------------------------------------------------
  describe("5. Harness", () => {
    test("createExecutionBudget tracks elapsed time and detects expiring budget", () => {
      const { context } = loadCoreContext();
      const harness = context.Harness;

      // Budget of 100ms
      const budget = harness.createExecutionBudget(100);
      expect(budget.isTimeExpiring()).toBe(false);
      expect(budget.maxRunTimeMs).toBe(100);
      expect(budget.getElapsedMs()).toBeGreaterThanOrEqual(0);
      expect(budget.getRemainingMs()).toBeLessThanOrEqual(100);
    });

    test("dispatchError formats error and optionally sends email", () => {
      let emailSent = false;
      let emailSubject = "";

      const { context, logs } = loadCoreContext({
        MailApp: {
          sendEmail: (to: string, subj: string, _body: string) => {
            if (to === "admin@example.com") {
              emailSent = true;
              emailSubject = subj;
            }
          },
        },
      });

      const formatted = context.Harness.dispatchError(
        "ReceiptIngestion",
        new Error("Gmail quota exceeded"),
        { notificationEmail: "admin@example.com" }
      );

      expect(formatted).toContain("[PIPELINE_ERROR] ReceiptIngestion");
      expect(formatted).toContain("Gmail quota exceeded");
      expect(emailSent).toBe(true);
      expect(emailSubject).toBe("[ALERT] Pipeline Error: ReceiptIngestion");
      expect(logs.some((l: string) => l.includes("[PIPELINE_ERROR]"))).toBe(true);
    });

    test("safeExecute executes safely with fallback on error", () => {
      const { context } = loadCoreContext();
      const harness = context.Harness;

      const success = harness.safeExecute("TestOp", () => 42, 0);
      expect(success).toBe(42);

      const failed = harness.safeExecute(
        "FailingOp",
        () => {
          throw new Error("Boom");
        },
        -1,
        { silent: true }
      );
      expect(failed).toBe(-1);
    });
  });

  // -------------------------------------------------------------
  // 6. SparkCore Facade
  // -------------------------------------------------------------
  describe("6. SparkCore Facade", () => {
    test("SparkCore binds all subsystems and provides direct convenience facades", () => {
      const { context } = loadCoreContext();
      const sc = context.SparkCore;

      expect(sc.version).toBe("1.0.0");
      expect(sc.GeminiFleet).toBeDefined();
      expect(sc.DriveMetadata).toBeDefined();
      expect(sc.DriveUtils).toBeDefined();
      expect(sc.SheetKit).toBeDefined();
      expect(sc.Harness).toBeDefined();

      // Check direct convenience methods
      expect(typeof sc.callGeminiAPI).toBe("function");
      expect(typeof sc.discoverAvailableModels).toBe("function");
      expect(typeof sc.parseMetadata).toBe("function");
      expect(typeof sc.formatMetadata).toBe("function");
      expect(typeof sc.extractFileId).toBe("function");
      expect(typeof sc.normalizeYearOrDateCell).toBe("function");
      expect(typeof sc.createExecutionBudget).toBe("function");
    });
  });
});

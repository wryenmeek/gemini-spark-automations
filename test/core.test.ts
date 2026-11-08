import { describe, expect, test, beforeEach } from "bun:test";
import * as path from "path";
import * as vm from "vm";

// Load the compiled core modules in a Gas-compatible VM context
function loadCoreContext(mocks: Record<string, any> = {}) {
  const fs = require("fs");
  const coreDir = path.join(import.meta.dir, "..", "core", "src");

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

  const files = [
    "GeminiFleet.js",
    "DriveMetadata.js",
    "DriveUtils.js",
    "SheetKit.js",
    "Harness.js",
    "SparkCore.js",
  ];

  for (const file of files) {
    const code = fs.readFileSync(path.join(coreDir, file), "utf-8");
    vm.runInContext(code, context);
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

    test("discoverAvailableModels filters specialized endpoints and sorts Flash-first", () => {
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

      const { context } = loadCoreContext({
        UrlFetchApp: {
          fetch: (_url: string) => ({
            getResponseCode: () => 200,
            getContentText: () => JSON.stringify(mockRawModels),
          }),
        },
      });

      const discovered = context.GeminiFleet.discoverAvailableModels("test_key", { bypassCache: true });
      expect(discovered).toEqual([
        "gemini-2.5-flash",
        "gemini-2.5-flash-lite",
        "gemini-3.5-flash",
        "gemini-2.5-pro",
      ]);
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
            return { getResponseCode: () => 404, getContentText: () => "Not Found" };
          },
        },
      });

      const result = context.GeminiFleet.callGeminiAPI(
        { contents: [{ parts: [{ text: "classify" }] }] },
        "test_api_key",
        ["gemini-2.5-flash", "gemini-2.5-flash-lite"]
      );

      expect(callLog).toEqual([
        "gemini-2.5-flash: 429 Daily",
        "gemini-2.5-flash-lite: 200 OK",
      ]);
      expect(result).toEqual({
        doc_type: "Invoice",
        confidence: 0.98,
        _modelUsed: "gemini-2.5-flash-lite",
      });
      // Primary model should now be banned
      expect(context.GeminiFleet.isModelDailyExhausted("gemini-2.5-flash")).toBe(true);
    });
  });

  // -------------------------------------------------------------
  // 2. DriveMetadata
  // -------------------------------------------------------------
  describe("2. DriveMetadata", () => {
    test("parseMetadata extracts Schema v1 JSON from clean or wrapped description strings", () => {
      const { context } = loadCoreContext();
      const meta = context.DriveMetadata;

      const validJson = '{"schema_v": 1, "doc_type": "Financial Receipt", "tags": ["Tax"], "confidence": 0.95}';
      expect(meta.parseMetadata(validJson)).toEqual({
        schema_v: 1,
        doc_type: "Financial Receipt",
        tags: ["Tax"],
        confidence: 0.95,
      });

      // Wrapped with extra text
      const wrapped = 'Pre-existing notes\n' + validJson + '\nFooter text';
      expect(meta.parseMetadata(wrapped)?.doc_type).toBe("Financial Receipt");

      // Non-metadata descriptions
      expect(meta.parseMetadata("Just a plain document description.")).toBeNull();
      expect(meta.parseMetadata("")).toBeNull();
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
          create: (name: string) => {
            docCreatedName = name;
            return {
              getId: () => "new_doc_id",
              getBody: () => ({
                setText: (t: string) => {
                  docText = t;
                },
              }),
              saveAndClose: () => {},
            };
          },
        },
        DriveApp: {
          getFileById: (_id: string) => ({
            getId: () => "new_doc_id",
            moveTo: (target: any) => {
              if (target.getId() === "target_folder_id") movedToTarget = true;
            },
          }),
        },
      });

      const file = context.DriveUtils.createDocInFolder("Test Specification", "# Heading\nContent", mockFolder);
      expect(docCreatedName).toBe("Test Specification");
      expect(docText).toBe("# Heading\nContent");
      expect(movedToTarget).toBe(true);
      expect(file.getId()).toBe("new_doc_id");
    });

    test("crawlFolderTree recursively discovers nested files with loop prevention", () => {
      const childFolder = {
        getId: () => "child_folder",
        getFiles: () => {
          let count = 0;
          return {
            hasNext: () => count < 1,
            next: () => {
              count++;
              return { getId: () => "file_child_1", getMimeType: () => "text/plain" };
            },
          };
        },
        getFolders: () => ({ hasNext: () => false, next: () => null }),
      };

      const rootFolder = {
        getId: () => "root_folder",
        getFiles: () => {
          let count = 0;
          return {
            hasNext: () => count < 1,
            next: () => {
              count++;
              return { getId: () => "file_root_1", getMimeType: () => "text/plain" };
            },
          };
        },
        getFolders: () => {
          let count = 0;
          return {
            hasNext: () => count < 1,
            next: () => {
              count++;
              return childFolder;
            },
          };
        },
      };

      const { context } = loadCoreContext();
      const files = context.DriveUtils.crawlFolderTree(rootFolder, { maxDepth: 3 });
      expect(files.map((f: any) => f.getId())).toEqual(["file_root_1", "file_child_1"]);
    });

    test("extractFileTextSnippet safely extracts text and flags PDF without dumping raw binary context", () => {
      const { context } = loadCoreContext({
        DocumentApp: {
          openById: (_id: string) => ({
            getBody: () => ({ getText: () => "Extracted document text content." }),
          }),
        },
      });

      const docFile = {
        getId: () => "doc_123",
        getName: () => "Document.gdoc",
        getMimeType: () => context.MimeType.GOOGLE_DOCS,
      };
      expect(context.DriveUtils.extractFileTextSnippet(docFile)).toBe("Extracted document text content.");

      const pdfFile = {
        getId: () => "pdf_123",
        getName: () => "Statement.pdf",
        getSize: () => 102400,
        getMimeType: () => "application/pdf",
      };
      const pdfSnippet = context.DriveUtils.extractFileTextSnippet(pdfFile);
      expect(pdfSnippet).toContain("Multimodal inlineData processing required");
      expect(pdfSnippet).not.toContain("%PDF-1.5");
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

    test("applyApprovedTaxonomyMerges consolidates synonym tags to canonical targets", () => {
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

    test("batchAppendRows writes rows in chunked batches", () => {
      let appendedRanges: any[] = [];
      const mockSheet = {
        getLastRow: () => 10,
        getRange: (startRow: number, startCol: number, numRows: number, numCols: number) => ({
          setValues: (vals: any[][]) => {
            appendedRanges.push({ startRow, startCol, numRows, numCols, vals });
          },
        }),
      };

      const { context } = loadCoreContext();
      const rows = [
        ["A1", "B1"],
        ["A2", "B2"],
        ["A3", "B3"],
      ];

      const count = context.SheetKit.batchAppendRows(mockSheet, rows, 2);
      expect(count).toBe(3);
      expect(appendedRanges.length).toBe(2);
      expect(appendedRanges[0].vals.length).toBe(2);
      expect(appendedRanges[1].vals.length).toBe(1);
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

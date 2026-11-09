import { describe, expect, test } from "bun:test";
import * as path from "path";
import * as vm from "vm";
import { SparkCore as SparkCoreTs, DriveMetadata as DriveMetadataTs, SheetKit as SheetKitTs } from "../index.ts";
import * as coreCjs from "../core/index.js";

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

    test("DriveUtils hierarchy helpers filter excluded folders, titles, and resolve parent IDs", () => {
      const { context } = loadCoreContext();
      const du = context.DriveUtils;

      // getPrimaryParentId & isFolderExcluded
      const createMockFile = (parentId: string) => ({
        getParents: () => {
          let hasNext = true;
          return {
            hasNext: () => hasNext,
            next: () => {
              hasNext = false;
              return { getId: () => parentId };
            },
          };
        },
      });

      const mockFileWithParent = createMockFile("folder_abc");
      expect(du.getPrimaryParentId(mockFileWithParent)).toBe("folder_abc");
      expect(du.getPrimaryParentId(null)).toBe("root");
      expect(du.getPrimaryParentId({ getParents: () => ({ hasNext: () => false }) })).toBe("root");

      // isFolderExcluded
      expect(du.isFolderExcluded(createMockFile("folder_abc"), ["folder_xyz", "folder_abc"])).toBe(true);
      expect(du.isFolderExcluded(createMockFile("folder_abc"), ["folder_xyz"])).toBe(false);
      expect(du.isFolderExcluded(null, ["folder_abc"])).toBe(false);

      // isTitleExcluded
      expect(du.isTitleExcluded("Receipt_2026_01.pdf", ["receipt", "invoice"])).toBe(true);
      expect(du.isTitleExcluded("Quarterly_Report.docx", ["receipt", "invoice"])).toBe(false);
      expect(du.isTitleExcluded("", ["receipt"])).toBe(false);
    });

    test("extractFileTextSnippet handles Google Slides shapes extraction", () => {
      const mockSlide = {
        getId: () => "pres_1",
        getMimeType: () => "application/vnd.google-apps.presentation",
      };

      const { context } = loadCoreContext({
        SlidesApp: {
          openById: (_id: string) => ({
            getSlides: () => [
              {
                getShapes: () => [
                  { getText: () => ({ asString: () => "Welcome to Slide 1" }) },
                  { getText: () => ({ asString: () => "Key Architecture Objectives" }) },
                ],
              },
            ],
          }),
        },
      });

      const text = context.DriveUtils.extractFileTextSnippet(mockSlide, 10);
      expect(text).toContain("Welcome to Slide 1");
      expect(text).toContain("Key Architecture Objectives");
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

    test("deduplicateRowsByColumn removes duplicate rows by extracted ID from bottom to top", () => {
      const deletedRowIndices: number[] = [];
      const mockSheet = {
        getLastRow: () => 5,
        deleteRow: (idx: number) => {
          deletedRowIndices.push(idx);
        },
        getRange: (_startRow: number, _col: number, _numRows: number, _numCols: number) => ({
          getValues: () => [
            ["https://docs.google.com/document/d/1HPY3pKrgzeJr1FMLiK_UNyNJcfPTanJoPRL3ikF_nA8/edit"], // row 2: ID 1
            ["https://docs.google.com/document/d/1XE78-Gae0a5DfkuC0lJcy62XjreqPIPovy8LuoAT3gA/edit"], // row 3: ID 2
            ["https://docs.google.com/document/d/1HPY3pKrgzeJr1FMLiK_UNyNJcfPTanJoPRL3ikF_nA8/view"], // row 4: duplicate ID 1
            ["https://docs.google.com/document/d/1XE78-Gae0a5DfkuC0lJcy62XjreqPIPovy8LuoAT3gA/edit"], // row 5: duplicate ID 2
          ],
        }),
      };

      const { context } = loadCoreContext();
      const deletedCount = context.SheetKit.deduplicateRowsByColumn(mockSheet, 1, { startRow: 2, extractId: true });
      expect(deletedCount).toBe(2);
      // Deletions must occur bottom-to-top (row 5, then row 4)
      expect(deletedRowIndices).toEqual([5, 4]);
    });

    test("normalizeDateColumn and backfillEmptyCells perform in-place column hygiene", () => {
      let updatedDates: any[][] = [];
      const mockDateSheet = {
        getLastRow: () => 4,
        getRange: (_r: number, _c: number, _nr: number, _nc: number) => ({
          getValues: () => [
            ["2025.0"],
            ["46241.0"],
            ["2024"],
          ],
          setValues: (v: any[][]) => {
            updatedDates = v;
          },
        }),
      };

      const { context } = loadCoreContext();
      const count = context.SheetKit.normalizeDateColumn(mockDateSheet, 1, { startRow: 2, fullDate: false });
      expect(count).toBe(2);
      expect(updatedDates).toEqual([["2025"], ["2026"], ["2024"]]);

      // backfillEmptyCells
      let updatedBackfills: any[][] = [];
      const mockBackfillSheet = {
        getLastRow: () => 3,
        getRange: (_r: number, _c: number, _nr: number, _nc: number) => ({
          getValues: () => [
            ["Leadership", ""],
            ["Engineering", "Existing Description"],
          ],
          setValues: (v: any[][]) => {
            updatedBackfills = v;
          },
        }),
      };

      const backfillCount = context.SheetKit.backfillEmptyCells(mockBackfillSheet, 2, {
        startRow: 2,
        keyColIndex: 1,
        defaultValueFn: (term: string) => `Subject domain for ${term}`,
      });
      expect(backfillCount).toBe(1);
      expect(updatedBackfills).toEqual([
        ["Leadership", "Subject domain for Leadership"],
        ["Engineering", "Existing Description"],
      ]);
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

    test("Harness trigger management methods clear and install triggers idempotently", () => {
      let deletedTriggers: any[] = [];
      let installedTrigger: any = null;

      const mockTriggers = [
        { getHandlerFunction: () => "handlerA" },
        { getHandlerFunction: () => "handlerB" },
      ];

      const { context } = loadCoreContext({
        ScriptApp: {
          getProjectTriggers: () => mockTriggers,
          deleteTrigger: (t: any) => {
            deletedTriggers.push(t);
          },
          newTrigger: (handler: string) => ({
            timeBased: () => ({
              everyDays: (_days: number) => ({
                atHour: (h: number) => ({
                  nearMinute: (m: number) => ({
                    create: () => {
                      installedTrigger = { type: "daily", handler, hour: h, minute: m };
                      return installedTrigger;
                    },
                  }),
                }),
              }),
              everyMinutes: (mins: number) => ({
                create: () => {
                  installedTrigger = { type: "interval", handler, intervalMinutes: mins };
                  return installedTrigger;
                },
              }),
              onWeekDay: (day: any) => ({
                atHour: (h: number) => ({
                  create: () => {
                    installedTrigger = { type: "weekly", handler, day, hour: h };
                    return installedTrigger;
                  },
                }),
              }),
            }),
          }),
        },
      });

      const harness = context.Harness;

      // clearTriggers
      const cleared = harness.clearTriggers("handlerA");
      expect(cleared).toBe(1);

      // installDailyTrigger
      harness.installDailyTrigger("dailyScan", 8, 30);
      expect(installedTrigger).toEqual({ type: "daily", handler: "dailyScan", hour: 8, minute: 30 });

      // installIntervalTrigger
      harness.installIntervalTrigger("crawlLoop", 15);
      expect(installedTrigger).toEqual({ type: "interval", handler: "crawlLoop", intervalMinutes: 15 });

      // installWeeklyTrigger
      harness.installWeeklyTrigger("weeklyDigest", "MONDAY", 9);
      expect(installedTrigger).toEqual({ type: "weekly", handler: "weeklyDigest", day: "MONDAY", hour: 9 });
    });

    test("createTaskAlert and sendEmailDigest dispatch tasks and emails safely", () => {
      let taskInserted: any = null;
      let emailDispatched: any = null;

      const { context } = loadCoreContext({
        Tasks: {
          newTask: () => ({}),
          Tasks: {
            insert: (task: any, listId: string) => {
              taskInserted = { task, listId };
              return task;
            },
          },
        },
        GmailApp: {
          sendEmail: (to: string, subj: string, body: string, opts: any) => {
            emailDispatched = { to, subj, body, opts };
          },
        },
      });

      const harness = context.Harness;

      // createTaskAlert
      const task = harness.createTaskAlert("Urgent Task", "Check queue immediately", { dueDays: 2 });
      expect(task).toBeDefined();
      expect(taskInserted.task.title).toBe("Urgent Task");
      expect(taskInserted.task.notes).toBe("Check queue immediately");

      // sendEmailDigest
      const sent = harness.sendEmailDigest({
        recipient: "user@example.com",
        subject: "Review Digest",
        body: "3 items pending review",
      });
      expect(sent).toBe(true);
      expect(emailDispatched.to).toBe("user@example.com");
      expect(emailDispatched.subj).toBe("Review Digest");
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

      // Check model ladder property getter
      expect(Array.isArray(sc.DEFAULT_MODEL_LADDER)).toBe(true);
      expect(sc.DEFAULT_MODEL_LADDER.length).toBe(18);
      expect(sc.DEFAULT_MODEL_LADDER[0]).toBe("gemini-2.5-flash");

      // Check direct convenience methods
      expect(typeof sc.callGeminiAPI).toBe("function");
      expect(typeof sc.discoverAvailableModels).toBe("function");
      expect(typeof sc.getDynamicModelLadder).toBe("function");
      expect(typeof sc.isModelDailyExhausted).toBe("function");
      expect(typeof sc.markModelDailyExhausted).toBe("function");
      expect(typeof sc.parseMetadata).toBe("function");
      expect(typeof sc.formatMetadata).toBe("function");
      expect(typeof sc.extractFileId).toBe("function");
      expect(typeof sc.getPrimaryParentId).toBe("function");
      expect(typeof sc.isFolderExcluded).toBe("function");
      expect(typeof sc.isTitleExcluded).toBe("function");
      expect(typeof sc.normalizeYearOrDateCell).toBe("function");
      expect(typeof sc.deduplicateRowsByColumn).toBe("function");
      expect(typeof sc.normalizeDateColumn).toBe("function");
      expect(typeof sc.backfillEmptyCells).toBe("function");
      expect(typeof sc.createExecutionBudget).toBe("function");
      expect(typeof sc.clearTriggers).toBe("function");
      expect(typeof sc.installDailyTrigger).toBe("function");
      expect(typeof sc.installIntervalTrigger).toBe("function");
      expect(typeof sc.installWeeklyTrigger).toBe("function");
      expect(typeof sc.createTaskAlert).toBe("function");
      expect(typeof sc.sendEmailDigest).toBe("function");
    });
  });

  // -------------------------------------------------------------
  // 7. 22 Code Review Remediation Regression Tests
  // -------------------------------------------------------------
  describe("7. 22 Code Review Remediation Regressions", () => {
    test("#01 Regression: Direct Node/Bun CommonJS and TS imports work without ReferenceError", () => {
      // TS direct import
      expect(SparkCoreTs.version).toBe("1.0.0");
      expect(typeof SparkCoreTs.parseMetadata).toBe("function");
      expect(typeof SparkCoreTs.normalizeYear).toBe("function");
      expect(typeof SparkCoreTs.extractFileId).toBe("function");

      // CJS direct import
      expect(coreCjs.SparkCore).toBeDefined();
      expect(coreCjs.SparkCore.version).toBe("1.0.0");
      expect(coreCjs.SparkCore.DriveMetadata).toBeDefined();
      expect(coreCjs.SparkCore.SheetKit).toBeDefined();

      // Call facade without global scope pollution
      const parsed = coreCjs.SparkCore.parseMetadata('{"schema_v": 1, "status": "ok"}');
      expect(parsed).toEqual({ schema_v: 1, status: "ok" });
      const yr = coreCjs.SparkCore.normalizeYear("2026.0");
      expect(yr).toBe("2026");
      const id = coreCjs.SparkCore.extractFileId(
        "https://drive.google.com/file/d/1234567890123456789012345/view"
      );
      expect(id).toBe("1234567890123456789012345");
    });

    test("#06 Regression: DriveUtils snippet extraction windowing prevents heap OOM on huge text", () => {
      const { context } = loadCoreContext();
      const du = context.DriveUtils;

      // Generate a large 500,000 char string
      const largeText = "word ".repeat(100000);
      const fakeFile = {
        getId: () => "large_doc_123",
        getName: () => "LargeDoc.txt",
        getMimeType: () => "text/plain",
        getBlob: () => ({
          getDataAsString: () => largeText,
        }),
      };

      const snippet = du.extractFileTextSnippet(fakeFile, 50);
      expect(snippet).toContain("... [TRUNCATED at 50 words]");
      const words = snippet.replace(/\n\.\.\. \[TRUNCATED at 50 words\]/, "").split(/\s+/);
      expect(words.length).toBe(50);
    });

    test("#07 Regression: GeminiFleet safety filter fast-exit and time budget expiration", () => {
      let callCount = 0;
      const mockUrlFetch = {
        fetch: (_url: string, _opts: any) => {
          callCount++;
          return {
            getResponseCode: () => 200,
            getContentText: () =>
              JSON.stringify({
                candidates: [
                  {
                    finishReason: "SAFETY",
                    content: { parts: [{ text: "" }] },
                  },
                ],
              }),
          };
        },
      };

      const { context } = loadCoreContext({ UrlFetchApp: mockUrlFetch });
      const fleet = context.GeminiFleet;

      // Pass ladder with 2 models: gemini-2.5-flash and gemini-2.5-pro
      const result = fleet.callGeminiAPI(
        { contents: [] },
        "test-key",
        ["gemini-2.5-flash", "gemini-2.5-pro"]
      );
      expect(result).toBeDefined();
      expect(result.error).toBe("BLOCKED_BY_SAFETY");
      expect(result.reason).toBe("SAFETY");
      // Must not cascade/rotate through gemini-2.5-pro!
      expect(callCount).toBe(1);

      // Check time budget expiration
      let calledAfterExpired = false;
      const expiredMock = {
        fetch: () => {
          calledAfterExpired = true;
          return { getResponseCode: () => 200, getContentText: () => "{}" };
        },
      };
      const { context: expiredCtx } = loadCoreContext({ UrlFetchApp: expiredMock });
      const expResult = expiredCtx.GeminiFleet.callGeminiAPI(
        { contents: [] },
        "test-key",
        ["gemini-2.5-flash"],
        {
          isTimeExpiring: () => true,
        }
      );
      expect(expResult).toBeNull();
      expect(calledAfterExpired).toBe(false);
    });

    test("#10 Regression: GeminiFleet parses JSON inside code blocks surrounded by conversational prelude/coda", () => {
      const mockUrlFetch = {
        fetch: (_url: string, _opts: any) => ({
          getResponseCode: () => 200,
          getContentText: () =>
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text:
                          'Here is the requested extraction result:\n```json\n{\n  "vendor": "Acme Store",\n  "total": 42.50\n}\n```\nLet me know if you need anything else!',
                      },
                    ],
                  },
                },
              ],
            }),
        }),
      };

      const { context } = loadCoreContext({ UrlFetchApp: mockUrlFetch });
      const result = context.GeminiFleet.callGeminiAPI({ contents: [] }, "test-key");
      expect(result).toBeDefined();
      expect(result.vendor).toBe("Acme Store");
      expect(result.total).toBe(42.5);
    });

    test("#11 Regression: SheetKit expands columns if rows have more columns than current sheet width", () => {
      const { context } = loadCoreContext();
      const sk = context.SheetKit;

      let insertColsCalled = false;
      let insertedCount = 0;
      let setValuesData: any[][] = [];

      const mockSheet = {
        getLastRow: () => 10,
        getMaxRows: () => 100,
        getMaxColumns: () => 5,
        insertRowsAfter: () => {},
        insertColumnsAfter: (_start: number, count: number) => {
          insertColsCalled = true;
          insertedCount = count;
        },
        getRange: (_r: number, _c: number, _numR: number, _numC: number) => ({
          setValues: (vals: any[][]) => {
            setValuesData = vals;
          },
        }),
      };

      // Row with 8 columns when sheet max columns is 5
      const wideRows = [["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"]];

      const appended = sk.batchAppendRows(mockSheet, wideRows);
      expect(appended).toBe(1);
      expect(insertColsCalled).toBe(true);
      expect(insertedCount).toBe(3); // 8 - 5 = 3 columns expanded
      expect(setValuesData[0]!.length).toBe(8);
    });

    test("#12 Regression: SheetKit formula injection sanitization prefixes formula triggers (=, +, -, @)", () => {
      const { context } = loadCoreContext();
      const sk = context.SheetKit;

      expect(sk.sanitizeCellValue("=SUM(A1:A10)")).toBe("'=SUM(A1:A10)");
      expect(sk.sanitizeCellValue("+cmd|' /C calc'!A0")).toBe("'+cmd|' /C calc'!A0");
      expect(sk.sanitizeCellValue("-1+1")).toBe("'-1+1");
      expect(sk.sanitizeCellValue("@ATTACK")).toBe("'@ATTACK");
      expect(sk.sanitizeCellValue("Normal text")).toBe("Normal text");
      expect(sk.sanitizeCellValue(12345)).toBe(12345);

      let appendedValues: any[][] = [];
      const mockSheet = {
        getLastRow: () => 1,
        getMaxRows: () => 10,
        getMaxColumns: () => 10,
        getRange: () => ({
          setValues: (vals: any[][]) => {
            appendedValues = vals;
          },
        }),
      };

      sk.batchAppendRows(mockSheet, [["=1+1", "@calc", "Safe"]]);
      expect(appendedValues[0]![0]).toBe("'=1+1");
      expect(appendedValues[0]![1]).toBe("'@calc");
      expect(appendedValues[0]![2]).toBe("Safe");
    });

    test("#13 Regression: GeminiFleet strips models/ prefix from model name in URLs", () => {
      let requestedUrl = "";
      const mockUrlFetch = {
        fetch: (url: string) => {
          requestedUrl = url;
          return {
            getResponseCode: () => 200,
            getContentText: () =>
              JSON.stringify({
                candidates: [{ content: { parts: [{ text: '{"status":"ok"}' }] } }],
              }),
          };
        },
      };

      const { context } = loadCoreContext({ UrlFetchApp: mockUrlFetch });
      context.GeminiFleet.callGeminiAPI({ contents: [] }, "test-key", "models/gemini-2.5-flash");

      expect(requestedUrl).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
      );
      expect(requestedUrl).not.toContain("models/models/");
    });

    test("#14 Regression: DriveMetadata strictly requires schema_v === 1 in parseMetadata", () => {
      const { context } = loadCoreContext();
      const dm = context.DriveMetadata;

      // Random JSON object lacking schema_v should return null
      expect(dm.parseMetadata('{"title": "Non-Schema Notes"}')).toBeNull();
      expect(dm.parseMetadata('{"schema_v": 2, "title": "Future Schema"}')).toBeNull();

      // Valid schema_v === 1 JSON
      const valid = dm.parseMetadata('{"schema_v": 1, "tags": ["reference"]}');
      expect(valid).toEqual({ schema_v: 1, tags: ["reference"] });
    });

    test("#16 Regression: SheetKit normalizes ISO date strings to year or date", () => {
      const { context } = loadCoreContext();
      const sk = context.SheetKit;

      expect(sk.normalizeYear("2025-08-15")).toBe("2025");
      expect(sk.normalizeDate("2025-08-15")).toBe("2025-08-15");
      expect(sk.normalizeYear("2026/04/01")).toBe("2026");
      expect(sk.normalizeDate("2026/04/01")).toBe("2026-04-01");
    });

    test("#18 Regression: GeminiFleet dynamically orders discovered models by ladder priority", () => {
      const mockDiscovered = {
        models: [
          { name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-2.5-flash-lite", supportedGenerationMethods: ["generateContent"] },
        ],
      };

      const mockUrlFetch = {
        fetch: () => ({
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify(mockDiscovered),
        }),
      };

      const { context } = loadCoreContext({ UrlFetchApp: mockUrlFetch });
      const discovered = context.GeminiFleet.discoverAvailableModels("key");

      // Flash must be sorted ahead of Flash-Lite, which is sorted ahead of Pro
      expect(discovered[0]).toBe("gemini-2.5-flash");
      expect(discovered[1]).toBe("gemini-2.5-flash-lite");
      expect(discovered[2]).toBe("gemini-2.5-pro");
    });

    test("#22 Regression: DriveMetadata trims tags down to 0 tags when necessary to fit 1024 bytes", () => {
      const { context } = loadCoreContext();
      const dm = context.DriveMetadata;

      // 930 character description string with 1 large tag that pushes past 1024
      const largeNote = "A".repeat(930);
      const data = {
        schema_v: 1,
        note: largeNote,
        tags: ["VeryLongTagNameToTrim"],
      };

      const formatted = dm.formatMetadata(data);
      expect(formatted.length).toBeLessThanOrEqual(1024);
      const parsed = JSON.parse(formatted);
      expect(parsed.tags.length).toBe(0); // Successfully trimmed down to 0 tags
    });
  });
});

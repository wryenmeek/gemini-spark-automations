import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";

const projectsDir = path.join(import.meta.dir, "..", "projects");

function loadGasContext(projectFolder: string, mocks: Record<string, any> = {}) {
  const codePath = path.join(projectsDir, projectFolder, "Code.gs");
  const code = fs.readFileSync(codePath, "utf-8");
  const logs: string[] = [];
  const context: Record<string, any> = {
    Logger: { log: (msg: string) => logs.push(msg) },
    Utilities: {
      formatDate: (_d: Date, _tz: string, _fmt: string) => "2026-10-30",
      base64Encode: (b: number[]) => Buffer.from(b).toString("base64"),
    },
    Session: {
      getScriptTimeZone: () => "America/New_York",
      getActiveUser: () => ({ getEmail: () => "wryenmeek@gmail.com" }),
    },
    MimeType: {
      GOOGLE_DOCS: "application/vnd.google-apps.document",
      GOOGLE_SLIDES: "application/vnd.google-apps.presentation",
    },
    DocumentApp: {
      ParagraphHeading: { HEADING2: "HEADING2" },
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
  vm.runInContext(code, context);
  return { context, logs };
}

describe("1. Financial Receipts Ingestion (Code.gs)", () => {
  test("extractReceiptMetadata parses SOP vendors and disqualifies surveys/pickup alerts", () => {
    const { context } = loadGasContext("receipts-ingestion");

    // 1. Disqualified Home Depot pickup survey
    const disqualifiedMsg = {
      getFrom: () => "homedepot@order.homedepot.com",
      getSubject: () => "Pickup complete, enjoy your order!",
      getPlainBody: () => "Total Paid: $45.00",
      getDate: () => new Date("2026-10-15T12:00:00Z"),
    };
    const res1 = context.extractReceiptMetadata(disqualifiedMsg);
    expect(res1.disqualified).toBe(true);

    // 2. Qualified Labcorp payment
    const labcorpMsg = {
      getFrom: () => "billing@labcorp.com",
      getSubject: () => "Labcorp Payment Confirmation",
      getPlainBody: () => "Thank you. Confirmation Number: 20261015ABC\nAmount Paid: $24.50\nVisa ending in 5763",
      getDate: () => new Date("2026-10-15T12:00:00Z"),
    };
    const res2 = context.extractReceiptMetadata(labcorpMsg);
    expect(res2.disqualified).toBe(false);
    expect(res2.merchant).toBe("Labcorp (Laboratory Corporation of America)");
    expect(res2.category).toBe("Healthcare / Medical");
    expect(res2.amount).toBe(24.5);
    expect(res2.paymentMethod).toBe("Card ending in 5763");
    expect(res2.orderId).toBe("Conf #20261015ABC");

    // 3. Greenville County Vehicle Property Tax
    const taxMsg = {
      getFrom: () => "payments@greenvillecounty.org",
      getSubject: () => "Payment Confirmation",
      getPlainBody: () => "Total Paid: $312.80 using MasterCard .... 2062",
      getDate: () => new Date("2026-09-10T12:00:00Z"),
    };
    const res3 = context.extractReceiptMetadata(taxMsg);
    expect(res3.merchant).toBe("Greenville County Tax Collector");
    expect(res3.amount).toBe(312.8);
    expect(res3.paymentMethod).toBe("Card ending in 2062");
  });

  test("appendRowToSheet maps 10 columns for 2025 and 8 columns for 2026", () => {
    const appendedRows: Record<string, any[][]> = {};
    const { context } = loadGasContext("receipts-ingestion", {
      SpreadsheetApp: {
        openById: (id: string) => ({
          getSheetByName: () => ({
            appendRow: (row: any[]) => {
              appendedRows[id] = appendedRows[id] || [];
              appendedRows[id].push(row);
            },
          }),
          getSheets: () => [],
        }),
      },
    });

    const sample2025 = {
      year: 2025,
      merchant: "LEGO System A/S",
      date: "2025-11-01",
      amount: 319.2,
      paymentMethod: "Card ending in 5763",
      category: "Merchandise / Hobbies",
      orderId: "Invoice #1343079835",
      description: "LEGO Receipt",
    };
    context.appendRowToSheet("1BzwXcQpvlSJ1ccdmfOQ8COZ2EIBSDOQ0UP7he73Yj-Q", "LEGO.pdf", sample2025);
    expect(appendedRows["1BzwXcQpvlSJ1ccdmfOQ8COZ2EIBSDOQ0UP7he73Yj-Q"]?.[0]?.length).toBe(10);

    const sample2026 = { ...sample2025, year: 2026, date: "2026-10-01" };
    context.appendRowToSheet("194nQzKDYo0Bt8tfO1P1UBAD-dtDgSb7CWDatv61-ADI", "LEGO_2026.pdf", sample2026);
    expect(appendedRows["194nQzKDYo0Bt8tfO1P1UBAD-dtDgSb7CWDatv61-ADI"]?.[0]?.length).toBe(8);
  });
});

describe("2. Writing Style & Tone Reference Index (Code.gs)", () => {
  test("getIndexedFileIds extracts 25+ char Drive File IDs from full URLs", () => {
    const mockSheets: Record<string, any[][]> = {
      "Master Index": [
        ["Header"],
        ["https://docs.google.com/document/d/1ff-NNFmnDyMihct__f4bEkzNjfjPaOaK2gq65Jtn_hU/edit"],
      ],
      "Review_Queue": [
        ["Header"],
        ["1jhhFetAkdzPuk1aUaMrnonMlMc5NwciOXoX60Uo2j8g"],
      ],
      "Rejected Files": [
        ["Header"],
        ["https://drive.google.com/file/d/1mNEugS6WJ5i1x7sYgbAW3OGjWpiHOZetoo7r6Pl6-qo/view"],
      ],
    };

    const { context } = loadGasContext("writing-style-index");
    const ss = {
      getSheetByName: (name: string) => {
        const rows = mockSheets[name] || [];
        return {
          getLastRow: () => rows.length,
          getRange: () => ({
            getValues: () => rows.slice(1),
          }),
        };
      },
    };

    const ids: Set<string> = context.getIndexedFileIds(ss);
    expect(ids.has("1ff-NNFmnDyMihct__f4bEkzNjfjPaOaK2gq65Jtn_hU")).toBe(true);
    expect(ids.has("1jhhFetAkdzPuk1aUaMrnonMlMc5NwciOXoX60Uo2j8g")).toBe(true);
    expect(ids.has("1mNEugS6WJ5i1x7sYgbAW3OGjWpiHOZetoo7r6Pl6-qo")).toBe(true);
  });

  test("autoDiscoverExclusion only excludes a folder when that specific folder has >= 3 rejections", () => {
    let excludedValue = "";
    const { context } = loadGasContext("writing-style-index", {
      DriveApp: {
        getRootFolder: () => ({ getId: () => "ROOT_FOLDER_ID" }),
      },
    });

    const ss = {
      getSheetByName: (name: string) => {
        if (name === "Rejected Files") {
          return {
            getLastRow: () => 4,
            getRange: () => ({
              getValues: () => [
                ["Excluded [FolderID:OTHER_FOLDER]"],
                ["Excluded [FolderID:OTHER_FOLDER]"],
                ["Excluded [FolderID:TARGET_FOLDER]"],
              ],
            }),
          };
        }
        if (name === "System_Config") {
          return {
            getDataRange: () => ({
              getValues: () => [
                ["Setting Key", "Value"],
                ["EXCLUDED_FOLDER_IDS", ""],
              ],
            }),
            getRange: () => ({
              setValue: (v: string) => {
                excludedValue = v;
              },
            }),
          };
        }
        return null;
      },
    };

    // Only 2 total for TARGET_FOLDER (1 in sheet + 1 pending) -> should NOT exclude
    context.autoDiscoverExclusion(ss, "TARGET_FOLDER", [
      ["", "", "", "", "", "", "", "", "", "", "Excluded [FolderID:TARGET_FOLDER]"],
    ]);
    expect(excludedValue).toBe("");

    // Now 3 total for TARGET_FOLDER (1 in sheet + 2 pending) -> SHOULD exclude
    context.autoDiscoverExclusion(ss, "TARGET_FOLDER", [
      ["", "", "", "", "", "", "", "", "", "", "Excluded [FolderID:TARGET_FOLDER]"],
      ["", "", "", "", "", "", "", "", "", "", "Excluded [FolderID:TARGET_FOLDER]"],
    ]);
    expect(excludedValue).toBe("TARGET_FOLDER");
  });

  test("normalizeYearOrDateCell cleans float years and Excel serial dates, and applyApprovedTaxonomyMerges consolidates synonyms", () => {
    const { context } = loadGasContext("writing-style-index", {
      Utilities: {
        formatDate: (d: Date, _tz: string, fmt: string) =>
          fmt === "yyyy-MM-dd" ? d.toISOString().slice(0, 10) : d.toISOString().slice(0, 4),
      },
    });

    expect(context.normalizeYearOrDateCell("2025.0", false)).toBe("2025");
    expect(context.normalizeYearOrDateCell("46241.0", false)).toBe("2026");
    expect(context.normalizeYearOrDateCell("46237.0", true)).toBe("2026-08-03");

    let masterAudienceVals = [["TTRPG Players"], ["TTRPG Campaign Players"]];
    let deletedTaxRow = 0;
    let proposalStatus = "";

    const mockSS = {
      getSheetByName: (name: string) => {
        if (name === "Taxonomy_Proposals") {
          return {
            getLastRow: () => 2,
            getDataRange: () => ({
              getValues: () => [
                ["Category", "Proposed Consolidated Term", "Terms to Merge", "Status"],
                ["Audiences", "TTRPG Players & Game Masters", "TTRPG Players, TTRPG Campaign Players", "APPROVED"],
              ],
            }),
            getRange: () => ({
              setValue: (v: string) => {
                proposalStatus = v;
              },
            }),
          };
        }
        if (name === "Master Index") {
          return {
            getLastRow: () => 4,
            getRange: () => ({
              getValues: () => masterAudienceVals,
              setValues: (v: string[][]) => {
                masterAudienceVals = v;
              },
            }),
          };
        }
        if (name === "Audiences") {
          return {
            getLastRow: () => 3,
            getDataRange: () => ({
              getValues: () => [
                ["Term", "Description", "Example"],
                ["TTRPG Players & Game Masters", "Canonical term", "Ex"],
                ["TTRPG Players", "Synonym", "Ex"],
              ],
            }),
            deleteRow: (r: number) => {
              deletedTaxRow = r;
            },
          };
        }
        return null;
      },
    };

    context.applyApprovedTaxonomyMerges(mockSS);
    expect(masterAudienceVals).toEqual([
      ["TTRPG Players & Game Masters"],
      ["TTRPG Players & Game Masters"],
    ]);
    expect(deletedTaxRow).toBe(3);
    expect(proposalStatus).toBe("CONSOLIDATED");
  });

  test("classifySampleWithGemini cascades through dynamic model ladder on HTTP 429 quota exhaustion", () => {
    const attemptedUrls: string[] = [];
    const { context, logs } = loadGasContext("writing-style-index", {
      PropertiesService: {
        getScriptProperties: () => ({
          getProperty: (k: string) => {
            if (k === "GEMINI_API_KEY") return "fake_key_style";
            if (k === "GEMINI_MODEL_LADDER") return "gemini-2.5-flash,gemini-2.5-flash-lite";
            return null;
          },
        }),
      },
      UrlFetchApp: {
        fetch: (url: string, _opts: any) => {
          attemptedUrls.push(url);
          if (url.includes("gemini-2.5-flash:")) {
            return {
              getResponseCode: () => 429,
              getContentText: () => JSON.stringify({ error: { code: 429, message: "RESOURCE_EXHAUSTED" } }),
            };
          }
          if (url.includes("gemini-2.5-flash-lite:")) {
            return {
              getResponseCode: () => 200,
              getContentText: () => JSON.stringify({
                candidates: [{
                  content: {
                    parts: [{
                      text: JSON.stringify({
                        isAiGenerated: false,
                        rejectionReason: "",
                        hasAmbiguity: false,
                        audience: "TTRPG Game Masters",
                        topic: "Campaign Architecture",
                        style: "Analytical & Structured",
                        tone: "Encouraging & Direct",
                        exemplaryQuote: "Every encounter must test a choice, not just resource attrition.",
                        strategicNotes: "Exemplifies DM guidance principles.",
                        confidenceScore: 0.96,
                      })
                    }]
                  }
                }]
              }),
            };
          }
          return { getResponseCode: () => 500, getContentText: () => "error" };
        },
      },
      Utilities: {
        sleep: () => {},
      },
    });

    const config = {
      MODEL_LADDER: ["gemini-2.5-flash", "gemini-2.5-flash-lite"],
    };
    const result = context.classifySampleWithGemini("Sample prose text about campaign design.", "Session 10 Notes", config);
    expect(result).not.toBeNull();
    expect(result.audience).toBe("TTRPG Game Masters");
    expect(result._modelUsed).toBe("gemini-2.5-flash-lite");
    expect(logs.some((l: string) => l.includes('[MODEL_LADDER_ROTATE] Model "gemini-2.5-flash" quota exhausted (HTTP 429)'))).toBe(true);
    expect(logs.some((l: string) => l.includes('[SUCCESS] Style classification succeeded using model: "gemini-2.5-flash-lite"'))).toBe(true);
  });

  test("runMonthlyTaxonomyClustering handles model quota failover and stages merge proposals", () => {
    let proposalAppended: any[] = [];
    const mockProposalsSheet = {
      appendRow: (row: any[]) => { proposalAppended = row; },
    };
    const mockAudiencesSheet = {
      getLastRow: () => 4,
      getRange: () => ({
        getValues: () => [
          ["TTRPG Players"],
          ["TTRPG Campaign Players"],
          ["Game Masters"],
        ],
      }),
    };

    const mockSystemConfigSheet = {
      getDataRange: () => ({
        getValues: () => [
          ["Setting Key", "Value", "Description"],
          ["GEMINI_MODEL_LADDER", "gemini-2.5-flash,gemini-2.5-flash-lite", ""],
        ],
      }),
    };

    const mockSS = {
      getSheetByName: (name: string) => {
        if (name === "Taxonomy_Proposals") return mockProposalsSheet;
        if (name === "Audiences") return mockAudiencesSheet;
        if (name === "System_Config") return mockSystemConfigSheet;
        return null;
      },
      insertSheet: () => ({
        appendRow: () => {},
        getRange: () => ({ setFontWeight: () => {} }),
        setFrozenRows: () => {},
      }),
    };

    const { context } = loadGasContext("writing-style-index", {
      SpreadsheetApp: {
        openById: () => mockSS,
      },
      PropertiesService: {
        getScriptProperties: () => ({
          getProperty: (k: string) => {
            if (k === "GEMINI_API_KEY") return "fake_key_style";
            if (k === "GEMINI_MODEL_LADDER") return "gemini-2.5-flash,gemini-2.5-flash-lite";
            return null;
          },
        }),
      },
      UrlFetchApp: {
        fetch: (url: string, _opts: any) => {
          if (url.includes("gemini-2.5-flash:")) {
            return {
              getResponseCode: () => 429,
              getContentText: () => JSON.stringify({ error: { code: 429, message: "RESOURCE_EXHAUSTED" } }),
            };
          }
          if (url.includes("gemini-2.5-flash-lite:")) {
            return {
              getResponseCode: () => 200,
              getContentText: () => JSON.stringify({
                candidates: [{
                  content: {
                    parts: [{
                      text: JSON.stringify([
                        {
                          canonicalTerm: "TTRPG Players & Game Masters",
                          mergedTerms: ["TTRPG Players", "TTRPG Campaign Players"],
                        }
                      ])
                    }]
                  }
                }]
              }),
            };
          }
          return { getResponseCode: () => 500, getContentText: () => "error" };
        },
      },
      Utilities: {
        sleep: () => {},
      },
    });

    context.runMonthlyTaxonomyClustering();
    expect(proposalAppended).toEqual([
      "Audiences",
      "TTRPG Players & Game Masters",
      "TTRPG Players, TTRPG Campaign Players",
      "PENDING_APPROVAL"
    ]);
  });

  test("callGeminiAPI in writing-style-index bans daily-exhausted models until reset", () => {
    const scriptCacheStore: Record<string, string> = {};
    const scriptPropsStore: Record<string, string> = {};
    const attemptedUrls: string[] = [];

    const mockFetch = (url: string, _options: any) => {
      attemptedUrls.push(url);
      if (url.includes("gemini-2.5-flash:")) {
        return {
          getResponseCode: () => 429,
          getContentText: () => JSON.stringify({
            error: {
              code: 429,
              message: "Quota exceeded for quota metric 'GenerateContent requests per day' (Free tier per day limit reached)",
              status: "RESOURCE_EXHAUSTED"
            }
          })
        };
      }
      if (url.includes("gemini-2.5-flash-lite:")) {
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            candidates: [{
              content: { parts: [{ text: JSON.stringify({ isAiGenerated: false, audience: "General" }) }] }
            }]
          })
        };
      }
      return { getResponseCode: () => 500, getContentText: () => "error" };
    };

    const { context } = loadGasContext("writing-style-index", {
      UrlFetchApp: { fetch: mockFetch },
      CacheService: {
        getScriptCache: () => ({
          get: (k: string) => scriptCacheStore[k] || null,
          put: (k: string, v: string) => { scriptCacheStore[k] = v; }
        })
      },
      PropertiesService: {
        getScriptProperties: () => ({
          getProperty: (k: string) => scriptPropsStore[k] || null,
          setProperty: (k: string, v: string) => { scriptPropsStore[k] = v; },
          deleteProperty: (k: string) => { delete scriptPropsStore[k]; }
        })
      },
      Utilities: { sleep: () => {} }
    });

    const ladder = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];
    const res = context.callGeminiAPI({ test: 1 }, "fake_key", ladder);
    expect(res).not.toBeNull();
    expect(res.audience).toBe("General");
    expect(res._modelUsed).toBe("gemini-2.5-flash-lite");
    expect(context.isModelDailyExhausted("gemini-2.5-flash")).toBe(true);

    const activeLadder = context.getDynamicModelLadder("fake_key", ladder);
    expect(activeLadder).toEqual(["gemini-2.5-flash-lite"]);
  });
});

describe("3. Drive Tagging Automation (Code.gs)", () => {
  test("getQueuedFileIds prevents duplicate queueing and extractFileTextSnippet avoids raw PDF bytes", () => {
    const { context } = loadGasContext("drive-tagging");

    const mockQueueSheet = {
      getLastRow: () => 3,
      getRange: () => ({
        getValues: () => [["file_id_1"], ["file_id_2"]],
      }),
    };
    const queued: Set<string> = context.getQueuedFileIds(mockQueueSheet);
    expect(queued.has("file_id_1")).toBe(true);
    expect(queued.has("file_id_2")).toBe(true);

    // PDF file fallback in extractFileTextSnippet should return file name, not blob string
    let blobCalled = false;
    const pdfFile = {
      getMimeType: () => "application/pdf",
      getName: () => "Sample_Architecture_Spec.pdf",
      getBlob: () => {
        blobCalled = true;
        return { getDataAsString: () => "%PDF-1.5 binary garbage" };
      },
    };
    const snippet = context.extractFileTextSnippet(pdfFile, 100);
    expect(blobCalled).toBe(false);
    expect(snippet).toBe("Sample_Architecture_Spec.pdf");
  });

  test("classifyFileWithGemini cascades through dynamic model ladder on HTTP 429 quota exhaustion and records model used", () => {
    const attemptedUrls: string[] = [];
    const { context, logs } = loadGasContext("drive-tagging", {
      PropertiesService: {
        getScriptProperties: () => ({
          getProperty: (k: string) => {
            if (k === "GEMINI_API_KEY") return "fake_key_tagging";
            if (k === "GEMINI_MODEL_LADDER") return "gemini-2.5-flash,gemini-2.5-flash-lite";
            return null;
          },
        }),
      },
      UrlFetchApp: {
        fetch: (url: string, _opts: any) => {
          attemptedUrls.push(url);
          if (url.includes("gemini-2.5-flash:")) {
            return {
              getResponseCode: () => 429,
              getContentText: () => JSON.stringify({ error: { code: 429, message: "RESOURCE_EXHAUSTED" } }),
            };
          }
          if (url.includes("gemini-2.5-flash-lite:")) {
            return {
              getResponseCode: () => 200,
              getContentText: () => JSON.stringify({
                candidates: [{
                  content: {
                    parts: [{
                      text: JSON.stringify({
                        doc_type: "Campaign Setting Guide",
                        existing_tags: ["Worldbuilding", "Lore"],
                        new_tags: [],
                        confidence: 0.95,
                        reasoning: "Detailed architectural lore of the campaign setting.",
                      })
                    }]
                  }
                }]
              }),
            };
          }
          return { getResponseCode: () => 500, getContentText: () => "error" };
        },
      },
      Utilities: {
        sleep: () => {},
      },
    });

    const mockDocFile = {
      getId: () => "doc_123",
      getName: () => "Vasloria_Guide.gdoc",
      getMimeType: () => "text/plain",
      getBlob: () => ({ getDataAsString: () => "Vasloria is a high-medieval province in northern Aemoh." }),
    };

    const res = context.classifyFileWithGemini(mockDocFile, ["Worldbuilding", "Lore", "Rules"]);
    expect(res).not.toBeNull();
    expect(res.doc_type).toBe("Campaign Setting Guide");
    expect(res.existing_tags).toEqual(["Worldbuilding", "Lore"]);
    expect(res._modelUsed).toBe("gemini-2.5-flash-lite");
    expect(logs.some((l: string) => l.includes('[MODEL_LADDER_ROTATE] Model "gemini-2.5-flash" quota exhausted (HTTP 429)'))).toBe(true);
    expect(logs.some((l: string) => l.includes('[SUCCESS] Extracted tags using model: "gemini-2.5-flash-lite"'))).toBe(true);
  });

  test("discoverAvailableModels and isDailyQuotaError work identically across sister projects", () => {
    const mockModelsResponse = {
      models: [
        { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
        { name: "models/imagen-3.0-generate-002", supportedGenerationMethods: ["generateImages"] },
        { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-2.5-flash-lite", supportedGenerationMethods: ["generateContent"] },
      ]
    };

    const { context } = loadGasContext("drive-tagging", {
      UrlFetchApp: {
        fetch: () => ({
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify(mockModelsResponse),
        })
      },
      CacheService: { getScriptCache: () => null }
    });

    const discovered = context.discoverAvailableModels("key");
    expect(discovered).toEqual(["gemini-2.5-flash", "gemini-2.5-flash-lite"]);

    expect(context.isDailyQuotaError(429, "Quota exceeded for quota metric 'GenerateContent requests per day'")).toBe(true);
    expect(context.isDailyQuotaError(429, "Rate limit reached per minute")).toBe(false);
  });
});

describe("4. Semantic Knowledge Graph Ingestion (Code.gs)", () => {
  test("generateCypherSeed produces idempotent MERGE statements for vertices and relationships", () => {
    const { context } = loadGasContext("knowledge-graph-ingestion");

    const sampleGraphData = {
      entities: [
        { name: "James Introcaso", type: "Character", description: "Lead Designer at MCDM" },
        { name: "MCDM", type: "Faction", description: "Publishing studio" },
        { name: "O'Reilly Hall", type: "Location" },
      ],
      relationships: [
        { source: "James Introcaso", target: "MCDM", type: "ALLIED_WITH" },
        { source: "James Introcaso", target: "O'Reilly Hall", type: "LOCATED_IN" },
      ],
    };

    const cypher = context.generateCypherSeed("sample_session.md", sampleGraphData);

    // Verify MERGE statements for vertices (avoiding ArcadeDB UNIQUE index collisions)
    expect(cypher).toContain("MERGE (jamesintrocaso:Character {name: 'James Introcaso', description: 'Lead Designer at MCDM'})");
    expect(cypher).toContain("MERGE (mcdm:Faction {name: 'MCDM', description: 'Publishing studio'})");
    expect(cypher).toContain("MERGE (oreillyhall:Location {name: 'O\\'Reilly Hall'})");

    // Verify relationships use MATCH ... MERGE pattern
    expect(cypher).toContain("MATCH (src:Character {name: 'James Introcaso'}), (tgt:Faction {name: 'MCDM'})");
    expect(cypher).toContain("MERGE (src)-[:ALLIED_WITH]->(tgt);");
    expect(cypher).toContain("MATCH (src:Character {name: 'James Introcaso'}), (tgt:Location {name: 'O\\'Reilly Hall'})");
    expect(cypher).toContain("MERGE (src)-[:LOCATED_IN]->(tgt);");

    // Verify header comments
    expect(cypher).toContain("Auto-generated OpenCypher Migration Script: sample_session.md");
  });

  test("isAlreadyIngested detects schema_v metadata to ensure zero-token screening", () => {
    const { context } = loadGasContext("knowledge-graph-ingestion");

    const ingestedFile = {
      getDescription: () => JSON.stringify({
        schema_v: 1,
        kg_ingested: true,
        entities_count: 5,
        relationships_count: 3,
        seed_file: "03_ingested_20261030_120000.cypher",
      }),
    };
    expect(context.isAlreadyIngested(ingestedFile)).toBe(true);

    const uningestedFile = {
      getDescription: () => "Raw file uploaded from Drive without metadata",
    };
    expect(context.isAlreadyIngested(uningestedFile)).toBe(false);

    const emptyDescFile = {
      getDescription: () => "",
    };
    expect(context.isAlreadyIngested(emptyDescFile)).toBe(false);
  });

  test("buildGeminiPayload packages PDF via multimodal inlineData and plain text via text part", () => {
    let base64Called = false;
    const { context } = loadGasContext("knowledge-graph-ingestion", {
      Utilities: {
        formatDate: () => "2026-10-30",
        base64Encode: (b: any) => {
          base64Called = true;
          return "MOCK_BASE64_BYTES";
        },
      },
    });

    // 1. PDF handling
    const mockPdfFile = {
      getName: () => "campaign_guide.pdf",
      getId: () => "pdf_file_123",
      getBlob: () => ({
        getBytes: () => [37, 80, 68, 70], // %PDF
      }),
    };
    const pdfPayload = context.buildGeminiPayload(mockPdfFile, "application/pdf", false, false, true);
    expect(base64Called).toBe(true);
    expect(pdfPayload.contents[0].parts[0].inlineData.mimeType).toBe("application/pdf");
    expect(pdfPayload.contents[0].parts[0].inlineData.data).toBe("MOCK_BASE64_BYTES");

    // 2. Plain Text handling
    const mockTextFile = {
      getName: () => "session_notes.md",
      getId: () => "txt_file_456",
      getBlob: () => ({
        getDataAsString: () => "The heroes traveled through the Misty Forest and encountered the Shadow Druids at midnight.",
      }),
    };
    const textPayload = context.buildGeminiPayload(mockTextFile, "text/plain", false, true, false);
    expect(textPayload.contents[0].parts[0].text).toContain("Misty Forest");
  });

  test("getKGConfig reads from ScriptProperties with safe defaults", () => {
    const { context } = loadGasContext("knowledge-graph-ingestion", {
      PropertiesService: {
        getScriptProperties: () => ({
          getProperty: (key: string) => {
            if (key === "GEMINI_API_KEY") return "AIzaSyFakeKey123";
            if (key === "SOURCE_FOLDER_ID") return "source_folder_456";
            return null;
          },
        }),
      },
    });

    const cfg = context.getKGConfig();
    expect(cfg.apiKey).toBe("AIzaSyFakeKey123");
    expect(cfg.sourceFolderId).toBe("source_folder_456");
    expect(cfg.seedsFolderId).toBe("1v9uyJ_rnGGUsuytisYKH6YcM1nF60dkT");
    expect(cfg.modelName).toBe("gemini-2.5-flash");
  });

  test("testKGIngestionDryRun audits source folder and seed folder without modifying files", () => {
    const mockFiles = [
      {
        getName: () => "Arcadia_Issue_1.pdf",
        getId: () => "file_1",
        getDescription: () => JSON.stringify({ schema_v: 1, kg_ingested: true }),
      },
      {
        getName: () => "Session_Notes_12.md",
        getId: () => "file_2",
        getDescription: () => "",
      },
    ];

    let fileIdx = 0;
    const mockSourceFolder = {
      getId: () => "1AYeQE47BeJdxwAAa3x5_Z2_hTmyq9NVz",
      getName: () => "MCDM Archive",
      getFiles: () => ({
        hasNext: () => fileIdx < mockFiles.length,
        next: () => mockFiles[fileIdx++],
      }),
      getFolders: () => ({
        hasNext: () => false,
        next: () => null,
      }),
    };

    const mockSeedsFolder = {
      getId: () => "1v9uyJ_rnGGUsuytisYKH6YcM1nF60dkT",
      getName: () => "seeds",
    };

    const { context, logs } = loadGasContext("knowledge-graph-ingestion", {
      PropertiesService: {
        getScriptProperties: () => ({
          getProperty: (key: string) => {
            if (key === "GEMINI_API_KEY") return "AIzaSyFakeKey123";
            return null;
          },
        }),
      },
      DriveApp: {
        getFolderById: (id: string) => {
          if (id === "1AYeQE47BeJdxwAAa3x5_Z2_hTmyq9NVz") return mockSourceFolder;
          if (id === "1v9uyJ_rnGGUsuytisYKH6YcM1nF60dkT") return mockSeedsFolder;
          throw new Error("Folder not found: " + id);
        },
      },
    });

    const result = context.testKGIngestionDryRun();
    expect(result.apiKeyConfigured).toBe(true);
    expect(result.sourceFolder).toBe("MCDM Archive");
    expect(result.totalFolders).toBe(1);
    expect(result.totalFiles).toBe(2);
    expect(result.ingestedFiles).toBe(1);
    expect(result.pendingFiles).toBe(1);
    expect(result.seedsFolder).toBe("seeds");
    expect(logs.some((l: string) => l.includes("Recursive Tree Stats: 1 folders, 2 total files"))).toBe(true);
  });

  test("runIngestionPipeline recursively crawls nested subfolders and processes eligible files in child folders", () => {
    let arcadiaFileIdx = 0;
    let createdSeedName = "";
    let createdSeedContent = "";

    const arcadiaFile = {
      getId: () => "arcadia_file_10",
      getName: () => "Arcadia-10_Color.pdf",
      getMimeType: () => "application/pdf",
      getSize: () => 8.5 * 1024 * 1024, // 8.5 MB
      getBlob: () => ({
        getBytes: () => [1, 2, 3],
      }),
      getDescription: () => "",
      setDescription: (_d: string) => {},
    };

    const mockArcadiaFolder = {
      getId: () => "folder_arcadia",
      getName: () => "Arcadia",
      getFiles: () => ({
        hasNext: () => arcadiaFileIdx < 1,
        next: () => {
          arcadiaFileIdx++;
          return arcadiaFile;
        },
      }),
      getFolders: () => ({
        hasNext: () => false,
        next: () => null,
      }),
    };

    let rootSubfoldersIdx = 0;
    const mockRootFolder = {
      getId: () => "1AYeQE47BeJdxwAAa3x5_Z2_hTmyq9NVz",
      getName: () => "MCDM Archive",
      getFiles: () => ({
        hasNext: () => false, // No files directly in root
        next: () => null,
      }),
      getFolders: () => ({
        hasNext: () => rootSubfoldersIdx < 1,
        next: () => {
          rootSubfoldersIdx++;
          return mockArcadiaFolder;
        },
      }),
    };

    const mockSeedsFolder = {
      getId: () => "1v9uyJ_rnGGUsuytisYKH6YcM1nF60dkT",
      getName: () => "seeds",
      createFile: (name: string, content: string, _type: any) => {
        createdSeedName = name;
        createdSeedContent = content;
      },
    };

    const { context, logs } = loadGasContext("knowledge-graph-ingestion", {
      PropertiesService: {
        getScriptProperties: () => ({
          getProperty: (key: string) => {
            if (key === "GEMINI_API_KEY") return "AIzaSyFakeKey123";
            return null;
          },
        }),
      },
      DriveApp: {
        getFolderById: (id: string) => {
          if (id === "1AYeQE47BeJdxwAAa3x5_Z2_hTmyq9NVz") return mockRootFolder;
          if (id === "1v9uyJ_rnGGUsuytisYKH6YcM1nF60dkT") return mockSeedsFolder;
          throw new Error("Folder not found: " + id);
        },
      },
      UrlFetchApp: {
        fetch: (url: string) => {
          if (url.includes("/v1beta/models?key=")) {
            return {
              getResponseCode: () => 200,
              getContentText: () => JSON.stringify({
                models: [{ name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] }]
              }),
            };
          }
          if (url.includes(":generateContent")) {
            return {
              getResponseCode: () => 200,
              getContentText: () => JSON.stringify({
                candidates: [{
                  content: {
                    parts: [{
                      text: JSON.stringify({
                        entities: [{ name: "Workshop Watching", type: "Item", description: "Arcadia article" }],
                        relationships: []
                      })
                    }]
                  }
                }]
              }),
            };
          }
          return { getResponseCode: () => 404, getContentText: "Not found" };
        },
      },
      Utilities: {
        formatDate: () => "20261031_211500",
        base64Encode: () => "base64data",
        sleep: () => {},
      },
    });

    const res = context.runIngestionPipeline();
    expect(res.status).toBe("SUCCESS");
    expect(res.processed).toBe(1);
    expect(createdSeedName).toBe("03_ingested_20261031_211500.cypher");
    expect(createdSeedContent).toContain("Workshop Watching");
    expect(logs.some((l: string) => l.includes('[CRAWL] Scanning folder: "MCDM Archive"'))).toBe(true);
    expect(logs.some((l: string) => l.includes('[CRAWL] Scanning folder: "Arcadia"'))).toBe(true);
    expect(logs.some((l: string) => l.includes('[SUCCESS] Created OpenCypher seed file: 03_ingested_20261031_211500.cypher'))).toBe(true);
  });

  test("setupKGTriggers replaces existing triggers and creates a 30-minute interval trigger", () => {
    let deletedCount = 0;
    let createdTrigger: any = null;

    const mockTriggers = [
      { getHandlerFunction: () => "runIngestionPipeline" },
      { getHandlerFunction: () => "someOtherHandler" },
    ];

    const { context, logs } = loadGasContext("knowledge-graph-ingestion", {
      ScriptApp: {
        getProjectTriggers: () => mockTriggers,
        deleteTrigger: (_t: any) => { deletedCount++; },
        newTrigger: (handler: string) => ({
          timeBased: () => ({
            everyMinutes: (m: number) => ({
              create: () => {
                createdTrigger = { handler, intervalMinutes: m };
                return createdTrigger;
              },
            }),
          }),
        }),
      },
    });

    context.setupKGTriggers();
    expect(deletedCount).toBe(1);
    expect(createdTrigger).toEqual({ handler: "runIngestionPipeline", intervalMinutes: 30 });
    expect(logs.some((l: string) => l.includes("[SUCCESS] Installed 30-minute recurring time trigger"))).toBe(true);
  });

  test("callGeminiAPI cascades to fallback models on HTTP 429 quota exhaustion", () => {
    const attemptedUrls: string[] = [];
    let sleepCalled = false;

    const mockFetch = (url: string, _options: any) => {
      attemptedUrls.push(url);
      if (url.includes("gemini-2.5-flash:")) {
        // Primary model is rate-limited (HTTP 429)
        return {
          getResponseCode: () => 429,
          getContentText: () => JSON.stringify({ error: { code: 429, message: "RESOURCE_EXHAUSTED" } }),
        };
      }
      if (url.includes("gemini-2.5-flash-lite:")) {
        // Fallback Tier 2 succeeds
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            candidates: [{
              content: {
                parts: [{
                  text: JSON.stringify({
                    entities: [{ name: "Matthew Colville", type: "Character" }],
                    relationships: []
                  })
                }]
              }
            }]
          }),
        };
      }
      return { getResponseCode: () => 500, getContentText: () => "error" };
    };

    const { context, logs } = loadGasContext("knowledge-graph-ingestion", {
      UrlFetchApp: { fetch: mockFetch },
      Utilities: {
        sleep: (_ms: number) => { sleepCalled = true; },
      },
    });

    const result = context.callGeminiAPI({ test: "payload" }, "fake_api_key", [
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite"
    ]);

    expect(sleepCalled).toBe(true);
    expect(result).not.toBeNull();
    expect(result.entities[0].name).toBe("Matthew Colville");
    // Verify rotation occurred from flash -> flash-lite
    expect(attemptedUrls.filter(u => u.includes("gemini-2.5-flash:")).length).toBe(2); // Initial + 1 backoff retry
    expect(attemptedUrls.filter(u => u.includes("gemini-2.5-flash-lite:")).length).toBe(1);
    expect(logs.some((l: string) => l.includes('[MODEL_LADDER_ROTATE] Model "gemini-2.5-flash" quota exhausted (HTTP 429)'))).toBe(true);
    expect(logs.some((l: string) => l.includes('[SUCCESS] Extracted graph entities using model: "gemini-2.5-flash-lite"'))).toBe(true);
  });

  test("callGeminiAPI handles exhaustion of entire ladder gracefully without crashing", () => {
    const attemptedModels: string[] = [];

    const mockFetch = (url: string, _options: any) => {
      const match = url.match(/models\/([^:]+):/);
      if (match && match[1]) attemptedModels.push(match[1]);
      return {
        getResponseCode: () => 429,
        getContentText: () => JSON.stringify({ error: { code: 429, message: "RESOURCE_EXHAUSTED" } }),
      };
    };

    const { context, logs } = loadGasContext("knowledge-graph-ingestion", {
      UrlFetchApp: { fetch: mockFetch },
      Utilities: {
        sleep: () => {},
      },
    });

    const ladder = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-1.5-flash"];
    const result = context.callGeminiAPI({ test: "payload" }, "fake_api_key", ladder);

    expect(result).toBeNull();
    expect(logs.some((l: string) => l.includes("[MODEL_LADDER_EXHAUSTED]"))).toBe(true);
  });

  test("discoverAvailableModels dynamically queries, filters non-text/embedding models, and ranks multimodal candidates", () => {
    const mockModelsResponse = {
      models: [
        { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
        { name: "models/imagen-3.0-generate-002", supportedGenerationMethods: ["generateImages"] },
        { name: "models/gemini-2.5-flash-preview-tts", supportedGenerationMethods: ["generateContent"] },
        { name: "models/lyria-3.5", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-2.5-flash-lite", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-3.5-flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-4-argon", supportedGenerationMethods: ["generateContent"] },
      ]
    };

    const { context } = loadGasContext("knowledge-graph-ingestion", {
      UrlFetchApp: {
        fetch: (url: string) => {
          if (url.includes("/v1beta/models?key=")) {
            return {
              getResponseCode: () => 200,
              getContentText: () => JSON.stringify(mockModelsResponse),
            };
          }
          return { getResponseCode: () => 404, getContentText: () => "Not found" };
        }
      },
      CacheService: {
        getScriptCache: () => null, // force live fetch
      }
    });

    const discovered = context.discoverAvailableModels("test_api_key");
    // Should filter out text-embedding, imagen, tts, lyria, leaving only gemini multimodal models ranked by priority
    expect(discovered).toEqual([
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-3.5-flash",
      "gemini-2.5-pro",
      "gemini-4-argon"
    ]);
  });

  test("isDailyQuotaError correctly differentiates daily rate limit (RPD) from per-minute limit (RPM)", () => {
    const { context } = loadGasContext("knowledge-graph-ingestion");

    const dailyError = JSON.stringify({
      error: {
        code: 429,
        message: "Quota exceeded for quota metric 'GenerateContent requests' and limit 'GenerateContent requests per day' of service 'generativelanguage.googleapis.com'",
        status: "RESOURCE_EXHAUSTED"
      }
    });

    const rpmError = JSON.stringify({
      error: {
        code: 429,
        message: "Resource exhausted. Quota exceeded for quota metric 'Queries' and limit 'Queries per minute'",
        status: "RESOURCE_EXHAUSTED"
      }
    });

    expect(context.isDailyQuotaError(429, dailyError)).toBe(true);
    expect(context.isDailyQuotaError(429, rpmError)).toBe(false);
    expect(context.isDailyQuotaError(200, dailyError)).toBe(false);
  });

  test("callGeminiAPI bans daily-exhausted models and skips them on subsequent invocations", () => {
    const scriptCacheStore: Record<string, string> = {};
    const scriptPropsStore: Record<string, string> = {};
    const attemptedUrls: string[] = [];

    const mockFetch = (url: string, _options: any) => {
      attemptedUrls.push(url);
      if (url.includes("gemini-2.5-flash:")) {
        // Returns explicit daily quota exhaustion error
        return {
          getResponseCode: () => 429,
          getContentText: () => JSON.stringify({
            error: {
              code: 429,
              message: "Quota exceeded for quota metric 'GenerateContent requests per day' (Free tier per day limit reached)",
              status: "RESOURCE_EXHAUSTED"
            }
          })
        };
      }
      if (url.includes("gemini-2.5-flash-lite:")) {
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            candidates: [{
              content: { parts: [{ text: JSON.stringify({ entities: [{ name: "Ajax", type: "Character" }], relationships: [] }) }] }
            }]
          })
        };
      }
      return { getResponseCode: () => 500, getContentText: () => "error" };
    };

    const mockCache = {
      get: (k: string) => scriptCacheStore[k] || null,
      put: (k: string, v: string) => { scriptCacheStore[k] = v; }
    };
    const mockProps = {
      getProperty: (k: string) => scriptPropsStore[k] || null,
      setProperty: (k: string, v: string) => { scriptPropsStore[k] = v; },
      deleteProperty: (k: string) => { delete scriptPropsStore[k]; }
    };

    const { context, logs } = loadGasContext("knowledge-graph-ingestion", {
      UrlFetchApp: { fetch: mockFetch },
      CacheService: { getScriptCache: () => mockCache },
      PropertiesService: { getScriptProperties: () => mockProps },
      Utilities: { sleep: () => {} }
    });

    // 1st run: gemini-2.5-flash hits daily limit, fails over immediately to gemini-2.5-flash-lite
    const ladder = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];
    const res1 = context.callGeminiAPI({ doc: 1 }, "key_123", ladder);
    expect(res1).not.toBeNull();
    expect(res1.entities[0].name).toBe("Ajax");
    expect(logs.some((l: string) => l.includes('[DAILY_LIMIT_EXCEEDED] Model "gemini-2.5-flash" hit daily quota limit'))).toBe(true);

    // Verify model was marked exhausted in cache and properties
    expect(scriptCacheStore["DAILY_EXHAUSTED_gemini-2.5-flash"]).toBe("true");
    expect(context.isModelDailyExhausted("gemini-2.5-flash")).toBe(true);

    // 2nd run: Calling getDynamicModelLadder automatically filters out the daily-exhausted model
    const dynamicLadder = context.getDynamicModelLadder("key_123", ladder);
    expect(dynamicLadder).toEqual(["gemini-2.5-flash-lite"]);

    // Subsequent callGeminiAPI directly starts with gemini-2.5-flash-lite without wasting a call on flash!
    const attemptedCountBeforeRes2 = attemptedUrls.length;
    const res2 = context.callGeminiAPI({ doc: 2 }, "key_123", ladder);
    expect(res2).not.toBeNull();
    // Only 1 fetch should have occurred for res2 (directly calling gemini-2.5-flash-lite)
    expect(attemptedUrls.length).toBe(attemptedCountBeforeRes2 + 1);
    expect(attemptedUrls[attemptedUrls.length - 1]).toContain("gemini-2.5-flash-lite:");
  });
});

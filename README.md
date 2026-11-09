# Gemini Spark — Google Apps Script Automations & Shared Core Library

This repository contains the production source code, unit tests, clasp bindings, and shared infrastructure for the Google Workspace automations powering the `gemini-spark` ecosystem.

## Repository Architecture

```text
├── core/                                     # SparkCore: Reusable Google Apps Script Library
│   ├── appsscript.json                       # Standalone Library manifest & scopes
│   ├── .clasp.json                           # Clasp configuration for standalone deployment
│   └── src/
│       ├── GeminiFleet.js                    # Full-fleet model discovery, Flash-first ladder, 429 daily quota tracking
│       ├── DriveMetadata.js                  # Direct-to-storage Schema v1 JSONL file descriptions (zero-token screening)
│       ├── DriveUtils.js                     # Safe doc creation, recursive BFS crawler, 25+ char ID extraction
│       ├── SheetKit.js                       # Queue deduplication, float year & Excel date normalizers, chunked appends
│       ├── Harness.js                        # 4-minute execution timer budget supervisor & error dispatching
│       ├── SparkCore.js                      # Cohesive namespace & direct facade methods
│       └── index.js                          # CommonJS / module entry point
├── projects/                                 # Production Pipeline Implementations
│   ├── receipts-ingestion/                   # Zero-token Gmail-to-Drive financial receipts pipeline
│   ├── writing-style-index/                  # Tone & prose analysis, rejection learning, monthly taxonomy clustering
│   ├── drive-tagging/                        # Direct-to-storage Schema v1 JSONL drive classifier & tagger
│   └── knowledge-graph-ingestion/            # Cypher seed generator & multimodal document extractor
├── scripts/                                  # Offline Companion CLI Tools & Pre-Chunking Fleet
│   ├── fleet_prechunker.py                   # Automated TOC & page-budgeted PDF pre-chunker (< 13.5 MB)
│   ├── scan_3rd_party_archives.py            # Recursive BFS metadata crawler for 3rd Party Archives
│   ├── scan_suppliments.py                   # Recursive BFS metadata crawler for Suppliments hierarchy
│   └── prechunk_oversized_books.py           # Legacy rulebook prechunker engine
├── spark-wheels/                             # Airgapped Python Wheel Depot & Offline Runner
├── docs/                                     # Engineering Specifications, SOPs & Governance Rubrics
│   └── IMPLEMENTATION_PLAN.md                # System Architecture, Subsystem Requirements & CI Design
├── test/
│   ├── core.test.ts                          # Comprehensive SparkCore unit tests (42 tests)
│   └── apps_script.test.ts                   # Production pipeline regression tests (23 tests)
├── tests/
│   └── python/                               # Python parser & prechunker unit tests (11 tests)
└── deploy.sh                                 # Clasp multi-project build & deployment runner
```

## Production Pipeline Matrix

| Pipeline / System | Script ID & Clasp Target | Bound Target / Resource | Execution Triggers |
| :--- | :--- | :--- | :--- |
| **SparkCore Library** (`core/`) | [`1ivaQzWjBEYWT0bfohNiZR9acwhrIGJSF9TXSsDmM_wvxeqN2f3RgmWVh`](https://script.google.com/d/1ivaQzWjBEYWT0bfohNiZR9acwhrIGJSF9TXSsDmM_wvxeqN2f3RgmWVh/edit) (v1.0.0) | Global Apps Script Standalone Library | Exported library namespace `SparkCore` |
| **1. Financial Receipts Ingestion** (`projects/receipts-ingestion`) | [`1PzJn5MJCCE4K0UhZHqS9rboJUpjR7P5psLi1DjQxPpHmKKPAIuxQdkfJ`](https://script.google.com/d/1PzJn5MJCCE4K0UhZHqS9rboJUpjR7P5psLi1DjQxPpHmKKPAIuxQdkfJ/edit) | [2026 Receipts Inventory](https://docs.google.com/spreadsheets/d/194nQzKDYo0Bt8tfO1P1UBAD-dtDgSb7CWDatv61-ADI/edit) | `setupDailyTrigger()` (Zero-token) |
| **2. Writing Style Index** (`projects/writing-style-index`) | [`1yuepYNbNxeZmYvy7LfmNeN6k1XgKgn-jWNA3nNkHlWgAXdEPfbIzDIwu`](https://script.google.com/d/1yuepYNbNxeZmYvy7LfmNeN6k1XgKgn-jWNA3nNkHlWgAXdEPfbIzDIwu/edit) | [Writing Style & Tone Reference Index](https://docs.google.com/spreadsheets/d/1HPY3pKrgzeJr1FMLiK_UNyNJcfPTanJoPRL3ikF_nA8/edit) | `setupAllTriggers()` (Scans every 4h, Monthly clustering) |
| **3. Drive Tagging Automation** (`projects/drive-tagging`) | [`1F2-pZJZ1jzfoNS7EgnQOYXOwii5YEU7rFOMKOWN52k2GQcWrBpPbp2-w`](https://script.google.com/d/1F2-pZJZ1jzfoNS7EgnQOYXOwii5YEU7rFOMKOWN52k2GQcWrBpPbp2-w/edit) | [Drive Tagging Master Index](https://docs.google.com/spreadsheets/d/1XE78-Gae0a5DfkuC0lJcy62XjreqPIPovy8LuoAT3gA/edit) | `setupTaggingTriggers()` (Scans every 6h, Sync every 2h) |
| **4. Knowledge Graph Ingestion** (`projects/knowledge-graph-ingestion`) | [`1WLRQ7rZnz-LmtKmssiCyjrm8vL2ikG-KdPjTfiSI28TuB6F2XdP21kFZ`](https://script.google.com/d/1WLRQ7rZnz-LmtKmssiCyjrm8vL2ikG-KdPjTfiSI28TuB6F2XdP21kFZ/edit) | Seed Cypher Output Folder & Master Catalog | `setupKGTriggers()` (Interval crawler every 30m) |

## SparkCore Shared Modules

### 1. `GeminiFleet`
- **Dynamic Full-Fleet Discovery:** Queries `GET /v1beta/models`, strips non-multimodal endpoints (`embedding`, `image`, `tts`), and ranks candidate models Flash-first (`2.5-flash` -> `2.5-flash-lite` -> `3.5-flash` -> `2.5-pro` -> `4-argon`).
- **Canonical Model Ladder (`DEFAULT_MODEL_LADDER`):** Exports the centralized 18-tier model prioritization ladder, accessible via `SparkCore.DEFAULT_MODEL_LADDER` and `SparkCore.getDynamicModelLadder(apiKey, configLadder)`.
- **429 Quota Tracking:** Distinguishes transient per-minute rate limits (RPM) from hard daily exhaustion (RPD). Automatically bans exhausted models across `CacheService` and `ScriptProperties` until midnight UTC.
- **Failover Cascade:** Automatically cascades across fallback models when quotas are exhausted, injecting `_modelUsed` provenance onto returned JSON.

### 2. `DriveMetadata`
- **Schema v1 JSONL Direct-to-Storage:** Encodes machine-readable JSONL into Google Drive's native 1,024-character `description` property:
  ```json
  {"schema_v": 1, "doc_type": "Invoice", "tags": ["Tax / Financial Record"], "confidence": 0.98, "tagged_by": "gemini_auto"}
  ```
- **Zero-Token Pre-Flight Screening:** Allows scheduled scripts to screen Drive folders with 0 LLM API calls simply by checking if `description.includes('"schema_v"')`.
- **Progressive Tag Trimming:** If metadata exceeds Drive's 1,024-byte boundary, tags are trimmed progressively down to 0 tags before failing.

### 3. `DriveUtils`
- **Safe Document Creation:** Solves the Apps Script runtime trap where `DriveApp.Folder.createFile` fails on `MimeType.GOOGLE_DOCS` by using `DocumentApp.create` + `file.moveTo`.
- **Recursive BFS Crawler:** Crawls folder hierarchies with visited ID set detection, execution time limits, and depth bounding.
- **Drive ID Extraction:** Robust regex extraction `/([-\w]{25,})/` that converts URLs into pure File IDs (`SparkCore.extractFileId`).
- **Hierarchy & Filter Helpers:** Provides `getPrimaryParentId`, `isFolderExcluded`, and `isTitleExcluded` for fast pre-filtering.
- **Multi-Format Text Extraction:** Safely extracts text from Google Docs, Google Slides shapes, and text/markdown files while avoiding raw PDF binary dumping.

### 4. `SheetKit`
- **Queue Deduplication:** Scans existing `Review_Queue` tabs to extract pending File IDs, preventing infinite duplicate queuing across scheduled runs.
- **Data Normalizers:** Sanitizes float years (`2025.0` -> `2025`) and Excel serial dates (`46241.0` -> `2026-08-07`).
- **Formula Injection Defense:** Neutralizes CSV/formula injection characters (`=`, `+`, `-`, `@`, `\t`, `\r`) via `SparkCore.sanitizeCellValue`.
- **In-Place Column Hygiene:** Batch deduplication (`deduplicateRowsByColumn`), column date cleaning (`normalizeDateColumn`), and missing description backfilling (`backfillEmptyCells`).
- **Taxonomy Synonym Merging:** Dynamically maps approved synonym tags to canonical definitions.
- **Chunked Batch Appends:** Chunks row insertions to stay within spreadsheet memory constraints with automatic grid expansion.

### 5. `Harness`
- **Execution Budget Supervisor:** Tracks elapsed script time against Google's 6-minute cutoff (default budget: 240,000 ms), cleanly yielding execution before abrupt termination (`createExecutionBudget`).
- **Trigger Lifecycle Management:** Idempotent management for project triggers (`clearTriggers`, `installDailyTrigger`, `installIntervalTrigger`, `installWeeklyTrigger`).
- **Consolidated Alerting & Notifications:** Google Tasks integration with fallback email routing (`createTaskAlert`) and multi-recipient email digest dispatching (`sendEmailDigest`).

## Offline Companion Tier: Fleet Pre-Chunking Architecture

Google Apps Script's V8 engine enforces a strict **15.0 MB heap allocation ceiling** (`Exceeded memory limit`). Any multi-megabyte PDF ($\ge 14.0$ MB) ingested via `DriveApp` or `UrlFetchApp` causes unrecoverable out-of-memory crashes.

To eliminate this bottleneck across knowledge extraction pipelines, the offline companion tier (`scripts/`) provides an automated, quota-safe pre-chunking fleet:

1. **Dual Slicing Engine (`scripts/fleet_prechunker.py`):**
   - **TOC Bookmark Hierarchy:** Extracts Level 1 and Level 2 bookmarks to slice books cleanly by chapter.
   - **Dynamic Page Budgeting:** For flat/unindexed PDFs, dynamically calculates pages per chunk to target ~8 MB sub-PDFs.
   - **Recursive Binary Bisection:** If any sliced chapter exceeds 13.5 MB, it is recursively bisected into Part 1 and Part 2.
2. **150 DPI Single-Page Raster Optimization:**
   - Uncompressed 300–600 DPI bitmap foldouts and maps (which can reach 20+ MB on a single page) are intercepted and re-encoded via PyMuPDF image insertion at 150 DPI, compressing 22 MB single pages down to 1.5–4.0 MB.
3. **Quota-Safe Drive Uploads:**
   - Implements 1.2s courteous delay between Drive API uploads.
   - 4-tier exponential backoff with jitter on `googleapi: Error 403: RATE_LIMIT_EXCEEDED (Requests per minute)`.
4. **Dynamic Drive Hierarchy Routing:**
   - Accepts any inventory JSON and state file.
   - Automatically checks or creates an `Extracted_Chapters` folder inside the source book's parent directory, uploading all compliant sub-PDFs ($< 13.5$ MB).

### Production Fleet Scorecard

| Target Drive Archive | Root ID | Folders Crawled | Files Scanned | Oversized Books ($\ge 14$ MB) | Generated Sub-PDF Chapters | Max Chunk Size |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| **3rd Party Archives** | `13Ovbl0JQZ3EGXDBY7UDFeSP6gd8_sHTC` | 689 | 3,206 | **79** (11 publishers) | **887** | $\le 13.5$ MB |
| **Suppliments** | `1RgAo-hdJ8qIERzyaa1xfvH9DZyhffsO9` | 24 | 1,005 | **40** (7 subdirs) | **597** | $\le 13.5$ MB |
| **Total Fleet** | — | **713** | **4,211** | **119 books** | **1,484 chapters** | **100% compliant** |

## Testing & Deployment

```bash
# Run complete test suite (SparkCore + Pipeline regressions)
bun test

# Run offline Python prechunker & crawler test suite
python3 -m pytest tests/

# Deploy all projects and shared library via clasp
./deploy.sh
```

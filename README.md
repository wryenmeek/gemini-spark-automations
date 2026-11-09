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
├── docs/                                     # Engineering Specifications, SOPs & Governance Rubrics
│   └── IMPLEMENTATION_PLAN.md                # System Architecture, Subsystem Requirements & CI Design
├── test/
│   ├── core.test.ts                          # Comprehensive SparkCore unit tests (59 tests)
│   └── apps_script.test.ts                   # Production pipeline regression tests (23 tests)
├── tests/
│   └── python/                               # Python parser & prechunker unit tests (11 tests)
└── deploy.sh                                 # Clasp multi-project build & deployment runner
```

## Production Pipeline Matrix

| Pipeline / System | Script ID & Clasp Target | Bound Target / Resource | Execution Triggers |
| :--- | :--- | :--- | :--- |
| **SparkCore Library** (`core/`) | Standalone Library | Global Apps Script Library | Referenced via library ID `SparkCore` |
| **1. Financial Receipts Ingestion** (`projects/receipts-ingestion`) | [`1PzJn5MJCCE4K0UhZHqS9rboJUpjR7P5psLi1DjQxPpHmKKPAIuxQdkfJ`](https://script.google.com/d/1PzJn5MJCCE4K0UhZHqS9rboJUpjR7P5psLi1DjQxPpHmKKPAIuxQdkfJ/edit) | [2026 Receipts Inventory](https://docs.google.com/spreadsheets/d/194nQzKDYo0Bt8tfO1P1UBAD-dtDgSb7CWDatv61-ADI/edit) | `setupDailyTrigger()` (Zero-token) |
| **2. Writing Style Index** (`projects/writing-style-index`) | [`1yuepYNbNxeZmYvy7LfmNeN6k1XgKgn-jWNA3nNkHlWgAXdEPfbIzDIwu`](https://script.google.com/d/1yuepYNbNxeZmYvy7LfmNeN6k1XgKgn-jWNA3nNkHlWgAXdEPfbIzDIwu/edit) | [Writing Style & Tone Reference Index](https://docs.google.com/spreadsheets/d/1HPY3pKrgzeJr1FMLiK_UNyNJcfPTanJoPRL3ikF_nA8/edit) | `setupAllTriggers()` (Scans every 4h, Monthly clustering) |
| **3. Drive Tagging Automation** (`projects/drive-tagging`) | [`1F2-pZJZ1jzfoNS7EgnQOYXOwii5YEU7rFOMKOWN52k2GQcWrBpPbp2-w`](https://script.google.com/d/1F2-pZJZ1jzfoNS7EgnQOYXOwii5YEU7rFOMKOWN52k2GQcWrBpPbp2-w/edit) | [Drive Tagging Master Index](https://docs.google.com/spreadsheets/d/1XE78-Gae0a5DfkuC0lJcy62XjreqPIPovy8LuoAT3gA/edit) | `setupTaggingTriggers()` (Scans every 6h, Sync every 2h) |
| **4. Knowledge Graph Ingestion** (`projects/knowledge-graph-ingestion`) | [`1WLRQ7rZnz-LmtKmssiCyjrm8vL2ikG-KdPjTfiSI28TuB6F2XdP21kFZ`](https://script.google.com/d/1WLRQ7rZnz-LmtKmssiCyjrm8vL2ikG-KdPjTfiSI28TuB6F2XdP21kFZ/edit) | Seed Cypher Output Folder & Master Catalog | `setupKGTriggers()` (Interval crawler every 30m) |

## SparkCore Shared Modules

### 1. `GeminiFleet`
- **Dynamic Full-Fleet Discovery:** Queries `GET /v1beta/models`, strips non-multimodal endpoints (`embedding`, `image`, `tts`), and ranks candidate models Flash-first (`2.5-flash` -> `2.5-flash-lite` -> `3.5-flash` -> `2.5-pro` -> `4-argon`).
- **429 Quota Tracking:** Distinguishes transient per-minute rate limits (RPM) from hard daily exhaustion (RPD). Automatically bans exhausted models across `CacheService` and `ScriptProperties` until midnight UTC.

### 2. `DriveMetadata`
- **Schema v1 JSONL Direct-to-Storage:** Encodes machine-readable JSONL into Google Drive's native 1,024-character `description` property:
  ```json
  {"schema_v": 1, "doc_type": "Invoice", "tags": ["Tax / Financial Record"], "confidence": 0.98, "tagged_by": "gemini_auto"}
  ```
- **Zero-Token Pre-Flight Screening:** Allows scheduled scripts to screen Drive folders with 0 LLM API calls simply by checking if `description.includes('"schema_v"')`.

### 3. `DriveUtils`
- **Safe Document Creation:** Solves the Apps Script runtime trap where `DriveApp.Folder.createFile` fails on `MimeType.GOOGLE_DOCS` by using `DocumentApp.create` + `file.moveTo`.
- **Recursive BFS Crawler:** Crawls folder hierarchies with visited ID set detection, execution time limits, and depth bounding.
- **Drive ID Extraction:** Robust regex extraction `/([-\w]{25,})/` that converts URLs into pure File IDs.
- **Safe Text Extraction:** Protects against raw PDF byte dumping into LLM prompts.

### 4. `SheetKit`
- **Queue Deduplication:** Scans existing `Review_Queue` tabs to extract pending File IDs, preventing infinite duplicate queuing across scheduled runs.
- **Data Normalizers:** Sanitizes float years (`2025.0` -> `2025`) and Excel serial dates (`46241.0` -> `2026-08-07`).
- **Taxonomy Synonym Merging:** Dynamically maps approved synonym tags to canonical definitions.
- **Chunked Batch Appends:** Chunks row insertions to stay within spreadsheet memory constraints.

### 5. `Harness`
- **Execution Budget Supervisor:** Tracks elapsed script time against Google's 6-minute cutoff (default budget: 240,000 ms), cleanly yielding execution before abrupt termination.
- **Structured Error Dispatching:** Formats error reports and dispatches alert emails via `MailApp` / `GmailApp`.

## Testing & Deployment

```bash
# Run complete test suite (SparkCore + Pipeline regressions)
bun test

# Deploy all projects and shared library via clasp
./deploy.sh
```

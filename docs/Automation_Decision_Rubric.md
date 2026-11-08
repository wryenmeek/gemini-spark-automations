# Automation Decision Rubric: Google Apps Script vs. Local Python

This reference guide establishes the Information Architecture and execution rubric for deciding when to maintain code in **Google Apps Script** (cloud background automation) versus **Local Python** (interactive sandbox execution).

---

## 1. Execution Environment Comparison

| Dimension | Google Apps Script (`.gs`) | Spark's Local Python (`vm_shell`) |
| :--- | :--- | :--- |
| **Execution Location** | Google Cloud Infrastructure (`script.google.com`) | Spark's Local VM Sandbox (`/working_dir/`) |
| **Timing & Cadence** | **Autonomous / Asynchronous**: Runs 24/7 via time triggers (every 10 min, daily, weekly) or event triggers (`onEdit`, `onChange`). | **Interactive / Synchronous**: Runs instantly during active chat turns; returns immediate output. |
| **Internet Access** | **Has Outbound Internet**: Can make external API calls via `UrlFetchApp` (e.g., calling `gemini-2.5-flash` or webhooks). | **Strictly Offline**: No internet access; cannot make external HTTP requests or API calls. |
| **Workspace Integration** | **Native Workspace Access**: Direct access to `DriveApp`, `SpreadsheetApp`, `DocumentApp`, `SlidesApp`, `GmailApp`, `Tasks`. | **File-Based Access**: Operates on local files or Workspace items via Drive tools (`openpyxl`, `pandas`, `pypdf`). |
| **Libraries & Tools** | Limited to Google Apps Script services and V8 JS runtime. | Pre-installed Python data stack (`pandas`, `numpy`, `openpyxl`, `pypdf`, `matplotlib`, `seaborn`). |
| **Deployment** | Managed via `clasp` and bound to Master Google Sheets in [`gemini-spark`](https://drive.google.com/drive/folders/1XQyRsEx8gQl8idUv_UhfRMYxS9dIx0tk). | **Zero Setup**: Executed directly by Spark in the chat window. |

---

## 2. Decision Rubric

### Choose **Google Apps Script** When:
1. **24/7 Background Automation**: Actions must happen continuously without starting a chat session (e.g., auto-tagging loose files added to Drive root, daily receipt ingestion, daily style index scanning).
2. **Event-Driven Triggers**: Code must fire immediately when a Google Sheet is edited (`onEdit`) or on a recurring schedule (`ScriptApp.newTrigger`).
3. **External API Integrations**: Workflows require outbound internet calls (e.g., sending text or inline PDFs to `gemini-2.5-flash` via `UrlFetchApp` for structured JSON classification).
4. **Native Workspace Service Interactions**: Workflows involve cross-product Workspace triggers (e.g., scanning Gmail for `financial receipts`, archiving attachments to Drive, appending to Sheets, and creating Google Tasks).

### Choose **Local Python in Spark VM** When:
1. **Immediate / Interactive Results**: Data processing, transformation, or visualization is needed right now in an active conversation.
2. **Complex Local Data & Math Analysis**: Workflows involve heavy data manipulation, CSV/Excel parsing, statistical analysis, or charting using `pandas`, `numpy`, or `matplotlib`.
3. **Bulk File Parsing & Generation**: Workflows involve parsing, splitting, or merging local binary files (PDFs, images, text files) using Python libraries (`pypdf`, `docx`, `pillow`).
4. **Iterative Prototyping**: Testing, debugging, and verifying script logic on actual data files before committing to a permanent Apps Script workflow.

---

## 3. Decision Flowchart

```text
                 Does the task need to run 24/7 in the background
                 or trigger automatically on document/sheet edits?
                                     │
                     ┌───────────────┴───────────────┐
                     ▼                               ▼
                   [YES]                           [NO]
                     │                               │
        Use GOOGLE APPS SCRIPT              Does it require outbound
      (Maintained in gemini-spark,       internet calls / Gemini API?
       executed on Google Cloud)                     │
                                     ┌───────────────┴───────────────┐
                                     ▼                               ▼
                                   [YES]                           [NO]
                                     │                               │
                        Use GOOGLE APPS SCRIPT            Use LOCAL PYTHON
                      (or Apps Script Web App)          (Executed by Spark
                                                         instantly in VM)
```

---

## 4. Active Production Apps Script Deployments (`gemini-spark`)

| Automation System | Documentation Spec (`gemini-spark`) | Live Apps Script Project (`script.google.com`) | Bound Master Spreadsheet |
| :--- | :--- | :--- | :--- |
| **1. Financial Receipts Ingestion** | [`Receipts_Ingestion_Automation_Code.gs.md`](https://docs.google.com/document/d/1ezcHQvkzr4sM-uLSWiQToKgvWaozWohLrstsAe6UA7g/edit)<br>[`Financial_Receipts_Label_Refinement_Procedure`](https://docs.google.com/document/d/1TNP58lmMvvi3BHIPTgfVMlm14gPK34QCxWTE5jmlBmk/edit) | [`Financial-Receipts-Ingestion`](https://script.google.com/d/1PzJn5MJCCE4K0UhZHqS9rboJUpjR7P5psLi1DjQxPpHmKKPAIuxQdkfJ/edit) | [2026 Receipts Inventory](https://docs.google.com/spreadsheets/d/194nQzKDYo0Bt8tfO1P1UBAD-dtDgSb7CWDatv61-ADI/edit)<br>[2025 Receipts Inventory](https://docs.google.com/spreadsheets/d/1BzwXcQpvlSJ1ccdmfOQ8COZ2EIBSDOQ0UP7he73Yj-Q/edit) |
| **2. Writing Style & Tone Index** | [`Writing_Style_Index_Automation_Code.gs.md`](https://docs.google.com/document/d/1vLxrT-IdxoSXEYNRTHK05DobNn6ZStVdrERm8gIFu7Q/edit) | [`Writing-Style-Index-Automation`](https://script.google.com/d/1yuepYNbNxeZmYvy7LfmNeN6k1XgKgn-jWNA3nNkHlWgAXdEPfbIzDIwu/edit) | [Writing Style & Tone Reference Index](https://docs.google.com/spreadsheets/d/1HPY3pKrgzeJr1FMLiK_UNyNJcfPTanJoPRL3ikF_nA8/edit) |
| **3. Drive Root Tagging** | [`Drive_Tagging_Automation_Code.gs.md`](https://docs.google.com/document/d/1VZj8q42K6X6TEOqvwRdNb-rS2TnHTAMf1jKZazOZeoU/edit)<br>[`Drive_Tagging_QA_Procedures.md`](https://docs.google.com/document/d/1sUoDzsLKt1JyLpruwnReAHhAqvuraE_UMOzRKTr1BL4/edit) | [`Drive-Tagging-Automation`](https://script.google.com/d/1F2-pZJZ1jzfoNS7EgnQOYXOwii5YEU7rFOMKOWN52k2GQcWrBpPbp2-w/edit) | [Drive Tagging Master Index](https://docs.google.com/spreadsheets/d/1XE78-Gae0a5DfkuC0lJcy62XjreqPIPovy8LuoAT3gA/edit) |
| **4. Universal Entity & Schema Extraction** | [`Entity_Extraction_Automation_Code.gs.md`](https://docs.google.com/document/d/1MyP4sjx1BXIwjiKq-3sG0k-ozX7c3vWdhlPQa68mpTw/edit)<br>[`Entity_Extraction_QA_Procedures.md`](https://docs.google.com/document/d/1xqckd5v2yOPkGnTkXrzZsUYHuUCnFzdAHnsq5dYdhFQ/edit) | Universal Extraction Library | [`Skill Resources`](https://drive.google.com/drive/folders/1qrsATL6edhrjs3HsY_R73ekoJdBm3nNP)<br>`/Users/wryen/Documents/Gemini/entity-extraction-automation` |
| **5. Semantic Knowledge Graph Ingestion** | [`Knowledge_Graph_Automation_Code.gs.md`](https://drive.google.com/file/d/1GXWpPDTaoj5MyWjZjstAhsMBU8JgmEmt/view)<br>[`Knowledge_Graph_QA_Procedures.md`](https://drive.google.com/file/d/10lj16vFN6ryN0UUDe62H0AgCXgbYCp6G/view) | [`MCDM-Archive-Knowledge-Graph-Ingestion`](https://script.google.com/d/1WLRQ7rZnz-LmtKmssiCyjrm8vL2ikG-KdPjTfiSI28TuB6F2XdP21kFZ/edit) | [MCDM_Archive_Knowledge_Graph](https://drive.google.com/drive/folders/1YECmZ3sMeAttBS2OTR_8WJaa_Bt5mO4b)<br>[assets/seeds](https://drive.google.com/drive/folders/1v9uyJ_rnGGUsuytisYKH6YcM1nF60dkT) |
| **6. Architectural Baseline** | [`Automation_Architecture_Learnings_and_Best_Practices.md`](https://docs.google.com/document/d/1HgCvM8q9A19BfYb4AosPTsU7ZLyJAYYFww3qhTDI-6c/edit) | Cross-System Engineering Standard | All Active Workspace Automations |


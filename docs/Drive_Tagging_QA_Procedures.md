# Quality Assurance & Validation Procedures: Drive Tagging System

This document outlines the Quality Assurance (QA) validation checks required to ensure that updates to the **Drive Tagging Master Index**, **Apps Script Code**, **System Documentation**, and **JSONL Description Tags** are valid and compliant with system standards.

---

## 1. Master Index Spreadsheet QA (`Drive Tagging Master Index`)

### Validation Checklist
- [ ] **Tab Structure**: Verify that all three required tabs (`Review_Queue`, `Tag_Taxonomy_Master`, `Evals_and_Corrections_Log`) exist with exact header naming.
- [ ] **Taxonomy Uniqueness**: Check for duplicate `Tag Name` entries on the `Tag_Taxonomy_Master` tab.
- [ ] **Dropdown Validation**: Ensure column `Human Action` on `Review_Queue` uses valid dropdown options (`Pending`, `Approved`, `Approved with Corrections`, `Rejected`).
- [ ] **Data Completeness**: Ensure no rows in `Review_Queue` have missing `File ID` or `Document Title` values.

---

## 2. Apps Script Code QA (`Code.gs`)

### Validation Checklist
- [ ] **Config & Credential Integrity**: Confirm `SPREADSHEET_ID`, `CONFIDENCE_THRESHOLD` (`0.90`), `BATCH_SIZE` (`10`), and `GEMINI_MODEL` (`gemini-2.5-flash`) are properly set, and `GEMINI_API_KEY` is stored in `Script Properties` (`PropertiesService.getScriptProperties()`).
- [ ] **Queue Deduplication**: Confirm `scanAndTagDriveFiles()` checks `getQueuedFileIds(queueSheet)` before invoking Gemini so pending items are never queued twice.
- [ ] **JSON Schema Enforcement & Multimodal PDF Support**: Ensure the API request payload specifies `responseMimeType: "application/json"` with `responseSchema`, sends PDFs via `inlineData` (`application/pdf`), and wraps `UrlFetchApp.fetch()` in a `try-catch` block.
- [ ] **Dry-Run Test**: In the Apps Script Editor (`script.google.com`), execute `testDriveTaggingDryRun()` to verify spreadsheet access, taxonomy count, and API key configuration without writing changes to Drive.

---

## 3. System Documentation QA (`gemini-spark` Folder)

### Validation Checklist
- [ ] **Folder Location**: Confirm all system reference documents reside inside the root folder [gemini-spark](https://drive.google.com/drive/folders/1XQyRsEx8gQl8idUv_UhfRMYxS9dIx0tk).
- [ ] **Hyperlink Validity**: Verify that all markdown links to spreadsheets, Google Docs, and Drive folders are active and clickable.
- [ ] **Cross-Document Consistency**: Confirm that parameters (`gemini-2.5-flash`, batch sizes, confidence thresholds, JSONL schema format) match across the decision rubric, `Code.gs`, and QA procedures.

---

## 4. JSONL Description Tags QA (Drive Files)

### Validation Checklist
- [ ] **JSONL Schema Conformance**: Verify `file.getDescription()` contains valid, parseable JSON matching Schema Version 1:
  ```json
  {"schema_v": 1, "doc_type": "Architecture Spec", "tags": ["AI", "CMS"], "confidence": 0.94, "tagged_by": "gemini_auto", "updated_at": "2026-10-30T12:00:00.000Z"}
  ```
- [ ] **Taxonomy Compliance**: Confirm that all tags in `tags: [...]` exist in `Tag_Taxonomy_Master` (or were automatically added upon `Approved` / `Approved with Corrections` sync).
- [ ] **Character Limit**: Ensure description string length does not exceed Google Drive's 25,000 character limit.
- [ ] **Character Encoding**: Confirm JSON strings do not contain unescaped line breaks or corrupted quotes.

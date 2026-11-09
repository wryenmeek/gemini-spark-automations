Quality Assurance & Validation Procedures: Universal Entity & Schema Extraction Pipeline
* System Location: Google Drive / gemini-spark & local project /Users/wryen/Documents/Gemini/entity-extraction-automation
* Technical Spec: Entity_Extraction_Automation_Code.gs.md
* Governing Standard: Automation_Architecture_Learnings_and_Best_Practices.md
* Effective Date: November 3, 2026
1. Overview & Return Contract QA
Every programmatic invocation of extractDocumentSchema(documentId, options) must return a deterministic, strongly typed result object adhering strictly to the production contract specifications.
Contract Field Specifications
* schema: Must be a valid OpenAPI 3.0 / Gemini responseSchema definition.
   * Root level must strictly enforce type: "OBJECT".
   * The properties dictionary must be non-empty and well-formed.
   * Every declared property must include an explicit semantic description.
   * All ARRAY type declarations must explicitly define child schema types via items.
   * All nested OBJECT definitions must include recursive, typed properties maps.
* validationTest (alias: test): Contains executable structural validation logic and verification receipts.
   * code: Self-contained, executable test suite string validating the target schema and sample extraction payloads.
   * Execution status fields: Requires passed: true, assertions > 0, and an empty failures: [] array.
* iterations (alias: iterationsProcessed): Integer value constrained to [1..maxIterations] reflecting the number of refinement loops required to reach convergence.
* coverageScore (alias: score): Normalized floating-point metric within [0.0, 1.0] quantifying source data structural extraction.
Coverage Score Weight Distribution
Component
	Weight
	Target Criteria
	Segment Coverage
	40%
	Measures the ratio of mapped slide sections, document paragraphs, and table rows.
	Concept & Mechanic Token Coverage
	40%
	Evaluates recall against identified domain-specific tokens, numeric properties, and dice/stat formulas.
	Structural Gap Alignment
	20%
	Calculated as P / (P + G), where P represents resolved schema properties and G represents detected unmapped subsystems.
	2. Multi-Format Ingestion & Runtime Guardrails Checklist
Engineers and automated CI pipelines must verify the following runtime safety barriers before promoting pipeline builds:


* Secret Isolation:
   * Verify GEMINI_API_KEY is fetched exclusively through PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY").
   * Direct script property hardcoding or client-exposed credentials must trigger immediate pipeline failure.
* Multimodal PDF Heap Protection (MAX_PDF_BYTES = 15 MB):
   * Confirm defensive size checks occur prior to byte loading. If file size exceeds 15 MB, the process must immediately throw EXCEEDS_INLINE_PDF_LIMIT prior to calling getBlob().getBytes(), safeguarding the 128 MB Apps Script V8 heap limit against exhaustion.
   * PDFs under the threshold must be safely encoded using Utilities.base64Encode into inlineData payloads with mimeType: "application/pdf".
* Presentation Completeness (SlidesApp):
   * Verify ingestDriveDocument traverses all structural slide shapes, table rows, and cells.
   * Confirm speaker notes extraction executes via getNotesPage().getSpeakerNotesShape() across all slide instances.
* Direct-to-Storage Metadata (Schema v1 JSONL):
   * Verify markFileSchemaExtracted writes a structured JSON payload directly to the Drive file description field matching:
      * {"schema_v": 1, "entity_schema_extracted": true, "properties_count": N, "iterations": I, "coverage_score": S, "validation_passed": true, "updated_at": "..."}
3. Pre-Flight Offline Unit Testing & Clasp Deployment QA
Prior to pushing script changes to Google Apps Script production projects, the following staging and deployment protocols must pass:
Offline Execution & Unit Testing
Execute the local test suite via Bun:


bun test test/entity_extraction.test.tsThe test runner evaluates:


* Google Slides structural parsing and shape traversal.
* Google Docs tokenization and paragraph segmentation.
* PDF boundary processing and MAX_PDF_BYTES heap limit defense.
* Markdown formatting parser logic.
* Dynamic runtime execution of the generated validationTest.code string.
* Gemini API responseSchema OpenAPI compliance and schema generation.
Clasp Deployment Flow
1. Confirm authentication credentials:
   * Verify .clasprc.json is present and active in the local execution directory or global clasp path.
2. Project initialization:
   * Execute clasp create --type standalone --title "Entity-Extraction-Schema-Refinement" --rootDir ./src if deploying a new runtime target.
3. Code synchronization:
   * Push validated source assets to the cloud container:
clasp push -f
   4. Post-push verification:
   * Validate that all local TypeScript and JavaScript manifests compile cleanly within the Apps Script V8 runtime.

Google Apps Script: Universal Entity & Schema Extraction Pipeline (Code.js)
* System Location: gemini-spark & local project /Users/wryen/Documents/Gemini/entity-extraction-automation
* Governing Standard: Automation_Architecture_Learnings_and_Best_Practices.md
* Runtime: Google Apps Script (V8 Engine) + gemini-2.5-flash with responseSchema
1. Overview & Return Contract
Given any Google Drive documentId (Google Slides, Google Docs, Google Sheets, PDF, Markdown, CSV, JSON, or plain text), extractDocumentSchema(documentId, options) executes an iterative schema refinement loop and returns:


* schema: The converged, strongly typed OpenAPI 3.0 / Gemini responseSchema object.
* test / validationTest: Both a self-contained executable validation test function (code) and the live execution result (passed, assertions, failures) verifying root and nested schema types, required properties, array items schemas, and extracted payload conformance.
* iterations / iterationsProcessed: Total refinement passes executed (1..maxIterations).
* score / coverageScore: Normalized [0, 1] coverage score measuring how much of the unstructured source document is captured by the returned schema across three weighted dimensions:
   * Segment Coverage (40%): Fraction of slides, paragraphs, or table rows whose domain concepts map to schema properties or extracted entities.
   * Concept & Mechanic Token Coverage (40%): Recall of salient non-stopword domain terms and dice/stat tokens in the schema and extracted payload.
   * Structural Gap Alignment (20%): Ratio of resolved schema properties to total detected subsystems ($P / (P + G)$).
Execution Contract
Field
	Type
	Description
	schema
	Object
	Strict OpenAPI 3.0 schema object consumed by Gemini responseSchema.
	extractedData
	Object
	Hydrated JSON payload matching the structural schema specification.
	validationTest.passed
	Boolean
	Evaluation status of all structural, type, and required constraints.
	validationTest.assertions
	Number
	Total assertions evaluated against the hydrated schema instance.
	validationTest.failures
	Array<String>
	Detailed descriptions of schema contract violations.
	validationTest.code
	String
	Self-contained, executable validation test suite in JavaScript.
	iterations
	Number
	Total convergence cycles completed by the engine.
	coverageScore
	Number
	Normalized metric ($[0.0, 1.0]$) aggregating segments, tokens, and gaps.
	unmappedElements
	Array<Object>
	Outstanding elements omitted from the consolidated schema model.
	2. Clasp CLI Project Structure & Commands
Local project path: /Users/wryen/Documents/Gemini/entity-extraction-automation


* src/appsscript.json: V8 runtime manifest with drive, documents.readonly, presentations.readonly, spreadsheets.readonly, and script.external_request OAuth scopes.
* src/Code.js: Universal Drive ingestor (ingestDriveDocument), iterative refinement loop (refineCampaignSchema, scanForUnmappedElements, updateSchemaWithGaps), Gemini structured extraction client (extractEntitiesWithGemini), schema test generator (buildAndRunSchemaValidationTest), and coverage scorer (calculateDocumentCoverageScore).
* test/entity_extraction.test.ts: Offline VM unit test suite (bun test) mocking DriveApp, SlidesApp, DocumentApp, SpreadsheetApp, PropertiesService, and UrlFetchApp.
Clasp CLI Deployment Commands
cd /Users/wryen/Documents/Gemini/entity-extraction-automation
bun test test/entity_extraction.test.ts
npx @google/clasp create --type standalone --title "Entity-Extraction-Schema-Refinement" --rootDir ./src
npx @google/clasp push -f
Manifest Configuration (src/appsscript.json)
{
  "timeZone": "Etc/UTC",
  "dependencies": {},
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "oauthScopes": [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/documents.readonly",
    "https://www.googleapis.com/auth/presentations.readonly",
    "https://www.googleapis.com/auth/spreadsheets.readonly",
    "https://www.googleapis.com/auth/script.external_request"
  ]
}
3. Core Production Functions (src/Code.js)
/**
 * Universal Entity & Schema Extraction Pipeline
 * Runtime: Google Apps Script (V8 Engine)
 * Model Target: gemini-2.5-flash
 */


const GEMINI_CONFIG = {
  MODEL: 'gemini-2.5-flash',
  API_BASE: 'https://generativelanguage.googleapis.com/v1beta/models',
  MAX_INLINE_BYTES: 15 * 1024 * 1024, // 15 MB limit for inline multimodal blobs
  DEFAULT_MAX_ITERATIONS: 3,
  MAX_TOKENS: 8192,
  TEMPERATURE: 0.1
};


/**
 * Executes iterative schema refinement and entity extraction against any Drive asset.
 * @param {string} documentId Drive File ID.
 * @param {Object} options Configuration parameters.
 * @returns {Object} Schema extraction and validation report.
 */
function extractDocumentSchema(documentId, options = {}) {
  const maxIterations = options.maxIterations || GEMINI_CONFIG.DEFAULT_MAX_ITERATIONS;
  const initialSchema = options.initialSchema || null;
  const skillInstructions = options.skillInstructions || 
    'Extract all entities, technical specifications, statistics, rules, and semantic relationships systematically.';


  const ingestedDoc = ingestDriveDocument(documentId);
  const refinementResult = refineCampaignSchema(
    skillInstructions,
    ingestedDoc.text,
    initialSchema,
    maxIterations,
    ingestedDoc
  );


  const validationResult = buildAndRunSchemaValidationTest(
    refinementResult.schema,
    refinementResult.extractedData,
    documentId
  );


  const coverageScore = calculateDocumentCoverageScore(
    ingestedDoc.text,
    refinementResult.schema,
    refinementResult.extractedData,
    refinementResult.unmappedElements
  );


  markFileSchemaExtracted(
    documentId,
    refinementResult.schema,
    refinementResult.iterations,
    coverageScore,
    validationResult.passed
  );


  return {
    documentId: documentId,
    schema: refinementResult.schema,
    extractedData: refinementResult.extractedData,
    validationTest: validationResult,
    iterations: refinementResult.iterations,
    coverageScore: coverageScore,
    unmappedElements: refinementResult.unmappedElements
  };
}


/**
 * Universal Drive Ingestor across native Workspace formats, PDFs, and flat files.
 * @param {string} documentId Drive File ID.
 * @returns {Object} Structured representation of the ingested asset.
 */
function ingestDriveDocument(documentId) {
  const file = DriveApp.getFileById(documentId);
  const mimeType = file.getMimeType();
  const size = file.getSize();


  let extractedText = '';
  let segments = [];
  let multimodalBlob = null;


  switch (mimeType) {
    case 'application/vnd.google-apps.presentation': {
      const presentation = SlidesApp.openById(documentId);
      const slides = presentation.getSlides();
      slides.forEach((slide, sIdx) => {
        let slideText = `[Slide ${sIdx + 1}]\n`;
        slide.getShapes().forEach(shape => {
          if (shape.getText()) {
            const txt = shape.getText().asString().trim();
            if (txt) slideText += `${txt}\n`;
          }
        });
        slide.getTables().forEach(table => {
          for (let r = 0; r < table.getNumRows(); r++) {
            let rowText = [];
            for (let c = 0; c < table.getNumColumns(); c++) {
              rowText.push(table.getCell(r, c).getText().asString().trim());
            }
            slideText += `| ${rowText.join(' | ')} |\n`;
          }
        });
        const notes = slide.getNotesPage().getSpeakerNotesShape().getText().asString().trim();
        if (notes) {
          slideText += `[Speaker Notes: ${notes}]\n`;
        }
        segments.push({ segmentId: `slide_${sIdx + 1}`, content: slideText });
        extractedText += `${slideText}\n\n`;
      });
      break;
    }


    case 'application/vnd.google-apps.document': {
      const doc = DocumentApp.openById(documentId);
      const body = doc.getBody();
      const paras = body.getParagraphs();
      paras.forEach((p, pIdx) => {
        const text = p.getText().trim();
        if (text) {
          segments.push({ segmentId: `para_${pIdx + 1}`, content: text });
          extractedText += `${text}\n`;
        }
      });
      const tables = body.getTables();
      tables.forEach((t, tIdx) => {
        for (let r = 0; r < t.getNumRows(); r++) {
          const row = t.getRow(r);
          let rowCells = [];
          for (let c = 0; c < row.getNumCells(); c++) {
            rowCells.push(row.getCell(c).getText().trim());
          }
          const rowStr = `| ${rowCells.join(' | ')} |`;
          segments.push({ segmentId: `table_${tIdx + 1}_row_${r + 1}`, content: rowStr });
          extractedText += `${rowStr}\n`;
        }
      });
      break;
    }


    case 'application/vnd.google-apps.spreadsheet': {
      const ss = SpreadsheetApp.openById(documentId);
      const sheets = ss.getSheets();
      sheets.forEach(sheet => {
        const sheetName = sheet.getName();
        const data = sheet.getDataRange().getValues();
        data.forEach((row, rIdx) => {
          const rowStr = row.map(cell => String(cell).trim()).filter(Boolean).join(' | ');
          if (rowStr) {
            segments.push({ segmentId: `${sheetName}_row_${rIdx + 1}`, content: rowStr });
            extractedText += `[${sheetName}] ${rowStr}\n`;
          }
        });
      });
      break;
    }


    case 'application/pdf': {
      const blob = file.getBlob();
      if (size <= GEMINI_CONFIG.MAX_INLINE_BYTES) {
        multimodalBlob = {
          mimeType: 'application/pdf',
          bytesBase64: Utilities.base64Encode(blob.getBytes())
        };
      }
      extractedText = `[PDF: ${file.getName()}, Size: ${size} bytes. Raw inline processing enabled]`;
      segments.push({ segmentId: 'pdf_multimodal_blob', content: extractedText });
      break;
    }


    case 'text/plain':
    case 'text/markdown':
    case 'text/csv':
    case 'application/json': {
      extractedText = file.getBlob().getDataAsString();
      const lines = extractedText.split('\n');
      lines.forEach((line, lIdx) => {
        const trimmed = line.trim();
        if (trimmed) {
          segments.push({ segmentId: `line_${lIdx + 1}`, content: trimmed });
        }
      });
      break;
    }


    default: {
      const rawBlob = file.getBlob();
      if (size <= GEMINI_CONFIG.MAX_INLINE_BYTES) {
        multimodalBlob = {
          mimeType: mimeType,
          bytesBase64: Utilities.base64Encode(rawBlob.getBytes())
        };
      }
      extractedText = `[Binary Document: ${file.getName()}, Mime: ${mimeType}, Size: ${size} bytes]`;
      segments.push({ segmentId: 'binary_file', content: extractedText });
      break;
    }
  }


  return {
    documentId: documentId,
    mimeType: mimeType,
    text: extractedText,
    segments: segments,
    multimodalBlob: multimodalBlob
  };
}


/**
 * Coordinates schema derivation cycles until gap convergence or maxIterations.
 * @param {string} skillInstructions Domain guidance.
 * @param {string} presentationDocument Ingested document plain text.
 * @param {Object} initialSchema Seed schema or null.
 * @param {number} maxIterations Refinement ceiling.
 * @param {Object} ingestedDoc Full ingested wrapper.
 * @returns {Object} Converged schema, payload, and remaining unmapped nodes.
 */
function refineCampaignSchema(skillInstructions, presentationDocument, initialSchema, maxIterations, ingestedDoc) {
  let currentSchema = initialSchema;
  let iterations = 0;
  let unmappedElements = [];
  let extractedData = {};


  if (!currentSchema) {
    currentSchema = generateBaselineSchema(presentationDocument, skillInstructions, ingestedDoc);
  }


  while (iterations < maxIterations) {
    iterations++;


    // Step A: Extract hydrated data against current candidate schema
    extractedData = extractEntitiesWithGemini(ingestedDoc, currentSchema, skillInstructions);


    // Step B: Scan source document for concepts omitted by the schema
    unmappedElements = scanForUnmappedElements(presentationDocument, currentSchema, skillInstructions, ingestedDoc);


    if (!unmappedElements || unmappedElements.length === 0) {
      break;
    }


    // Step C: Update schema with discovered structural gaps
    const updatedSchema = updateSchemaWithGaps(currentSchema, unmappedElements);
    
    // Halt iteration if the schema topology stabilized
    if (JSON.stringify(updatedSchema) === JSON.stringify(currentSchema)) {
      break;
    }


    currentSchema = updatedSchema;
  }


  // Final hydration pass on the converged schema
  extractedData = extractEntitiesWithGemini(ingestedDoc, currentSchema, skillInstructions);


  return {
    schema: currentSchema,
    extractedData: extractedData,
    iterations: iterations,
    unmappedElements: unmappedElements
  };
}


/**
 * Computes missing domains, metrics, or entities absent from the schema definition.
 * @param {string} documentText Document textual corpus.
 * @param {Object} schema Current OpenAPI schema.
 * @param {string} skillInstructions Semantic parsing directives.
 * @param {Object} ingestedDoc Document wrapper for multimodal fallbacks.
 * @returns {Array<Object>} Structural gaps to integrate.
 */
function scanForUnmappedElements(documentText, schema, skillInstructions, ingestedDoc) {
  const prompt = `Analyze the source text against the current JSON schema definition.
Identify domain subsystems, stats, tables, mechanic rules, or distinct entity groupings that are present in the source text but CANNOT be mapped into the schema without losing fidelity.


Domain Directives:
${skillInstructions}


Current Schema Structure:
${JSON.stringify(schema, null, 2)}


Source Text Sample:
${documentText.slice(0, 30000)}


Return a JSON array containing gap descriptors:
- "propertyKey": Suggested camelCase key name.
- "type": "string" | "number" | "boolean" | "array" | "object"
- "description": Explicit definition of what this unmapped subsystem contains.
- "itemsType": (If array) primitive or nested object definition.
- "required": Boolean indicating whether this subsystem is a core concept.`;


  const apiKey = getGeminiApiKey_();
  const url = `${GEMINI_CONFIG.API_BASE}/${GEMINI_CONFIG.MODEL}:generateContent?key=${apiKey}`;


  let contents = [];
  if (ingestedDoc && ingestedDoc.multimodalBlob) {
    contents.push({
      parts: [
        { inlineData: { mimeType: ingestedDoc.multimodalBlob.mimeType, data: ingestedDoc.multimodalBlob.bytesBase64 } },
        { text: prompt }
      ]
    });
  } else {
    contents.push({
      parts: [{ text: prompt }]
    });
  }


  const payload = {
    contents: contents,
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'ARRAY',
        description: 'List of unmapped structural subsystems identified in the source text',
        items: {
          type: 'OBJECT',
          properties: {
            propertyKey: { type: 'STRING' },
            type: { type: 'STRING' },
            description: { type: 'STRING' },
            itemsType: { type: 'STRING' },
            required: { type: 'BOOLEAN' }
          },
          required: ['propertyKey', 'type', 'description', 'required']
        }
      }
    }
  };


  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: false
  });


  const parsed = JSON.parse(response.getContentText());
  const rawContent = parsed.candidates[0].content.parts[0].text;
  return JSON.parse(rawContent);
}


/**
 * Programmatically grafts detected subsystem gaps into the OpenAPI schema definition.
 * @param {Object} schema Existing OpenAPI candidate schema.
 * @param {Array<Object>} gaps Subsystems discovered during element scanning.
 * @returns {Object} Mutated and normalized OpenAPI schema.
 */
function updateSchemaWithGaps(schema, gaps) {
  const updated = JSON.parse(JSON.stringify(schema));
  
  if (!updated.properties) {
    updated.properties = {};
  }
  if (!updated.required) {
    updated.required = [];
  }


  gaps.forEach(gap => {
    const key = gap.propertyKey.trim();
    if (!key || updated.properties[key]) {
      return;
    }


    const typeNormalized = gap.type.toLowerCase();
    let propDef = {
      description: gap.description || ''
    };


    switch (typeNormalized) {
      case 'array':
        propDef.type = 'ARRAY';
        if (gap.itemsType && gap.itemsType.toLowerCase() === 'object') {
          propDef.items = {
            type: 'OBJECT',
            properties: {
              name: { type: 'STRING', description: 'Identifier or label' },
              details: { type: 'STRING', description: 'Descriptive or systemic content' }
            },
            required: ['name']
          };
        } else if (gap.itemsType && ['number', 'integer'].includes(gap.itemsType.toLowerCase())) {
          propDef.items = { type: 'NUMBER' };
        } else {
          propDef.items = { type: 'STRING' };
        }
        break;


      case 'number':
      case 'integer':
        propDef.type = 'NUMBER';
        break;


      case 'boolean':
        propDef.type = 'BOOLEAN';
        break;


      case 'object':
        propDef.type = 'OBJECT';
        propDef.properties = {
          name: { type: 'STRING' },
          value: { type: 'STRING' }
        };
        break;


      case 'string':
      default:
        propDef.type = 'STRING';
        break;
    }


    updated.properties[key] = propDef;
    if (gap.required && !updated.required.includes(key)) {
      updated.required.push(key);
    }
  });


  return updated;
}


/**
 * Builds an isolated validation suite and executes runtime conformance assertions.
 * @param {Object} schema Converged OpenAPI schema specification.
 * @param {Object} extractedData Extracted entity payload.
 * @param {string} documentId Source document identifier.
 * @returns {Object} Live evaluation result and self-contained JavaScript test code.
 */
function buildAndRunSchemaValidationTest(schema, extractedData, documentId) {
  let assertions = 0;
  let failures = [];


  // Assertion Suite 1: Structural Schema Integrity
  assertions++;
  if (!schema || typeof schema !== 'object') {
    failures.push('Schema must be a valid non-null object');
  }


  assertions++;
  if (schema.type !== 'OBJECT') {
    failures.push(`Schema root type must be "OBJECT", encountered: "${schema.type}"`);
  }


  assertions++;
  if (!schema.properties || typeof schema.properties !== 'object') {
    failures.push('Schema must define a valid "properties" container');
  }


  // Assertion Suite 2: Required Properties Completeness
  if (Array.isArray(schema.required)) {
    schema.required.forEach(reqKey => {
      assertions++;
      if (!(reqKey in schema.properties)) {
        failures.push(`Required key "${reqKey}" is not declared in schema properties`);
      }
      assertions++;
      if (extractedData && (extractedData[reqKey] === undefined || extractedData[reqKey] === null)) {
        failures.push(`Extracted payload is missing required field: "${reqKey}"`);
      }
    });
  }


  // Assertion Suite 3: Data Conformance & Type Matching
  if (extractedData && schema.properties) {
    Object.keys(schema.properties).forEach(propKey => {
      const propDef = schema.properties[propKey];
      const val = extractedData[propKey];


      if (val !== undefined && val !== null) {
        assertions++;
        switch (propDef.type) {
          case 'STRING':
            if (typeof val !== 'string') failures.push(`Field "${propKey}" expected string, got ${typeof val}`);
            break;
          case 'NUMBER':
            if (typeof val !== 'number') failures.push(`Field "${propKey}" expected number, got ${typeof val}`);
            break;
          case 'BOOLEAN':
            if (typeof val !== 'boolean') failures.push(`Field "${propKey}" expected boolean, got ${typeof val}`);
            break;
          case 'ARRAY':
            if (!Array.isArray(val)) {
              failures.push(`Field "${propKey}" expected array, got ${typeof val}`);
            } else if (propDef.items && propDef.items.type === 'OBJECT' && propDef.items.required) {
              val.forEach((item, idx) => {
                propDef.items.required.forEach(itemReq => {
                  assertions++;
                  if (item[itemReq] === undefined || item[itemReq] === null) {
                    failures.push(`Field "${propKey}[${idx}]" missing required property "${itemReq}"`);
                  }
                });
              });
            }
            break;
          case 'OBJECT':
            if (typeof val !== 'object' || Array.isArray(val)) {
              failures.push(`Field "${propKey}" expected object, got ${typeof val}`);
            }
            break;
        }
      }
    });
  }


  // Synthesize runnable verification source code
  const code = `
function validateDocumentExtraction(schema, extractedData) {
  const assertions = [];
  const failures = [];


  function assert(condition, message) {
    assertions.push(message);
    if (!condition) failures.push(message);
  }


  assert(schema && schema.type === 'OBJECT', 'Root must be an OBJECT schema');
  assert(schema.properties && typeof schema.properties === 'object', 'Properties must be defined');


  if (Array.isArray(schema.required)) {
    schema.required.forEach(req => {
      assert(req in schema.properties, 'Required property ' + req + ' declared');
      assert(extractedData && extractedData[req] !== undefined, 'Payload has required property ' + req);
    });
  }


  return {
    passed: failures.length === 0,
    totalAssertions: assertions.length,
    failures: failures
  };
}
`;


  return {
    passed: failures.length === 0,
    assertions: assertions,
    failures: failures,
    code: code.trim()
  };
}


/**
 * Calculates a normalized coverage score measuring source information capture.
 * @param {string} documentText Source document string.
 * @param {Object} schema OpenAPI schema definition.
 * @param {Object} extractedData Extracted entities.
 * @param {Array<Object>} remainingGaps Remaining unmapped elements.
 * @returns {number} Coverage score normalized [0.0, 1.0].
 */
function calculateDocumentCoverageScore(documentText, schema, extractedData, remainingGaps) {
  // Dimension 1: Structural Gap Alignment (Weight: 20%)
  const resolvedPropertiesCount = Object.keys(schema.properties || {}).length;
  const unmappedGapsCount = (remainingGaps || []).length;
  const structuralAlignment = resolvedPropertiesCount + unmappedGapsCount > 0
    ? resolvedPropertiesCount / (resolvedPropertiesCount + unmappedGapsCount)
    : 1.0;


  // Dimension 2: Salient Concept & Mechanic Recall (Weight: 40%)
  const domainTokens = extractSalientTokens_(documentText);
  const serializedOutput = JSON.stringify(extractedData || {}).toLowerCase();
  let matchedTokens = 0;


  if (domainTokens.size > 0) {
    domainTokens.forEach(token => {
      if (serializedOutput.includes(token.toLowerCase())) {
        matchedTokens++;
      }
    });
  }
  const tokenRecall = domainTokens.size > 0 ? (matchedTokens / domainTokens.size) : 1.0;


  // Dimension 3: Segment Representation Ratio (Weight: 40%)
  const chunks = documentText.split(/\n{2,}/).filter(c => c.trim().length > 40);
  let representedChunks = 0;


  if (chunks.length > 0) {
    chunks.forEach(chunk => {
      const chunkTokens = extractSalientTokens_(chunk);
      let chunkMatch = 0;
      chunkTokens.forEach(ct => {
        if (serializedOutput.includes(ct.toLowerCase())) chunkMatch++;
      });
      // Segment marked represented if >= 30% of its domain concepts are retained
      if (chunkTokens.size > 0 && (chunkMatch / chunkTokens.size) >= 0.3) {
        representedChunks++;
      }
    });
  }
  const segmentRatio = chunks.length > 0 ? (representedChunks / chunks.length) : 1.0;


  const aggregatedScore = (segmentRatio * 0.40) + (tokenRecall * 0.40) + (structuralAlignment * 0.20);
  return Number(Math.min(Math.max(aggregatedScore, 0.0), 1.0).toFixed(4));
}


/**
 * Executes structured extraction via Gemini responseSchema.
 * @param {Object} doc Ingested document object.
 * @param {Object} schema Target OpenAPI schema.
 * @param {string} skillInstructions Semantic parsing directives.
 * @returns {Object} Extracted JSON entity payload.
 */
function extractEntitiesWithGemini(doc, schema, skillInstructions) {
  const apiKey = getGeminiApiKey_();
  const url = `${GEMINI_CONFIG.API_BASE}/${GEMINI_CONFIG.MODEL}:generateContent?key=${apiKey}`;


  const prompt = `Perform complete entity and domain extraction following these instructions:
${skillInstructions}


Source Document Excerpt:
${doc.text.slice(0, 35000)}`;


  let contents = [];
  if (doc.multimodalBlob) {
    contents.push({
      parts: [
        { inlineData: { mimeType: doc.multimodalBlob.mimeType, data: doc.multimodalBlob.bytesBase64 } },
        { text: prompt }
      ]
    });
  } else {
    contents.push({
      parts: [{ text: prompt }]
    });
  }


  const payload = {
    contents: contents,
    generationConfig: {
      temperature: GEMINI_CONFIG.TEMPERATURE,
      maxOutputTokens: GEMINI_CONFIG.MAX_TOKENS,
      responseMimeType: 'application/json',
      responseSchema: schema
    }
  };


  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: false
  });


  const jsonResponse = JSON.parse(response.getContentText());
  const extractedText = jsonResponse.candidates[0].content.parts[0].text;
  return JSON.parse(extractedText);
}


/**
 * Persists extraction telemetry and JSONL metadata in the Drive file description.
 * @param {string} documentId Drive file identifier.
 * @param {Object} schema Converged OpenAPI schema.
 * @param {number} iterations Total refinement iterations completed.
 * @param {number} score Normalized coverage score.
 * @param {boolean} testPassed Validation test status.
 */
function markFileSchemaExtracted(documentId, schema, iterations, score, testPassed) {
  const file = DriveApp.getFileById(documentId);
  const metadataRecord = {
    standard: 'Schema_v1',
    extractedAt: new Date().toISOString(),
    iterations: iterations,
    coverageScore: score,
    testPassed: testPassed,
    schemaKeys: Object.keys(schema.properties || {})
  };


  const jsonlEntry = JSON.stringify(metadataRecord);
  const currentDescription = file.getDescription() || '';


  // Filter out prior Schema_v1 tags before appending current telemetry
  const sanitized = currentDescription
    .split('\n')
    .filter(line => !line.includes('"standard":"Schema_v1"'))
    .join('\n')
    .trim();


  const newDescription = sanitized ? `${sanitized}\n${jsonlEntry}` : jsonlEntry;
  file.setDescription(newDescription);
}


// ---------------------------------------------------------------------------
// Internal Pipeline Utilities
// ---------------------------------------------------------------------------


/**
 * Derives an initial baseline OpenAPI schema using the Gemini reflection endpoint.
 * @private
 */
function generateBaselineSchema(documentText, skillInstructions, ingestedDoc) {
  const prompt = `Synthesize an initial structural OpenAPI 3.0 schema that extracts all domain subsystems from the source text.
Return the schema root as type OBJECT with a "properties" map and "required" array.


Directives:
${skillInstructions}


Document Sample:
${documentText.slice(0, 20000)}`;


  const apiKey = getGeminiApiKey_();
  const url = `${GEMINI_CONFIG.API_BASE}/${GEMINI_CONFIG.MODEL}:generateContent?key=${apiKey}`;


  let contents = [];
  if (ingestedDoc && ingestedDoc.multimodalBlob) {
    contents.push({
      parts: [
        { inlineData: { mimeType: ingestedDoc.multimodalBlob.mimeType, data: ingestedDoc.multimodalBlob.bytesBase64 } },
        { text: prompt }
      ]
    });
  } else {
    contents.push({
      parts: [{ text: prompt }]
    });
  }


  const payload = {
    contents: contents,
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json'
    }
  };


  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: false
  });


  const parsed = JSON.parse(response.getContentText());
  const schemaObj = JSON.parse(parsed.candidates[0].content.parts[0].text);


  if (!schemaObj.type) schemaObj.type = 'OBJECT';
  if (!schemaObj.properties) schemaObj.properties = {};
  if (!schemaObj.required) schemaObj.required = [];


  return schemaObj;
}


/**
 * Extracts salient tokens and mechanic syntax (dice notations, stat blocks, keywords).
 * @private
 */
function extractSalientTokens_(text) {
  const tokens = new Set();
  const stopWords = new Set([
    'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'were', 'which',
    'what', 'their', 'there', 'about', 'would', 'could', 'should', 'into', 'then'
  ]);


  // Dice and mechanic notation pattern (e.g., 1d20, +4, 3d6+2, DC15, AC18)
  const mechanicRegex = /\b(\d+d\d+([+-]\d+)?|DC\s*\d+|AC\s*\d+|\+\d+)\b/gi;
  let match;
  while ((match = mechanicRegex.exec(text)) !== null) {
    tokens.add(match[0].toUpperCase());
  }


  // Domain terms: TitleCase entities and capitalized subsystems
  const entityRegex = /\b[A-Z][a-zA-Z0-9_]{3,}\b/g;
  while ((match = entityRegex.exec(text)) !== null) {
    const word = match[0].toLowerCase();
    if (!stopWords.has(word)) {
      tokens.add(match[0]);
    }
  }


  return tokens;
}


/**
 * Retrieves the Gemini API Key from Script Properties.
 * @private
 */
function getGeminiApiKey_() {
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) {
    throw new Error('GEMINI_API_KEY is not defined in Script Properties.');
  }
  return key;
}

# Receipts Ingestion Automation Code (Google Apps Script)

**System Location:** Google Drive / `gemini-spark`  
**Filename:** `Receipts_Ingestion_Automation_Code.gs.md`  
**Live Apps Script Project:** [Financial-Receipts-Ingestion](https://script.google.com/d/1PzJn5MJCCE4K0UhZHqS9rboJUpjR7P5psLi1DjQxPpHmKKPAIuxQdkfJ/edit) (`1PzJn5MJCCE4K0UhZHqS9rboJUpjR7P5psLi1DjQxPpHmKKPAIuxQdkfJ`)  
**Bound Spreadsheet:** [2026 Tax Receipts Inventory](https://docs.google.com/spreadsheets/d/194nQzKDYo0Bt8tfO1P1UBAD-dtDgSb7CWDatv61-ADI/edit) (`194nQzKDYo0Bt8tfO1P1UBAD-dtDgSb7CWDatv61-ADI`)  
**Author:** Gemini Spark & Wryen Meek  
**Effective Date:** October 30, 2026  
**Runtime:** Google Apps Script (V8 Engine)

---

## 1. Overview & Architecture

This Apps Script project implements the zero-token ingestion engine for Wryen Meek's financial receipts and tax records. It runs serverless inside Google Workspace on a daily time-driven trigger at 8:30 AM, handling all mechanical file operations and spreadsheet updates before the 9:00 AM Gemini scheduled report.

### Key Advantages
- **Zero Token Usage:** Reads Gmail, creates Drive documents/PDFs, and appends rows to Google Sheets without calling an LLM.
- **Dual-Schema Master Sheet Support:** Automatically formats and appends rows to match the 10-column reconciliation schema in the **2025 Inventory Sheet** and the 8-column expense schema in the **2026 Inventory Sheet**.
- **Built-In Attachment & Native Doc Handling:** Automatically extracts vendor PDF attachments (e.g., Banfield invoices, Home Depot eReceipts) directly to Google Drive, or generates a native Google Doc via `DocumentApp` when no PDF is attached.
- **Multi-Message & Ledger Deduplication:** Prevents double-counting when a single thread contains both an order confirmation and a shipping/invoice email, and verifies against existing rows in the target spreadsheet before appending.
- **Full SOP Vendor Alignment:** Implements all 15 vendor categories and negative-scoping disqualifiers defined in `Financial_Receipts_Label_Refinement_Procedure`.

---

## 2. Complete Apps Script Source Code (`Code.gs`)

```javascript
/**
 * Financial Receipts & Tax Deductions Ingestion Engine (Code.gs)
 * Automates Drive receipt archiving, Google Sheets row appending, and state tracking.
 */

const CONFIG = {
  LABELS: {
    SOURCE: 'financial receipts',
    INDEXED: 'receipts/indexed',
    REVIEW: 'receipts/review_needed'
  },
  FOLDERS: {
    RECEIPTS_2025: '1pkvyPz6_VGhLS2HS7mcpeAyg3Plz3rvF', // Taxes/2025/Receipts
    RECEIPTS_2026: '1tAcCCcSOrv4Yprrm6IrjWKB00fJc9-wX'  // Taxes/2026/Receipts
  },
  SHEETS: {
    INVENTORY_2025_ID: '1BzwXcQpvlSJ1ccdmfOQ8COZ2EIBSDOQ0UP7he73Yj-Q',
    INVENTORY_2026_ID: '194nQzKDYo0Bt8tfO1P1UBAD-dtDgSb7CWDatv61-ADI',
    TAB_NAME: 'Untitled'
  }
};

/**
 * Main Entry Point: Runs daily via Time-Driven Trigger (8:30 AM)
 */
function runDailyReceiptIngestion() {
  ensureLabelsExist();

  const sourceLabel = GmailApp.getUserLabelByName(CONFIG.LABELS.SOURCE);
  const indexedLabel = GmailApp.getUserLabelByName(CONFIG.LABELS.INDEXED);
  const reviewLabel = GmailApp.getUserLabelByName(CONFIG.LABELS.REVIEW);

  if (!sourceLabel) {
    Logger.log('Source label "' + CONFIG.LABELS.SOURCE + '" not found.');
    return;
  }

  const query = 'label:"' + CONFIG.LABELS.SOURCE + '" -label:"' + CONFIG.LABELS.INDEXED + '"';
  const threads = GmailApp.search(query, 0, 50);

  Logger.log('Found ' + threads.length + ' unindexed receipt threads.');
  if (threads.length === 0) return;

  const existingKeys2025 = getExistingSheetKeys(CONFIG.SHEETS.INVENTORY_2025_ID);
  const existingKeys2026 = getExistingSheetKeys(CONFIG.SHEETS.INVENTORY_2026_ID);

  let processed2025 = 0;
  let processed2026 = 0;
  let totalAmountLogged = 0;

  threads.forEach(thread => {
    const messages = thread.getMessages();
    let threadHandled = false;
    const threadSeenOrders = new Set();

    // Sort messages so messages with PDF attachments are evaluated first
    const sortedMessages = messages.slice().sort((a, b) => {
      const aHasPdf = hasPdfAttachment(a) ? 1 : 0;
      const bHasPdf = hasPdfAttachment(b) ? 1 : 0;
      return bHasPdf - aHasPdf;
    });

    sortedMessages.forEach(msg => {
      if (msg.isInTrash() || msg.isDraft()) return;

      const parsedData = extractReceiptMetadata(msg);
      if (!parsedData || parsedData.disqualified || parsedData.amount <= 0) {
        Logger.log('Skipping non-qualifying message: ' + msg.getSubject());
        return;
      }

      // Deduplicate multiple messages for the same purchase within a single thread
      const dedupKey = parsedData.orderId
        ? `${parsedData.merchant}|${parsedData.orderId}`
        : `${parsedData.merchant}|${parsedData.date}|${parsedData.amount.toFixed(2)}`;

      if (threadSeenOrders.has(dedupKey)) {
        Logger.log('Skipping duplicate message in same thread for: ' + dedupKey);
        return;
      }
      threadSeenOrders.add(dedupKey);

      const year = parsedData.year;
      if (year !== 2025 && year !== 2026) {
        Logger.log('Skipping message outside 2025-2026 tax years (' + year + '): ' + msg.getSubject());
        return;
      }

      const targetFolderId = (year === 2025) ? CONFIG.FOLDERS.RECEIPTS_2025 : CONFIG.FOLDERS.RECEIPTS_2026;
      const targetSheetId = (year === 2025) ? CONFIG.SHEETS.INVENTORY_2025_ID : CONFIG.SHEETS.INVENTORY_2026_ID;
      const existingKeys = (year === 2025) ? existingKeys2025 : existingKeys2026;

      if ( parsedData.orderId && existingKeys.has(parsedData.orderId) ) {
        Logger.log('Order already logged in sheet (' + parsedData.orderId + '). Marking thread handled.');
        threadHandled = true;
        return;
      }

      // 1. Archive Receipt Document/PDF in Google Drive
      const receiptFile = archiveReceiptInDrive(msg, parsedData, targetFolderId);

      // 2. Append Row to Master Inventory Sheet
      if (receiptFile) {
        if (!existingKeys.has(receiptFile.getName())) {
          appendRowToSheet(targetSheetId, receiptFile.getName(), parsedData);
          existingKeys.add(receiptFile.getName());
          if (parsedData.orderId) existingKeys.add(parsedData.orderId);
        }
        if (year === 2025) processed2025++;
        if (year === 2026) processed2026++;
        totalAmountLogged += parsedData.amount;
        threadHandled = true;
      }
    });

    if (threadHandled) {
      thread.addLabel(indexedLabel);
      thread.removeLabel(reviewLabel);
    } else {
      thread.addLabel(reviewLabel);
    }
  });

  Logger.log(
    `Ingestion Complete. 2025: ${processed2025}, 2026: ${processed2026}, Total Logged: $${totalAmountLogged.toFixed(2)}`
  );
}

/**
 * Checks if a GmailMessage has a PDF attachment
 */
function hasPdfAttachment(msg) {
  const attachments = msg.getAttachments();
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    if (att.getContentType() === 'application/pdf' || att.getName().toLowerCase().endsWith('.pdf')) {
      return true;
    }
  }
  return false;
}

/**
 * Loads existing Receipt Filenames and Reference/Order IDs from a target sheet to prevent duplicates
 */
function getExistingSheetKeys(sheetId) {
  const keys = new Set();
  try {
    const ss = SpreadsheetApp.openById(sheetId);
    const sheet = ss.getSheetByName(CONFIG.SHEETS.TAB_NAME) || ss.getSheets()[0];
    if (!sheet || sheet.getLastRow() < 2) return keys;
    const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 7).getValues();
    data.forEach(row => {
      const filename = String(row[0] || '').trim();
      const refCol = String(row[6] || '').trim();
      if (filename) keys.add(filename);
      if (refCol) keys.add(refCol);
    });
  } catch (e) {
    Logger.log('Warning: Could not read existing keys from ' + sheetId + ': ' + e.toString());
  }
  return keys;
}

/**
 * Extracts metadata, vendor, amounts, and tax category from message per SOP Section 2 & 5
 */
function extractReceiptMetadata(msg) {
  const from = msg.getFrom().toLowerCase();
  const subject = msg.getSubject();
  const subjectLower = subject.toLowerCase();
  const body = msg.getPlainBody() || '';
  const dateObj = msg.getDate();
  const year = dateObj.getFullYear();
  const dateStr = Utilities.formatDate(dateObj, Session.getScriptTimeZone(), 'yyyy-MM-dd');

  // Section 2B Disqualification Criteria (Never Label / Never Ingest)
  const disqualifiedSubjects = [
    'pickup complete',
    'survey',
    'delivered 1 item',
    'pre-visit estimate',
    'echeck-in',
    'statement is ready',
    'payment scheduled'
  ];
  if (disqualifiedSubjects.some(term => subjectLower.includes(term))) {
    return { disqualified: true };
  }

  let merchant = 'Unknown Merchant';
  let category = 'Merchandise / General';
  let amount = 0;
  let paymentMethod = 'Card on file';
  let orderId = '';
  let description = subject;

  // Extract amount using common receipt regex patterns
  const amountMatch =
    body.match(/(?:Total Paid|TOTAL|Total Charged|Amount Paid|Order Total|Grand Total|Payment Amount|You paid|Amount)[:\s]*\$?\s*([0-9,]+\.[0-9]{2})/i) ||
    subject.match(/\$([0-9,]+\.[0-9]{2})/) ||
    body.match(/\$([0-9,]+\.[0-9]{2})\s*(?:USD)?/i);

  if (amountMatch) {
    amount = parseFloat(amountMatch[1].replace(/,/g, ''));
  }

  // Vendor-Specific Rules & Extraction (aligned with SOP Section 5 Master Registry)
  if (from.includes('amazon.com')) {
    merchant = 'Amazon.com';
    category = 'Merchandise / General';
    const idMatch =
      body.match(/(?:Order #|Order #:|order number)\s*([D0-9]{3}-[0-9]{7}-[0-9]{7})/i) ||
      subject.match(/([D0-9]{3}-[0-9]{7}-[0-9]{7})/);
    orderId = idMatch ? 'Order #' + idMatch[1] : '';
    if (from.includes('digital-no-reply') || subjectLower.includes('kindle') || subjectLower.includes('amazon.com order of')) {
      category = 'Entertainment / Books & Digital Media';
    }
  } else if (from.includes('prismahealth.org')) {
    merchant = 'Prisma Health';
    category = 'Healthcare / Medical';
    const authMatch = body.match(/Authorization code:?\s*([0-9A-Z]+)/i);
    orderId = authMatch ? 'Auth #' + authMatch[1] : 'Clinical Visit Copay';
    description = 'Clinical outpatient visit copay payment';
  } else if (from.includes('patient-message.com') || subjectLower.includes('total care psychiatry')) {
    merchant = 'Total Care Psychiatry';
    category = 'Healthcare / Medical';
    description = 'Outpatient psychiatric consultation / therapy session copay';
    paymentMethod = 'MasterCard ending in 2062';
  } else if (from.includes('labcorp')) {
    merchant = 'Labcorp (Laboratory Corporation of America)';
    category = 'Healthcare / Medical';
    const invMatch = body.match(/(?:Invoice|Confirmation)\s*(?:#|Number)?[:\s]*([0-9A-Z-]+)/i);
    orderId = invMatch ? 'Conf #' + invMatch[1] : 'Labcorp Payment';
    description = 'Clinical laboratory testing payment confirmation';
  } else if (from.includes('banfield.com')) {
    merchant = 'Banfield Pet Hospital (Woodruff SC)';
    category = 'Pet Care / Veterinary';
    const invMatch = body.match(/Invoice\s*(?:#|Number)?[:\s]*([0-9]+)/i);
    orderId = invMatch ? 'Invoice #' + invMatch[1] : '';
    description = 'Veterinary care & medication';
  } else if (from.includes('paypal.com')) {
    // Exclude personal peer-to-peer transfers per SOP Section 3.3
    if (!body.includes('Merchant') && !body.includes('Order ID') && !body.includes('Invoice ID') && !body.includes('Spotify')) {
      return { disqualified: true };
    }
    if (body.includes('Spotify USA')) {
      merchant = 'Spotify USA Inc';
      category = 'Entertainment / Subscriptions';
      paymentMethod = 'Capital One Checking ending in 9479 (via PayPal)';
      description = 'Monthly Spotify audio streaming subscription';
    } else {
      const merchMatch = body.match(/Merchant\s*\n+\s*([^\n\r]+)/i);
      merchant = merchMatch ? merchMatch[1].trim() + ' (via PayPal)' : 'PayPal Merchant Payment';
      category = 'Merchandise / Online Services';
    }
    const pMatch = body.match(/(?:Order ID|Invoice ID|Transaction ID)[:\s]*([A-Z0-9-]+)/i);
    orderId = pMatch ? 'Order ID: ' + pMatch[1] : '';
  } else if (from.includes('google.com')) {
    if (body.includes('Google Cloud') || from.includes('payments-noreply')) {
      merchant = 'Google Cloud Platform';
      category = 'Professional / Cloud Infrastructure';
      description = 'GCP infrastructure and API usage charges';
    } else {
      merchant = 'Google LLC / Google Play';
      category = 'Professional / Software Subscriptions';
    }
    const gMatch = body.match(/(?:Order number|Invoice number)[:\s]*([A-Z0-9.-]+)/i);
    orderId = gMatch ? 'Order #' + gMatch[1] : '';
  } else if (from.includes('homedepot.com')) {
    merchant = 'The Home Depot';
    category = 'Home Improvement / Maintenance';
    const hdMatch = body.match(/Order\s*#?[:\s]*([A-Z0-9-]+)/i);
    orderId = hdMatch ? 'Order #' + hdMatch[1] : '';
  } else if (from.includes('tractorsupply.com')) {
    merchant = 'Tractor Supply Co.';
    category = 'Home Improvement / Landscaping & Gardening';
    const tsMatch = body.match(/Order Number[:\s]*([0-9]+)/i);
    orderId = tsMatch ? 'Order #' + tsMatch[1] : '';
  } else if (from.includes('nabucasa.com')) {
    merchant = 'Nabu Casa, Inc.';
    category = 'Professional / Smart Home & Cloud Software';
    description = 'Home Assistant Cloud Remote Access Subscription';
  } else if (from.includes('todoist.com')) {
    merchant = 'Doist Inc. / Todoist';
    category = 'Professional / Productivity Software';
    description = 'Todoist Pro Annual Subscription';
  } else if (from.includes('intuit.com')) {
    merchant = 'Intuit TurboTax';
    category = 'Professional / Tax Preparation';
    const ttMatch = body.match(/Order Number[:\s]*([A-Z0-9-]+)/i);
    orderId = ttMatch ? 'Order #' + ttMatch[1] : '';
  } else if (from.includes('greenvillecounty.org')) {
    merchant = 'Greenville County Tax Collector';
    category = 'Taxes & Government Fees / Vehicle Property Tax';
    description = 'Greenville County Vehicle Property Tax Payment';
  } else if (from.includes('priceline.com')) {
    merchant = 'Priceline.com';
    category = 'Travel / Lodging';
    const plMatch = body.match(/trip number[:\s]*([0-9-]+)/i);
    orderId = plMatch ? 'Trip #' + plMatch[1] : '';
  } else if (from.includes('wingstop.com')) {
    merchant = 'Wingstop';
    category = 'Dining / Meals';
    description = 'Online food & dining order';
  } else if (from.includes('panerabread.com')) {
    merchant = 'Panera Bread';
    category = 'Dining / Meals';
    const pbMatch = body.match(/Order\s*#?[:\s]*([0-9]+)/i);
    orderId = pbMatch ? 'Order #' + pbMatch[1] : '';
    description = 'Online food & dining carryout';
  } else if (from.includes('lego.com')) {
    merchant = 'LEGO System A/S';
    category = 'Merchandise / Hobbies';
    const legoMatch = body.match(/(?:Invoice|Order)\s*#?[:\s]*([0-9]+)/i);
    orderId = legoMatch ? 'Invoice #' + legoMatch[1] : '';
  }

  // Extract Card Last 4 Digits
  const cardMatch = body.match(/(?:Visa|MasterCard|Amex|Discover|Card|ending in)\s*(?:ending in|\.{2,4}|\*+)?\s*([0-9]{4})/i);
  if (cardMatch) {
    paymentMethod = 'Card ending in ' + cardMatch[1];
  }

  return {
    disqualified: false,
    year: year,
    merchant: merchant,
    date: dateStr,
    amount: amount,
    paymentMethod: paymentMethod,
    category: category,
    orderId: orderId,
    description: description
  };
}

/**
 * Saves vendor PDF attachment or creates a formatted native Google Doc in target Drive folder
 */
function archiveReceiptInDrive(msg, data, folderId) {
  const folder = DriveApp.getFolderById(folderId);
  const cleanMerchant = data.merchant.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_');
  const cleanOrder = data.orderId ? '_' + data.orderId.replace(/[^a-zA-Z0-9]/g, '') : '';
  const attachments = msg.getAttachments();

  // Case A: Vendor attached a PDF receipt (e.g., Banfield, LEGO, Home Depot eReceipt)
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    if (att.getContentType() === 'application/pdf' || att.getName().toLowerCase().endsWith('.pdf')) {
      const pdfName = `${cleanMerchant}_Receipt_${data.date}${cleanOrder}.pdf`;
      return folder.createFile(att.copyBlob().setName(pdfName));
    }
  }

  // Case B: HTML/Text body receipt -> Create native Google Doc via DocumentApp and move to target folder
  const docTitle = `${cleanMerchant}_Receipt_${data.date}${cleanOrder}`;
  const doc = DocumentApp.create(docTitle);
  const body = doc.getBody();

  body.appendParagraph(`${data.merchant} — Purchase Receipt`)
      .setHeading(DocumentApp.ParagraphHeading.HEADING2);
  body.appendParagraph(`Date: ${data.date}`);
  body.appendParagraph(`Merchant: ${data.merchant}`);
  body.appendParagraph(`Amount Paid: $${data.amount.toFixed(2)} USD`);
  body.appendParagraph(`Payment Method: ${data.paymentMethod}`);
  body.appendParagraph(`Order / Reference ID: ${data.orderId || 'N/A'}`);
  body.appendParagraph(`Category: ${data.category}`);
  body.appendParagraph(`Description: ${data.description}`);
  body.appendParagraph(`Gmail Thread ID: ${msg.getThread().getId()}`);
  body.appendHorizontalRule();
  body.appendParagraph('Original Email Excerpt:').setBold(true);
  body.appendParagraph((msg.getPlainBody() || '').substring(0, 4000));

  doc.saveAndClose();

  const file = DriveApp.getFileById(doc.getId());
  file.moveTo(folder);
  return file;
}

/**
 * Appends transaction row directly to the master inventory sheet (handling 2025 10-col vs 2026 8-col schemas)
 */
function appendRowToSheet(sheetId, filename, data) {
  const ss = SpreadsheetApp.openById(sheetId);
  const sheet = ss.getSheetByName(CONFIG.SHEETS.TAB_NAME) || ss.getSheets()[0];

  if (data.year === 2025 || sheetId === CONFIG.SHEETS.INVENTORY_2025_ID) {
    // 2025 10-column reconciliation schema:
    // [Receipt Filename, Merchant / Issuer, Receipt Date, Receipt Amount, Payment Method, Matched Account, Reference / Order Details, Matched Tx Date, Matched Tx Amount, Status]
    sheet.appendRow([
      filename,
      data.merchant,
      data.date,
      data.amount,
      data.paymentMethod,
      data.category,
      data.orderId || data.description,
      data.date,
      data.amount,
      'Unreconciled (Auto-Ingested)'
    ]);
  } else {
    // 2026 8-column expense schema:
    // [Receipt Filename, Merchant / Issuer, Date, Amount Paid ($), Payment Method, Category, Reference / Order IDs, Description / Items]
    sheet.appendRow([
      filename,
      data.merchant,
      data.date,
      data.amount,
      data.paymentMethod,
      data.category,
      data.orderId,
      data.description
    ]);
  }

  Logger.log(`Appended to Sheet ${sheetId}: ${data.merchant} - $${data.amount.toFixed(2)}`);
}

/**
 * Helper: Ensures required Gmail tracking labels exist
 */
function ensureLabelsExist() {
  [CONFIG.LABELS.INDEXED, CONFIG.LABELS.REVIEW].forEach(labelName => {
    if (!GmailApp.getUserLabelByName(labelName)) {
      GmailApp.createLabel(labelName);
      Logger.log('Created Gmail label: ' + labelName);
    }
  });
}

/**
 * Setup Function: Run once from Script Editor to install daily 8:30 AM Trigger
 */
function setupDailyTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'runDailyReceiptIngestion') {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('runDailyReceiptIngestion')
    .timeBased()
    .everyDays(1)
    .atHour(8)
    .nearMinute(30)
    .create();

  Logger.log('Daily 8:30 AM trigger installed successfully.');
}
```

---

## 3. Step-by-Step Deployment Guide

1. **Open Google Apps Script:** Go to [script.google.com](https://script.google.com) and click **New Project** (or open your 2026 Master Receipt Sheet and click **Extensions > Apps Script**).
2. **Paste Code:** Name the project `Financial-Receipts-Ingestion`, replace starter code in `Code.gs` with the script above, and save.
3. **Run Setup Trigger:** Select `setupDailyTrigger` from the toolbar dropdown and click **Run**, granting Workspace permissions when prompted.
4. **Verify Execution:** Run `runDailyReceiptIngestion` manually at any time to verify ingestion.

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

  const budget = typeof SparkCore !== "undefined" && SparkCore.createExecutionBudget
    ? SparkCore.createExecutionBudget(240000)
    : null;

  for (let t = 0; t < threads.length; t++) {
    if (budget && budget.isTimeExpiring()) {
      Logger.log('[BUDGET_EXPIRED] Execution time budget reaching limit. Halting receipt threads loop cleanly.');
      break;
    }
    const thread = threads[t];
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
  }

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
 * Saves vendor PDF attachment or creates a formatted native Google Doc in target Drive folder.
 * Uses SparkCore.extractFileId for resilient folder resolution.
 */
function archiveReceiptInDrive(msg, data, folderId) {
  const cleanFolderId = typeof SparkCore !== "undefined" && SparkCore.extractFileId
    ? (SparkCore.extractFileId(folderId) || folderId)
    : folderId;
  const folder = DriveApp.getFolderById(cleanFolderId);
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
 * Appends transaction row directly to the master inventory sheet (handling 2025 10-col vs 2026 8-col schemas).
 * Sanitizes untrusted text fields via SparkCore.SheetKit.sanitizeCellValue to defend against formula injection.
 */
function appendRowToSheet(sheetId, filename, data) {
  const cleanSheetId = typeof SparkCore !== "undefined" && SparkCore.extractFileId
    ? (SparkCore.extractFileId(sheetId) || sheetId)
    : sheetId;
  const ss = SpreadsheetApp.openById(cleanSheetId);
  const sheet = ss.getSheetByName(CONFIG.SHEETS.TAB_NAME) || ss.getSheets()[0];

  const sanitize = typeof SparkCore !== "undefined" && SparkCore.sanitizeCellValue
    ? SparkCore.sanitizeCellValue
    : function(v) { return v; };

  if (data.year === 2025 || sheetId === CONFIG.SHEETS.INVENTORY_2025_ID) {
    // 2025 10-column reconciliation schema:
    // [Receipt Filename, Merchant / Issuer, Receipt Date, Receipt Amount, Payment Method, Matched Account, Reference / Order Details, Matched Tx Date, Matched Tx Amount, Status]
    sheet.appendRow([
      sanitize(filename),
      sanitize(data.merchant),
      data.date,
      data.amount,
      sanitize(data.paymentMethod),
      sanitize(data.category),
      sanitize(data.orderId || data.description),
      data.date,
      data.amount,
      'Unreconciled (Auto-Ingested)'
    ]);
  } else {
    // 2026 8-column expense schema:
    // [Receipt Filename, Merchant / Issuer, Date, Amount Paid ($), Payment Method, Category, Reference / Order IDs, Description / Items]
    sheet.appendRow([
      sanitize(filename),
      sanitize(data.merchant),
      data.date,
      data.amount,
      sanitize(data.paymentMethod),
      sanitize(data.category),
      sanitize(data.orderId),
      sanitize(data.description)
    ]);
  }

  Logger.log(`Appended to Sheet ${cleanSheetId}: ${data.merchant} - $${data.amount.toFixed(2)}`);
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
 * Setup Function: Run once from Script Editor to install daily 8:30 AM Trigger.
 * Delegates to SparkCore.Harness.installDailyTrigger.
 */
function setupDailyTrigger() {
  if (typeof SparkCore !== "undefined" && SparkCore.installDailyTrigger) {
    SparkCore.installDailyTrigger('runDailyReceiptIngestion', 8, 30);
    Logger.log('Daily 8:30 AM trigger installed successfully via SparkCore.');
    return;
  }

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

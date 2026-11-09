# Financial Receipts Label Refinement Procedure

**System Location:** Google Drive / [gemini-spark](https://drive.google.com/drive/folders/1XQyRsEx8gQl8idUv_UhfRMYxS9dIx0tk)
**Companion Apps Script Spec:** [Receipts_Ingestion_Automation_Code.gs.md](https://docs.google.com/document/d/1ezcHQvkzr4sM-uLSWiQToKgvWaozWohLrstsAe6UA7g/edit)
**Live Apps Script Project:** [Financial-Receipts-Ingestion](https://script.google.com/d/1PzJn5MJCCE4K0UhZHqS9rboJUpjR7P5psLi1DjQxPpHmKKPAIuxQdkfJ/edit) (`1PzJn5MJCCE4K0UhZHqS9rboJUpjR7P5psLi1DjQxPpHmKKPAIuxQdkfJ`)
**Master Inventory Sheets:** [2025 Tax Receipts Inventory](https://docs.google.com/spreadsheets/d/1BzwXcQpvlSJ1ccdmfOQ8COZ2EIBSDOQ0UP7he73Yj-Q/edit) | [2026 Tax Receipts Inventory](https://docs.google.com/spreadsheets/d/194nQzKDYo0Bt8tfO1P1UBAD-dtDgSb7CWDatv61-ADI/edit)
**Author / Context:** Gemini Spark & Wryen Meek
**Effective Date:** October 30, 2026
**Governing Label:** `financial receipts` (Internal Gmail ID: `Label_106`)

---

## 1. Purpose & Operational Context

This document establishes the canonical standard operating procedure (SOP) for identifying, validating, refining, and maintaining the automated categorization of financial receipts and tax-deductible expense records across Wryen Meek's Gmail account and Google Drive tax archives (`Taxes/2025` and `Taxes/2026`).

The system operates through a four-layer automation architecture:
1. **First-Line AI Classifier:** Google Workspace Studio workflow (*"Label Receipt Emails"*) evaluating incoming messages against semantic criteria.
2. **Deterministic Gmail Filters:** Explicit rule-based filters (configured via Gmail API) providing guaranteed 100% precision for known merchants, healthcare providers, and recurring subscriptions.
3. **8:30 AM Zero-Token Apps Script Ingestion Engine ([`Financial-Receipts-Ingestion`](https://script.google.com/d/1PzJn5MJCCE4K0UhZHqS9rboJUpjR7P5psLi1DjQxPpHmKKPAIuxQdkfJ/edit)):** Scans `label:"financial receipts" -label:"receipts/indexed"`, archives PDF attachments or native Google Doc receipts into `Taxes/2025/Receipts` (`1pkvyPz6_VGhLS2HS7mcpeAyg3Plz3rvF`) or `Taxes/2026/Receipts` (`1tAcCCcSOrv4Yprrm6IrjWKB00fJc9-wX`), appends rows directly to the permanent 2025 (10-column) or 2026 (8-column) Master Inventory Sheet, and applies `receipts/indexed`.
4. **9:00 AM Daily Surveillance & Self-Updating Scheduled Scan:** A daily cron query (*"Track 2025-2026 tax receipts and tagged emails"*) scanning both `label:"financial receipts"` and recent unlabeled Inbox emails (`in:inbox -label:"financial receipts" newer_than:2d`). When an unlabeled purchase is detected, the scan tags the thread, archives the receipt, updates the permanent master inventory spreadsheet, and generates a new deterministic Gmail filter.

---

## 2. Receipt Qualification & Disqualification Taxonomy

To prevent archive bloat, double-counting, and tax compliance errors, messages must meet strict criteria before receiving the `financial receipts` label.

### A. Mandatory Qualification Criteria (Must Label)
- **Completed Commercial Purchases:** Merchant order confirmations and shipping confirmations that contain itemized pricing, sales tax, total paid, and payment method (e.g., Amazon physical orders, Home Depot, Tractor Supply, LEGO Shop).
- **Outpatient Healthcare Payments & Copays:** Proof-of-payment receipts containing authorization codes, transaction IDs, or credit card digits (e.g., Prisma Health clinical visit copays, Total Care Psychiatry therapy copays, Labcorp payment confirmations, Banfield veterinary hospital invoices).
- **Recurring Commercial Subscriptions:** Recurring software and service billing receipts with verifiable merchant identifiers and order IDs (e.g., Spotify via PayPal, Home Assistant Cloud / Nabu Casa, Todoist Pro, Google Play Google One annual storage).
- **Cloud & Developer Infrastructure:** Monthly usage invoices and payment received notifications (e.g., Google Cloud Platform billing receipts).
- **Annual Local Tax & Official Fees:** Government property tax payments and official filing fees (e.g., Greenville County Vehicle Property Tax, TurboTax online tax preparation).

### B. Strict Disqualification Criteria (Never Label)
- **Unpaid Statements & Past-Due Notices:** Periodic account summaries, billing statements without proof of payment, or past-due collections notices (e.g., Labcorp patient statements, utility statements).
- **Pre-Visit Cost Estimates & eCheck-In Reminders:** Projected clinical estimates or appointment check-in prompts (e.g., Prisma Health pre-visit estimates).
- **Post-Fulfillment Surveys & Delivery Tracking:** Shipping status updates lacking invoice links, pure delivery notifications, or post-pickup customer satisfaction surveys (e.g., Home Depot *"Pickup complete, enjoy your order!"* survey prompts, Amazon *"Delivered 1 item"* alerts).
- **Zero-Cash Credit Downloads:** Subscription title redemptions where no cash or card is charged (e.g., Audible 1-credit member audiobook downloads, Kindle free promotions).
- **Preliminary Insurance Order Acknowledgment:** Resupply orders in process prior to final delivery or billing (e.g., AeroCare CPAP supply requests).
- **Inter-Account Transfers & Credit Card Payments:** Bank-to-card balance payments, checking-to-savings transfers, or peer-to-peer friend transfers (e.g., Citi card balance payments, Venmo/PayPal friend transfers).

---

## 3. Filter Design Principles & Collision Avoidance

All deterministic Gmail filters created under this procedure must adhere to four design rules:
1. **Exact Phrase Quoting for Ambiguous Terms:** Always wrap multi-word phrases in literal double quotes in the query parameter (e.g., `"code for greenville"`). Never pass unquoted space-delimited words into `containWords`, as Gmail evaluates unquoted terms with implicit boolean OR across disparate sections of an email.
2. **Negative Scoping on Multi-Event Vendor Senders:** When a merchant uses the same sender email for orders, status updates, and surveys (such as Home Depot or Tractor Supply), explicitly exclude non-financial subjects (e.g., `-subject:"Pickup complete" -subject:"survey"`).
3. **Merchant Discrimination on Payment Gateways:** When filtering payment aggregators like PayPal (`service@paypal.com`), always require purchase metadata tokens (`"You paid" ("Merchant" OR "Order ID" OR "Invoice ID")`) to strictly exclude personal peer-to-peer transfers.
4. **Cross-Year Sender Resilience:** When merchants utilize multiple corporate sending subdomains across years (e.g., `intuit@notifications.intuit.com` vs. `do_not_reply@intuit.com`), combine them into grouped parenthetical expressions.

---

## 4. End-to-End Refinement Lifecycle Procedure

Execute this 7-step workflow whenever auditing past periods, onboarding new vendor categories, or resolving classification errors:

### Step 1: Surveillance Query Execution
Execute a targeted Gmail thread search for the target date range excluding existing tagged messages:
`after:YYYY/MM/DD before:YYYY/MM/DD -label:"financial receipts" (order OR receipt OR invoice OR payment OR confirmation)`

### Step 2: Message Inspection & Evidence Extraction
Inspect the full plain text body and header metadata of candidate threads. Extract the 6 required audit fields:
- Merchant / Issuer Display Name and Sending Address
- Transaction Date (in `YYYY-MM-DD` format)
- Exact Amount Paid & Currency
- Payment Method (Card brand and last 4 digits, bank checking/savings digits, or wallet)
- Transaction / Order / Invoice / Authorization Reference Numbers
- Itemized Description & Tax Deduction Category

### Step 3: Taxonomy Compliance Evaluation
Cross-reference extracted data against Section 2 (Qualification vs. Disqualification). If the transaction is a canceled order, duplicate notification, or $0.00 credit redemption, flag it for exclusion.

### Step 4: Deterministic Filter Synthesis
If the vendor is not covered by an existing rule, create a high-precision filter via `gmail:create_filter` targeting the exact sender and subject pattern, with action `addLabelIds: ['Label_106']`.

### Step 5: Label Application & False-Positive Remediation
- Apply `Label_106` to all qualified historical threads using `gmail:label_thread`.
- If an email was contaminated by an overlapping filter (such as `Label_101`), strip the erroneous label using `gmail:unlabel_thread`.

### Step 6: Drive Document & Permanent Master Inventory Ingestion
- The daily 8:30 AM Apps Script engine ([`Financial-Receipts-Ingestion`](https://script.google.com/d/1PzJn5MJCCE4K0UhZHqS9rboJUpjR7P5psLi1DjQxPpHmKKPAIuxQdkfJ/edit)) automatically archives vendor PDF attachments or native Google Doc receipts in `Taxes/2025/Receipts` (`1pkvyPz6_VGhLS2HS7mcpeAyg3Plz3rvF`) or `Taxes/2026/Receipts` (`1tAcCCcSOrv4Yprrm6IrjWKB00fJc9-wX`).
- Transactions are appended directly in place to the single permanent Master Inventory Sheet ([2025 Inventory](https://docs.google.com/spreadsheets/d/1BzwXcQpvlSJ1ccdmfOQ8COZ2EIBSDOQ0UP7he73Yj-Q/edit) using its 10-column reconciliation schema, or [2026 Inventory](https://docs.google.com/spreadsheets/d/194nQzKDYo0Bt8tfO1P1UBAD-dtDgSb7CWDatv61-ADI/edit) using its 8-column expense schema) and tagged `receipts/indexed`.

### Step 7: Automated Schedule Synchronization
Verify that the daily 9:00 AM scheduled query references the permanent Master Inventory Spreadsheet IDs (`1BzwXcQpvlSJ1ccdmfOQ8COZ2EIBSDOQ0UP7he73Yj-Q` and `194nQzKDYo0Bt8tfO1P1UBAD-dtDgSb7CWDatv61-ADI`) and inspects any threads flagged `receipts/review_needed`.

---

## 5. Active Filter Master Registry (Reference)

| Vendor / Category | Filter Criteria Query | Action |
| :--- | :--- | :--- |
| **TurboTax / Intuit Orders** | `from:(intuit@notifications.intuit.com OR do_not_reply@intuit.com) subject:("Order Confirmation" OR "Your Order Confirmation")` | Add `Label_106` |
| **Tractor Supply Orders** | `from:no-reply@ta.tractorsupply.com subject:"Thank you for ordering"` | Add `Label_106` |
| **The Home Depot Orders & eReceipts** | `from:homedepot@order.homedepot.com subject:("We received your order" OR "Your Electronic Receipt") -subject:"Pickup complete"` | Add `Label_106` |
| **Amazon Standard Orders** | `from:auto-confirm@amazon.com subject:"Ordered:"` | Add `Label_106` |
| **Amazon Digital / Kindle** | `from:digital-no-reply@amazon.com subject:("Amazon.com order of")` | Add `Label_106` |
| **Amazon Shipping Invoices** | `from:shipment-tracking@amazon.com "Your invoice can be accessed here"` | Add `Label_106` |
| **Prisma Health Paid Copays** | `from:noreply@prismahealth.org subject:"Thank you for your payment" "Payment Processed"` | Add `Label_106` |
| **Total Care Psychiatry** | `from:noreply@patient-message.com OR subject:("receipt from TOTAL CARE PSYCHIATRY" OR "TOTAL CARE PSYCHIATRY payment receipt")` | Add `Label_106` |
| **Labcorp Payment Confirmations** | `from:labcorp.com subject:("Payment Confirmation" OR "Payment Receipt")` | Add `Label_106` |
| **Banfield Pet Hospital** | `from:no-reply@banfield.com subject:"Your Invoice for" has:attachment` | Add `Label_106` |
| **PayPal Merchant Payments** | `from:service@paypal.com "You paid" ("Merchant" OR "Order ID" OR "Invoice ID")` | Add `Label_106` |
| **Google Cloud & Google Play** | `from:(payments-noreply@google.com OR googleplay-noreply@google.com) subject:("We've received your payment" OR "Your Google Play Order Receipt")` | Add `Label_106` |
| **Priceline Lodging Receipts** | `from:info@travel.priceline.com subject:"receipt from Priceline"` | Add `Label_106` |
| **Dining (Wingstop & Panera)** | `from:(noreply@online.wingstop.com OR panera@m2.panerabread.com) subject:("Your order confirmation" OR "We've received your")` | Add `Label_106` |
| **Annual Software & Property Tax** | `from:(support@nabucasa.com OR no-reply@todoist.com OR payments@greenvillecounty.org) subject:("Receipt" OR "Invoice" OR "Payment Confirmation" OR "Subscription renewed")` | Add `Label_106` |
| **LEGO Shop Invoices** | `from:no-reply-billing03@lego.com subject:"Receipt"` | Add `Label_106` |

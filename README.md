# Gemini Spark — Google Apps Script Automations

This workspace contains the source code, `appsscript.json` manifests, `clasp` bindings, unit tests, and Google Drive documentation for all three `gemini-spark` Google Apps Script automations.

## Deployed Projects

| Project | Script ID & Editor Link | Bound Google Sheet | Trigger Setup Function |
| :--- | :--- | :--- | :--- |
| **1. Financial Receipts Ingestion** (`projects/receipts-ingestion`) | [`1PzJn5MJCCE4K0UhZHqS9rboJUpjR7P5psLi1DjQxPpHmKKPAIuxQdkfJ`](https://script.google.com/d/1PzJn5MJCCE4K0UhZHqS9rboJUpjR7P5psLi1DjQxPpHmKKPAIuxQdkfJ/edit) | [2026 Receipts Inventory](https://docs.google.com/spreadsheets/d/194nQzKDYo0Bt8tfO1P1UBAD-dtDgSb7CWDatv61-ADI/edit) | `setupDailyTrigger()` (Zero-token; no API key required) |
| **2. Writing Style Index Automation** (`projects/writing-style-index`) | [`1yuepYNbNxeZmYvy7LfmNeN6k1XgKgn-jWNA3nNkHlWgAXdEPfbIzDIwu`](https://script.google.com/d/1yuepYNbNxeZmYvy7LfmNeN6k1XgKgn-jWNA3nNkHlWgAXdEPfbIzDIwu/edit) | [Writing Style & Tone Reference Index](https://docs.google.com/spreadsheets/d/1HPY3pKrgzeJr1FMLiK_UNyNJcfPTanJoPRL3ikF_nA8/edit) | `setupAllTriggers()` (Requires `GEMINI_API_KEY` in Script Properties) |
| **3. Drive Tagging Automation** (`projects/drive-tagging`) | [`1F2-pZJZ1jzfoNS7EgnQOYXOwii5YEU7rFOMKOWN52k2GQcWrBpPbp2-w`](https://script.google.com/d/1F2-pZJZ1jzfoNS7EgnQOYXOwii5YEU7rFOMKOWN52k2GQcWrBpPbp2-w/edit) | [Drive Tagging Master Index](https://docs.google.com/spreadsheets/d/1XE78-Gae0a5DfkuC0lJcy62XjreqPIPovy8LuoAT3gA/edit) | `setupTaggingTriggers()` (Requires `GEMINI_API_KEY` in Script Properties) |

## Local Commands

```bash
# Run unit tests
bun test

# Push local changes to all 3 bound Apps Script projects
./deploy.sh
```

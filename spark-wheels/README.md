# Gemini Spark — Offline Python Wheel Depot (`spark-wheels/`)

This directory serves as the local offline dependency depot for the Python companion tier of Gemini Spark Automations (`fleet_prechunker.py`, `scan_3rd_party_archives.py`, and batch PDF splitting utilities).

---

## 1. Architecture Overview

Apps Script execution quotas (6 minutes wall-clock, 15 MB payload limits) prevent in-container slicing of massive 50–500 MB RPG manual PDFs. The offline companion processing tier handles high-throughput Drive crawling, Table of Contents (TOC) inspection, bisection slicing, and chunk uploads.

To ensure deterministic, reproducible execution across airgapped, firewall-restricted, or headless CI runner environments without ad-hoc external network dependencies, dependencies are vendored or staged via standard pre-compiled Python wheels (`.whl`).

```
spark-wheels/
├── README.md               # Architecture documentation & runbooks
├── requirements.txt        # Pinned runtime dependencies
├── download_wheels.sh      # Automated multi-platform wheel fetcher
└── *.whl                   # Pre-cached binary distributions (optional / git-lfs / airgapped)
```

---

## 2. Pinned Runtime Dependencies (`requirements.txt`)

The core companion utilities require:
- `pymupdf>=1.24.0`: High-performance PDF parsing, TOC hierarchy tree inspection, page-level extraction, and atomic sub-document serialization.
- `google-api-python-client>=2.100.0`: Official Google Drive v3 REST API client for large batch operations.
- `google-auth>=2.20.0`: OAuth2 service account and application-default credentials integration.
- `requests>=2.31.0`: Resilient HTTP client with retry and backoff semantics.

---

## 3. Operational Workflows

### 3.1 Fetching Wheels for Offline Staging
To populate the depot with wheel archives for offline use:

```bash
# From repository root
cd spark-wheels
pip download -r requirements.txt -d .
```

To fetch binary wheels targeting specific platform architectures (e.g. Linux x86_64 for Ubuntu CI workers):
```bash
pip download \
  --only-binary=:all: \
  --platform manylinux2014_x86_64 \
  --python-version 3.12 \
  --implementation cp \
  --abi cp312 \
  -r requirements.txt \
  -d .
```

### 3.2 Installing Offline in Airgapped Environments
To install dependencies strictly from the local depot without any internet connection:

```bash
pip install --no-index --find-links spark-wheels -r spark-wheels/requirements.txt
```

### 3.3 CI Pipeline Dry-Run Verification
The GitHub Actions workflow (`.github/workflows/ci.yml`) runs an automated bridge integrity check on every push and pull request:

```bash
pip install --dry-run -r spark-wheels/requirements.txt
```

---

## 4. Security & Depot Hygiene
- **No Direct Execution:** Files stored in this folder are non-executable packages and documentation.
- **Vulnerability Audits:** Run `pip audit -r spark-wheels/requirements.txt` periodically to ensure pinned versions contain no known CVEs.
- **Deterministic Hashes:** In production deployments requiring airgapped supply-chain guarantees, generate hash-pinned requirements using `pip-compile --generate-hashes`.

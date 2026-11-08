#!/usr/bin/env python3
"""
Fleet Pre-Chunker Runner
Iterates through oversized rulebooks (>= 14.0 MB) across 3rd Party Archives,
generates compliant vector-compressed sub-PDFs (< 14.0 MB) via TOC bookmark slicing
or bisection page-budgeting, creates an 'Extracted_Chapters' folder in each publisher's
Drive directory, and uploads the chunks for autonomous Apps Script ingestion.
"""

import os
import sys
import json
import re
import shutil
import tempfile
import subprocess
import time
import random
from pathlib import Path
import pymupdf

MAX_CHUNK_MB = 13.5  # Safe buffer below Apps Script 15.0 MB limit
INVENTORY_JSON = "/tmp/3rd_party_archives_inventory.json"
STATE_FILE = "/tmp/fleet_prechunk_state.json"
TEMP_WORK_DIR = "/tmp/fleet_prechunk_workspace"

# Publisher Root Folder IDs in Google Drive
PUBLISHER_FOLDERS = {
    "2C Gaming Archive": "1M0whDtq4YjxBEHR2vV7N24XjzDTsA7Xk",
    "Arcane Library Archive": "1FWmXZY8ps6nGn8thzi-BvE2a34xqzkPL",
    "Ghostfire Gaming": "15xId-TEWl0sQ74jXsW96XC4fNvNSTftn",
    "Griffon's Saddlebag": "1JmyRLc9pqfQHfKZ8ssE_o9P_5pL3lgq-",
    "kibblestasty archive": "1jJb0omE-FRg8tKq3p4znMYt3EuLOoNej",
    "Kobold Press Archive": "1MByzSsO7L9jyyVt8cokuqQMD80tJz-hO",
    "Limithron Archive": "1FZwaC3auKNro6HPKzL4aPTZjplROJLJx",
    "Mage Hand Press Archive": "1QehsI9KcE9-YuTeQ9Pe_1zTqG6XSI5Mw",
    "MCDM Archive": "1AYeQE47BeJdxwAAa3x5_Z2_hTmyq9NVz",
    "Monty Cook Games Archive": "1FaEUZRKL6CeNtPj61yLnKYeWv61NKWl9",
    "The Gamemaster's Book of": "13TlX1GSEs83RoK8JSSYH-3TSR0SWu-xF",
}

# Known pre-existing Extracted_Chapters folder for MCDM Archive
EXISTING_EXTRACTED_FOLDERS = {
    "MCDM Archive": "1RdzBAGF4aFYbVmU-1T_NiD7kHt8EB8yp"
}

# Files/keywords already completed earlier today
ALREADY_COMPLETED_KEYWORDS = [
    "flee",
    "where_evil_lives",
    "where evil lives",
    "creature codex",
]


def load_state():
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"processed_ids": {}, "publisher_extracted_folders": EXISTING_EXTRACTED_FOLDERS.copy()}


def save_state(state):
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)


def get_remote_drive_items(folder_id):
    """Returns dict of {name: {'id': id, 'type': type}} in target Drive folder."""
    cmd = ["gdrive", "readonly", "ls", folder_id, "--max", "500"]
    res = subprocess.run(cmd, check=False, capture_output=True, text=True)
    if res.returncode != 0:
        return {}
    items = {}
    lines = res.stdout.strip().split("\n")
    for line in lines[2:]:
        parts = line.split()
        if len(parts) >= 4:
            fid = parts[0]
            ftype = parts[-3]
            fname = " ".join(parts[1:-3])
            items[fname] = {"id": fid, "type": ftype}
    return items


def get_or_create_extracted_folder(publisher_name, state):
    """Finds or creates the Extracted_Chapters folder in the publisher's Drive folder."""
    if publisher_name in state["publisher_extracted_folders"]:
        return state["publisher_extracted_folders"][publisher_name]

    pub_folder_id = PUBLISHER_FOLDERS.get(publisher_name)
    if not pub_folder_id:
        print(f"[WARN] Unknown publisher '{publisher_name}', falling back to MCDM Extracted_Chapters")
        return EXISTING_EXTRACTED_FOLDERS["MCDM Archive"]

    # Check if folder already exists in Drive
    items = get_remote_drive_items(pub_folder_id)
    if "Extracted_Chapters" in items and "folder" in items["Extracted_Chapters"]["type"]:
        folder_id = items["Extracted_Chapters"]["id"]
        print(f"  [FOUND] Extracted_Chapters folder for {publisher_name}: {folder_id}")
        state["publisher_extracted_folders"][publisher_name] = folder_id
        save_state(state)
        return folder_id

    # Create Extracted_Chapters folder
    print(f"  [MKDIR] Creating 'Extracted_Chapters' in {publisher_name} ({pub_folder_id})...")
    cmd = ["gdrive", "mutate", "mkdir", "Extracted_Chapters", "--parent", pub_folder_id]
    res = subprocess.run(cmd, check=False, capture_output=True, text=True)
    if res.returncode == 0:
        # Re-fetch items to get ID
        items = get_remote_drive_items(pub_folder_id)
        if "Extracted_Chapters" in items:
            folder_id = items["Extracted_Chapters"]["id"]
            print(f"  [CREATED] Extracted_Chapters folder for {publisher_name}: {folder_id}")
            state["publisher_extracted_folders"][publisher_name] = folder_id
            save_state(state)
            return folder_id

    print(f"[ERROR] Failed to create Extracted_Chapters in {publisher_name}: {res.stderr}")
    return pub_folder_id


def download_file(file_id, dest_path):
    """Downloads a file from Google Drive."""
    print(f"  [DOWNLOAD] Downloading ID {file_id} to {dest_path}...")
    cmd = ["gdrive", "readonly", "download", file_id, "--out", dest_path]
    res = subprocess.run(cmd, check=False, capture_output=True, text=True)
    if res.returncode == 0 and os.path.exists(dest_path) and os.path.getsize(dest_path) > 0:
        mb = os.path.getsize(dest_path) / (1024 * 1024)
        print(f"  [DOWNLOAD SUCCESS] {mb:.1f} MB")
        return True
    print(f"  [DOWNLOAD FAILED] ID {file_id}: {res.stderr}")
    return False


def save_and_enforce_size(doc, start_idx, end_idx, base_filename, out_dir):
    """
    Saves a slice of pages with maximum compression.
    If the resulting PDF exceeds MAX_CHUNK_MB, recursively bisects into Part 1 & Part 2.
    If a single page exceeds MAX_CHUNK_MB, downsamples/rasterizes at 150 DPI.
    """
    chunk_doc = pymupdf.open()
    chunk_doc.insert_pdf(doc, from_page=start_idx, to_page=end_idx)

    out_path = os.path.join(out_dir, f"{base_filename}.pdf")
    chunk_doc.save(out_path, garbage=4, deflate=True, deflate_images=True, deflate_fonts=True)
    size_mb = os.path.getsize(out_path) / (1024 * 1024)
    page_count = end_idx - start_idx + 1

    if size_mb <= MAX_CHUNK_MB:
        print(f"    [CHUNK] {base_filename}.pdf ({page_count} pp, {size_mb:.2f} MB)")
        return [out_path]

    # If single page exceeds limit, optimize via 150 DPI rasterization
    if page_count <= 1:
        print(f"    [OPTIMIZE SINGLE PAGE] Page {start_idx+1} is {size_mb:.2f} MB > {MAX_CHUNK_MB} MB. Re-rasterizing at 150 DPI...")
        page = doc[start_idx]
        pix = page.get_pixmap(dpi=150)
        opt_doc = pymupdf.open()
        opt_page = opt_doc.new_page(width=page.rect.width, height=page.rect.height)
        opt_page.insert_image(opt_page.rect, pixmap=pix)
        opt_doc.save(out_path, garbage=4, deflate=True)
        opt_mb = os.path.getsize(out_path) / (1024 * 1024)
        if opt_mb <= MAX_CHUNK_MB:
            print(f"    [CHUNK OPTIMIZED] {base_filename}.pdf (1 pp, {opt_mb:.2f} MB)")
            return [out_path]
        else:
            print(f"    [DISCARD OVERSIZED] Even at 150 DPI, {base_filename}.pdf is {opt_mb:.2f} MB. Skipping.")
            os.remove(out_path)
            return []

    # Bisect oversized slice
    os.remove(out_path)
    mid_idx = start_idx + (page_count // 2) - 1
    print(f"    [BISECT] {base_filename}.pdf is {size_mb:.2f} MB > {MAX_CHUNK_MB} MB. Bisecting at page {mid_idx+1}...")
    parts = []
    parts.extend(save_and_enforce_size(doc, start_idx, mid_idx, f"{base_filename}_Part1", out_dir))
    parts.extend(save_and_enforce_size(doc, mid_idx + 1, end_idx, f"{base_filename}_Part2", out_dir))
    return parts


def chunk_pdf_document(pdf_path, out_dir, prefix):
    """
    Intelligently chunks any PDF using Table of Contents or page-budgeting fallback.
    """
    doc = pymupdf.open(pdf_path)
    total_pages = len(doc)
    total_mb = os.path.getsize(pdf_path) / (1024 * 1024)
    print(f"  [INSPECT] {os.path.basename(pdf_path)}: {total_pages} pages, {total_mb:.1f} MB")

    toc = doc.get_toc()
    generated_files = []

    # Filter TOC for level 1 bookmarks
    l1_entries = [(title.strip(), page) for level, title, page in toc if level == 1 and page > 0]
    
    # If Level 1 is too coarse (e.g. only 1 or 2 parts), try Level 2
    if len(l1_entries) <= 2 and len([t for level, t, p in toc if level == 2]) >= 4:
        l1_entries = [(title.strip(), page) for level, title, page in toc if level in (1, 2) and page > 0]

    # Clean and deduplicate entries by page
    cleaned_entries = []
    seen_pages = set()
    skip_titles = {"credits", "foreword", "table of contents", "contents", "open game license", "legal", "title page"}
    for title, page in l1_entries:
        if title.lower() in skip_titles:
            continue
        if page not in seen_pages and page <= total_pages:
            seen_pages.add(page)
            cleaned_entries.append((title, page))

    cleaned_entries.sort(key=lambda x: x[1])

    if len(cleaned_entries) >= 3:
        # TOC-based chunking
        print(f"  [STRATEGY] Using TOC Bookmarks ({len(cleaned_entries)} sections found)")
        # If first bookmark starts > page 1, save intro/front matter
        if cleaned_entries[0][1] > 1:
            intro_end = cleaned_entries[0][1] - 2
            if intro_end >= 0:
                files = save_and_enforce_size(doc, 0, intro_end, f"{prefix}_00_FrontMatter", out_dir)
                generated_files.extend(files)

        for i in range(len(cleaned_entries)):
            title, start_page = cleaned_entries[i]
            start_idx = start_page - 1
            end_idx = (cleaned_entries[i+1][1] - 2) if i + 1 < len(cleaned_entries) else total_pages - 1
            end_idx = max(end_idx, start_idx)
            safe_title = re.sub(r'[^a-zA-Z0-9_-]', '_', title)[:40].strip('_')
            base_name = f"{prefix}_{i+1:02d}_{safe_title}"
            files = save_and_enforce_size(doc, start_idx, end_idx, base_name, out_dir)
            generated_files.extend(files)
    else:
        # Fallback: Page-budgeted slicing
        print(f"  [STRATEGY] No detailed TOC found. Using page-budgeting fallback.")
        avg_mb_per_page = total_mb / max(1, total_pages)
        # Aim for ~8MB chunks
        pages_per_chunk = max(4, int(8.0 / max(0.01, avg_mb_per_page)))
        print(f"  [PAGE BUDGET] ~{pages_per_chunk} pages per chunk ({avg_mb_per_page:.2f} MB/page)")
        
        chunk_idx = 1
        for start_idx in range(0, total_pages, pages_per_chunk):
            end_idx = min(start_idx + pages_per_chunk - 1, total_pages - 1)
            base_name = f"{prefix}_Part{chunk_idx:02d}_p{start_idx+1:04d}_p{end_idx+1:04d}"
            files = save_and_enforce_size(doc, start_idx, end_idx, base_name, out_dir)
            generated_files.extend(files)
            chunk_idx += 1

    return generated_files


def upload_chunks(chunk_files, remote_folder_id):
    """Uploads chunks to Google Drive, skipping any that already exist remotely."""
    existing_items = get_remote_drive_items(remote_folder_id)
    print(f"  [DRIVE] Existing files in target folder {remote_folder_id}: {len(existing_items)}")

    uploaded_count = 0
    for f in chunk_files:
        fname = os.path.basename(f)
        fsize_mb = os.path.getsize(f) / (1024 * 1024)
        if fsize_mb > MAX_CHUNK_MB:
            print(f"    [FAIL-CLOSED GUARD] Rejecting {fname} ({fsize_mb:.2f} MB > {MAX_CHUNK_MB} MB)!")
            continue
        if fname in existing_items:
            print(f"    [SKIP] Already in Drive: {fname}")
            uploaded_count += 1
            continue

        # Courteous pacing delay between uploads
        time.sleep(1.2)

        # Retry with exponential backoff on RATE_LIMIT_EXCEEDED
        for attempt in range(4):
            cmd = ["gdrive", "mutate", "upload", f, "--parent", remote_folder_id]
            res = subprocess.run(cmd, check=False, capture_output=True, text=True)
            if res.returncode == 0:
                print(f"    [UPLOAD SUCCESS] {fname} ({fsize_mb:.2f} MB)")
                uploaded_count += 1
                break
            elif "RATE_LIMIT_EXCEEDED" in res.stderr or "Quota exceeded" in res.stderr:
                wait_sec = (2 ** attempt) * 4 + random.uniform(1.0, 3.0)
                print(f"    [RATE LIMIT] Drive 403 hit. Backing off for {wait_sec:.1f}s before retry (attempt {attempt+1}/4)...")
                time.sleep(wait_sec)
            else:
                print(f"    [UPLOAD ERROR] {fname}: {res.stderr.strip()[:100]}")
                break
    return uploaded_count


def process_single_file(item, state, upload=True):
    file_id = item["id"]
    file_name = item["name"]
    file_path = item["path"]
    size_mb = item["size_mb"]

    parts = file_path.split("/")
    publisher = parts[1] if len(parts) > 1 else "Unknown"

    print(f"\n========================================================")
    print(f"Processing: [{size_mb:.1f} MB] {file_name}")
    print(f"Publisher:  {publisher}")
    print(f"File ID:    {file_id}")
    print(f"========================================================")

    # Check if already processed
    if file_id in state["processed_ids"]:
        print(f"  [ALREADY PROCESSED] File ID {file_id} in state. Skipping.")
        return True

    # Check if already completed name (e.g. Flee Mortals, Where Evil Lives, Creature Codex)
    clean_low = file_name.lower().replace("_", " ")
    if any(k in file_name.lower() or k in clean_low for k in ALREADY_COMPLETED_KEYWORDS):
        print(f"  [ALREADY COMPLETED] {file_name} was pre-chunked. Marking done.")
        state["processed_ids"][file_id] = {"status": "already_chunked", "publisher": publisher}
        save_state(state)
        return True

    # Setup local workspace
    book_work_dir = os.path.join(TEMP_WORK_DIR, file_id)
    os.makedirs(book_work_dir, exist_ok=True)

    # Look for local download in /Users/wryen/Downloads/
    local_pdf = None
    downloads_path = os.path.join("/Users/wryen/Downloads", file_name)
    if os.path.exists(downloads_path):
        print(f"  [LOCAL DISCOVERY] Found existing copy in Downloads: {downloads_path}")
        local_pdf = downloads_path
    else:
        # Download from Google Drive
        dest_pdf = os.path.join(book_work_dir, file_name)
        if download_file(file_id, dest_pdf):
            local_pdf = dest_pdf

    if not local_pdf or not os.path.exists(local_pdf):
        print(f"  [ERROR] Could not acquire PDF for ID {file_id}. Skipping.")
        return False

    # Generate Prefix
    safe_name = re.sub(r'[^a-zA-Z0-9]', '_', os.path.splitext(file_name)[0])
    prefix = safe_name[:25].strip('_')

    # Chunk PDF
    chunks_dir = os.path.join(book_work_dir, "chunks")
    os.makedirs(chunks_dir, exist_ok=True)
    chunks = chunk_pdf_document(local_pdf, chunks_dir, prefix)

    print(f"\n  [CHUNKING COMPLETE] Generated {len(chunks)} sub-PDFs for {file_name}")

    if upload and chunks:
        remote_folder_id = get_or_create_extracted_folder(publisher, state)
        print(f"  [UPLOAD TARGET] Folder: {remote_folder_id}")
        uploaded = upload_chunks(chunks, remote_folder_id)
        print(f"  [UPLOAD RESULT] {uploaded}/{len(chunks)} chunks verified in Drive.")

    # Mark as processed in state
    state["processed_ids"][file_id] = {
        "status": "completed",
        "file_name": file_name,
        "publisher": publisher,
        "size_mb": size_mb,
        "chunk_count": len(chunks)
    }
    save_state(state)

    # Clean up book workspace
    shutil.rmtree(book_work_dir, ignore_errors=True)
    print(f"  [CLEANUP] Removed temporary workspace {book_work_dir}")
    return True


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Fleet Pre-Chunker Runner")
    parser.add_argument("--publisher", type=str, default="", help="Filter by publisher name substring")
    parser.add_argument("--file-id", type=str, default="", help="Process specific file ID")
    parser.add_argument("--no-upload", action="store_true", help="Do not upload chunks to Drive")
    parser.add_argument("--limit", type=int, default=0, help="Limit number of books to process")
    args = parser.parse_args()

    if not os.path.exists(INVENTORY_JSON):
        print(f"[ERROR] Inventory file {INVENTORY_JSON} not found. Run crawler first.")
        sys.exit(1)

    with open(INVENTORY_JSON, "r", encoding="utf-8") as f:
        inventory = json.load(f)

    oversized = inventory.get("oversized_pdfs", [])
    print(f"Total oversized PDFs in inventory: {len(oversized)}")

    state = load_state()
    print(f"Loaded state with {len(state['processed_ids'])} previously processed files.")

    # Filter target books
    targets = []
    seen_ids = set()
    for item in oversized:
        fid = item["id"]
        if fid in seen_ids:
            continue
        seen_ids.add(fid)

        if args.file_id and item["id"] != args.file_id:
            continue
        if args.publisher and args.publisher.lower() not in item["path"].lower():
            continue
        targets.append(item)

    # Sort targets: largest first or by publisher
    targets.sort(key=lambda x: x["size_mb"], reverse=True)
    if args.limit > 0:
        targets = targets[:args.limit]

    print(f"Targeting {len(targets)} oversized books for pre-chunking.")

    success_count = 0
    for idx, item in enumerate(targets):
        print(f"\n>>> [{idx+1}/{len(targets)}] Progressing book {item['name']}...")
        if process_single_file(item, state, upload=not args.no_upload):
            success_count += 1

    print(f"\n========================================================")
    print(f"FLEET PRE-CHUNKING BATCH COMPLETE")
    print(f"Processed: {success_count}/{len(targets)} books successfully.")
    print(f"========================================================")


if __name__ == "__main__":
    main()

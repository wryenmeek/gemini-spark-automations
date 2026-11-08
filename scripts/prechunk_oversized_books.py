#!/usr/bin/env python3
"""
MCDM Archive Pre-Chunker Sidecar
Splits oversized MCDM PDFs (>15MB) into chapter- and creature-family-level
sub-PDFs (<14MB) with high-density vector text and full layout preservation.
Uploads processed chunks directly into Google Drive's 'Extracted_Chapters' folder
for autonomous ingestion by the Apps Script dynamic Gemini model pipeline.
"""

import os
import sys
import re
import subprocess
import tempfile
import pymupdf

DRIVE_CHUNKS_FOLDER_ID = "1RdzBAGF4aFYbVmU-1T_NiD7kHt8EB8yp"
MAX_CHUNK_MB = 14.0

def get_remote_drive_files(folder_id):
    """Retrieves list of existing filenames in target Drive folder to avoid duplicates."""
    cmd = ["gdrive", "readonly", "ls", folder_id, "--max", "300"]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        return set()
    files = set()
    lines = res.stdout.strip().split("\n")
    for line in lines[2:]:
        parts = line.split()
        if len(parts) >= 4:
            fname = " ".join(parts[1:-3])
            files.add(fname)
    return files

def upload_to_drive(local_path, folder_id):
    """Uploads a local chunk PDF to Google Drive."""
    filename = os.path.basename(local_path)
    cmd = ["gdrive", "mutate", "upload", local_path, "--parent", folder_id]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode == 0:
        print(f"  [UPLOAD SUCCESS] {filename} -> Drive ({folder_id})")
        return True
    else:
        print(f"  [UPLOAD ERROR] {filename}: {res.stderr}")
        return False

def save_and_enforce_size_limit(doc, start_idx, end_idx, base_filename, out_dir):
    """
    Saves a slice of pages with maximum compression.
    If the resulting PDF exceeds MAX_CHUNK_MB, recursively bisects into Part 1 & Part 2.
    Returns a list of generated file paths.
    """
    chunk_doc = pymupdf.open()
    chunk_doc.insert_pdf(doc, from_page=start_idx, to_page=end_idx)
    
    out_path = os.path.join(out_dir, f"{base_filename}.pdf")
    chunk_doc.save(out_path, garbage=4, deflate=True)
    size_mb = os.path.getsize(out_path) / (1024 * 1024)
    page_count = end_idx - start_idx + 1

    if size_mb <= MAX_CHUNK_MB or page_count <= 1:
        print(f"  [CHUNK] {base_filename}.pdf ({page_count} pages, {size_mb:.2f} MB)")
        return [out_path]

    # Chunk is oversized (>14 MB): bisect into Part 1 and Part 2
    os.remove(out_path)
    mid_idx = start_idx + (page_count // 2) - 1
    print(f"  [BISECT] {base_filename}.pdf is {size_mb:.2f} MB > {MAX_CHUNK_MB} MB. Splitting {page_count} pages at page {mid_idx + 1}...")
    
    parts = []
    parts.extend(save_and_enforce_size_limit(doc, start_idx, mid_idx, f"{base_filename}_Part1", out_dir))
    parts.extend(save_and_enforce_size_limit(doc, mid_idx + 1, end_idx, f"{base_filename}_Part2", out_dir))
    return parts

def chunk_where_evil_lives(pdf_path, out_dir):
    """Chunks 'Where Evil Lives' by boss lair chapters."""
    print(f"\n=== Processing Where Evil Lives: {pdf_path} ===")
    doc = pymupdf.open(pdf_path)
    toc = doc.get_toc()
    total_pages = len(doc)

    level_1 = [(title.strip(), page) for level, title, page in toc if level == 1]
    skip_titles = {"Credits", "Foreword", "Table of Contents", "Open Game License version 1.0a"}

    generated_files = []
    chapter_idx = 1
    for i in range(len(level_1)):
        title, start_page = level_1[i]
        if title in skip_titles:
            continue
        start_idx = start_page - 1
        end_idx = (level_1[i + 1][1] - 2) if i + 1 < len(level_1) else total_pages - 1
        if end_idx < start_idx:
            end_idx = start_idx
        safe_title = re.sub(r"[^a-zA-Z0-9_-]", "_", title).strip("_")
        base_name = f"WEL_{chapter_idx:02d}_{safe_title}"
        chapter_idx += 1
        
        files = save_and_enforce_size_limit(doc, start_idx, end_idx, base_name, out_dir)
        generated_files.extend(files)

    return generated_files

def chunk_flee_mortals(pdf_path, out_dir):
    """Chunks 'Flee, Mortals!' by creature families, environments, and villain parties."""
    print(f"\n=== Processing Flee, Mortals!: {pdf_path} ===")
    doc = pymupdf.open(pdf_path)
    toc = doc.get_toc()
    total_pages = len(doc)

    generated_files = []

    # 1. Introduction (p.8 to p.34)
    intro_files = save_and_enforce_size_limit(doc, 7, 33, "FM_00_Introduction", out_dir)
    generated_files.extend(intro_files)

    # 2. Chapter 1: Creatures (Level 2 entries from p.35 to p.298)
    ch1_entries = [(title.strip(), page) for level, title, page in toc if level == 2 and 35 <= page < 299]
    for i in range(len(ch1_entries)):
        title, start_page = ch1_entries[i]
        start_idx = start_page - 1
        end_idx = (ch1_entries[i + 1][1] - 2) if i + 1 < len(ch1_entries) else 297
        safe_title = re.sub(r"[^a-zA-Z0-9_-]", "_", title).strip("_")
        base_name = f"FM_Ch1_{i+1:02d}_{safe_title}"
        files = save_and_enforce_size_limit(doc, start_idx, end_idx, base_name, out_dir)
        generated_files.extend(files)

    # 3. Chapter 2: Environments (Level 2 entries from p.299 to p.352)
    ch2_entries = [(title.strip(), page) for level, title, page in toc if level == 2 and 299 <= page < 353]
    for i in range(len(ch2_entries)):
        title, start_page = ch2_entries[i]
        start_idx = start_page - 1
        end_idx = (ch2_entries[i + 1][1] - 2) if i + 1 < len(ch2_entries) else 351
        safe_title = re.sub(r"[^a-zA-Z0-9_-]", "_", title).strip("_")
        base_name = f"FM_Ch2_{i+1:02d}_{safe_title}"
        files = save_and_enforce_size_limit(doc, start_idx, end_idx, base_name, out_dir)
        generated_files.extend(files)

    # 4. Chapter 3: Villain Parties (Level 2 entries from p.353 to p.397)
    ch3_entries = [(title.strip(), page) for level, title, page in toc if level == 2 and 353 <= page < 398]
    for i in range(len(ch3_entries)):
        title, start_page = ch3_entries[i]
        start_idx = start_page - 1
        end_idx = (ch3_entries[i + 1][1] - 2) if i + 1 < len(ch3_entries) else 396
        safe_title = re.sub(r"[^a-zA-Z0-9_-]", "_", title).strip("_")
        base_name = f"FM_Ch3_{i+1:02d}_{safe_title}"
        files = save_and_enforce_size_limit(doc, start_idx, end_idx, base_name, out_dir)
        generated_files.extend(files)

    # 5. Chapter 4: Psionics
    psi_files = save_and_enforce_size_limit(doc, 397, 399, "FM_Ch4_Psionic_Powers", out_dir)
    generated_files.extend(psi_files)

    return generated_files

def main():
    import argparse
    parser = argparse.ArgumentParser(description="MCDM Archive Pre-Chunker Sidecar")
    parser.add_argument("--upload", action="store_true", help="Upload generated chunks to Google Drive")
    parser.add_argument("--book", choices=["wel", "fm", "all"], default="wel", help="Which book to process")
    parser.add_argument("--limit", type=int, default=0, help="Limit number of chunks uploaded (for testing)")
    args = parser.parse_args()

    work_dir = os.path.join(tempfile.gettempdir(), "mcdm_prechunked_chapters")
    os.makedirs(work_dir, exist_ok=True)
    print(f"Working output directory: {work_dir}")

    generated_chunks = []

    # Path detection
    wel_path = "/Users/wryen/Downloads/Where_Evil_Lives_the_MCDM_Book_of_Boss_Battles_v1.1.pdf"
    fm_path = "/Users/wryen/Downloads/Flee__Mortals__The_MCDM_Monster_Book_v1.1.pdf"

    if args.book in ("wel", "all"):
        if os.path.exists(wel_path):
            wel_files = chunk_where_evil_lives(wel_path, work_dir)
            generated_chunks.extend(wel_files)
        else:
            print(f"[WARN] Local file not found: {wel_path}")

    if args.book in ("fm", "all"):
        if os.path.exists(fm_path):
            fm_files = chunk_flee_mortals(fm_path, work_dir)
            generated_chunks.extend(fm_files)
        else:
            print(f"[WARN] Local file not found: {fm_path}")

    print(f"\n=== SUMMARY: Generated {len(generated_chunks)} compliant chunk sub-PDFs ===")
    for f in generated_chunks[:10]:
        mb = os.path.getsize(f) / (1024 * 1024)
        print(f"  - {os.path.basename(f)} ({mb:.2f} MB)")
    if len(generated_chunks) > 10:
        print(f"  ... and {len(generated_chunks) - 10} more files.")

    if args.upload:
        print(f"\nChecking Google Drive folder ID: {DRIVE_CHUNKS_FOLDER_ID}...")
        existing_remote = get_remote_drive_files(DRIVE_CHUNKS_FOLDER_ID)
        print(f"Existing files in Drive folder: {len(existing_remote)}")

        to_upload = [f for f in generated_chunks if os.path.basename(f) not in existing_remote]
        if args.limit > 0:
            to_upload = to_upload[:args.limit]

        print(f"Uploading {len(to_upload)} new chunks to Google Drive...")
        uploaded = 0
        for f in to_upload:
            if upload_to_drive(f, DRIVE_CHUNKS_FOLDER_ID):
                uploaded += 1
        print(f"\n[DONE] Successfully uploaded {uploaded}/{len(to_upload)} chunks to Google Drive.")

if __name__ == "__main__":
    main()

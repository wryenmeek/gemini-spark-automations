#!/usr/bin/env python3
"""
Crawler for 3rd Party Archives (13Ovbl0JQZ3EGXDBY7UDFeSP6gd8_sHTC)
Iterates through all publisher subfolders, identifying all PDFs and specifically
flagging those exceeding the 15MB limit that require pre-chunking.
"""

import json
import subprocess

ROOT_FOLDER_ID = "13Ovbl0JQZ3EGXDBY7UDFeSP6gd8_sHTC"
MAX_MB_THRESHOLD = 14.0  # Safe threshold below Apps Script 15MB limit
OUTPUT_JSON = "/tmp/3rd_party_archives_inventory.json"


def parse_ls_output(output):
    items = []
    lines = output.strip().split("\n")
    for line in lines[2:]:
        parts = line.split()
        if len(parts) >= 4:
            fid = parts[0]
            size_unit = parts[-1]
            size_val = parts[-2]
            ftype = parts[-3]
            fname = " ".join(parts[1:-3])

            # Convert size to MB float
            size_mb = 0.0
            try:
                val = float(size_val.replace(",", ""))
                unit = size_unit.upper()
                if unit == "B":
                    size_mb = val / (1024 * 1024)
                elif unit == "KB":
                    size_mb = val / 1024
                elif unit == "MB":
                    size_mb = val
                elif unit == "GB":
                    size_mb = val * 1024
            except ValueError:
                pass

            items.append(
                {
                    "id": fid,
                    "name": fname,
                    "type": ftype,
                    "size_str": f"{size_val} {size_unit}",
                    "size_mb": round(size_mb, 2),
                }
            )
    return items


def list_folder(folder_id):
    cmd = ["gdrive", "readonly", "ls", folder_id, "--max", "300"]
    try:
        res = subprocess.run(cmd, check=False, capture_output=True, text=True, timeout=30)
        if res.returncode == 0:
            return parse_ls_output(res.stdout)
    except subprocess.TimeoutExpired:
        print(f"  [TIMEOUT] Listing folder {folder_id} timed out.", flush=True)
    return []


def main():
    print(
        f"Starting BFS crawl of 3rd Party Archives (Root: {ROOT_FOLDER_ID})...",
        flush=True,
    )

    queue = [(ROOT_FOLDER_ID, "3rd Party Archives")]
    visited = {ROOT_FOLDER_ID}

    all_files = []
    all_folders = []
    oversized_pdfs = []
    regular_pdfs = []

    folder_count = 0

    while queue:
        curr_id, curr_path = queue.pop(0)
        folder_count += 1
        curr_path.split("/")[-1]

        items = list_folder(curr_id)
        sub_folder_count = 0
        file_count = 0

        for it in items:
            item_path = f"{curr_path}/{it['name']}"
            if it["type"] == "folder":
                sub_folder_count += 1
                if it["id"] not in visited:
                    visited.add(it["id"])
                    all_folders.append((it["id"], item_path))
                    # Avoid traversing inside Extracted_Chapters or seeds/legacy
                    if "Extracted_Chapters" not in it["name"] and "seeds" not in it["name"]:
                        queue.append((it["id"], item_path))
            else:
                file_count += 1
                it["path"] = item_path
                all_files.append(it)

                # Check for PDF
                is_pdf = it["type"] == "application/pdf" or it["name"].lower().endswith(".pdf")
                if is_pdf:
                    if it["size_mb"] >= MAX_MB_THRESHOLD:
                        oversized_pdfs.append(it)
                        print(
                            f"  >>> [OVERSIZED PDF FOUND] {it['size_mb']:.1f} MB: {it['name']} (Path: {item_path})",
                            flush=True,
                        )
                    else:
                        regular_pdfs.append(it)

        if folder_count % 5 == 0 or len(queue) == 0:
            print(
                f"[{folder_count} folders visited] Queue: {len(queue)} | Files: {len(all_files)} | Oversized PDFs: {len(oversized_pdfs)}",
                flush=True,
            )

    print("\n==================================================", flush=True)
    print(f"Crawl Completed across {folder_count} folders!", flush=True)
    print(f"Total Files Found: {len(all_files)}", flush=True)
    print(f"Total PDFs Found: {len(oversized_pdfs) + len(regular_pdfs)}", flush=True)
    print(
        f"Total Oversized PDFs (>= {MAX_MB_THRESHOLD} MB): {len(oversized_pdfs)}",
        flush=True,
    )
    print("==================================================", flush=True)

    # Save summary to JSON
    with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
        json.dump(
            {
                "total_folders": len(all_folders),
                "total_files": len(all_files),
                "oversized_pdfs": oversized_pdfs,
                "regular_pdfs": regular_pdfs,
            },
            f,
            indent=2,
        )
    print(f"Full inventory saved to: {OUTPUT_JSON}", flush=True)


if __name__ == "__main__":
    main()

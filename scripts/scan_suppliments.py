#!/usr/bin/env python3
"""
Recursive crawler for Suppliments Drive folder (1RgAo-hdJ8qIERzyaa1xfvH9DZyhffsO9)
Discovers all nested folders, inventorying all PDFs and flagging oversized ones (>= 14.0 MB).
"""

import json
import subprocess
import sys
import time

ROOT_FOLDER_ID = "1RgAo-hdJ8qIERzyaa1xfvH9DZyhffsO9"
MAX_MB_THRESHOLD = 14.0
OUTPUT_JSON = "/tmp/suppliments_inventory.json"


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
    cmd = ["gdrive", "readonly", "ls", folder_id, "--max", "500"]
    for attempt in range(3):
        try:
            res = subprocess.run(cmd, check=False, capture_output=True, text=True, timeout=30)
            if res.returncode == 0:
                return parse_ls_output(res.stdout)
            else:
                if "RATE_LIMIT" in res.stderr:
                    time.sleep(2 * (attempt + 1))
                    continue
                print(f"  [ERROR] Listing {folder_id}: {res.stderr.strip()}", flush=True)
                break
        except subprocess.TimeoutExpired:
            print(
                f"  [TIMEOUT] Listing folder {folder_id} timed out. Retry {attempt + 1}...",
                flush=True,
            )
            time.sleep(2)
    return []


def main():
    root_id = sys.argv[1] if len(sys.argv) > 1 else ROOT_FOLDER_ID
    print(f"Starting BFS crawl of folder (Root: {root_id})...", flush=True)

    queue = [(root_id, "Suppliments")]
    visited = {root_id}

    all_files = []
    all_folders = []
    oversized_pdfs = []
    regular_pdfs = []

    folder_count = 0

    while queue:
        curr_id, curr_path = queue.pop(0)
        folder_count += 1

        items = list_folder(curr_id)
        sub_folder_count = 0
        file_count = 0

        for it in items:
            item_path = f"{curr_path}/{it['name']}"
            if it["type"] == "folder":
                sub_folder_count += 1
                if it["id"] not in visited:
                    visited.add(it["id"])
                    all_folders.append(
                        {
                            "id": it["id"],
                            "name": it["name"],
                            "path": item_path,
                            "parent_id": curr_id,
                        }
                    )
                    # Avoid traversing inside Extracted_Chapters
                    if "Extracted_Chapters" not in it["name"]:
                        queue.append((it["id"], item_path))
            elif it["type"] == "shortcut":
                # Shortcuts are not direct files
                pass
            else:
                file_count += 1
                it["path"] = item_path
                it["parent_id"] = curr_id
                it["parent_path"] = curr_path
                all_files.append(it)

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

    with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
        json.dump(
            {
                "root_id": root_id,
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

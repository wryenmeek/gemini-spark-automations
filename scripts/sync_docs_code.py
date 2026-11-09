#!/usr/bin/env python3
"""Syncs live Apps Script Code.gs files into docs/*.gs.md documentation files."""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def sync_receipts():
    doc_path = ROOT / "docs" / "Receipts_Ingestion_Automation_Code.gs.md"
    code_path = ROOT / "projects" / "receipts-ingestion" / "Code.gs"
    code = code_path.read_text(encoding="utf-8").strip()
    doc = doc_path.read_text(encoding="utf-8")

    prefix = doc.split("```javascript")[0]
    suffix = doc.split("```javascript")[1].split("```\n\n---")[1]
    new_doc = f"{prefix}```javascript\n{code}\n```\n\n---{suffix}"
    doc_path.write_text(new_doc, encoding="utf-8")
    print(f"Synced {doc_path.name}")


def sync_drive_tagging():
    doc_path = ROOT / "docs" / "Drive_Tagging_Automation_Code.gs.md"
    code_path = ROOT / "projects" / "drive-tagging" / "Code.gs"
    code = code_path.read_text(encoding="utf-8").strip()
    doc = doc_path.read_text(encoding="utf-8")

    prefix = doc.split("```javascript")[0]
    new_doc = f"{prefix}```javascript\n{code}\n```\n"
    doc_path.write_text(new_doc, encoding="utf-8")
    print(f"Synced {doc_path.name}")


def sync_knowledge_graph():
    doc_path = ROOT / "docs" / "Knowledge_Graph_Automation_Code.gs.md"
    code_path = ROOT / "projects" / "knowledge-graph-ingestion" / "Code.gs"
    code = code_path.read_text(encoding="utf-8").strip()
    doc = doc_path.read_text(encoding="utf-8")

    prefix = doc.split("```javascript")[0]
    new_doc = f"{prefix}```javascript\n{code}\n```\n"
    doc_path.write_text(new_doc, encoding="utf-8")
    print(f"Synced {doc_path.name}")


def sync_writing_style():
    doc_path = ROOT / "docs" / "Writing_Style_Index_Automation_Code.gs.md"
    code_path = ROOT / "projects" / "writing-style-index" / "Code.gs"
    code = code_path.read_text(encoding="utf-8").strip()
    doc = doc_path.read_text(encoding="utf-8")

    # The doc has: "4. Complete Production Source Code (Code.gs)\n\n\n\uec03..."
    header_marker = "4. Complete Production Source Code (Code.gs)"
    parts = doc.split(header_marker)
    prefix = parts[0] + header_marker + "\n\n```javascript\n"

    tail_marker = "\uec02"
    if tail_marker in parts[1]:
        note = parts[1].split(tail_marker)[1].strip()
        new_doc = f"{prefix}{code}\n```\n\n{note}\n"
    else:
        new_doc = f"{prefix}{code}\n```\n"

    doc_path.write_text(new_doc, encoding="utf-8")
    print(f"Synced {doc_path.name}")


if __name__ == "__main__":
    sync_receipts()
    sync_drive_tagging()
    sync_knowledge_graph()
    sync_writing_style()

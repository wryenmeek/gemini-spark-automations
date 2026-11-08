import os
import sys

# Add scripts directory to path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "scripts")))

from unittest.mock import MagicMock, patch

from fleet_prechunker import get_remote_drive_items
from scan_3rd_party_archives import parse_ls_output


def test_parse_ls_output_4_token_line():
    """
    Regression Test for Finding #02:
    4-token lines (such as folders or simple files without whitespace) must extract
    the token at index 1 as the name rather than slicing parts[1:-3] into an empty string.
    """
    raw_output = """Id Name Type Size
------------------------------------------------------------------------
13Ovbl0JQZ3EGXDBY7UDFeSP6gd8_sHTC Extracted_Chapters folder 0 B
2abc456def78901234567890123456780 README.txt text/plain 1.2 KB
"""
    items = parse_ls_output(raw_output)
    assert len(items) == 2

    # Folder line: 4 tokens
    assert items[0]["id"] == "13Ovbl0JQZ3EGXDBY7UDFeSP6gd8_sHTC"
    assert items[0]["name"] == "Extracted_Chapters"
    assert items[0]["type"] == "folder"

    # Single-word filename line: 4 tokens
    assert items[1]["name"] == "README.txt"
    assert items[1]["size_str"] == "1.2 KB"


def test_parse_ls_output_multi_word_filename():
    """Verify that multi-word filenames are properly joined."""
    raw_output = """Id Name Type Size
------------------------------------------------------------------------
1abc456def78901234567890123456780 Flee Mortals! The MCDM Monster Book.pdf application/pdf 85.4 MB
"""
    items = parse_ls_output(raw_output)
    assert len(items) == 1
    assert items[0]["name"] == "Flee Mortals! The MCDM Monster Book.pdf"
    assert items[0]["size_mb"] == 85.4
    assert items[0]["type"] == "application/pdf"


def test_parse_ls_output_units_conversion():
    """Verify correct byte-to-megabyte conversion across all unit types."""
    raw_output = """Id Name Type Size
------------------------------------------------------------------------
1id Byte_File.bin application/octet-stream 1048576 B
2id Kilo_File.bin application/octet-stream 2048 KB
3id Mega_File.bin application/octet-stream 15.5 MB
4id Giga_File.bin application/octet-stream 1.5 GB
"""
    items = parse_ls_output(raw_output)
    assert len(items) == 4
    assert items[0]["size_mb"] == 1.0
    assert items[1]["size_mb"] == 2.0
    assert items[2]["size_mb"] == 15.5
    assert items[3]["size_mb"] == 1536.0


@patch("subprocess.run")
def test_fleet_prechunker_4_token_line_parsing(mock_run):
    """
    Regression Test for Finding #02:
    `get_remote_drive_items` in `fleet_prechunker.py` must correctly parse 4-token lines.
    """
    mock_res = MagicMock()
    mock_res.returncode = 0
    mock_res.stdout = """Id Name Type Size
------------------------------------------------------------------------
folderId1234567890123456789012345 Extracted_Chapters folder 0 B
fileId123456789012345678901234567 Book.pdf application/pdf 12.0 MB
"""
    mock_run.return_value = mock_res

    items = get_remote_drive_items("dummy_parent_id")
    assert "Extracted_Chapters" in items
    assert items["Extracted_Chapters"]["id"] == "folderId1234567890123456789012345"
    assert items["Extracted_Chapters"]["type"] == "folder"

    assert "Book.pdf" in items
    assert items["Book.pdf"]["id"] == "fileId123456789012345678901234567"

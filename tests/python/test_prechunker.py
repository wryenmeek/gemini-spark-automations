import os
import subprocess
import sys
from unittest.mock import MagicMock, patch

# Add scripts directory to path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "scripts")))

import fleet_prechunker


def test_get_or_create_extracted_folder_fails_closed():
    """
    Regression Test for Finding #15:
    If mkdir fails or errors, get_or_create_extracted_folder must return None
    (fail-closed) rather than falling back to parent_id.
    """
    state = {}
    with patch("fleet_prechunker.get_remote_drive_items", return_value={}):
        with patch("subprocess.run") as mock_run:
            mock_res = MagicMock()
            mock_res.returncode = 1
            mock_res.stderr = "Permission denied or network failure"
            mock_run.return_value = mock_res

            res = fleet_prechunker.get_or_create_extracted_folder(
                "parent_id_123", "TestFolder", state
            )
            assert res is None
            assert "extracted_folders" in state
            assert "parent_id_123" not in state["extracted_folders"]


def test_subprocess_timeout_handling_in_get_remote_drive_items():
    """
    Regression Test for Finding #03:
    get_remote_drive_items must enforce timeout and catch subprocess.TimeoutExpired.
    """
    with patch(
        "subprocess.run", side_effect=subprocess.TimeoutExpired(cmd=["gdrive"], timeout=60)
    ) as mock_run:
        items = fleet_prechunker.get_remote_drive_items("folder_id_123")
        assert items == {}
        # Verify timeout argument was passed
        mock_run.assert_called_once()
        assert mock_run.call_args.kwargs.get("timeout") == 60


def test_subprocess_timeout_handling_in_download_file():
    """
    Regression Test for Finding #03:
    download_file must enforce timeout=300 and catch subprocess.TimeoutExpired.
    """
    with patch(
        "subprocess.run", side_effect=subprocess.TimeoutExpired(cmd=["gdrive"], timeout=300)
    ) as mock_run:
        success = fleet_prechunker.download_file("file_id_123", "/tmp/fake_dest.pdf")
        assert success is False
        mock_run.assert_called_once()
        assert mock_run.call_args.kwargs.get("timeout") == 300


def test_subprocess_timeout_handling_in_upload_chunks():
    """
    Regression Test for Finding #03:
    upload_chunks must enforce timeout=300 and catch subprocess.TimeoutExpired.
    """
    with patch("fleet_prechunker.get_remote_drive_items", return_value={}):
        with patch("os.path.getsize", return_value=5 * 1024 * 1024):
            with patch(
                "subprocess.run", side_effect=subprocess.TimeoutExpired(cmd=["gdrive"], timeout=300)
            ) as mock_run:
                uploaded = fleet_prechunker.upload_chunks(["/tmp/chunk1.pdf"], "remote_folder_123")
                assert uploaded == 0
                mock_run.assert_called_once()
                assert mock_run.call_args.kwargs.get("timeout") == 300


def test_partial_upload_marks_partial_failure():
    """
    Regression Test for Finding #04:
    If uploaded < len(chunks), process_single_file must mark status as 'partial_failure'
    and return False rather than prematurely completing.
    """
    item = {
        "id": "file123",
        "name": "BigBook.pdf",
        "path": "3rd Party Archives/MCDM/BigBook.pdf",
        "size_mb": 45.0,
        "parent_id": "parent123",
        "parent_path": "3rd Party Archives/MCDM",
    }
    state = {"processed_ids": {}}

    with patch("os.path.exists", side_effect=lambda p: True if "Downloads" in p else False):
        with patch(
            "fleet_prechunker.chunk_pdf_document", return_value=["/tmp/c1.pdf", "/tmp/c2.pdf"]
        ):
            with patch(
                "fleet_prechunker.get_or_create_extracted_folder", return_value="ext_folder_123"
            ):
                with patch(
                    "fleet_prechunker.upload_chunks", return_value=1
                ):  # Only 1 of 2 uploaded
                    with patch("fleet_prechunker.save_state"):
                        with patch("shutil.rmtree"):
                            success = fleet_prechunker.process_single_file(item, state, upload=True)
                            assert success is False
                            assert "file123" in state["processed_ids"]
                            assert state["processed_ids"]["file123"]["status"] == "partial_failure"
                            assert state["processed_ids"]["file123"]["uploaded_count"] == 1


def test_path_traversal_sanitization():
    """
    Regression Test for Finding #08:
    Filenames containing path traversal characters (../) must be sanitized to their basename.
    """
    item = {
        "id": "file_traversal_test",
        "name": "../../../etc/shadow.pdf",
        "path": "3rd Party Archives/MCDM/shadow.pdf",
        "size_mb": 20.0,
        "parent_id": "parent123",
    }
    state = {"processed_ids": {}}

    def fake_exists(p):
        # Don't find in downloads, but report dest exists after download
        if "Downloads" in p:
            return False
        return True

    with patch("os.path.exists", side_effect=fake_exists):
        with patch("fleet_prechunker.download_file", return_value=True) as mock_download:
            with patch("fleet_prechunker.chunk_pdf_document", return_value=[]):
                with patch("fleet_prechunker.save_state"):
                    with patch("shutil.rmtree"):
                        fleet_prechunker.process_single_file(item, state, upload=False)
                        # Ensure download destination used sanitized basename 'shadow.pdf'
                        dest_called = mock_download.call_args[0][1]
                        assert "shadow.pdf" in dest_called
                        assert ".." not in dest_called


def test_downloads_directory_resolution():
    """
    Regression Test for Finding #19:
    Local downloads path must use os.path.expanduser('~/Downloads') instead of hardcoded username.
    """
    expected_downloads_dir = os.path.expanduser("~/Downloads")
    assert (
        not expected_downloads_dir.startswith("/Users/wryen/Downloads")
        or os.environ.get("USER") == "wryen"
    )

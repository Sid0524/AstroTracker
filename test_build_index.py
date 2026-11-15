"""Index builder reliability: new releases (DR1) arrive even when IRSA is slow or flaky."""

import contextlib
import io
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent / "tools"))
import build_index as b  # noqa: E402

NAME = lambda w: f"{w[0].replace('spherex_', '')}/{w[1]}"  # noqa: E731


def quiet():
    stack = contextlib.ExitStack()
    stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
    stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
    return stack


class FetchAllTests(unittest.TestCase):
    todo = [("spherex_dr1", f"2025W{w}_1A") for w in range(10, 16)]

    def test_all_folders_fetched_without_a_budget(self):
        with quiet():
            fetched, failed, skipped = b.fetch_all(self.todo, NAME, 3, fetch=lambda c, f: [f])
        self.assertEqual(sorted(fetched), [NAME(w) for w in self.todo])
        self.assertEqual((failed, skipped), ([], []))

    def test_a_failing_folder_does_not_lose_the_others(self):
        def fetch(collection, folder):
            if folder == "2025W12_1A":
                raise RuntimeError("TAP 502")
            return [folder]

        with quiet():
            fetched, failed, skipped = b.fetch_all(self.todo, NAME, 2, fetch=fetch)
        self.assertEqual(failed, ["dr1/2025W12_1A"])
        self.assertEqual(len(fetched), 5)
        self.assertEqual(skipped, [])

    def test_time_budget_stops_new_folders_and_defers_the_rest(self):
        now = [0.0]

        def fetch(collection, folder):  # each folder takes 31 minutes
            now[0] += 31 * 60
            return [folder]

        with quiet():
            fetched, failed, skipped = b.fetch_all(self.todo, NAME, 1, max_minutes=60, fetch=fetch, clock=lambda: now[0])
        self.assertEqual(len(fetched), 2, "folders started within the budget finish")
        self.assertEqual(skipped, [NAME(w) for w in self.todo[2:]])
        self.assertEqual(failed, [])

    def test_no_more_than_workers_folders_run_at_once(self):
        lock, active, peak = threading.Lock(), [0], [0]
        gate = threading.Event()

        def fetch(collection, folder):
            with lock:
                active[0] += 1
                peak[0] = max(peak[0], active[0])
            gate.wait(0.05)
            with lock:
                active[0] -= 1
            return []

        with quiet():
            b.fetch_all(self.todo, NAME, 3, fetch=fetch)
        self.assertEqual(peak[0], 3)


class MainTests(unittest.TestCase):
    """Runs main() against fake IRSA responses in a temporary data folder."""

    def run_main(self, root, argv, fetch):
        listing = [{"obs_collection": c, "folder": f} for c, f in
                   [("spherex_dr1", "2025W17_4B"), ("spherex_dr1", "2025W18_1B"), ("spherex_qr3", "2026W40_1A")]]
        with patch.object(b, "ROOT", root), patch.object(b, "discover_collections", return_value=["spherex_qr3", "spherex_dr1"]), \
                patch.object(b, "tap", return_value=listing), patch.object(b, "fetch_folder", side_effect=fetch), \
                patch.object(sys, "argv", ["build_index.py", *argv]), quiet():
            b.main()
        return json.loads((Path(root) / "index.json").read_text())

    def test_dr1_folders_are_indexed_and_failures_stay_incomplete_for_retry(self):
        row = (269.4, 4.7, 60900.0, 10.0, 3, 1, 116, "l2b-v27-2026-228")

        def fetch(collection, folder):
            if folder == "2025W18_1B":
                raise RuntimeError("TAP timeout")
            return [row]

        with tempfile.TemporaryDirectory() as root:
            index = self.run_main(root, [], fetch)
            self.assertEqual(index["indexedCollections"], ["spherex_qr3", "spherex_dr1"])
            self.assertIn("dr1/2025W17_4B", index["complete"])
            self.assertNotIn("dr1/2025W18_1B", index["complete"], "failed folder is retried next run")
            self.assertEqual(index["refreshProvenance"]["foldersFailed"], ["dr1/2025W18_1B"])
            self.assertEqual(index["total"], 2)
            tile = Path(root) / "tiles" / f"{b.tile_key(269.4, 4.7)}.bin"
            self.assertEqual(tile.stat().st_size, 2 * b.ROW.size)

            # Next run: only the incomplete folder (plus recent ones) is fetched.
            calls = []
            index = self.run_main(root, ["--recent", "0"], lambda c, f: calls.append(f) or [row])
            self.assertEqual(calls, ["2025W18_1B"])
            self.assertIn("dr1/2025W18_1B", index["complete"])
            self.assertEqual(index["refreshProvenance"]["foldersFailed"], [])

    def test_budget_is_recorded_as_deferred_folders(self):
        now = [0.0]

        def fetch(collection, folder):  # each folder takes 31 minutes
            now[0] += 31 * 60
            return []

        with tempfile.TemporaryDirectory() as root, patch.object(b.time, "monotonic", lambda: now[0]):
            index = self.run_main(root, ["--max-minutes", "60", "--workers", "1"], fetch)
        self.assertEqual(index["refreshProvenance"]["foldersDeferred"], ["qr3/2026W40_1A"])
        self.assertEqual(index["complete"], ["dr1/2025W17_4B", "dr1/2025W18_1B"])


if __name__ == "__main__":
    unittest.main()


class IrsaParsingTests(unittest.TestCase):
    """DR1 and QR rows from IRSA become index rows; the newest processing wins."""

    def test_fetch_folder_keeps_the_newest_version_per_exposure_and_detector(self):
        uri = "ibe/data/spherex/dr1/level2/2025W17_4B/{v}/3/level2_2025W17_4B_0116_1D3_spx_{v}.fits"
        arts = [{"uri": uri.format(v=v)} for v in ("l2b-v20-2025-267", "l2b-v27-2026-228", "l2b_retry-v27-2026-228")]
        arts.append({"uri": "ibe/data/spherex/dr1/level2/2025W17_4B/other/file.txt"})  # ignored
        obs = [{"obs_id": "2025W17_4B_0116_1", "energy_bandpassname": "SPHEREx-D3", "t_min": "60800.5",
                "s_ra": "10.0", "s_dec": "20.0", "s_region": "POLYGON ICRS 9.9 19.9 10.1 19.9 10.1 20.1 9.9 20.1"},
               {"obs_id": "2025W17_4B_0116_1", "energy_bandpassname": "SPHEREx-D4", "t_min": "60800.5",
                "s_ra": "10", "s_dec": "20", "s_region": "x"},  # no file for D4
               {"obs_id": "2025W17_4B_0116_1", "energy_bandpassname": "SPHEREx-D3", "t_min": "1",
                "s_ra": "1", "s_dec": "1", "s_region": ""}]  # no footprint
        with patch.object(b, "tap", side_effect=[obs, arts]) as tap:
            rows = b.fetch_folder("spherex_dr1", "2025W17_4B")
        self.assertIn("obs_collection='spherex_dr1'", tap.call_args_list[0].args[0])
        self.assertIn("ibe/data/spherex/dr1/level2/2025W17_4B/", tap.call_args_list[1].args[0])
        self.assertEqual(len(rows), 1)
        ra, dec, mjd, pa, det, sub, seq, ver = rows[0]
        self.assertEqual((ra, dec, mjd, det, sub, seq), (10.0, 20.0, 60800.5, 3, 1, 116))
        self.assertEqual(ver, "l2b_retry-v27-2026-228", "newest processing, retry breaks ties")
        self.assertAlmostEqual(pa, 0.0, places=1)

    def test_version_rank_orders_by_processing_date_then_retry(self):
        self.assertLess(b.version_rank("l2b-v20-2025-267"), b.version_rank("l2b-v27-2026-228"))
        self.assertLess(b.version_rank("l2b-v27-2026-228"), b.version_rank("l2b_retry-v27-2026-228"))
        self.assertEqual(b.version_rank("odd"), (0, 0, 0, 0))

    def test_tile_keys_match_the_browser_scheme(self):
        self.assertEqual(b.tile_key(0, 0), "18_0")
        self.assertEqual(b.tile_key(359.99, 89.9), "35_6", "7 cells in the 85-90 band")
        self.assertEqual(b.tile_key(-10, -89.9), "0_6", "RA -10 wraps to 350")

    def test_tap_retries_then_succeeds_and_rejects_error_documents(self):
        class Resp(io.BytesIO):
            def __enter__(self): return self
            def __exit__(self, *a): return False

        responses = [OSError("502"), Resp(b"<?xml version='1.0'?><VOTABLE>error</VOTABLE>"), Resp(b"a,b\n1,2\n")]

        def urlopen(request, timeout=None):
            r = responses.pop(0)
            if isinstance(r, Exception):
                raise r
            return r

        with patch.object(b.urllib.request, "urlopen", urlopen), patch.object(b.time, "sleep"), quiet():
            self.assertEqual(b.tap("SELECT 1"), [{"a": "1", "b": "2"}])
        responses[:] = [OSError("down")] * 2
        with patch.object(b.urllib.request, "urlopen", urlopen), patch.object(b.time, "sleep"), quiet(), \
                self.assertRaises(OSError):
            b.tap("SELECT 1", tries=2)

    def test_discovery_lists_current_releases_only(self):
        class Resp(io.BytesIO):
            def __enter__(self): return self
            def __exit__(self, *a): return False

        page = b'<OPTION value="spherex_dr1"/><OPTION value="spherex_qr3"/><OPTION value="spherex_qr3_deep"/><OPTION value="spherex_cal"/>'
        calls = [OSError("busy"), Resp(page)]
        opener = lambda url, timeout=None: (lambda r: (_ for _ in ()).throw(r) if isinstance(r, Exception) else r)(calls.pop(0))  # noqa: E731
        with patch.object(b.urllib.request, "urlopen", opener), patch.object(b.time, "sleep"):
            self.assertEqual(b.discover_collections(), ["spherex_qr3", "spherex_dr1"])
        calls[:] = [Resp(b"nothing here")]
        with patch.object(b.urllib.request, "urlopen", opener), self.assertRaises(RuntimeError):
            b.discover_collections()
        calls[:] = [OSError("down")] * 4
        with patch.object(b.urllib.request, "urlopen", opener), patch.object(b.time, "sleep"), self.assertRaises(OSError):
            b.discover_collections()

    def test_existing_tiles_are_kept_and_refetched_folders_replaced(self):
        row = (269.4, 4.7, 60900.0, 10.0, 3, 1, 116, "v1")
        with tempfile.TemporaryDirectory() as root:
            MainTests().run_main(root, [], lambda c, f: [row])
            (Path(root) / "tiles" / "stale.bin").write_bytes(b"")
            index = MainTests().run_main(root, ["--refresh", "dr1/2025W17_4B", "--recent", "0", "--limit", "1"],
                                         lambda c, f: [row, row])
            self.assertFalse((Path(root) / "tiles" / "stale.bin").exists(), "orphan tiles removed")
            self.assertEqual(index["total"], 4, "refetched folder replaced (2 rows), others kept (2 rows)")
            self.assertEqual(index["refreshProvenance"]["mode"], "targeted")


class WorkflowTests(unittest.TestCase):
    def test_weekly_rebuild_stops_well_before_the_job_timeout(self):
        import re
        text = (Path(__file__).resolve().parent / ".github" / "workflows" / "update-index.yml").read_text()
        budget = float(re.search(r"build_index\.py --max-minutes (\d+)", text).group(1))
        timeout = float(re.search(r"timeout-minutes: (\d+)", text).group(1))
        self.assertLessEqual(budget + 45, timeout, "room for in-flight folders, tracks and commit")

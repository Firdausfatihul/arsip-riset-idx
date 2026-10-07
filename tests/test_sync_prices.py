"""tools/sync_prices.py: as-of closes per KSEI snapshot date; no network."""
from datetime import date
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import sync_prices


class ClosesTests(unittest.TestCase):
    def test_as_of_close_skips_bad_rows_and_stale_gaps(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "stockbit_TEST_metrics.csv"
            path.write_text("date,Open 1D,High 1D,Low 1D,Close 1D,Volume 1D\n"
                            "2026-08-28,1,1,1,100,5\n"
                            "2026-08-29,1,1,1,,5\n"          # empty close: ignored
                            "2026-08-31,1,1,1,0,5\n"         # zero close: ignored
                            "2026-07-01,1,1,1,90,5\n"        # unsorted input
                            "2026-10-02,1,1,1,120,5\n", encoding="utf-8")
            prices = sync_prices.closes(path, [date(2026, 7, 31), date(2026, 8, 31), date(2026, 9, 30)])
        # Jul 31: last row Jul 1 is 30 days old -> stale; Aug 31: Aug 28 close; Sep 30: Aug 28 is >7 days old.
        self.assertEqual(prices, [None, 100.0, None])


if __name__ == "__main__":
    unittest.main()

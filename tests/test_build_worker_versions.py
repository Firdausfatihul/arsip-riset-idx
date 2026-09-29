"""Auxiliary asset cache identities, using only temporary files (no archive build)."""
import hashlib
import pathlib
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from build_worker import auxiliary_versions  # noqa: E402


class AuxiliaryVersions(unittest.TestCase):
    def test_exact_bytes_and_independent_asset_hashes(self):
        names = ('events.json', 'ownership.json', 'signals.json', 'ksei_history.json')
        with tempfile.TemporaryDirectory() as tmp:
            out = pathlib.Path(tmp)
            for name in names:
                (out / name).write_bytes(b'{"value":1}')
            original = auxiliary_versions(out)
            self.assertEqual(original, auxiliary_versions(out))
            self.assertEqual(original['asset_hashes']['events.json'], hashlib.sha256(b'{"value":1}').hexdigest())
            for name in names:
                with self.subTest(asset=name):
                    # Whitespace differs while parsed data is equal: hash the served bytes.
                    (out / name).write_bytes(b'{"value": 1}')
                    changed = auxiliary_versions(out)
                    self.assertNotEqual(changed['data_version'], original['data_version'])
                    self.assertNotEqual(changed['asset_hashes'][name], original['asset_hashes'][name])
                    for other in names:
                        if other != name:
                            self.assertEqual(changed['asset_hashes'][other], original['asset_hashes'][other])
                    (out / name).write_bytes(b'{"value":1}')
            (out / 'manifest.json').write_bytes(b'unrelated manifest metadata')
            (out / 'D1.json').write_bytes(b'document bytes have a separate version')
            self.assertEqual(original, auxiliary_versions(out))

    def test_missing_added_and_removed_assets_have_distinct_versions(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = pathlib.Path(tmp)
            empty = auxiliary_versions(out)
            self.assertEqual(empty['asset_hashes'], {})
            (out / 'events.json').write_bytes(b'')
            present = auxiliary_versions(out)
            self.assertNotEqual(present['data_version'], empty['data_version'])
            self.assertEqual(set(present['asset_hashes']), {'events.json'})
            (out / 'events.json').unlink()
            self.assertEqual(auxiliary_versions(out), empty)


if __name__ == '__main__':
    unittest.main()

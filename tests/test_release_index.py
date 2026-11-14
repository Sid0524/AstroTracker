import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))

from build_index import COLLECTION_RE, URI_RE, supported_collections


class ReleaseIndexTests(unittest.TestCase):
    def test_collection_discovery_includes_dr1_and_excludes_other_product_sets(self):
        names = [
            'spherex_qr3', 'spherex_dr1', 'spherex_qr2', 'spherex_dr1_deep',
            'spherex_dr1_cube', 'spherex_qr2_cal',
        ]
        self.assertEqual(
            supported_collections(names),
            ['spherex_qr2', 'spherex_qr3', 'spherex_dr1'],
        )
        self.assertTrue(COLLECTION_RE.fullmatch('spherex_dr1'))
        self.assertFalse(COLLECTION_RE.fullmatch('spherex_dr1_deep'))

    def test_official_dr1_artifact_path_matches_the_qr_level2_layout(self):
        uri = (
            'ibe/data/spherex/dr1/level2/2025W19_1B/'
            'l2b-v27-2026-197/3/'
            'level2_2025W19_1B_0116_1D3_spx_l2b-v27-2026-197.fits'
        )
        match = URI_RE.search(uri)
        self.assertIsNotNone(match)
        self.assertEqual(match.groups(), (
            'dr1', '2025W19_1B', 'l2b-v27-2026-197', '3',
            '2025W19_1B', '0116', '1', '3',
        ))

    def test_qr2_and_qr3_artifact_paths_remain_supported(self):
        for release in ('qr2', 'qr3'):
            uri = (
                f'ibe/data/spherex/{release}/level2/2025W19_1B/'
                'l2b-v27-2026-197/3/'
                'level2_2025W19_1B_0116_1D3_spx_l2b-v27-2026-197.fits'
            )
            self.assertEqual(URI_RE.search(uri).group(1), release)


if __name__ == '__main__':
    unittest.main()

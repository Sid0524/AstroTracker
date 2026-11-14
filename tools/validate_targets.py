#!/usr/bin/env python3
"""Report indexed SPHEREx footprint hits for five fixed challenge positions.

This is a bounded, read-only check: it opens only nearby catalog tiles and,
optionally, sends one HEAD request for a representative FITS file per target.
It does not request cutouts, inspect FITS pixel data, assess data quality, or
make source-detection claims.
"""

import argparse
import datetime as dt
import json
import math
import os
import struct
import urllib.error
import urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data')
ROW = struct.Struct('<fffhBBHHHH')
HALF_SIDE = 1.74
SEARCH_R = 2.5
TILE_DEG = 5.0
S3_HOSTS = (
    'https://nasa-irsa-spherex.s3.amazonaws.com/',
    'https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/',
    'https://s3.amazonaws.com/nasa-irsa-spherex/',
    'https://s3.us-east-1.amazonaws.com/nasa-irsa-spherex/',
)
TARGETS = (
    ("Barnard's Star", 269.446268, 4.768204),
    ('Epsilon Indi B', 331.04414658852124, -56.78284419511611),
    ('WISE 0855', 133.7951292, -7.2451472),
    ('RW Aurigae', 76.95652603458, 30.40143817389),
    ('R Draconis', 248.16761083295, 66.75497941722),
)


def band_info(band, tile_deg=TILE_DEG):
    lo = -90 + band * tile_deg
    hi = lo + tile_deg
    edge = 0 if lo < 0 < hi else min(abs(lo), abs(hi))
    return max(1, math.ceil(360 * math.cos(math.radians(edge)) / tile_deg))


def tiles_near(ra, dec, radius, tile_deg=TILE_DEG):
    keys = set()
    n_bands = round(180 / tile_deg)
    b0 = max(0, math.floor((dec - radius + 90) / tile_deg))
    b1 = min(n_bands - 1, math.floor((dec + radius + 90) / tile_deg))
    max_abs_dec = min(90, abs(dec) + radius)
    dra = 360 if max_abs_dec >= 89.9 else radius / math.cos(math.radians(max_abs_dec))
    for band in range(b0, b1 + 1):
        n = band_info(band, tile_deg)
        if dra >= 180:
            keys.update(f'{band}_{i}' for i in range(n))
            continue
        i0 = math.floor(((ra - dra) % 360) / 360 * n)
        span = math.ceil((2 * dra) / 360 * n) + 1
        keys.update(f'{band}_{(i0 + k) % n}' for k in range(span + 1))
    return keys


def contains(ra0, dec0, pa_centideg, ra, dec):
    ra0, dec0, ra, dec = map(math.radians, (ra0, dec0, ra, dec))
    dra = ra - ra0
    c = math.sin(dec0) * math.sin(dec) + math.cos(dec0) * math.cos(dec) * math.cos(dra)
    if c <= 0:
        return False
    x = math.cos(dec) * math.sin(dra) / c / (math.pi / 180)
    y = (math.cos(dec0) * math.sin(dec) - math.sin(dec0) * math.cos(dec) * math.cos(dra)) / c / (math.pi / 180)
    if math.hypot(x, y) > SEARCH_R:
        return False
    pa = math.radians(pa_centideg / 100)
    u = x * math.cos(pa) + y * math.sin(pa)
    w = -x * math.sin(pa) + y * math.cos(pa)
    return abs(u) <= HALF_SIDE and abs(w) <= HALF_SIDE


def s3_url(collection, folder, version, image_id, detector):
    h = 0
    for char in image_id + str(detector):
        h = (h * 31 + ord(char)) & 0xFFFFFFFF
    if h >= 0x80000000:
        h -= 0x100000000
    base = S3_HOSTS[abs(h) % len(S3_HOSTS)]
    return (
        f'{base}{collection}/level2/{folder}/{version}/{detector}/'
        f'level2_{image_id}D{detector}_spx_{version}.fits'
    )


def file_availability(url, timeout):
    try:
        request = urllib.request.Request(url, method='HEAD')
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return {
                'status': response.status,
                'contentLength': response.headers.get('Content-Length'),
                'acceptRanges': response.headers.get('Accept-Ranges'),
            }
    except urllib.error.HTTPError as error:
        return {'status': error.code, 'error': str(error.reason)}
    except Exception as error:  # noqa: BLE001
        return {'status': None, 'error': str(error)}


def read_target_rows(index, ra, dec, data_root=ROOT):
    keys = tiles_near(ra, dec, SEARCH_R, index.get('tileDeg', TILE_DEG))
    rows = []
    for key in sorted(keys.intersection(index.get('tiles', {}))):
        path = os.path.join(data_root, 'tiles', f'{key}.bin')
        with open(path, 'rb') as tile:
            data = tile.read()
        if len(data) % ROW.size:
            raise ValueError(f'{path} length is not divisible by rowBytes ({ROW.size})')
        for offset in range(0, len(data), ROW.size):
            values = ROW.unpack_from(data, offset)
            row_ra, row_dec, mjd_delta, pa, detector, sub, folder_i, seq, version_i, _ = values
            if not contains(row_ra, row_dec, pa, ra, dec):
                continue
            folder_parts = index['folders'][folder_i].split('/', 1)
            if len(folder_parts) != 2:
                continue
            collection, folder = folder_parts
            version = index['versions'][version_i]
            image_id = f'{folder}_{seq:04d}_{sub}'
            mjd = mjd_delta + index.get('mjd0', 60000.0)
            date = (dt.datetime(1858, 11, 17, tzinfo=dt.timezone.utc)
                    + dt.timedelta(days=mjd)).date().isoformat()
            rows.append({
                'collection': f'spherex_{collection}',
                'detector': detector,
                'date': date,
                'mjd': mjd,
                'id': image_id,
                'url': s3_url(collection, folder, version, image_id, detector),
            })
    return sorted(rows, key=lambda row: row['mjd'])


def summarize(index, check_headers=True, timeout=20, data_root=ROOT):
    results = []
    for name, ra, dec in TARGETS:
        rows = read_target_rows(index, ra, dec, data_root)
        by_detector = {}
        for row in rows:
            detector = f"D{row['detector']}"
            dates = by_detector.setdefault(detector, {})
            dates[row['date']] = dates.get(row['date'], 0) + 1
        representative = None
        if rows and check_headers:
            row = rows[0]
            representative = {
                'collection': row['collection'],
                'detector': f"D{row['detector']}",
                'date': row['date'],
                'id': row['id'],
                'url': row['url'],
                'head': file_availability(row['url'], timeout),
            }
        results.append({
            'target': name,
            'coordinates': {'ra': ra, 'dec': dec},
            'footprintIndexHitCount': len(rows),
            'byDetectorAndDate': by_detector,
            'representativeFitsHead': representative,
        })
    return {
        'indexUpdated': index.get('updated') or 'unknown',
        'indexedCollections': index.get('indexedCollections') or sorted({
            f"spherex_{folder.split('/', 1)[0]}"
            for folder in index.get('folders', [])
            if isinstance(folder, str) and '/' in folder
        }),
        'results': results,
        'scope': (
            'Footprint-index hits only. FITS HEAD checks test URL availability '
            'and headers only; no cutouts or FITS pixels were inspected. '
            'No data-quality or source-detection claims are made.'
        ),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--no-head', action='store_true', help='skip representative FITS HEAD requests')
    parser.add_argument('--head-timeout', type=float, default=20, help='timeout per HEAD request in seconds')
    parser.add_argument('--index', default=os.path.join(ROOT, 'index.json'), help='static index JSON path')
    args = parser.parse_args()
    with open(args.index, encoding='utf-8') as source:
        index = json.load(source)
    data_root = os.path.dirname(os.path.abspath(args.index))
    print(json.dumps(summarize(index, not args.no_head, args.head_timeout, data_root), indent=2))


if __name__ == '__main__':
    main()

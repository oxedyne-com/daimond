#!/usr/bin/env python3
"""Writes vectors.json: the submit/v3 manifest and card/v3 layouts, encoded here
independently of the Rust codec (kimberlite/src/trust.rs), so the Rust test, the
approve page's WebCrypto and this file must agree byte for byte.

Run once: python3 -I gen_vectors.py > vectors.json.  Never edit vectors.json to
make a check green; a layout change is a new submit_vN directory.
"""
import hashlib, json, struct

def s16(b):
    b = b.encode() if isinstance(b, str) else b
    return struct.pack('>H', len(b)) + b

WHO = {'fenced': 1, 'daimon': 2}
RES = {'failed': 0, 'passed': 1, 'skipped': 2}
KIND = {'runner': 1, 'page': 2}

# The page artefact (daimond-a's rule, 06 Nov): its sha256 is SHA-256 of the bundle's
# files.sha256 and its size is files.sha256's byte size.  A small bundle, its files.sha256 in
# the form dk ship-bundle checks ('<sha256>  <relative path>', sorted and unique, LC_ALL=C).
BUNDLE = {
    'www/index.html':       b'<!doctype html><title>Daimond</title>\n',
    'www/js/daimond.js':    b'export const v = 1;\n',
    'www/sw.js':            b'self.addEventListener("fetch", () => {});\n',
}
FILES_SHA256 = ''.join(hashlib.sha256(BUNDLE[p]).hexdigest() + '  ' + p + '\n'
    for p in sorted(BUNDLE, key=lambda p: p.encode())).encode()
PAGE_SHA256 = hashlib.sha256(FILES_SHA256).hexdigest()
PAGE_SIZE = len(FILES_SHA256)

def card(c):
    out = b'kimberlite/card/v3\0' + s16(c['title']) + s16(c['summary']) + s16(c['branch']) \
        + s16(c['diffstat']) + bytes.fromhex(c['diff_sha256']) + bytes([len(c['checks'])])
    for k in c['checks']:
        out += s16(k['name']) + bytes([WHO[k['who']], RES[k['result']]]) + struct.pack('>I', k['count'])
    out += struct.pack('>H', len(c['write_paths']))
    for p in c['write_paths']:
        out += s16(p)
    return out + bytes([1 if c['page_code'] else 0]) + s16(c['review'])

def manifest(m, card_sha):
    out = b'kimberlite/submit/v3\0' + struct.pack('>Q', m['seq']) + s16(m['commit']) \
        + s16(m['base_commit']) + bytes([len(m['pins'])])
    for p in m['pins']:
        out += s16(p['name']) + s16(p['pin'])
    out += card_sha + s16(','.join(m['nets'])) \
        + bytes([len(m['artefacts'])])
    for a in m['artefacts']:
        out += bytes([KIND[a['kind']]]) + bytes.fromhex(a['sha256']) + struct.pack('>Q', a['size']) + s16(a['target'])
    return out + bytes([1 if m['write_path'] else 0]) + bytes.fromhex(m['failing_first'])

DIFF = b'diff --git a/kimberlite/src/run.rs b/kimberlite/src/run.rs\n'
CASES = [
    {
        'name': 'runner_only',
        'card': {
            'title': 'Daimon change: turn always ends with words',
            'summary': 'A turn never ends without words to you.\nTests pass.',
            'branch': 'daimon/turn-words',
            'diffstat': ' kimberlite/src/run.rs | 12 ++++++----\n 1 file changed, 8 insertions(+), 4 deletions(-)',
            'diff_sha256': hashlib.sha256(DIFF).hexdigest(),
            'checks': [
                {'name': 'runner', 'who': 'fenced', 'result': 'passed', 'count': 0},
                {'name': 'tests', 'who': 'fenced', 'result': 'passed', 'count': 214},
                {'name': 'page tests', 'who': 'daimon', 'result': 'passed', 'count': 6456},
            ],
            'write_paths': [],
            'page_code': False,
            'review': '',
        },
        'manifest': {
            'seq': 1762387200,
            'commit': '3a1f' + '0' * 36,
            'base_commit': '9f396af1f' + '1' * 31,
            'pins': [{'name': 'fe2o3', 'pin': 'c0ffee' + '2' * 34}],
            'nets': [],
            'artefacts': [
                {'kind': 'runner', 'sha256': '9c2e' + '3' * 60, 'size': 31457280, 'target': 'x86_64-unknown-linux-gnu'},
            ],
            'write_path': False,
            'failing_first': '00' * 32,
        },
    },
    {
        'name': 'runner_and_page_test_net_sha256_ids',
        'card': {
            'title': 'Ändern: ünïcode title',
            'summary': '',
            'branch': 'daimon/both',
            'diffstat': '',
            'diff_sha256': '00' * 32,
            'checks': [
                {'name': 'fails on the old code: 2, passes on the new: 2', 'who': 'fenced', 'result': 'passed', 'count': 2},
            ],
            'write_paths': ['kimberlite/src/store.rs', 'fe2o3/fe2o3_file/src/lib.rs'],
            'page_code': True,
            'review': 'Ändern: a review',
        },
        'manifest': {
            'seq': 1,
            'commit': 'ab' * 32,
            'base_commit': 'cd' * 32,
            'pins': [{'name': 'fe2o3', 'pin': 'ef' * 20}, {'name': 'fe2o3-gw', 'pin': 'cb81f2bb' + '7' * 32}],
            'nets': ['test'],
            'artefacts': [
                {'kind': 'runner', 'sha256': '44' * 32, 'size': 1, 'target': 'x86_64-unknown-linux-gnu'},
                {'kind': 'page', 'sha256': PAGE_SHA256, 'size': PAGE_SIZE, 'target': 'test'},
            ],
            'write_path': True,
            'failing_first': '6a' * 32,
        },
    },
]

out = []
for c in CASES:
    cb = card(c['card'])
    csha = hashlib.sha256(cb).digest()
    mb = manifest(c['manifest'], csha)
    out.append({
        'name': c['name'],
        'card': c['card'],
        'card_hex': cb.hex(),
        'card_sha256': csha.hex(),
        'manifest': c['manifest'],
        'manifest_hex': mb.hex(),
        'challenge': hashlib.sha256(mb).hexdigest(),
    })
print(json.dumps({'v': 4, 'page_bundle': {'files_sha256': FILES_SHA256.decode(),
    'sha256': PAGE_SHA256, 'size': PAGE_SIZE}, 'cases': out}, indent=1, ensure_ascii=False))

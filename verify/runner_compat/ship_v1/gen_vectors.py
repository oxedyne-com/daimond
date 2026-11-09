#!/usr/bin/env python3
"""Writes vectors.json: the bytes a runner's device key signs for one ship state on the
relay (UNBLOCK-160 RL1/RL2/PS4), encoded here independently of the Rust code, so the
gateway, Kimberlite's keeper and the page must agree byte for byte.

Run once: python3 -I gen_vectors.py > vectors.json.  Never edit vectors.json to make a
check green; a layout change is a new ship_vN directory.  The key is a fixed test seed,
never a real device's.
"""
import base64, datetime, hashlib, json
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

def b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b'=').decode()

DOMAIN  = b'kimberlite/device/v1\0'   # keeper device_key.rs signed_bytes
PURPOSE = b'ship-state\0'             # Purpose::ShipState
SEED    = hashlib.sha256(b'daimond ship_v1 test device key').digest()

def body(**kv):
    return json.dumps(kv, ensure_ascii=False, separators=(',', ':'))

# Each case carries the clock its replayer pins (the page test too) as `now`, and what the
# page does with it, `expect` kept or dropped, and `reason`: a post `at` further than
# repost + skew from `now`, either way, is dropped, as the gateway refuses it.
NOW    = 1762696800                   # 2025-11-09T14:00:00Z, the cases' usual `now`
REPOST = 420                          # gateway `ship_repost_secs`, Kimberlite's re-post interval
SKEW   = 120                          # gateway SIGNED_SKEW_SECS

DEVICE  = 'shipv1testdevice'
INSTALL = 'SWkxSW5zdGFsbElkMDEyMw'
SUB     = '9f1c2e3d4b5a69788796a5b4c3d2e1f0'          # 32-hex submission id (plain.rs)
COMMIT  = '3b18e512dba79e4c8d3f1d4b2a6c7e9f00112233'  # 40-hex commit

def ship(state, at, note=''):
    """A §5 ship-state body: submission id, commit, state, the shipper's RFC 3339 `at`,
    the stall bound and a note."""
    return body(id=SUB, commit=COMMIT, state=state, at=at, stall_secs=3600, note=note)

# post `at`: Kimberlite's post time, unix seconds; the body's `at` is the RFC 3339 state time.
CASES = [
    {'name': 'unicode_and_escapes', 'nonce': 'U2hpcFYxTm9uY2UwMTIzNA', 'at': NOW - 30, 'now': NOW,
     'body': ship('live', '2025-11-09T13:59:30Z', 'quote " back\\slash café ✓')},
    {'name': 'shipping',            'nonce': 'U2hpcFYxTm9uY2U1Njc4OQ', 'at': NOW, 'now': NOW + 400,
     'body': ship('shipping', '2025-11-09T13:58:02Z')},
    {'name': 'stopped_at_window',   'nonce': 'U2hpcFYxTm9uY2VBQkNERQ', 'at': NOW - REPOST - SKEW, 'now': NOW,
     'body': ship('stopped', '2025-11-09T13:50:00Z', 'held: no tap within stall_secs')},
]
KEPT = 'signed by the paired device, post at within repost + skew of now'


key   = Ed25519PrivateKey.from_private_bytes(SEED)
other = Ed25519PrivateKey.from_private_bytes(hashlib.sha256(b'daimond ship_v1 another device').digest())
raw   = serialization.Encoding.Raw, serialization.PublicFormat.Raw
pub   = key.public_key().public_bytes(*raw)

def text(c):
    return 'kimberlite-ship:v1:%s:%s:%s:%d:%s' % (DEVICE, INSTALL, c['nonce'], c['at'], c['body'])

def rfc3339(t):
    return datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

def entry(c, signed, signer=key, **extra):
    now = c.get('now', NOW)
    return dict({
        'name':       c['name'],
        'now':        now,
        'now_rfc3339': rfc3339(now),
        'seed_hex':   SEED.hex(),
        'pubkey':     b64u(pub),
        'device':     DEVICE,
        'device_state': 'paired',
        'install':    INSTALL,
        'nonce':      c['nonce'],
        'at':         c['at'],
        'body':       c['body'],
        'signed_hex': signed.hex(),
        'sig':        b64u(signer.sign(signed)),
    }, **extra)

out = [entry(c, DOMAIN + PURPOSE + text(c).encode('utf-8'), expect='kept', reason=KEPT) for c in CASES]

# Each refusal is a post a verifier must refuse, `why` says by which rule; `signed_hex` is
# the bytes the key actually signed, never what a verifier rebuilds.
base = dict(CASES[1], now=NOW)
good = DOMAIN + PURPOSE + text(base).encode('utf-8')
def moved(c, at):
    m = dict(c, at=at)
    return entry(m, DOMAIN + PURPOSE + text(m).encode('utf-8'))
n = base['nonce']
col = text(base).replace(':%s:' % n, ':%s:%s' % (n[:-1], n[-1]), 1)
REFUSALS = [
    dict(entry(base, DOMAIN + b'gateway-request\0' + text(base).encode('utf-8')),
         name='wrong_purpose', why='signed under another purpose tag'),
    dict(entry(base, good, signer=other), name='other_device_key',
         why="signed by another device's key, not the named device's"),
    dict(entry(base, good, device_state='pending'), name='pending_device',
         why='the named device is pending, not paired'),
    dict(entry(base, good, device_state='removed'), name='removed_device',
         why='the named device was removed: no key on the account'),
    dict(entry(base, DOMAIN + PURPOSE + col.encode('utf-8')), name='colon_shift',
         why="a ':' moved: the signed fields are not the posted ones"),
    dict(entry(base, DOMAIN + b'ship-state' + text(base).encode('utf-8') + b'\0'), name='nul_shift',
         why="the purpose tag's NUL moved to the end"),
    dict(moved(base, NOW - REPOST - SKEW - 1), name='stale_at',
         why='post at older than now - (repost + skew)'),
    dict(moved(base, NOW + REPOST + SKEW + 1), name='future_at',
         why='post at later than now + (repost + skew)'),
    dict(entry(dict(base, now=NOW + REPOST + SKEW + 1), good), name='aged_out',
         why='a good post the page holds past now - (repost + skew): its device stopped re-posting'),
]
for r in REFUSALS:
    r['expect'] = 'dropped'
    r['reason'] = r.pop('why')

print(json.dumps({'v': 1, 'repost_secs': REPOST, 'skew_secs': SKEW, 'cases': out, 'refusals': REFUSALS},
    ensure_ascii=False, indent=1))

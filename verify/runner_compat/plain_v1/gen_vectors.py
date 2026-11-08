#!/usr/bin/env python3
# Regenerates vectors.json for the plain route's card (kimberlite/plain/v1), byte layout as
# PLAINROUTE_RESUME (kimb/plainroute 1098fc581): run `python3 -I gen_vectors.py > vectors.json`.
# `seq` is written as a decimal string: a u64 does not survive a JSON number in JavaScript.
import base64
import hashlib
import json
import struct

DOMAIN = b"kimberlite/plain/v1\0"

def s16(s):
    b = s.encode("utf-8")
    return struct.pack(">H", len(b)) + b

def card(v):
    out = DOMAIN + struct.pack(">Q", v["seq"])
    for k in ("repo", "branch", "commit", "summary", "chat"):
        out += s16(v[k])
    out += s16(v["diamond"])
    out += s16(v["diamond_name"])
    out += bytes([v["page_code"], v["runner_code"], len(v["checks"])])
    for c in v["checks"]:
        out += s16(c["name"]) + bytes([c["result"]]) + struct.pack(">I", c["runs"])
    return out

CASES = [
    {"name": "page change, two passed checks", "seq": 1762425600, "repo": "daimond",
     "branch": "daimon/weekday-dates", "commit": "3f9c2e1a7b6d5c4e3f2a1b0c9d8e7f6a5b4c3d2e",
     "summary": "Dates in chats show the weekday.", "chat": "chat-7f3a", "diamond": "Daimond", "diamond_name": "Weekday dates", "page_code": 1, "runner_code": 0,
     "checks": [{"name": "node --test www/js", "result": 1, "runs": 1233},
                {"name": "cargo test --lib", "result": 1, "runs": 6456}]},
    {"name": "no page code, no checks, no chat, non-ASCII summary", "seq": 1, "repo": "daimond",
     "branch": "daimon/naïve-fix", "commit": "a" * 64, "summary": "Grüße — weekday shown",
     "chat": "", "diamond": "", "diamond_name": "Grüße — garden", "page_code": 0, "runner_code": 0, "checks": []},
    {"name": "a failed check", "seq": 18446744073709551615, "repo": "fe2o3", "branch": "daimon/x",
     "commit": "0123456789abcdef0123456789abcdef01234567", "summary": "Two\nlines.",
     "chat": "chat-1", "diamond": "Kimberlite ✦ run", "diamond_name": "é" * 64, "page_code": 1, "runner_code": 1,
     "checks": [{"name": "cargo test", "result": 2, "runs": 0}]},
]

vecs = []
for v in CASES:
    c = card(v)
    vecs.append(dict(v, seq=str(v["seq"]), card_hex=c.hex(),
                     card_b64u=base64.urlsafe_b64encode(c).rstrip(b"=").decode(),
                     challenge_hex=hashlib.sha256(c).hexdigest()))
print(json.dumps({"domain": "kimberlite/plain/v1\\0", "vectors": vecs}, indent=1, ensure_ascii=False))

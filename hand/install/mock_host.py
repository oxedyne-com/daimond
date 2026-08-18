#!/usr/bin/env python3
"""A stand-in for the machine hand, so the relay can be driven without Rust.

It speaks the real framing -- a 4-byte native-endian length prefix followed by
UTF-8 JSON, which is Chrome's format and not negotiable -- and the real
messages, from ``hand/src/wire.rs``.  It runs nothing.  Every ``exec`` produces
invented output on a schedule, which is exactly what is wanted: the relay's job
is order, attribution and the shape of failure, and none of that needs a real
process to exercise.

It is also the only way to reach the failures that matter.  A gap in the
sequence, a message over Chrome's 1 MB limit, and a host that dies mid-command
are all things a correct hand will never do, so a correct hand cannot be used to
test what happens when they occur.

Behaviour is read from ``mock_cfg.json`` beside this file, because Chrome gives
a native messaging host no arguments of its own -- it passes the calling
extension's origin as ``argv[1]`` and nothing else -- and the browser's
environment is not the test runner's to set.

    {"chunks": 3, "gap": false, "huge": false, "crash": false, "delay_ms": 0}

    chunks    how many chunks per stream
    gap       skip one sequence number, so the relay must report a hole
    huge      send one message over 1 MB, which makes Chrome drop the
              connection without telling either end why
    crash     exit after "started", as a host that segfaults would
    delay_ms  pause between chunks, for testing a long, quiet run
    caps      what the "hello" claims this hand can enforce.  The page reads
              the granted folder out of this list as a "root:<path>" entry,
              because ``wire.rs`` has no field for it
    exit      the status the command ends with, for proving a failure is
              reported as a failure
    quiet_ms  silence between "started" and the first chunk, which is what a
              build that says nothing for a minute looks like
    noise_ms  send an unrecognised message this often and NOTHING else -- no
              "started", no output, no end.  A page that treats any message as
              proof of life waits for ever on it

Everything it receives and sends is appended to ``mock_host.log`` beside it, so
a test can prove the relay sent ``bye`` when the page went away rather than
leaving an orphan.
"""

import json
import os
import struct
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
CFG = os.path.join(HERE, 'mock_cfg.json')
LOG = os.path.join(HERE, 'mock_host.log')

PROTO = 1


def note(what, msg):
    """Records one line of the conversation, best effort."""
    try:
        with open(LOG, 'a', encoding='utf-8') as fh:
            fh.write('%.3f %s %s\n' % (time.time(), what, json.dumps(msg)[:400]))
    except OSError:
        pass


def cfg():
    """The behaviour asked for, or the plain default."""
    out = {'chunks': 3, 'gap': False, 'huge': False, 'crash': False, 'delay_ms': 0,
           'caps': ['mock'], 'exit': 0, 'quiet_ms': 0, 'noise_ms': 0}
    try:
        with open(CFG, encoding='utf-8') as fh:
            out.update(json.load(fh))
    except (OSError, ValueError):
        pass
    return out


def read():
    """One frame from the browser, or None at end of stream."""
    head = sys.stdin.buffer.read(4)
    if len(head) < 4:
        return None
    (n,) = struct.unpack('@I', head)
    body = sys.stdin.buffer.read(n)
    if len(body) < n:
        return None
    return json.loads(body.decode('utf-8'))


def send(msg):
    """One frame back.  Native byte order, which is what Chrome reads."""
    data = json.dumps(msg).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('@I', len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()
    note('->', msg)


def run(req, c):
    """Answers one exec with invented output, on the schedule configured."""
    rid = req.get('id', '')

    # A host that says something the page does not understand, and nothing it
    # does.  Nothing here is a wire message: the point is that a page must not
    # take an unrecognised frame as evidence that the command is alive.
    if c['noise_ms']:
        while True:
            send({'t': 'noop', 'id': rid})
            time.sleep(c['noise_ms'] / 1000.0)

    send({'t': 'started', 'id': rid, 'pid': os.getpid()})

    # The long silence at the start of a real build.  It is not a hang, and a
    # page that cannot tell the two apart kills the command it was asked to run.
    if c['quiet_ms']:
        time.sleep(c['quiet_ms'] / 1000.0)

    if c['crash']:
        note('!!', {'crash': rid})
        sys.exit(1)

    if c['huge']:
        # Over Chrome's 1 MB cap.  Chrome drops the connection on seeing this
        # and tells neither end why, which is the case the relay has to survive.
        send({'t': 'chunk', 'id': rid, 'stream': 'out', 'seq': 1, 'data': 'x' * 1_200_000})
        return

    # Counted as it is sent, not declared.  These two totals are the app's ONLY
    # measure of whether output went missing between here and the model, so a
    # hardcoded pair is an oracle that lies: they used to be 64 and 26 whatever
    # was actually emitted, and three chunks of "line N of cargo test\n" is 63
    # bytes against a claimed 64, so every ordinary run in verify_handrun was
    # handed "[some output did not arrive: 63 of 64 bytes on stdout, 27 of 26 on
    # stderr]".  The app was reporting this file's figure faithfully -- 27 of 26
    # is more than was asked for, which no byte counter can say about itself --
    # and the note cost a lane an hour on 2026-08-18.
    out_bytes = 0
    err_bytes = 0

    seq = 0
    for i in range(c['chunks']):
        seq += 1
        # A deliberate hole: the relay must say so rather than hand the page a
        # transcript that merely looks complete.
        if c['gap'] and i == 1:
            seq += 1
        data = 'line %d of %s\n' % (i + 1, ' '.join(req.get('argv', [])))
        out_bytes += len(data.encode('utf-8'))
        send({'t': 'chunk', 'id': rid, 'stream': 'out', 'seq': seq, 'data': data})
        if c['delay_ms']:
            time.sleep(c['delay_ms'] / 1000.0)

    err = 'a word from standard error\n'
    err_bytes += len(err.encode('utf-8'))
    send({'t': 'chunk', 'id': rid, 'stream': 'err', 'seq': 1, 'data': err})
    send({'t': 'ended', 'id': rid, 'exit': c['exit'], 'timed_out': False, 'killed': False,
          'out_bytes': out_bytes, 'err_bytes': err_bytes})


def main():
    note('--', {'started': sys.argv[1:]})
    c = cfg()
    while True:
        try:
            req = read()
        except ValueError as e:
            send({'t': 'error', 'id': None, 'message': 'undecodable frame: %s' % e})
            return
        if req is None:
            note('--', {'stdin closed': True})
            return
        note('<-', req)

        t = req.get('t')
        if t == 'hello':
            send({'t': 'hello', 'proto': PROTO, 'host': 'daimond-hand (mock)',
                  'version': '0.0.0-mock', 'os': 'linux', 'caps': c['caps']})
        elif t == 'exec':
            run(req, c)
        elif t == 'signal':
            send({'t': 'ended', 'id': req.get('id', ''), 'exit': -1, 'timed_out': False,
                  'killed': True, 'out_bytes': 0, 'err_bytes': 0})
        elif t == 'bye':
            note('--', {'bye': True})
            return
        else:
            send({'t': 'error', 'id': req.get('id'), 'message': 'unknown message %r' % t})


if __name__ == '__main__':
    main()

// handbridge.mjs — pairing a REAL hand binary to a page with no browser extension.
//
// Extracted (2026-09-24) out of `dev/verify_handmeterless.mjs`, which had the only copy, so
// `dev/verify_handnotice.mjs` could pair a second, deliberately old hand without a second copy
// of the native-messaging wire. `verify_handmeterless.mjs` re-exports nothing here itself any
// more — both files import from this one.
//
// Real: the hand process, spoken to over Chrome's own native-messaging framing (a 4-byte
// native-endian length prefix and UTF-8 JSON). Stood in for: the extension and Chrome's native
// messaging themselves, which a headless browser cannot have — `fakeExtension` hands the page's
// relay a `chrome.runtime` shaped exactly as the relay needs and no more, and `bridge` is the
// pipe on the other end of it, in the test process rather than a second browser process.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const LE = os.endianness() === 'LE';

/// Plant `n` files under `mark`, spread across three subfolders, for a fixture that needs
/// something on disk before a hand can be asked to read or remove it.
export function plant(mark, n) {
	fs.mkdirSync(mark, { recursive: true });
	for (let i = 0; i < n; i++) {
		const sub = path.join(mark, ['src', 'docs', 'sub/deep'][i % 3]);
		fs.mkdirSync(sub, { recursive: true });
		fs.writeFileSync(path.join(sub, `f${String(i).padStart(3, '0')}.txt`), `file ${i}\n`);
	}
}

/// The fake extension, installed before any script on the page runs. It has the shape the relay
/// uses and no more: `connect` for the one port, `sendMessage` answering nothing (which the
/// relay reads as an extension too old to know the question, its safe reading).
export function fakeExtension(extId) {
	const ports = [];
	window.__fromHand = (m) => {
		for (const p of ports) {
			if (p.dead) continue;
			for (const f of p.msg) { try { f(m); } catch (e) { /* the relay's own fault */ } }
		}
	};
	window.__handGone = () => {
		for (const p of ports) {
			if (p.dead) continue;
			p.dead = true;
			for (const f of p.gone) { try { f(); } catch (e) { /* ditto */ } }
		}
	};
	const runtime = {
		lastError: null,
		connect(id, info) {
			const p = { msg: [], gone: [], dead: false };
			ports.push(p);
			window.__toHand(JSON.stringify({ t: '__connect', name: (info && info.name) || '' }));
			return {
				name: (info && info.name) || '',
				postMessage(m) {
					if (p.dead) throw new Error('Attempting to use a disconnected port object');
					window.__toHand(JSON.stringify(m));
				},
				disconnect() { p.dead = true; window.__toHand(JSON.stringify({ t: '__disconnect' })); },
				onMessage: { addListener(f) { p.msg.push(f); } },
				onDisconnect: { addListener(f) { p.gone.push(f); } },
			};
		},
		sendMessage(id, msg, cb) { setTimeout(() => { if (cb) cb(null); }, 0); },
	};
	try {
		if (!window.chrome) window.chrome = {};
		Object.defineProperty(window.chrome, 'runtime', { value: runtime, configurable: true, writable: true });
	} catch (e) { /* the relay will say there is no hand, and the checks will fail */ }
	const stamp = () => { try { document.documentElement.dataset.daimondHands = extId; } catch (e) { /* later */ } };
	if (document.documentElement) stamp();
	else document.addEventListener('readystatechange', stamp, { once: true });
}

/// One page's hand: a process of `bin` per port the page opens, with fixture roots under `root`.
export function bridge(page, bin, root) {
	const b = { sent: [], got: [], procs: 0, child: null };
	let buf = Buffer.alloc(0);
	let chain = Promise.resolve();
	const toPage = (m) => {
		b.got.push(m);
		chain = chain.then(() => page.evaluate((x) => window.__fromHand(x), m)).catch(() => {});
	};
	const start = () => {
		const env = {
			...process.env,
			DAIMOND_HAND_ROOT:        path.join(root, 'grant'),
			DAIMOND_HAND_JOURNAL_DIR: path.join(root, 'journal'),
			DAIMOND_HAND_TRASH_DIR:   path.join(root, 'trash'),
			DAIMOND_HAND_SCRATCH_DIR: path.join(root, 'scratch'),
		};
		for (const k of ['DAIMOND_HAND_JOURNAL_DIR', 'DAIMOND_HAND_TRASH_DIR', 'DAIMOND_HAND_SCRATCH_DIR']) {
			fs.mkdirSync(env[k], { recursive: true });
		}
		const child = spawn(bin, [], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
		b.procs += 1;
		b.child = child;
		buf = Buffer.alloc(0);
		child.stdout.on('data', (d) => {
			buf = Buffer.concat([buf, d]);
			for (;;) {
				if (buf.length < 4) return;
				const n = LE ? buf.readUInt32LE(0) : buf.readUInt32BE(0);
				if (buf.length < 4 + n) return;
				const body = buf.subarray(4, 4 + n).toString('utf8');
				buf = buf.subarray(4 + n);
				let m;
				try { m = JSON.parse(body); } catch (e) { continue; }
				toPage(m);
			}
		});
		child.stderr.on('data', () => { /* the hand's own log; the checks read the wire */ });
		child.on('exit', () => {
			if (b.child === child) {
				b.child = null;
				chain = chain.then(() => page.evaluate(() => window.__handGone())).catch(() => {});
			}
		});
	};
	const write = (m) => {
		if (!b.child) return;
		const body = Buffer.from(JSON.stringify(m), 'utf8');
		const head = Buffer.alloc(4);
		if (LE) head.writeUInt32LE(body.length, 0); else head.writeUInt32BE(body.length, 0);
		try { b.child.stdin.write(Buffer.concat([head, body])); } catch (e) { /* gone */ }
	};
	b.fromPage = (raw) => {
		let m;
		try { m = JSON.parse(raw); } catch (e) { return; }
		if (m.t === '__connect') { if (b.child) b.child.kill('SIGKILL'); start(); return; }
		if (m.t === '__disconnect') { const c = b.child; b.child = null; if (c) c.kill('SIGKILL'); return; }
		b.sent.push(m);
		write(m);
		if (m.t === 'bye') { const c = b.child; setTimeout(() => { if (c) c.kill('SIGKILL'); }, 500); }
	};
	b.close = () => { const c = b.child; b.child = null; if (c) c.kill('SIGKILL'); };
	// The next link starts `next` instead, and this one's hand goes as a crashed one does: the
	// page is told the port died, and asks again when something needs the hand.
	b.swapTo = (next) => {
		bin = next;
		const c = b.child;
		if (c) c.kill('SIGKILL');
	};
	return b;
}

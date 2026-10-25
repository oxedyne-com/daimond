/* ============================================================
   Test -- a passkey enrolled before the recovery record (F3b M2).
   ------------------------------------------------------------
   A passkey enrolled before the `recover` record existed was never
   recorded, so every such device read "Not recoverable yet" and the
   offer enrolled a second credential. passkey.js `noteHeld` records
   it once, and only when the gateway really holds its sealed copy
   (the same test `addPasskey` relies on, `synced`).

   Drives the REAL passkey.js in a stand-in window, with the gateway
   and identity.js stood in.

   Run:  node www/js/recoverheld.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'passkey.js'), 'utf8');
let failures = 0, passes = 0;
function check(name, cond, detail) {
	const line = name + (detail !== undefined && detail !== '' ? ' — ' + detail : '');
	if (cond) { console.log('  ok   ' + line); passes++; }
	else { console.log('  FAIL ' + line); failures++; }
}

/// A page with `o.enrolled` (a passkey record here), `o.held` (the gateway holds its blob)
/// and `o.how` (what identity.js `recoverable` answers to begin with).
function load(o) {
	const m = new Map();
	if (o.enrolled) m.set('daimond-passkey', JSON.stringify({ v: 2, cred: 'AQIDBA', blob: 'sealed' }));
	const ls = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
	const got = { fetches: [], notes: [] };
	let how = o.how || '';
	const win = {
		localStorage: ls, crypto: webcrypto, TextEncoder, TextDecoder, btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
		atob: (s) => Buffer.from(s, 'base64').toString('binary'), console, navigator: {},
		fetch: async (url) => {
			got.fetches.push(url);
			if (o.offline) throw new Error('offline');
			return o.held
				? { ok: true, json: async () => ({ ok: true, blob: 'sealed' }) }
				: { ok: false, status: 404, json: async () => ({ ok: false }) };
		},
		DaimondIdentity: {
			exists: () => o.identity !== false,
			recoverable: () => how,
			noteRecovery: (k, on) => { got.notes.push([k, on]); if (k === 'passkey' && on) how = 'passkey'; return true; },
		},
	};
	win.window = win;
	new Function('window', 'with (window) {\n' + SRC + '\n}')(win);
	return { PK: win.DaimondPasskey, got };
}

async function main() {
	console.log('noteHeld: an earlier passkey is recorded once, and only when the gateway holds it');
	{
		const a = load({ enrolled: true, held: true });
		check('noteHeld is exported', a.PK && typeof a.PK.noteHeld === 'function');
		const r1 = a.PK.noteHeld ? await a.PK.noteHeld() : false;
		check('held: recorded as a way back', r1 === true && a.got.notes.length === 1
			&& a.got.notes[0][0] === 'passkey' && a.got.notes[0][1] === true, JSON.stringify(a.got.notes));
		check('the gateway was asked by the hashed handle', a.got.fetches.length === 1 && /\/api\/passkey-blob\?h=/.test(a.got.fetches[0]));
		if (a.PK.noteHeld) await a.PK.noteHeld();
		check('once: a second call asks and records nothing more', a.got.fetches.length === 1 && a.got.notes.length === 1);
	}
	{
		const b = load({ enrolled: true, held: false });
		const r = b.PK.noteHeld ? await b.PK.noteHeld() : null;
		check('not held: nothing recorded (never on an assumption)', r === false && b.got.notes.length === 0, JSON.stringify(b.got.notes));
	}
	{
		const c = load({ enrolled: true, held: true, offline: true });
		const r = c.PK.noteHeld ? await c.PK.noteHeld() : null;
		check('gateway unreachable: nothing recorded', r === false && c.got.notes.length === 0);
	}
	{
		const d = load({ enrolled: false, held: true });
		const r = d.PK.noteHeld ? await d.PK.noteHeld() : null;
		check('no passkey here: the gateway is not asked', r === false && d.got.fetches.length === 0);
	}
	{
		const e = load({ enrolled: true, held: true, how: 'passkey' });
		const r = e.PK.noteHeld ? await e.PK.noteHeld() : null;
		check('already recorded: not asked again', r === false && e.got.fetches.length === 0 && e.got.notes.length === 0);
	}
	{
		const f = load({ enrolled: true, held: true, identity: false });
		const r = f.PK.noteHeld ? await f.PK.noteHeld() : null;
		check('no identity: nothing to record', r === false && f.got.notes.length === 0);
	}
	console.log(`\n${passes} ok, ${failures} failed`);
	process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

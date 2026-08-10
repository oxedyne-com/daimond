// verify_fsnames.mjs — a name the workspace uses, and the name the filesystem will take.
//
// A Maildir message is called `<uid>.<uidvalidity>.daimond:2,<flags>`. The `:2,` is the Maildir
// standard's and the flags after it are what the mail panel matches on, so the colon is not ours to
// drop. It is also refused by every File System Access root except a modern browser's own sandbox —
// including the real local folder a user may have open, which is exactly where `mail/…` lands — and
// the refusal reached a user as:
//
//   OPFS: open/create file '70074.3.daimond:2,' failed: JsValue(TypeError: Failed to execute
//   'getFileHandle' on 'FileSystemDirectoryHandle': Name is not allowed.)
//
// THE STRICT ROOT IS STOOD IN FOR, and it has to be. Chromium 149 and 150 and Firefox 151 all
// ACCEPT that name in their sandbox: `FileSystemAccessManagerImpl::IsSafePathComponent` returns
// early for `storage::kFileSystemTypeTemporary`, testing only `.`, `..`, `/` and `\`. Every other
// root falls through to `base::i18n::IsFilenameLegal`, whose illegal set is the ICU pattern
// `[["*/:<>?\\|][:Cc:][:Cf:]]`. A picker cannot be driven headlessly, so the strict rule is put on
// the prototype instead — the same device by which verify_fsa stands an OPFS subdirectory in for a
// real folder, and the same one the user's own browser applies.
//
// The stand-in enforces the CHARACTER half of the strict rule and not its position-dependent half
// (a leading or trailing space, `.` or `~`). That is deliberate and matches src/fsname.rs: those
// are legal in every sandbox, `foo.txt~` is a name people have, and escaping them would move a file
// that is already on disk.
//
// Run with dev/serve.mjs up (DAIMOND_PORT, default 8777). No gateway, no mock model.
import { open, signInAs, shot } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const MAILDIR = 'mail/alice@test.local/INBOX/cur';
const MSG     = '70074.3.daimond:2,S';
const BODY    = 'From: a@b.test\r\nSubject: the colon stays\r\n\r\nbody\r\n';

const s = await open({ name: 'fsnames', connect: false });
const p = s.page;
await p.waitForTimeout(1500);

// ── The strict root, stood in for ───────────────────────────────────────
//
// Installed on the prototype, so the handles the wasm already holds are governed by it too.

const armed = await p.evaluate(() => {
	const P = FileSystemDirectoryHandle.prototype;
	if (P.__strictArmed) return 'already';
	const ILLEGAL = /["*\/:<>?\\|\x00-\x1F\x7F]/;
	const bad = (name) => {
		const n = String(name);
		return n === '' || n === '.' || n === '..' || ILLEGAL.test(n);
	};
	const guard = (fn, api) => function (name, ...rest) {
		if (bad(name)) {
			return Promise.reject(new TypeError(
				"Failed to execute '" + api + "' on 'FileSystemDirectoryHandle': Name is not allowed."));
		}
		return fn.call(this, name, ...rest);
	};
	P.getFileHandle      = guard(P.getFileHandle,      'getFileHandle');
	P.getDirectoryHandle = guard(P.getDirectoryHandle, 'getDirectoryHandle');
	P.removeEntry        = guard(P.removeEntry,        'removeEntry');
	P.__strictArmed = true;
	return 'armed';
});

// PROVE THE INSTRUMENT. A stand-in that does not bite turns every assertion below into a
// statement about a browser nobody has.
const instrument = await p.evaluate(async () => {
	const root = await navigator.storage.getDirectory();
	let refused = '', accepted = '';
	try { await root.getFileHandle('a:b', { create: true }); refused = '(accepted it!)'; }
	catch (e) { refused = String(e && e.message); }
	try { await root.getFileHandle('instrument.txt', { create: true }); accepted = 'ok'; }
	catch (e) { accepted = String(e && e.message); }
	return { refused, accepted };
});
check('the strict-root stand-in is armed', armed === 'armed', armed);
check('and it refuses a colon in the browser’s own words',
	/Name is not allowed/.test(instrument.refused), instrument.refused);
check('while an ordinary name still opens', instrument.accepted === 'ok', instrument.accepted);

// ── The defect: a Maildir message, through the door mail uses ───────────
//
// `DaimondApp.write_bytes` is the one door mail's `deps.writeBytes` goes through, so this is the
// user's path and not a path built for the test.

const wrote = await p.evaluate(async ({ dir, msg, body }) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	window.__fs = { mod, app };
	const bytes = new TextEncoder().encode(body);
	try { await app.write_bytes(dir + '/' + msg, bytes); return 'ok'; }
	catch (e) { return String((e && (e.message || e)) || e); }
}, { dir: MAILDIR, msg: MSG, body: BODY });
check('a Maildir message can be written at all', wrote === 'ok', wrote.slice(0, 200));

const readBack = await p.evaluate(async ({ dir, msg }) => {
	try {
		const b = await __fs.mod.read_bytes(dir + '/' + msg, 0, 4096);
		return new TextDecoder().decode(b);
	} catch (e) { return 'ERROR ' + String((e && (e.message || e)) || e); }
}, { dir: MAILDIR, msg: MSG });
check('and read back byte for byte', readBack === BODY, readBack.slice(0, 120).replace(/\r?\n/g, '⏎'));

// The listing is what mail matches flags on, so it has to give back the name the workspace used —
// not the name the browser stored.
const listed = await p.evaluate(async ({ dir }) => {
	try {
		const j = await __fs.app.run_tool('file_list', JSON.stringify({ path: dir }));
		return String(j);
	} catch (e) { return 'ERROR ' + String((e && (e.message || e)) || e); }
}, { dir: MAILDIR });
check('and listed under the name the workspace gave it, flags and all',
	listed.indexOf(MSG) > -1, listed.replace(/\s+/g, ' ').slice(0, 160));

// What actually landed on disk: a legal name, and exactly one file.
const onDisk = await p.evaluate(async ({ dir }) => {
	let d = await DaimondCloud.opfsRoot();
	for (const seg of dir.split('/')) d = await d.getDirectoryHandle(seg);
	const names = [];
	for await (const ent of d.entries()) names.push(ent[0]);
	return names;
}, { dir: MAILDIR });
check('one file on disk, under a name the strict root accepts',
	onDisk.length === 1 && !/[":*<>?\\|]/.test(onDisk[0]), JSON.stringify(onDisk));

// ── A store written before the codec existed ────────────────────────────
//
// The stand-in comes off: a sandbox that accepts a colon is where the legacy names actually are,
// and every user whose mail HAS been syncing has them. Nothing may move, and nothing may fork.

// A reload is a new realm, so the prototype it was put on goes with the old one.
await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'fsnames');
await p.waitForTimeout(1500);

const LEGACY_DIR = 'mail/bob@test.local/INBOX/cur';
const LEGACY     = '90001.7.daimond:2,';
const LEGACY_BODY = 'From: legacy@b.test\r\n\r\nwritten before the codec\r\n';

const seeded = await p.evaluate(async ({ dir, name, body }) => {
	let d = await DaimondCloud.opfsRoot();
	for (const seg of dir.split('/')) d = await d.getDirectoryHandle(seg, { create: true });
	try {
		const fh = await d.getFileHandle(name, { create: true });
		const w = await fh.createWritable();
		await w.write(new TextEncoder().encode(body));
		await w.close();
		return 'ok';
	} catch (e) { return String(e && e.message); }
}, { dir: LEGACY_DIR, name: LEGACY, body: LEGACY_BODY });
check('this sandbox can hold a legacy name at all, so the case is real',
	seeded === 'ok', seeded);

const legacyRead = await p.evaluate(async ({ dir, name }) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	window.__fs = { mod, app };
	try {
		const b = await mod.read_bytes(dir + '/' + name, 0, 4096);
		return new TextDecoder().decode(b);
	} catch (e) { return 'ERROR ' + String((e && (e.message || e)) || e); }
}, { dir: LEGACY_DIR, name: LEGACY });
check('a message stored before the codec is still readable, unmoved',
	legacyRead === LEGACY_BODY, legacyRead.slice(0, 90).replace(/\r?\n/g, '⏎'));

const legacyRewrite = await p.evaluate(async ({ dir, name }) => {
	const again = 'From: legacy@b.test\r\n\r\nrewritten in place\r\n';
	await __fs.app.write_bytes(dir + '/' + name, new TextEncoder().encode(again));
	let d = await DaimondCloud.opfsRoot();
	for (const seg of dir.split('/')) d = await d.getDirectoryHandle(seg);
	const names = [];
	for await (const ent of d.entries()) names.push(ent[0]);
	const b = await __fs.mod.read_bytes(dir + '/' + name, 0, 4096);
	return { names, text: new TextDecoder().decode(b) };
}, { dir: LEGACY_DIR, name: LEGACY });
check('and rewriting it keeps ONE file, at the name it already had',
	legacyRewrite.names.length === 1 && legacyRewrite.names[0] === LEGACY,
	JSON.stringify(legacyRewrite.names));
check('with the new bytes in it',
	/rewritten in place/.test(legacyRewrite.text), legacyRewrite.text.slice(0, 60).replace(/\r?\n/g, '⏎'));

// An ordinary name is byte-identical on disk, which is the whole of the no-migration claim.
const ordinary = await p.evaluate(async () => {
	const names = ['crystal.json', 'notes.txt', 'file%20name', 'foo.txt~', '100%', 'café.md'];
	for (const n of names) {
		await __fs.app.write_bytes('plainbox/' + n, new TextEncoder().encode('x'));
	}
	const d = await (await DaimondCloud.opfsRoot()).getDirectoryHandle('plainbox');
	const got = [];
	for await (const ent of d.entries()) got.push(ent[0]);
	return { want: names.slice().sort(), got: got.sort() };
});
check('an ordinary name is the same bytes on disk it always was',
	JSON.stringify(ordinary.want) === JSON.stringify(ordinary.got),
	JSON.stringify(ordinary.got));

// ── The two implementations of the codec agree ──────────────────────────
//
// There are two because the workspace walkers in daimond.js reach the browser's handles directly
// rather than through the wasm. Two that are never compared are two that will drift.

const codec = await p.evaluate(() => {
	const corpus = [
		'70074.3.daimond:2,', '70074.3.daimond:2,FRS', 'crystal.json', '.daimond',
		'file%20name', '100%', '%', '%%', '%25', '%3A', '%3a', 'a%3Ab', 'https%3A%2F%2Fe.com',
		'"', '*', '/', ':', '<', '>', '?', '\\', '|', 'a"b*c:d<e>f?g\\h|i',
		'', '.', '..', '...', 'é', '日本語.txt', 'Ω:Ω', 'foo.txt~', ' lead', 'trail ',
		'x'.repeat(255), 'x'.repeat(256),
	];
	for (let c = 0; c < 0x80; c++) {
		corpus.push(String.fromCharCode(c));
		corpus.push('a' + String.fromCharCode(c) + 'b');
	}
	const R = window.__fs.mod;
	const J = window.DaimondCloud;
	// Reported rather than thrown: a build without one of the two codecs is exactly the state
	// this check exists to name, and a thrown TypeError would take the whole run down with it.
	if (typeof R.fs_disk_name !== 'function') {
		return { n: 0, disagree: [['(the wasm exports no fs_disk_name)']], notRound: [], merged: [] };
	}
	if (!J || typeof J.diskName !== 'function') {
		return { n: 0, disagree: [['(cloud.js publishes no diskName)']], notRound: [], merged: [] };
	}
	const disagree = [], notRound = [], collide = new Map();
	for (const s of corpus) {
		const r = R.fs_disk_name(s), j = J.diskName(s);
		if (r !== j) disagree.push([s, r, j]);
		if (R.fs_logical_name(r) !== s || J.logicalName(j) !== s) notRound.push([s, r]);
		if (collide.has(r) && collide.get(r) !== s) collide.set(r, [collide.get(r), s]);
		else if (!collide.has(r)) collide.set(r, s);
	}
	const merged = [...collide.entries()].filter(([, v]) => Array.isArray(v));
	return {
		n: corpus.length,
		disagree: disagree.slice(0, 3),
		notRound: notRound.slice(0, 3),
		merged: merged.slice(0, 3),
	};
});
check('the Rust codec and the JavaScript one agree, name for name',
	codec.disagree.length === 0, codec.n + ' names · ' + JSON.stringify(codec.disagree));
check('and both are reversible over the same corpus',
	codec.notRound.length === 0, JSON.stringify(codec.notRound));
check('and no two names become one',
	codec.merged.length === 0, JSON.stringify(codec.merged));

await shot(s, 'fsnames');
const errs = s.errs.filter(e => !/favicon|404|401|net::ERR/.test(e));
console.log('\nconsole errors:', errs.slice(0, 4));
await s.close();

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);

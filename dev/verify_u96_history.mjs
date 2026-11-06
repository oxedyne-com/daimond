// gateway: own
// verify_u96_history.mjs — a diamond's name never changes unseen, and a rebuilt record never renames it (UNBLOCK-96).
//
// Two paired devices of one Pro account on a gateway of this run's own (the tree's binary), A and B, as
// `handoffpair.mjs` pairs them.
//
//   H  A renames diamond X through the rail (the person's door). B pulls. B's History of X holds exactly ONE
//      record-change row for the name: old → new, naming A's device, by "you" (writer "user"). B's rail shows
//      X under the new name, and so does X's daimon chat, which holds no name of its own.
//   R  On B, X's meta.json is deleted while X's version hold is held (by this run, as a turn end would hold
//      it), and B reads its diamonds, which rebuilds the record from the crystal under that hold. B is closed
//      and reopened. B's History of X holds the rebuild row; after a round each way, X's name is the new name
//      on both devices, and A's record of X is what it was in every field but `touched` (activity, which B's
//      join may move; the list sorts by it). Then the contract that matters: A renames X again, B then stamps
//      X with activity alone (so B's copy is the newer by `touched`, its name the older), B pushes, A pulls:
//      A keeps its name, and after A pushes, B takes it. The name is never decided by the touched clock. That
//      check is proved red by the engine's mutants (dev/u96_red.sh), not by a page break: the merge is the
//      wasm's.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE: `--break <name>` serves an edited page file to both devices,
// and the run must go red in that check's section WHERE THE UNBROKEN RUN ON THE SAME TREE WAS GREEN (lead
// ruling U96g): a check already red unbroken proves nothing about a break. The unbroken run leaves its
// results under SCRATCH, keyed by the tree (its www, src and dev, their uncommitted diff and the wasm it serves); a break run
// with none for this tree stops (exit 2).
//
//   --break twice     H  History reads every record change twice (two rows for one rename)
//   --break nodev     H  the row names no device
//   --break bysync    H  the row calls every change sync's
//   --break railname  H  the rail draws a diamond's name as it was first listed (the old name)
//   --break copyname  H  a daimon's chat copies its diamond's name when made, and shows its copy
//   --break norebuild R  History leaves out a rebuild's row
//   --break guess     R  a provisional record is read as the sender's edit (the base's merge)
//
// A break whose anchor does not match exactly once stops the run (exit 2).
//
//   eval "$(bash dev/world.sh N --env)"     # the world's ports; its gateway port must be free
//   node dev/verify_u96_history.mjs [--break twice] [--only H,R]
//   U96_BREAK=<name> dk arms <env> u96_history   # a break as a dk arms arm

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SCRATCH } from './harness.mjs';
import { GWBIN, requireFreshGateway, gatewayEnv } from './gwbin.mjs';
import { checker, settle, pair, reopen } from './handoffpair.mjs';
import { guardRan } from './verdict.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TREE = path.resolve(HERE, '..');
const WWW  = path.join(TREE, 'www');
const J    = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (f) => { const i = process.argv.indexOf(f); return (i >= 0 && process.argv[i + 1]) ? process.argv[i + 1] : ''; };

const PORT = Number(process.env.DAIMOND_PORT || 0), GW_PORT = Number(process.env.DAIMOND_GW_PORT || 0);
const MOCK_PORT = Number(process.env.DAIMOND_MOCK_PORT || 0), MOCK_LOG = process.env.DAIMOND_MOCK_LOG || '';
if (!PORT || !GW_PORT || !MOCK_PORT || !MOCK_LOG) {
	console.log('refusing to run: eval "$(bash dev/world.sh <N> --env)" first.');
	process.exit(2);
}

// ── Breaks ──────────────────────────────────────────────────────────────
const BREAKS = {
	twice: { section: 'H', what: 'History reads every record change twice', edits: [
		{ file: 'js/versions.js', from: "\t\treturn list.filter(function (m) { return m && m.field; })", to: "\t\tlist = list.concat(list);\n\t\treturn list.filter(function (m) { return m && m.field; })" }] },
	nodev: { section: 'H', what: 'the row names no device', edits: [
		{ file: 'js/page/crystal.js', from: '\t\tdevice: dev,\n', to: "\t\tdevice: '',\n" }] },
	bysync: { section: 'H', what: "every change is drawn as sync's", edits: [
		{ file: 'js/page/crystal.js', from: "by: t('versions.meta_by_' + (", to: "by: t('versions.meta_by_sync', (" }] },
	railname: { section: 'H', what: 'the rail keeps the name a diamond was first drawn with', edits: [
		{ file: 'js/page/agentspanel.js', from: '\tpaintDiamondName(name, f.name);            // text nodes only (H5)\n',
			to: '\twindow.__firstName = window.__firstName || {}; if (!(f.id in window.__firstName)) window.__firstName[f.id] = f.name;\n\tpaintDiamondName(name, window.__firstName[f.id]);\n' }] },
	copyname: { section: 'H', what: "a daimon's chat copies its diamond's name and shows the copy", edits: [
		{ file: 'js/page/diamonds.js', from: "\t\t\tname: '',                  // the Diamond's, read through `chatName`, never a copy\n",
			to: "\t\t\tname: f.name || '',\n" },
		{ file: 'js/page/tilestyle.js', from: '\tif (s.diamondId) {\n\t\tvar d = (pg.diamonds', to: '\tif (s.diamondId && !s.name) {\n\t\tvar d = (pg.diamonds' }] },
	norebuild: { section: 'R', what: "History leaves out a rebuild's row", edits: [
		{ file: 'js/versions.js', from: "return list.filter(function (m) { return m && m.field; })", to: "return list.filter(function (m) { return m && m.field && m.by !== 'rebuild'; })" }] },
	guess: { section: 'R', what: "a provisional record is merged as the sender's edit", edits: [
		{ file: 'js/page/parcel_collect.js', from: '\t\tif (meta.provisional === true) return null;\n', to: '' },
		{ file: 'js/page/parcel_apply.js', from: '\t\t\t\tif (mine && mine.provisional === true) { lf.tags = wf.tags.slice(); lf.name = wf.name; }\n', to: '' }] },
};
const BREAK = arg('--break') || process.env.U96_BREAK || '';	// U96_BREAK: the same break when dk arms runs it (it passes no args)
if (BREAK && !BREAKS[BREAK]) { console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`); process.exit(2); }
{
	const stale = [];
	// The named break's anchors only, so the run can be taken to a base whose files differ (UNBLOCK-96e).
	for (const [n, b] of Object.entries(BREAKS).filter(([n]) => n === BREAK)) {
		for (const e of b.edits) if (fs.readFileSync(path.join(WWW, e.file), 'utf8').split(e.from).length !== 2) stale.push(`${n} (${e.file})`);
	}
	if (stale.length) { console.error('break anchor(s) no longer match exactly once: ' + stale.join(', ')); process.exit(2); }
}
const ONLY = new Set((arg('--only') || 'H,R').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));
const ROUTE = !BREAK ? null : async (page) => {
	const byFile = {};
	for (const e of BREAKS[BREAK].edits) (byFile[e.file] = byFile[e.file] || []).push(e);
	for (const [file, edits] of Object.entries(byFile)) {
		let body = fs.readFileSync(path.join(WWW, file), 'utf8');
		for (const e of edits) body = body.replace(e.from, () => e.to);
		await page.route('**/' + file + '*', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body }));
	}
};
// ── The unbroken run on this tree, which a break is judged against ──
function treeKey() {
	const h = crypto.createHash('sha256');
	// What is served and run, not HEAD: a note committed beside them changes no result.
	h.update(execFileSync('git', ['rev-parse', 'HEAD:www', 'HEAD:src', 'HEAD:dev'], { cwd: TREE }));
	h.update(execFileSync('git', ['diff', 'HEAD', '--', 'www', 'src', 'dev'], { cwd: TREE, maxBuffer: 1 << 28 }));
	const wasm = path.join(WWW, 'pkg/oxedyne_daimond_bg.wasm');
	h.update(fs.existsSync(wasm) ? fs.readFileSync(wasm) : Buffer.alloc(0));
	return h.digest('hex').slice(0, 16);
}
const UNBROKEN = path.join(SCRATCH, 'verify_u96_history', 'unbroken-' + treeKey() + '.json');
let unbroken = null;
if (BREAK) {
	try { unbroken = JSON.parse(fs.readFileSync(UNBROKEN, 'utf8')); }
	catch (e) { console.error(`no unbroken run on this tree (${UNBROKEN}): run without a break first`); process.exit(2); }
	if (!unbroken.sections || !unbroken.sections[BREAKS[BREAK].section]) {
		console.error(`the unbroken run on this tree did not run section ${BREAKS[BREAK].section}`); process.exit(2);
	}
}
if (BREAK) console.log(`\n*** BREAK ${BREAK}: ${BREAKS[BREAK].what} — failures below are the point ***\n`);

// ── The stack: this run's own gateway; the world's app server and mock, or its own ──
const RUN = Date.now().toString(36);
const ROOT = path.join(SCRATCH, 'verify_u96_history', RUN);
fs.mkdirSync(ROOT, { recursive: true });
const KIDS = new Set();
function child(cmd, args, opts, label) {
	const out = fs.openSync(path.join(ROOT, label + '.out'), 'a');
	const c = spawn(cmd, args, Object.assign({ stdio: ['ignore', out, out] }, opts));
	KIDS.add(c); c.on('exit', () => KIDS.delete(c));
	return c;
}
const killAll = () => { for (const c of KIDS) { try { c.kill('SIGTERM'); } catch (e) { /* gone */ } } };
process.on('exit', killAll);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { killAll(); process.exit(130); });
const listening = (port) => new Promise((res) => {
	const s = net.connect(port, '127.0.0.1');
	s.once('connect', () => { s.destroy(); res(true); });
	s.once('error', () => res(false));
});
async function waitPort(port, ms = 30000) {
	for (const t0 = Date.now(); Date.now() - t0 < ms; ) { if (await listening(port)) return true; await sleep(200); }
	return false;
}
async function stack() {
	if (await listening(GW_PORT)) throw new Error('port ' + GW_PORT + ' is taken: this verifier starts its own gateway there');
	const appUp = await listening(PORT), mockUp = await listening(MOCK_PORT);
	if (appUp) {
		const served = await fetch(`http://127.0.0.1:${PORT}/js/daimond.js`).then((r) => r.text()).catch(() => '');
		if (served !== fs.readFileSync(path.join(TREE, 'www/js/daimond.js'), 'utf8')) throw new Error('the app server on ' + PORT + ' is not serving this tree (' + TREE + ')');
	}
	const cwd = path.join(ROOT, 'gwcwd');
	fs.mkdirSync(cwd, { recursive: true });
	execFileSync('bash', ['dev/devgw.sh'], { cwd: TREE, env: Object.assign({}, process.env, { DAIMOND_GW_PORT: String(GW_PORT) }) });
	fs.copyFileSync(path.join(TREE, 'dev/devgw/app.jdat'), path.join(cwd, 'app.jdat'));
	fs.symlinkSync(fs.realpathSync(path.join(TREE, 'gateway/keys')), path.join(cwd, 'keys'));
	child(GWBIN, [], { cwd, env: gatewayEnv({ APP_MODE: 'sandbox' }) }, 'gateway');
	fs.writeFileSync(MOCK_LOG, '');
	if (!mockUp) child('node', ['dev/mockllm.mjs', String(MOCK_PORT)], { cwd: TREE, env: Object.assign({}, process.env, { DAIMOND_MOCK_LOG: MOCK_LOG }) }, 'mock');
	if (!appUp) child('node', ['dev/serve.mjs'], { cwd: TREE, env: Object.assign({}, process.env, { DAIMOND_PORT: String(PORT), DAIMOND_GW_PORT: String(GW_PORT) }) }, 'serve');
	let up = false;
	for (let i = 0; i < 60 && !up; i++) {
		try { up = (await fetch(`http://127.0.0.1:${GW_PORT}/api/health`)).ok; } catch (e) { /* not yet */ }
		if (!up) await sleep(500);
	}
	if (!up || !(await waitPort(MOCK_PORT)) || !(await waitPort(PORT))) throw new Error('the stack did not come up (' + ROOT + ')');
}

// ── Reading and driving a device ────────────────────────────────────────
const push = async (s) => { await s.page.evaluate(() => (window.DaimondSync.flush ? window.DaimondSync.flush() : window.DaimondSync.push())).catch(() => {}); await settle(s.page); };
const pull = async (s) => { await s.page.evaluate(() => window.DaimondSync.pull()).catch(() => {}); await settle(s.page); };
async function carry(from, to, pred, ms = 90000) {
	for (const t0 = Date.now(); Date.now() - t0 < ms; ) {
		await push(from); await pull(to);
		if (await pred()) return true;
		await sleep(1200);
	}
	return false;
}
/// The store's own list of diamonds on `s`, by id: `{ name, touched, updated, provisional }`.
const listed = (s) => s.page.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	const out = {};
	for (const d of JSON.parse(await app.list_diamonds())) out[d.id] = { name: d.name, touched: d.touched, updated: d.updated, provisional: !!d.provisional };
	return out;
}).catch((e) => ({ error: String(e) }));
/// The name the rail draws for diamond `id` on `s`, '' where it draws none.
const railName = (s, id) => s.page.evaluate((id) => {
	const b = document.querySelector('#diamond-list .diamond-box[data-id="' + id + '"] .session-box-name');
	return b ? b.textContent.trim() : '';
}, id).catch(() => '');
/// Open diamond `id` on `s` through its rail row.
async function openDiamond(s, id) {
	await s.page.evaluate((id) => { const b = document.querySelector('#diamond-list .diamond-box[data-id="' + id + '"]'); if (b) b.click(); }, id);
	await s.page.waitForFunction((id) => { const d = window.DaimondDiamond.current(); return !!d && d.id === id; }, id, { timeout: 15000 }).catch(() => {});
	await sleep(800);
}
/// The name `s` shows over diamond `id`'s daimon chat, opened as a person opens it.
async function daimonChatName(s, id) {
	await openDiamond(s, id);
	await s.page.evaluate(() => { const c = document.getElementById('dview-chat'); if (c) c.click(); });
	await sleep(800);
	return s.page.evaluate((id) => {
		const r = window.DaimondDiamond.conversation(id);
		const el = document.getElementById('current-session-name');
		return { shown: el ? el.textContent.trim() : '', stored: r ? String(r.name || '') : '(no record)' };
	}, id).catch((e) => ({ shown: '', stored: String(e) }));
}
/// The record-change rows `s` draws in diamond `id`'s History, as text.
async function historyRows(s, id) {
	await openDiamond(s, id);
	await s.page.evaluate(() => { const c = document.getElementById('dview-crystal'); if (c) c.click(); });
	await sleep(600);
	await s.page.evaluate(() => {
		const want = window.DaimondI18n ? DaimondI18n.t('crystal.history') : 'History';
		const b = [...document.querySelectorAll('button.crystal-act')].find((x) => x.textContent.trim() === want);
		if (b) b.click();
	});
	await s.page.waitForSelector('.hist-list', { timeout: 15000 }).catch(() => {});
	await sleep(800);
	return s.page.evaluate(() => [...document.querySelectorAll('.hist-list .hist-row.hist-meta')].map((r) => ({
		kind: (r.querySelector('.hist-kind') || {}).textContent || '', note: (r.querySelector('.hist-note') || {}).textContent || '' }))).catch(() => []);
}
/// What the page calls `who` in a row: `versions.meta_by_<who>`.
const byWord = (s, who) => s.page.evaluate((k) => window.DaimondI18n ? DaimondI18n.t(k) : k, 'versions.meta_by_' + who);
/// Run `fn(dir)` in `s`'s page over the OPFS directory `diamonds/<id>`, wherever the account's root puts it.
const inDiamondDir = (s, id, body) => s.page.evaluate(async ({ id, body }) => {
	const find = async (dir, depth) => {
		try { const d = await dir.getDirectoryHandle('diamonds'); return await d.getDirectoryHandle(id); } catch (e) { /* not here */ }
		if (depth <= 0) return null;
		for await (const [, h] of dir.entries()) if (h.kind === 'directory') { const f = await find(h, depth - 1); if (f) return f; }
		return null;
	};
	const dir = await find(await navigator.storage.getDirectory(), 3);
	if (!dir) return { error: 'no diamonds/' + id + ' in this origin' };
	return (new Function('dir', 'return (async () => {' + body + '})()'))(dir);
}, { id, body });

// ── The run ─────────────────────────────────────────────────────────────
const { ok, bad, check } = checker();
const sections = {};
async function section(name, fn) {
	if (!ONLY.has(name)) return;
	console.log(`\n── ${name} ──`);
	const n0 = ok.length, f0 = bad.length;
	try { await fn(); }
	catch (e) { check(`${name}: threw: ${String((e && e.stack) || e).split('\n').slice(0, 2).join(' | ')}`, false, ''); }
	sections[name] = { ok: ok.length - n0, bad: bad.length - f0, badNames: bad.slice(f0), okNames: ok.slice(n0) };
}

let a, b, idA = '', X = '', OLD = '', NEW = '';
try {
	requireFreshGateway();
	await stack();
	console.log(`verify_u96_history: tree ${TREE}, run ${RUN}, break=${BREAK || 'none'}`);
	const acct = 'u96h' + RUN;
	({ a, b, idA } = await pair(check, acct, acct + 'desk', { route: ROUTE, nominate: false }));

	// Set-up: diamond X made on A and carried to B under its first name.
	OLD = 'Fred Hoogland ' + RUN; NEW = 'Hoogland stories ' + RUN;
	X = await a.page.evaluate((n) => window.DaimondDiamond.create(n), OLD);
	check('set-up: A made diamond X', !!X, J(X));
	await a.page.evaluate((id) => { const r = window.DaimondDiamond.conversation(id); return !!r; }, X);	// its daimon chat
	// X's crystal carries a heading, as any diamond worked in does: a lost record is rebuilt from it (R).
	// A diamond made a moment ago holds an empty crystal.json, which nothing can be rebuilt from.
	const wroteC = await a.page.evaluate(async ({ id, title }) => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		await app.run_tool('file_write', JSON.stringify({ path: 'diamonds/' + id + '/crystal.json', content: JSON.stringify({ title, sections: [] }) }));
		return true;
	}, { id: X, title: OLD }).catch((e) => String(e));
	check('set-up: X\'s crystal on A has its heading', wroteC === true, J(wroteC));
	const gotX = await carry(a, b, async () => ((await listed(b))[X] || {}).name === OLD);
	check('set-up: X reaches B under its first name', gotX, J((await listed(b))[X] || null));
	const crystalB = async () => inDiamondDir(b, X, "const f = await dir.getFileHandle('crystal.json'); return await (await f.getFile()).text();").catch(() => '');
	let cB = ''; for (let i = 0; i < 20 && !String(cB).includes(OLD); i++) { await push(a); await pull(b); cB = await crystalB(); if (!String(cB).includes(OLD)) await sleep(1000); }
	check('set-up: X\'s crystal reaches B with its heading', String(cB).includes(OLD), J(String(cB).slice(0, 120)));
	if (!gotX) throw new Error('B never received X');
	await openDiamond(b, X);

	await section('H', async () => {
		// The person's door: a double-click on the rail's name, the dialog, OK.
		await a.page.evaluate((id) => {
			const n = document.querySelector('#diamond-list .diamond-box[data-id="' + id + '"] .session-box-name');
			if (n) n.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		}, X);
		await a.page.waitForSelector('.dlg-card input.dlg-input', { timeout: 8000 }).catch(() => {});
		await a.page.evaluate((nm) => {
			const c = [...document.querySelectorAll('.dlg-card')].filter((x) => x.querySelector('input.dlg-input')).pop();
			if (!c) return;
			const i = c.querySelector('input.dlg-input'); i.value = nm; i.dispatchEvent(new Event('input', { bubbles: true }));
			c.querySelector('.dlg-ok').click();
		}, NEW);
		await sleep(1500);
		check('H: A holds the new name', ((await listed(a))[X] || {}).name === NEW, J((await listed(a))[X] || null));
		const got = await carry(a, b, async () => ((await listed(b))[X] || {}).name === NEW);
		check('H: B pulls the new name', got, J((await listed(b))[X] || null));
		await sleep(1000);
		const rows = (await historyRows(b, X)).filter((r) => r.note.includes(NEW));
		const devA = await b.page.evaluate((id) => { try { return window.DaimondPresence && DaimondPresence.name ? DaimondPresence.name(id) || '' : ''; } catch (e) { return ''; } }, idA);
		const you = await byWord(b, 'user');
		console.log('  B History rows naming the new name: ' + J(rows) + ' (A is "' + devA + '", id ' + idA + ')');
		check('H: B\'s History holds exactly one row for the rename', rows.length === 1, rows.length + ' row(s)');
		const r = rows[0] || { note: '' };
		check('H: the row says old → new', r.note.includes(OLD) && r.note.includes(NEW), r.note);
		check('H: the row names A\'s device', !!(devA || idA) && (r.note.includes(devA || idA) || r.note.includes(idA)), r.note);
		check('H: the row\'s writer is the person ("' + you + '")', new RegExp('\\b' + you + '\\b').test(r.note.replace(NEW, '').replace(OLD, '')), r.note);
		check('H: B\'s rail shows X under the new name', (await railName(b, X)) === NEW, J(await railName(b, X)));
		const dc = await daimonChatName(b, X);
		check('H: B shows X\'s daimon chat under the new name', dc.shown === NEW, J(dc));
	});

	await section('R', async () => {
		const aBefore = await inDiamondDir(a, X, "const f = await (await dir.getDirectoryHandle('.daimond')).getFileHandle('meta.json'); return await (await f.getFile()).text();");
		// B: X's version hold held, as a turn end holds it; meta.json goes; B reads its diamonds.
		await b.page.evaluate((id) => new Promise((granted) => {
			navigator.locks.request('daimond-version-' + id, { mode: 'exclusive' }, () => new Promise((release) => { window.__u96release = release; granted(true); }));
		}), X);
		const gone = await inDiamondDir(b, X, "await (await dir.getDirectoryHandle('.daimond')).removeEntry('meta.json'); return 'gone';");
		check('R: B\'s meta.json of X is deleted under the hold', gone === 'gone', J(gone));
		const rebuilt = (await listed(b))[X] || null;
		check('R: B rebuilds X\'s record from its crystal, provisional', !!rebuilt && rebuilt.provisional === true, J(rebuilt));
		const waits = await inDiamondDir(b, X, "const out = []; try { const w = await (await dir.getDirectoryHandle('versions')).getDirectoryHandle('metawait'); for await (const [n] of w.entries()) out.push(n); } catch (e) { /* none */ } return out;");
		console.log('  B waiting record changes under the hold: ' + J(waits));
		// B closes with the hold (the lock goes with the page), and reopens.
		await b.close().catch(() => {});
		b = await reopen(b);
		await sleep(2000);
		const rows = await historyRows(b, X);
		const rb = await byWord(b, 'rebuild');
		console.log('  B History rows after reopening: ' + J(rows));
		check('R: B\'s History holds the rebuild row', rows.some((r) => r.note.includes(rb)), J(rows.map((r) => r.note)));
		// A round each way: B's guess must not reach A as the newer copy, and B must come back to the real name.
		for (let i = 0; i < 3; i++) { await push(b); await pull(a); await push(a); await pull(b); await sleep(1000); }
		const la = (await listed(a))[X] || {}, lb = (await listed(b))[X] || {};
		check('R: A still names X with the new name', la.name === NEW, J(la));
		check('R: B names X with the new name', lb.name === NEW, J(lb));
		check('R: B\'s rail shows the new name', (await railName(b, X)) === NEW, J(await railName(b, X)));
		const aAfter = await inDiamondDir(a, X, "const f = await (await dir.getDirectoryHandle('.daimond')).getFileHandle('meta.json'); return await (await f.getFile()).text();");
		const butTouched = (t) => { try { const m = JSON.parse(t); delete m.touched; return J(m); } catch (e) { return '(unreadable) ' + t; } };
		check('R: nothing of B\'s guess reached A (A\'s record, every field but touched)', typeof aBefore === 'string' && butTouched(aBefore) === butTouched(aAfter), J({ before: aBefore, after: aAfter }));
		// THE NAME IS NOT DECIDED BY THE TOUCHED CLOCK: A renames, then B moves X by activity alone.
		const NEW2 = NEW + ' again';
		const wasm = (s, fn, ...args) => s.page.evaluate(async ({ fn, args }) => {
			const mod = await import('../pkg/oxedyne_daimond.js');
			if (fn === 'touch_diamond') return mod.touch_diamond(...args);
			const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
			return app[fn](...args);
		}, { fn, args }).then(() => '', (e) => String(e));
		check('R: A renames X again', (await wasm(a, 'rename_diamond', X, NEW2, 'user')) === '' && ((await listed(a))[X] || {}).name === NEW2, J((await listed(a))[X] || null));
		await sleep(50);
		check('R: B stamps X by activity alone', (await wasm(b, 'touch_diamond', X)) === '', '');
		const ta = ((await listed(a))[X] || {}).touched || 0, tb = ((await listed(b))[X] || {}).touched || 0;
		check('R: B\'s copy is the newer by touched, its name the older', tb > ta && ((await listed(b))[X] || {}).name === NEW, J({ ta, tb, b: (await listed(b))[X] || null }));
		await push(b); await pull(a);
		check('R: A keeps its later name over B\'s fresher-touched copy', ((await listed(a))[X] || {}).name === NEW2, J((await listed(a))[X] || null));
		const back = await carry(a, b, async () => ((await listed(b))[X] || {}).name === NEW2);
		check('R: B takes A\'s later name', back, J((await listed(b))[X] || null));
		check('R: A still names X with its later name', ((await listed(a))[X] || {}).name === NEW2, J((await listed(a))[X] || null));
	});
} catch (e) {
	check('the run finished without throwing', false, String((e && e.stack) || e).slice(0, 700));
} finally {
	await a?.close().catch(() => {});
	await b?.close().catch(() => {});
	killAll();
}

console.log('\nsections: ' + Object.entries(sections).map(([n, v]) => `${n} ${v.ok} ok/${v.bad} failed`).join(', '));
if (BREAK) {
	const want = BREAKS[BREAK].section;
	const red = Object.entries(sections).filter(([, v]) => v.bad > 0).map(([n]) => n);
	const was = new Set(unbroken.sections[want].okNames || []);
	const bit = ((sections[want] || {}).badNames || []).filter((n) => was.has(n));
	const as = bit.length > 0;
	console.log(`\nbreak '${BREAK}': red in ${red.length ? red.join(', ') : 'NOTHING'}; wanted ${want}; green unbroken, red broken: ${bit.length ? J(bit) : 'NONE'}`
		+ ` — ${as ? 'BITES' : 'DOES NOT BITE: nothing it aims at moved from the unbroken run, so the checks prove nothing'}`);
	process.exit(as ? 0 : 1);
}
fs.writeFileSync(UNBROKEN, J({ at: new Date().toISOString(), tree: TREE, sections }));
console.log('unbroken results for this tree: ' + UNBROKEN);
guardRan(ok.length + bad.length);
console.log(`\nverify_u96_history: ${ok.length} ok, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);

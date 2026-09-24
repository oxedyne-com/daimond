// verify_markshere.mjs — a mark grants on this device only where the synced row AND this
// device's own record of what was pressed on it both allow it (R2, and R3's remainder).
//
// ── WHY ──────────────────────────────────────────────────────────────────────
//
// A mark is a row in a Diamond's link sidecar, or a holding on a chat record, and both travel
// whole in the sync parcel. Until R2 a row that said `by:"user"` -- and, for a machine folder,
// named this device -- was a grant here, so anything that could write those bytes could write a
// grant: another device on an older bundle, a replayed export, a forged parcel, a pre-R3 row whose
// note said `share`. The re-check of 2026-09-23 (`specs/daimond_bc2_recheck_20260923.md`, R2 and
// R3) drove exactly that, and `specs/daimond_signed_marks_design_20260923.md` is the design: the
// grant here is the intersection of the row and `daimond-marks-here`, which never syncs and is
// written only by a press here. A removal or a narrowing travels; a widening never does.
//
// ── WHAT IT ASSERTS (the design's proof plan, verifier form) ─────────────────
//
//   A. The browser workspace, which the phone always has open.
//      P1  a forged `by:"user"`, `share:true` row, written by export -> import, is waiting and
//          not attached; the notice lists it. Control: Use here brings it into force.
//      P3  a chat record in a parcel, with a newer `metaAt`, claiming a workspace mark and a Read:
//          nothing in the chat's scope, nothing quoted into the composer, the notice lists both.
//          Control: the notice's press brings both into force.
//      P5  a removal made here (the Workspace panel's ◈), then a replay of the export taken
//          before it: the row comes back waiting. Every removal door goes through one helper.
//      P7  the record lost: every mark waits, the notice says there is no record here, and
//          "Use all here" restores them.
//      P9  the grid: rows (user, legacy, agent, fold, wrong owner, wrong `from`, the other root,
//          a duplicate, an ancestor) x entry states (none, pressed, narrower, other root), and
//          every reader -- `attached`, `read_only`, `unconfirmed`, the share roots, the ⇄, the
//          composer's prefix, a chat's scope -- agrees with the design's rule in every cell.
//      F7  (QA 2026-09-24) the × on a chat holding that waits here takes it off and grants
//          nothing, and no × in the page reaches the paperclip's toggle or a confirmation.
//      F1  (QA 2026-09-24) a backup restored through the account menu whose copy of a sidecar
//          has lost one mark and narrowed another drops and narrows this device's entries;
//          the old rows, replayed after it, wait and stay narrow. A mark it kept stays in force.
//   B. A machine folder (an OPFS subdirectory stands in, reconnected at boot).
//      P1b the forged row naming this device; P1c the same in a newer parcel through
//          `applySync`; P2 a pre-R3 `note:"share"` row, and a forged `share:true` over a mark
//          confirmed here unshared; P4 a replay of the shared row after ⇄ off; P4b share off
//          arriving, then the old shared row arriving; P5b a removal arriving, then the row
//          back; P8 a confirmation writes no row and moves no stamp; P3 the chat route naming
//          this device; P7 the lost record again, where a shared folder stays unshared after
//          "Use all here" until its own ⇄; and P9's grid in this root.
//
// The rule every P9 cell is judged against is written out below from the design's text (`rule`),
// not read from the module, so a reader that agrees with a wrong module still fails. The checks
// are made on behaviour -- `DaimondDiamond.bounds`, `DaimondCore.syncFolderShare`, the notice, the
// Workspace panel, the composer, `DaimondAttach.chatScope`, the sidecar's bytes and the Diamond's
// stamp -- so a run against the base (124ef8d0) fails on the property and not on a missing
// global. Checks marked `route` are the design's routes, which fail at the base; the others are
// controls. The count line says how many of each held.
//
// Needs a world for the app and the mock provider: `eval "$(bash dev/world.sh N --env)"`.
import fs from 'node:fs';
import { open, signInAs, connectMock, newChat, errors, scratch } from './harness.mjs';

const ok = [], bad = [];
const tally = { route: [0, 0], control: [0, 0] };
const check = (name, pass, detail, kind = 'route') => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	tally[kind][pass ? 0 : 1]++;
	console.log((pass ? '  ok   ' : '  FAIL ') + (kind === 'control' ? '[ctl] ' : '') + name
		+ (detail ? ' — ' + String(detail).slice(0, 400) : ''));
};
const control = (name, pass, detail) => check(name, pass, detail, 'control');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FOLDER = 'markshere-folder';
const OTHER  = 'fedcba9876543210';      // another device's id, as a mark made there names it
const KEY    = 'daimond-marks-here';    // the record's key, written here to remove and seed it
// Another machine folder, as the record keys one since M2: a name and this device's id for it.
const ELSEWHERE = 'machine:elsewhere#' + 'e'.repeat(32);
const BODY   = 'MARKSHERE-READ-BODY-7f3a';

let step = 'boot';
const s = await open({ name: 'markshere', connect: false, defaults: false,
	route: async (page) => {
		page.setDefaultNavigationTimeout(180000);
		page.on('pageerror', (e) => console.log('  note  page error during "' + step + '": '
			+ String((e && (e.stack || e.message)) || e).split('\n').slice(0, 4).join(' | ')));
	} });
const p = s.page;
// Under load the Settings form can miss its first fill; the mock is only needed for a chat to
// start at all, so a second try is cheaper than a lost run.
for (let i = 0; i < 3; i++) {
	try { await connectMock(s); break; }
	catch (e) { console.log('  note  connectMock try ' + (i + 1) + ': ' + String(e.message || e).slice(0, 160)); await sleep(2000); }
}

// ── Page helpers, installed again after every reload ─────────────────────────
const install = () => p.evaluate(() => {
	const app = () => DaimondCore.diamondApp();
	const side = (exp) => Object.keys(exp.files || {}).find((k) => /\.daimond\/links\.jsonl$/.test(k));
	const H = window.__mh = {
		async refresh() {
			await DaimondCore.loadDiamonds();
			document.dispatchEvent(new CustomEvent('daimond-links-changed'));
			if (DaimondCore.syncClearWalkCache) DaimondCore.syncClearWalkCache();
			await new Promise((r) => setTimeout(r, 250));
		},
		async create(name) { const id = await app().create_diamond(name); await H.refresh(); return id; },
		async stamp(id) { return (JSON.parse(await app().list_diamonds()).find((d) => d.id === id) || {}).touched; },
		async sidecar(id) { const e = JSON.parse(await app().export_diamond(id)); const k = side(e); return k ? String(e.files[k] || '') : ''; },
		async rows(id) { return JSON.parse(await app().links_touching('diamond:' + id) || '[]').filter((l) => l.owner === id); },
		// Append raw rows to a Diamond's sidecar the way the re-check did: export, edit, import.
		async forge(id, rows) {
			const e = JSON.parse(await app().export_diamond(id));
			const k = side(e) || '.daimond/links.jsonl';
			e.files = e.files || {};
			e.files[k] = String(e.files[k] || '') + rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
			await app().import_diamond(JSON.stringify(e), false);
			await H.refresh();
		},
		// A change to rows, as data: `{ set: { <id>: {fields} }, drop: [ids], add: [rows] }`.
		patch(rows, x) {
			const set = (x && x.set) || {}, drop = (x && x.drop) || [];
			return rows.filter((r) => drop.indexOf(r.id) < 0)
				.map((r) => set[r.id] ? Object.assign({}, r, set[r.id]) : r)
				.concat((x && x.add) || []);
		},
		async editRows(id, x) {
			const e = JSON.parse(await app().export_diamond(id));
			const k = side(e);
			const rows = String(e.files[k] || '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
			e.files[k] = H.patch(rows, x).map((r) => JSON.stringify(r)).join('\n') + '\n';
			await app().import_diamond(JSON.stringify(e), false);
			await H.refresh();
		},
		async exportOf(id) { return app().export_diamond(id); },
		async importOf(text) { await app().import_diamond(text, false); await H.refresh(); },
		// A parcel carrying this Diamond with its rows edited and the stamp given.
		async parcel(id, T, x) {
			const e = JSON.parse(await app().export_diamond(id));
			const k = side(e);
			const rows = String(e.files[k] || '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
			e.files[k] = H.patch(rows, x).map((r) => JSON.stringify(r)).join('\n') + '\n';
			return { diamonds: [{ id: id, touched: T, updated: T, data: JSON.stringify(e) }] };
		},
		async apply(parcel) { await DaimondCore.applySync(parcel); await H.refresh(); },
		async add(id, ref, rel, by, share) {
			const lid = share ? await app().add_link(id, 'diamond:' + id, ref, rel || 'holds', '', by, true)
				: await app().add_link(id, 'diamond:' + id, ref, rel || 'holds', '', by);
			await H.refresh();
			return lid;
		},
		async bounds(id) {
			const b = await DaimondDiamond.bounds(id);
			return { at: (b.attached || []).slice().sort(), ro: (b.read_only || []).slice().sort(),
				un: (b.unconfirmed || []).slice().sort() };
		},
		// What sync writes into and deletes from on another device's word. The build publishes
		// `DaimondFiles.shareRoots`; the base does not, and with a folder open the census's own
		// `flagged` is the same list, so a base run measures the same thing.
		async shared() {
			if (DaimondCore.syncClearWalkCache) DaimondCore.syncClearWalkCache();
			if (window.DaimondFiles && DaimondFiles.shareRoots) return (await DaimondFiles.shareRoots()).slice().sort();
			// With no folder open there is nothing to measure; with one open and nothing
			// flagged the census has no plan, and says `folder: false`, and nothing is shared.
			if ((await import('/pkg/oxedyne_daimond.js')).workspace_mode() !== 'folder') return null;
			const sh = await DaimondCore.syncFolderShare();
			return (sh.flagged || []).slice().sort();
		},
		// The user's press on a mark: the notice's Use here where it lists the mark, and the
		// same confirmation through the page's own door where it does not.
		async useHere(id, ref) { return DaimondAttach.confirmHere(id, ref); },
		ref(kind, path) { return DaimondAttach.ref(kind, path); },
		dev() { return (window.DaimondIdentity && DaimondIdentity.deviceId && DaimondIdentity.deviceId()) || ''; },
		// The record, read and written raw: to lose it (P7) and to seed an entry no door
		// would write (P9). The base reads nothing here, so the seeding is inert there.
		recRaw() { try { return localStorage.getItem(H.recKey()); } catch (e) { return null; } },
		recKey() {
			let pre = '';
			try { if (window.DaimondAccounts && DaimondAccounts.prefix) pre = DaimondAccounts.prefix() || ''; } catch (e) { /* none */ }
			return pre + 'daimond-marks-here';
		},
		recDrop() { try { localStorage.removeItem(H.recKey()); } catch (e) { /* blocked */ } },
		recSeed(owner, entries) {
			let rec = null;
			try { rec = JSON.parse(localStorage.getItem(H.recKey()) || 'null'); } catch (e) { rec = null; }
			if (!rec || rec.v !== 1) rec = { v: 1, d: {}, c: {} };
			rec.d = rec.d || {};
			rec.d[owner] = (rec.d[owner] || []).filter((x) => !entries.some((e) => e.id === x.id && e.to === x.to && e.root === x.root))
				.concat(entries);
			localStorage.setItem(H.recKey(), JSON.stringify(rec));
		},
		recSeedChat(chatId, entries) {
			let rec = null;
			try { rec = JSON.parse(localStorage.getItem(H.recKey()) || 'null'); } catch (e) { rec = null; }
			if (!rec || rec.v !== 1) rec = { v: 1, d: {}, c: {} };
			rec.c = rec.c || {};
			rec.c[chatId] = (rec.c[chatId] || []).concat(entries);
			localStorage.setItem(H.recKey(), JSON.stringify(rec));
		},
		recEntries(owner) {
			try { const r = JSON.parse(localStorage.getItem(H.recKey()) || 'null'); return (r && r.d && r.d[owner]) || []; }
			catch (e) { return []; }
		},
		// A chat record as the store holds it, and the same record arriving in a parcel with a
		// newer `metaAt` carrying the holdings given.
		chatRec(cid) { return (DaimondCore.chatStore().stored() || []).find((c) => c.id === cid) || null; },
		async chatParcel(cid, holds) {
			const rec = JSON.parse(JSON.stringify(H.chatRec(cid)));
			const now = Date.now() + 60000;
			rec.holds = holds; rec.metaAt = now; rec.updatedAt = Math.max(rec.updatedAt || 0, now);
			await DaimondCore.applySync({ chats: [rec] });
			await new Promise((r) => setTimeout(r, 400));
			if (DaimondAttach.render) try { DaimondAttach.render(); } catch (e) { /* not drawn */ }
		},
		async composer() {
			const box = document.getElementById('chat-input');
			if (!box) return null;
			box.value = '';
			await DaimondAttach.syncPrefix();
			return box.value;
		},
	};
	return true;
});

/// The notice over the composer, as it is drawn.
const notice = () => p.evaluate(() => {
	const box = document.getElementById('mark-notice');
	if (!box) return { box: false, shown: false, rows: [] };
	const r = box.getBoundingClientRect();
	return {
		box:   true,
		shown: !box.hidden && r.height > 0,
		head:  ((box.querySelector('.mark-notice-head') || {}).textContent) || '',
		why:   ((box.querySelector('.mark-notice-why') || {}).textContent) || '',
		rows:  [...box.querySelectorAll('.mark-notice-row')].map((x) => x.dataset.path).sort(),
		all:   !!box.querySelector('[data-act="mark-use-all"]'),
	};
});
const H = (name, ...args) => p.evaluate(([n, a]) => window.__mh[n](...a), [name, args]);
const T = (k, v) => p.evaluate(([k, v]) => DaimondI18n.t(k, v || undefined), [k, v || null]);
const has = (a, x) => Array.isArray(a) && a.includes(x);
const J = (x) => JSON.stringify(x);
const press = async (sel) => {
	const el = await p.$(sel);
	if (!el) return false;
	await el.click({ force: true });
	await sleep(1500);
	return true;
};

/// Put a Diamond on screen, as the rail's click does, on its crystal face.
async function openDiamond(id) {
	await p.evaluate((id) => {
		const box = document.querySelector('.diamond-box[data-id="' + id + '"]');
		if (box) box.click();
	}, id);
	await sleep(1500);
	return p.evaluate(() => (window.DaimondDiamond && DaimondDiamond.current()) ? DaimondDiamond.current().id : '');
}

/// This device's ⇄ on a folder of the open Diamond, pressed only where it is not already `on`.
async function shareHere(path, on) {
	const rows = await panelRows();
	if (!rows[path] || rows[path].share === on) return false;
	const done = await press('#panel-work .files-row.attached[data-path="' + path + '"] [data-act="share"]');
	await install();
	return done;
}

/// The Diamond's own rows in the Workspace panel: what each ⇄ says and whether it can be pressed.
async function panelRows() {
	await p.evaluate(() => window.DaimondPanels && DaimondPanels.show('work'));
	await sleep(500);
	await p.click('#panel-work [data-act="refresh"]', { force: true }).catch(() => {});
	await sleep(700);
	await p.click('.files-scope-chip[data-scope="diamond"]', { force: true }).catch(() => {});
	await sleep(1400);
	return p.evaluate(() => Object.fromEntries([...document.querySelectorAll('#panel-work .files-row.attached')].map((e) => {
		const b = e.querySelector('[data-act="share"]');
		return [e.dataset.path || '', { share: b ? b.getAttribute('aria-pressed') === 'true' : null,
			pressable: b ? !b.disabled : null, ro: e.classList.contains('ro') }];
	})));
}

await install();
const DEV = await H('dev');
const B = (x) => 'dir:[browser]' + x;
const M = (x, devs) => 'dir:[machine:' + FOLDER + (devs === undefined ? '@' + DEV : devs ? '@' + devs : '') + ']' + x;

// ═══════════════════════════════════════════════════════════════════════════════
// A. THE BROWSER WORKSPACE
// ═══════════════════════════════════════════════════════════════════════════════
step = 'A';
const modeA = await p.evaluate(async () => (await import('/pkg/oxedyne_daimond.js')).workspace_mode());
control('A0. the browser workspace is open', modeA !== 'folder', modeA);
await p.evaluate(async (body) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	// Every folder a cell names exists, so a row is judged on its grant and never as gone.
	for (const d of ['secret', 'kept', 'chatdir', 'lostone', 'losttwo', 'u-none', 'u-press', 'u-share', 'u-rel', 'u-cons',
		'u-root', 'l-none', 'l-press', 'a-seed', 'f-seed', 'o-seed', 'r-seed', 'x-other', 'dup', 'anc', 'anc/child', 'gro',
		'xdrop', 'bk-keep', 'bk-gone', 'bk-narrow']) {
		await m.write_file(d + '/x.md', 'not granted');
	}
	await m.write_file('chatdir/plan.md', body);
}, BODY);

// ── P1: the re-check's p2_routes shape ────────────────────────────────────────
step = 'P1';
const d1 = await H('create', 'MH forged');
await H('forge', d1, [{ id: 'forged1', ts: 5, from: 'diamond:' + d1, to: B('secret'), rel: 'holds', note: '', by: 'user', share: true }]);
const b1 = await H('bounds', d1);
check('P1. a forged user row by export -> import is not attached, and waits',
	!has(b1.at, 'secret') && has(b1.un, 'secret'), J(b1));
await openDiamond(d1);
const n1 = await notice();
check('P1. the notice over the composer lists it', n1.shown && has(n1.rows, 'secret'), J(n1));
const pressed1 = await press('#mark-notice .mark-notice-row[data-path="secret"] [data-act="mark-use-here"]')
	|| await H('useHere', d1, B('secret'));
const c1 = await H('bounds', d1);
control('P1. Use here brings it into force', has(c1.at, 'secret') && !has(c1.un, 'secret'), J({ pressed1, c1 }));

// ── P3: a chat record in a parcel, claiming a mark and a Read ─────────────────
step = 'P3';
const cid = await newChat(s);
await install();
await H('chatParcel', cid, [
	{ ref: B('chatdir'), path: 'chatdir', dir: true, ws: true, state: 'note' },
	{ ref: 'file:[browser]chatdir/plan.md', path: 'chatdir/plan.md', dir: false, ws: false, state: 'read' },
]);
const held3 = await p.evaluate((cid) => (DaimondAttach.chatList(cid) || []).map((a) => a.path), cid);
control('P3. the parcel\'s holdings are on the chat', has(held3, 'chatdir') && has(held3, 'chatdir/plan.md'), J(held3));
const scope3 = await p.evaluate((cid) => DaimondAttach.chatScope(cid), cid);
check('P3. a chat record from a parcel marks nothing into the chat\'s scope', !has(scope3, 'chatdir'), J(scope3));
const comp3 = await H('composer');
check('P3. and quotes nothing into the composer', typeof comp3 === 'string' && comp3.indexOf(BODY) < 0,
	J((comp3 || '').slice(0, 160)));
const n3 = await notice();
check('P3. the notice lists both claims', n3.shown && has(n3.rows, 'chatdir') && has(n3.rows, 'chatdir/plan.md'), J(n3));
if (!(await press('#mark-notice [data-act="mark-use-all"]'))) {
	await p.evaluate((cid) => { for (const a of DaimondAttach.chatList(cid)) if (DaimondAttach.chatConfirm) DaimondAttach.chatConfirm(cid, a.ref); }, cid);
}
const scope3b = await p.evaluate((cid) => DaimondAttach.chatScope(cid), cid);
const comp3b = await H('composer');
control('P3. the press brings the mark into scope and the Read into the composer',
	has(scope3b, 'chatdir') && typeof comp3b === 'string' && comp3b.indexOf(BODY) >= 0,
	J({ scope3b, quoted: (comp3b || '').indexOf(BODY) >= 0 }));

// ── P5: a removal made here, then the export taken before it replayed ─────────
step = 'P5';
const d5 = await H('create', 'MH removed');
const l5 = await H('add', d5, B('kept'), 'holds', 'user');
await openDiamond(d5);
if ((await H('bounds', d5)).un.includes('kept')) await H('useHere', d5, B('kept'));
const b5a = await H('bounds', d5);
control('P5. the mark is in force here', has(b5a.at, 'kept'), J(b5a));
const e5 = await H('exportOf', d5);
const rows5 = await panelRows();
const off5 = await press('#panel-work .files-row.attached[data-path="kept"] [data-act="hold-dir"]');
await install();
const b5b = await H('bounds', d5);
control('P5. the Workspace panel\'s ◈ takes it off', off5 && !has(b5b.at, 'kept') && !has(b5b.un, 'kept'), J({ off5, rows5, b5b }));
await H('importOf', e5);
const b5c = await H('bounds', d5);
check('P5. the removed row, replayed, comes back waiting and not in force',
	!has(b5c.at, 'kept') && has(b5c.un, 'kept'), J(b5c));

// Every removal door goes through the one helper that drops this device's entry with the row:
// the only other `remove_link` in the page is the legacy row's carry, whose entry has moved.
const src = await p.evaluate(async () => (await fetch('/js/daimond.js', { cache: 'no-store' })).text());
const lines = src.split('\n');
const doors = [];
lines.forEach((ln, i) => {
	if (!/remove_link\(/.test(ln) || /^\s*(\/\/|\*)/.test(ln)) return;
	let fn = '';
	for (let j = i; j >= 0 && !fn; j--) { const m = /^\s*(?:async\s+)?function\s+(\w+)/.exec(lines[j]); if (m) fn = m[1]; }
	// The one helper, and the legacy row's carry (its entry has already moved to the new row).
	if (fn === 'removeLinkHere' || /else if \(l\.id\) await diamondApp\(\)\.remove_link\(l\.owner, l\.id\)/.test(ln)) return;
	doors.push(fn + ':' + (i + 1));
});
check('P5. no removal door in the page takes a row off without its entry', doors.length === 0,
	doors.length + ' raw remove_link call(s) outside the helper ' + J(doors.slice(0, 10)));

// ── P7 (browser): the record lost ─────────────────────────────────────────────
step = 'P7a';
const d7 = await H('create', 'MH lost');
await H('add', d7, B('lostone'), 'holds', 'user');
await H('add', d7, B('losttwo'), 'consulted', 'user');
await openDiamond(d7);
for (const x of ['lostone', 'losttwo']) if ((await H('bounds', d7)).un.includes(x)) await H('useHere', d7, B(x));
const b7a = await H('bounds', d7);
control('P7. both marks in force before the record is lost', has(b7a.at, 'lostone') && has(b7a.at, 'losttwo'), J(b7a));
await H('recDrop');
await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'markshere');
await sleep(3000);
await install();
await openDiamond(d7);
const b7b = await H('bounds', d7);
check('P7. after a reload with no record, every mark waits', b7b.at.length === 0
	&& has(b7b.un, 'lostone') && has(b7b.un, 'losttwo'), J(b7b));
const n7 = await notice();
const noRec = await T('marks.no_record');
check('P7. the notice says this device holds no record', n7.shown && n7.why === noRec, J({ why: n7.why, want: noRec }));
await press('#mark-notice [data-act="mark-use-all"]');
await install();
const b7c = await H('bounds', d7);
control('P7. "Use all here" restores them, the consulted one still read-only',
	has(b7c.at, 'lostone') && has(b7c.at, 'losttwo') && has(b7c.ro, 'losttwo') && !has(b7c.ro, 'lostone'), J(b7c));

// ═══════════════════════════════════════════════════════════════════════════════
// P9: the grid. Each cell is a folder; each reader is asked about every cell and compared
// with the rule as the design states it.
// ═══════════════════════════════════════════════════════════════════════════════

/// The design's rule (section 2), as a reader of it would write it: `{ force, rel, share,
/// waiting }` for a row, the entry this device holds for it (or none), and the root open now.
function rule(row, entry, root, owner) {
	const kind = String(row.to).split(':')[0];
	const m = /^[a-z]+:\[(browser|machine)(?::([^\]@]*)(?:@[^\]]*)?)?\]/.exec(row.to);
	const refRoot = m ? (m[1] === 'machine' ? 'machine:' + (m[2] || '') : 'browser') : null;
	// A machine root is the folder's name and its id here (M2); a reference carries the name.
	const k = /^(machine:.*)#[0-9a-f]{32}$/.exec(root);
	const fits = !refRoot || refRoot === (k ? k[1] : root) || (m[1] === 'machine' && !m[2] && root.startsWith('machine:'));
	const mark = (row.rel === 'holds' || row.rel === 'consulted') && (kind === 'dir' || kind === 'file')
		&& (row.by === 'user' || row.by === '') && row.owner === owner && row.from === 'diamond:' + owner;
	const inForce = mark && fits && !!entry && entry.id === row.id && entry.to === row.to && entry.root === root;
	return {
		force:   inForce,
		rel:     inForce ? (entry.rel === 'holds' && row.rel === 'holds' ? 'holds' : 'consulted') : null,
		share:   inForce && entry.share === true && row.share === true,
		waiting: mark && fits && !inForce,
	};
}

/// Build one grid Diamond. `cells` are `{ path, ref, rel, by, share, place, entry }`: `place` is
/// `own`, `other` (stored in another Diamond's sidecar) or `reversed` (ends swapped); `entry` is
/// `none`, `press` (the user's Use here), `narrow-share` / `narrow-rel` (pressed, then the row
/// arrives wider than the entry), `seed` (an entry written straight into the record where no door
/// would write one), or `root` (an entry for another root).
async function buildGrid(name, cells, root) {
	const g = await H('create', name);
	const other = await H('create', name + ' other');
	const own = [], elsewhere = [];
	for (const c of cells) {
		const row = { id: 'g-' + c.path.replace(/[^a-z0-9]/gi, '-'), ts: 5, rel: c.rel || 'holds', note: '',
			by: c.by === undefined ? 'user' : c.by, share: !!c.share };
		if (c.place === 'reversed') Object.assign(row, { from: c.ref, to: 'diamond:' + g });
		else Object.assign(row, { from: 'diamond:' + g, to: c.ref });
		(c.place === 'other' ? elsewhere : own).push(row);
		c.row = Object.assign({ owner: c.place === 'other' ? other : g }, row);
	}
	await H('forge', g, own);
	if (elsewhere.length) await H('forge', other, elsewhere);
	await openDiamond(g);
	for (const c of cells) {
		if (c.entry === 'press' || c.entry === 'narrow-share' || c.entry === 'narrow-rel') await H('useHere', g, c.ref);
	}
	// Narrowing the entry is widening the row after the press: a forged `share:true`, or
	// `holds` over a mark pressed as `consulted`.
	const widen = cells.filter((c) => c.entry === 'narrow-share' || c.entry === 'narrow-rel');
	if (widen.length) {
		const set = {};
		widen.forEach((c) => { set[c.row.id] = c.entry === 'narrow-share' ? { share: true } : { rel: 'holds' }; });
		await H('editRows', g, { set });
		widen.forEach((c) => { if (c.entry === 'narrow-share') c.row.share = true; else c.row.rel = 'holds'; });
	}
	const seeds = cells.filter((c) => c.entry === 'seed' || c.entry === 'root');
	if (seeds.length) {
		await p.evaluate(([g, list]) => window.__mh.recSeed(g, list), [g, seeds.map((c) => ({ id: c.row.id,
			to: c.row.to, rel: c.row.rel, share: c.row.share, root: c.entry === 'root' ? (root === 'browser' ? ELSEWHERE : 'browser') : root }))]);
		await H('refresh');
	}
	// What this device's record now says, so each cell is judged against the entry it has.
	for (const c of cells) {
		const pressed = c.entry === 'press' || c.entry === 'narrow-share' || c.entry === 'narrow-rel';
		const rel0 = c.entry === 'narrow-rel' ? 'consulted' : c.row.rel;
		c.expect = rule(c.row, pressed ? { id: c.row.id, to: c.row.to, rel: rel0, share: false, root: root }
			: seeds.includes(c) ? { id: c.row.id, to: c.row.to, rel: c.row.rel, share: c.row.share,
				root: c.entry === 'root' ? (root === 'browser' ? ELSEWHERE : 'browser') : root } : null, root, g);
		// The path a reader names this cell by.
		c.name = c.path;
	}
	return g;
}

/// Ask every reader about every cell and report the cells where it disagrees with the rule.
async function readGrid(g, cells, label, withShareButton) {
	await install();
	const b = await H('bounds', g);
	const sh = await H('shared');
	const rows = withShareButton ? await panelRows() : null;
	await p.click('#dview-chat', { force: true }).catch(() => {});
	await sleep(800);
	await install();
	const comp = await H('composer');
	const noteLine = String(comp || '').split('\n').find((l) => /^Note /.test(l)) || '';
	const noted = noteLine ? noteLine.replace(/^Note /, '').split(', ') : [];
	const force = await p.evaluate(async ([g, refs]) => {
		if (!window.DaimondAttach || !DaimondAttach.inForce) return null;
		const out = {};
		for (const r of refs) out[r] = await DaimondAttach.inForce(g, r);
		return out;
	}, [g, cells.filter((c) => c.place === 'own').map((c) => c.ref)]);
	const wrong = { attached: [], read_only: [], unconfirmed: [], share_roots: [], share_button: [], prefix: [], inForce: [] };
	for (const c of cells) {
		if (c.skip) continue;
		const e = c.expect;
		if (has(b.at, c.name) !== e.force) wrong.attached.push(c.name);
		if (has(b.ro, c.name) !== (e.force && e.rel === 'consulted')) wrong.read_only.push(c.name);
		if (has(b.un, c.name) !== e.waiting && !c.collapsed) wrong.unconfirmed.push(c.name);
		if (sh !== null && has(sh, c.name) !== e.share) wrong.share_roots.push(c.name);
		if (rows && rows[c.name] && rows[c.name].share !== null) {
			if (rows[c.name].share !== e.share || rows[c.name].pressable !== e.force) wrong.share_button.push(c.name);
		}
		if (has(noted, c.name) !== (e.force && e.rel === 'holds')) wrong.prefix.push(c.name);
		if (force && c.place === 'own') {
			const f = force[c.ref];
			if (!!f !== e.force || (f && (f.rel !== e.rel || !!f.share !== e.share))) wrong.inForce.push(c.name);
		}
	}
	const where = label + ': ';
	check(where + 'bounds().attached agrees with the rule in every cell', wrong.attached.length === 0, 'wrong: ' + J(wrong.attached) + ' attached ' + J(b.at));
	check(where + 'bounds().read_only agrees in every cell', wrong.read_only.length === 0, 'wrong: ' + J(wrong.read_only));
	check(where + 'bounds().unconfirmed agrees in every cell', wrong.unconfirmed.length === 0, 'wrong: ' + J(wrong.unconfirmed) + ' unconfirmed ' + J(b.un));
	// In the browser workspace the flag is inert (everything there syncs) and only the build
	// publishes the list, so there it is a control; with a folder open it is the census's own.
	if (sh !== null) check(where + 'the share roots agree in every cell', wrong.share_roots.length === 0, 'wrong: ' + J(wrong.share_roots) + ' shared ' + J(sh),
		label.indexOf('browser') >= 0 ? 'control' : 'route');
	if (rows) check(where + 'the ⇄ agrees in every cell (on, and pressable)', wrong.share_button.length === 0, 'wrong: ' + J(wrong.share_button));
	check(where + 'the composer\'s prefix names exactly the holds in force', wrong.prefix.length === 0, 'wrong: ' + J(wrong.prefix) + ' noted ' + J(noted));
	if (force) control(where + 'DaimondAttach.inForce agrees with the rule in every cell', wrong.inForce.length === 0, 'wrong: ' + J(wrong.inForce));
	return wrong;
}

/// One grid of cells over a root: `R` spells a reference in it.
const gridCells = (R, otherRootRef) => [
	{ path: 'u-none',   ref: R('u-none'),   entry: 'none' },
	{ path: 'u-press',  ref: R('u-press'),  entry: 'press' },
	{ path: 'u-share',  ref: R('u-share'),  entry: 'narrow-share' },
	{ path: 'u-rel',    ref: R('u-rel'),    rel: 'consulted', entry: 'narrow-rel' },
	{ path: 'u-cons',   ref: R('u-cons'),   rel: 'consulted', entry: 'press' },
	{ path: 'u-root',   ref: R('u-root'),   entry: 'root' },
	{ path: 'l-none',   ref: R('l-none'),   by: '', entry: 'none' },
	{ path: 'l-press',  ref: R('l-press'),  by: '', entry: 'press' },
	{ path: 'a-seed',   ref: R('a-seed'),   by: 'agent:daimon', share: true, entry: 'seed' },
	{ path: 'f-seed',   ref: R('f-seed'),   by: 'fold', entry: 'seed' },
	{ path: 'o-seed',   ref: R('o-seed'),   place: 'other', share: true, entry: 'seed' },
	{ path: 'r-seed',   ref: R('r-seed'),   place: 'reversed', entry: 'seed' },
	{ path: 'x-other',  ref: otherRootRef,  entry: 'none' },
];

step = 'P9a';
const cellsA = gridCells(B, M('x-other'));
const gA = await buildGrid('MH grid browser', cellsA, 'browser');
await readGrid(gA, cellsA, 'P9 browser', true);

// The dedupe and the collapse: two rows naming one folder, a forged one first in the sidecar and
// the pressed one second; and a forged ancestor over a pressed child.
step = 'P9b';
const gD = await H('create', 'MH dedupe');
await H('forge', gD, [
	{ id: 'dup-forged', ts: 5, from: 'diamond:' + gD, to: B('dup'), rel: 'holds', note: '', by: 'user', share: true },
	{ id: 'anc-forged', ts: 5, from: 'diamond:' + gD, to: B('anc'), rel: 'holds', note: '', by: 'user' },
	{ id: 'anc-child', ts: 6, from: 'diamond:' + gD, to: B('anc/child'), rel: 'holds', note: '', by: 'user' },
]);
await H('forge', gD, [{ id: 'dup-pressed', ts: 6, from: 'diamond:' + gD, to: 'dir:dup', rel: 'consulted', note: '', by: 'user' }]);
await openDiamond(gD);
// `confirmHere` presses the first row naming the thing, which here is the forged one; the second
// row is pressed through the record's own door, as the paperclip on it would. The base has none.
await p.evaluate(async (g) => {
	const rows = JSON.parse(await DaimondCore.diamondApp().links_touching('diamond:' + g) || '[]');
	const dup = rows.find((l) => l.id === 'dup-pressed');
	if (window.DaimondMarksHere && dup) DaimondMarksHere.grant(g, dup, 'browser', { share: false });
}, gD);
await H('useHere', gD, B('anc/child'));
await H('refresh');
const bD = await H('bounds', gD);
const shD = await H('shared');
check('P9 dedupe: of two rows for one folder, the one pressed here decides (read-only, unshared)',
	has(bD.at, 'dup') && has(bD.ro, 'dup') && !has(bD.un, 'dup') && (shD === null || !has(shD, 'dup')), J({ bD, shD }));
check('P9 collapse: a forged ancestor waits and does not hide the child pressed here',
	has(bD.at, 'anc/child') && !has(bD.at, 'anc') && has(bD.un, 'anc'), J(bD));

// A chat's grid: a holding claimed and not pressed, pressed, one whose path is not the path in
// its reference, and one pressed under another root.
step = 'P9c';
const cg = await newChat(s);
await install();
await H('chatParcel', cg, [
	{ ref: B('c-none'),  path: 'c-none',  dir: true, ws: true, state: 'note' },
	{ ref: B('c-press'), path: 'c-press', dir: true, ws: true, state: 'note' },
	{ ref: B('c-path'),  path: 'c-else',  dir: true, ws: true, state: 'note' },
	{ ref: B('c-root'),  path: 'c-root',  dir: true, ws: true, state: 'note' },
]);
await p.evaluate(([cg, r]) => { if (DaimondAttach.chatConfirm) DaimondAttach.chatConfirm(cg, r); }, [cg, B('c-press')]);
await p.evaluate(([cg, list]) => window.__mh.recSeedChat(cg, list), [cg, [
	{ ref: B('c-path'), path: 'c-else', ws: true, read: false, root: 'browser' },
	{ ref: B('c-root'), path: 'c-root', ws: true, read: false, root: ELSEWHERE },
]]);
const scopeG = (await p.evaluate((cid) => DaimondAttach.chatScope(cid), cg)).slice().sort();
check('P9 chat: the scope is exactly the holding pressed here', J(scopeG) === J(['c-press']), J(scopeG));

// ── F7: the × on a chat holding nobody pressed here ───────────────────────────
// It went through the paperclip's toggle, which confirms a holding waiting here, so a person
// taking off a folder they did not recognise granted it write reach and a Read instead.
step = 'F7';
const cx = await newChat(s);
await install();
await H('chatParcel', cx, [{ ref: B('xdrop'), path: 'xdrop', dir: true, ws: true, state: 'read' }]);
const chatNow = (cid) => p.evaluate(async (cid) => ({
	scope: await DaimondAttach.chatScope(cid),
	list:  (DaimondAttach.chatList(cid) || []).map((a) => a.path),
	force: DaimondAttach.chatInForce(cid, DaimondAttach.ref('dir', 'xdrop')),
}), cid);
const fx0 = await chatNow(cx);
control('F7. the parcel\'s holding is on the chat and grants nothing', has(fx0.list, 'xdrop') && !has(fx0.scope, 'xdrop')
	&& !fx0.force, J(fx0));
const xPressed = await p.evaluate(() => {
	const rows = [...document.querySelectorAll('#chat-attachments .arte-row, #chat-attachments .attach-icon')];
	const row = rows.find((r) => /xdrop/.test(r.textContent || ''));
	const x = row && row.querySelector('.arte-drop');
	if (!x) return 'no ×: ' + rows.map((r) => (r.textContent || '').trim().slice(0, 40)).join(' | ');
	x.click();
	return '';
});
control('F7. its tile has a × to press', xPressed === '', xPressed);
await sleep(1000);
const fx1 = await chatNow(cx);
check('F7. the × takes a holding waiting here off, and grants it nothing',
	!has(fx1.list, 'xdrop') && !has(fx1.scope, 'xdrop') && !fx1.force, J(fx1));
const recX = await p.evaluate((cid) => {
	const r = JSON.parse(localStorage.getItem(window.__mh.recKey()) || 'null');
	return (r && r.c && Object.prototype.hasOwnProperty.call(r.c, cid)) ? r.c[cid] : [];
}, cx);
check('F7. and leaves no entry for it on this device', recX.length === 0, J(recX));

// Every × in the page is a removal: none reaches the paperclip's toggle or a confirmation.
const dropsBad = [];
lines.forEach((ln, i) => {
	if (!/\bonDrop:/.test(ln) || /^\s*(\/\/|\*)/.test(ln)) return;
	let body = ln;
	if (!/\}\s*,?\s*$/.test(ln)) {
		for (let j = i + 1; j < lines.length && j < i + 12; j++) {
			body += '\n' + lines[j];
			if (/^\s*\},?\s*$/.test(lines[j])) break;
		}
	}
	if (/Toggle\(|[Cc]onfirm|Grant/.test(body)) dropsBad.push(i + 1);
});
check('F7. no × in the page reaches a toggle or a confirmation', dropsBad.length === 0,
	'onDrop at line(s) ' + J(dropsBad));

// ── F1: a removal and a narrowing that arrive by backup restore ───────────────
// The restore writes each Diamond's sidecar over whole, and settled only the chats, so a mark
// it removed kept this device's entry and a replay of the old row was in force with no press.
step = 'F1';
const dR = await H('create', 'MH restore');
const lnKeep = await H('add', dR, B('bk-keep'), 'holds', 'user');
const lnGone = await H('add', dR, B('bk-gone'), 'holds', 'user');
const lnNarrow = await H('add', dR, B('bk-narrow'), 'holds', 'user');
for (const x of ['bk-keep', 'bk-gone', 'bk-narrow']) if ((await H('bounds', dR)).un.includes(x)) await H('useHere', dR, B(x));
const bR0 = await H('bounds', dR);
control('F1. three marks in force, none read-only', ['bk-keep', 'bk-gone', 'bk-narrow'].every((x) => has(bR0.at, x) && !has(bR0.ro, x)),
	J({ bR0, ids: [lnKeep, lnGone, lnNarrow] }));
// A backup exported through the account menu, as a person does.
await p.click('#user-row');
await sleep(600);
const dl = p.waitForEvent('download', { timeout: 60000 });
await p.click('button.admin-item:has-text("' + await T('home.export_backup') + '")');
const bkWith = scratch('markshere', 'backup-with-' + process.pid + '.json');
await (await dl).saveAs(bkWith);
await p.keyboard.press('Escape');
await sleep(400);
const bk = JSON.parse(fs.readFileSync(bkWith, 'utf8'));
const bkSide = (bk.workspace || []).find((x) => x && x.path === 'diamonds/' + dR + '/.daimond/links.jsonl');
control('F1. the backup carries the Diamond\'s sidecar', !!bkSide, bkSide ? bkSide.path : J((bk.workspace || []).length));
// Its copy of the sidecar has lost one mark and narrowed another: what a later backup, or one
// taken on the device that made the change, holds.
const bkRows = bkSide ? Buffer.from(bkSide.b64, 'base64').toString('utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : [];
const goneRow = bkRows.find((r) => r.id === lnGone);
if (bkSide) {
	const kept = bkRows.filter((r) => r.id !== lnGone).map((r) => (r.id === lnNarrow ? Object.assign({}, r, { rel: 'consulted' }) : r));
	bkSide.b64 = Buffer.from(kept.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8').toString('base64');
}
const bkWithout = scratch('markshere', 'backup-without-' + process.pid + '.json');
fs.writeFileSync(bkWithout, JSON.stringify(bk));
await p.click('#user-row');
await sleep(600);
const chooser = p.waitForEvent('filechooser', { timeout: 30000 });
await p.click('button.admin-item:has-text("' + await T('home.import_backup') + '")');
await (await chooser).setFiles(bkWithout);
await p.waitForSelector('.dlg-ok:not([disabled])', { timeout: 60000 });
// The restore reloads the page once it is acknowledged.
await Promise.all([
	p.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {}),
	p.click('.dlg-ok'),
]);
await signInAs(s, 'markshere');
await sleep(3000);
await install();
await H('refresh');
const rowsR = await H('rows', dR);
control('F1. the restore took one row away and narrowed another',
	!rowsR.some((r) => r.id === lnGone) && (rowsR.find((r) => r.id === lnNarrow) || {}).rel === 'consulted',
	J(rowsR.map((r) => [r.id, r.rel, r.to])));
const entR = await H('recEntries', dR);
check('F1. a mark a restored backup removed takes this device\'s entry with it', !entR.some((e) => e.id === lnGone), J(entR));
check('F1. and one it narrowed narrows the entry', (entR.find((e) => e.id === lnNarrow) || {}).rel === 'consulted', J(entR));
const bR1 = await H('bounds', dR);
control('F1. the mark it kept is still in force', has(bR1.at, 'bk-keep') && !has(bR1.ro, 'bk-keep'), J(bR1));
// The old rows replayed after it: a copy of the Diamond with a newer stamp, as any writer of
// the parcel, or a device that never heard of the change, can deliver.
const replay = await H('parcel', dR, Date.now() + 3600000, { add: goneRow ? [goneRow] : [], set: { [lnNarrow]: { rel: 'holds' } } });
await H('apply', replay);
const bR2 = await H('bounds', dR);
check('F1. the removed row, replayed after the restore, waits and is not in force',
	!has(bR2.at, 'bk-gone') && has(bR2.un, 'bk-gone'), J(bR2));
check('F1. the narrowed row, replayed wide, stays read-only', has(bR2.at, 'bk-narrow') && has(bR2.ro, 'bk-narrow'), J(bR2));
for (const f of [bkWith, bkWithout]) { try { fs.unlinkSync(f); } catch (e) { /* tidy */ } }

// ═══════════════════════════════════════════════════════════════════════════════
// B. A MACHINE FOLDER
// ═══════════════════════════════════════════════════════════════════════════════
step = 'B';
await p.evaluate(async (folder) => {
	const root = await navigator.storage.getDirectory();
	try { await root.removeEntry(folder, { recursive: true }); } catch (e) { /* first run */ }
	const dir = await root.getDirectoryHandle(folder, { create: true });
	const names = ['secret', 'legacyshare', 'mine', 'shared', 'synced', 'viasync', 'theirs', 'chatm', 'lostshare', 'lostplain',
		'u-none', 'u-press', 'u-share', 'u-rel', 'u-cons', 'u-root', 'l-none', 'l-press', 'a-seed', 'f-seed', 'o-seed', 'r-seed', 'x-other', 'gro'];
	for (const d of names) {
		const sub = await dir.getDirectoryHandle(d, { create: true });
		const fh = await sub.getFileHandle('keep.md', { create: true });
		const w = await fh.createWritable();
		await w.write('kept ' + d);
		await w.close();
	}
	const db = await new Promise((res, rej) => {
		const q = indexedDB.open('daimond-fsa', 1);
		q.onupgradeneeded = () => q.result.createObjectStore('handles');
		q.onsuccess = () => res(q.result);
		q.onerror   = () => rej(q.error);
	});
	await new Promise((res, rej) => {
		const tx = db.transaction('handles', 'readwrite');
		tx.objectStore('handles').put(dir, 'workspace');
		tx.oncomplete = res;
		tx.onerror = () => rej(tx.error);
	});
	db.close();
}, FOLDER);
// A rootless mark pressed in the browser workspace: under the folder it fits, and its entry is
// for the browser, so it waits there.
const gRo = await H('create', 'MH rootless');
await H('forge', gRo, [{ id: 'gro1', ts: 5, from: 'diamond:' + gRo, to: 'dir:gro', rel: 'holds', note: '', by: 'user' }]);
await H('useHere', gRo, 'dir:gro');
const bRoA = await H('bounds', gRo);
control('B0. a rootless mark pressed in the browser workspace is in force there', has(bRoA.at, 'gro'), J(bRoA));
await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'markshere');
await sleep(3500);
await install();
const modeB = await p.evaluate(async () => (await import('/pkg/oxedyne_daimond.js')).workspace_mode());
control('B0. the app reconnected the stand-in folder at boot, as a desktop does', modeB === 'folder', modeB);
const bRoB = await H('bounds', gRo);
control('B0. the same rootless mark, its entry for the browser, waits under the folder',
	!has(bRoB.at, 'gro') && has(bRoB.un, 'gro'), J(bRoB));

// ── P1b: the forged row naming this device ────────────────────────────────────
step = 'P1b';
const e1 = await H('create', 'MH machine forged');
await H('forge', e1, [{ id: 'forged2', ts: 5, from: 'diamond:' + e1, to: M('secret'), rel: 'holds', note: '', by: 'user', share: true }]);
const bb1 = await H('bounds', e1);
const sb1 = await H('shared');
check('P1b. a forged user row naming this device is not attached, and waits', !has(bb1.at, 'secret') && has(bb1.un, 'secret'), J(bb1));
check('P1b. and its share flag shares nothing from here', !has(sb1, 'secret'), J(sb1));
await openDiamond(e1);
await H('useHere', e1, M('secret'));
const bb1c = await H('bounds', e1);
const sb1c = await H('shared');
control('P1b. Use here brings it into force', has(bb1c.at, 'secret'), J(bb1c));
check('P1b. and a confirmation never carries the share flag', !has(sb1c, 'secret'), J(sb1c));

// ── P2: the share flag ────────────────────────────────────────────────────────
step = 'P2';
const e2 = await H('create', 'MH share');
await H('forge', e2, [{ id: 'legacy1', ts: 5, from: 'diamond:' + e2, to: M('legacyshare'), rel: 'holds', note: 'share', by: 'user' }]);
const s2a = await H('shared');
check('P2. a pre-R3 row whose note says "share" shares nothing from here', !has(s2a, 'legacyshare'), J(s2a));
const mine = await H('add', e2, M('mine'), 'holds', 'user');
await openDiamond(e2);
if ((await H('bounds', e2)).un.includes('mine')) await H('useHere', e2, M('mine'));
await H('editRows', e2, { set: { [mine]: { share: true } } });
const s2b = await H('shared');
const pr2 = await panelRows();
check('P2. a forged share:true over a mark confirmed here unshared shares nothing', !has(s2b, 'mine'), J(s2b));
check('P2. and its ⇄ says so: not on here, and pressable', pr2.mine && pr2.mine.share === false && pr2.mine.pressable === true, J(pr2.mine));
await shareHere('mine', true);
const s2c = await H('shared');
control('P2. this device\'s own ⇄ shares it', has(s2c, 'mine'), J(s2c));

// ── P4: replay of a superseded shared row ─────────────────────────────────────
step = 'P4';
const e4 = await H('create', 'MH replay share');
await H('add', e4, M('shared'), 'holds', 'user');
await openDiamond(e4);
if ((await H('bounds', e4)).un.includes('shared')) await H('useHere', e4, M('shared'));
await shareHere('shared', true);
const s4a = await H('shared');
control('P4. shared by this device\'s ⇄', has(s4a, 'shared'), J(s4a));
const x4 = await H('exportOf', e4);
await shareHere('shared', false);
const s4b = await H('shared');
control('P4. ⇄ off stops it', !has(s4b, 'shared'), J(s4b));
await H('importOf', x4);
const s4c = await H('shared');
const b4c = await H('bounds', e4);
check('P4. the old shared row, replayed, shares nothing', !has(s4c, 'shared'), J(s4c));
control('P4. and the mark itself is still in force', has(b4c.at, 'shared'), J(b4c));

// ── P4b, P5b, P1c: changes arriving through the sync apply ────────────────────
step = 'P4b';
const e6 = await H('create', 'MH sync');
await H('add', e6, M('synced'), 'holds', 'user');
await openDiamond(e6);
if ((await H('bounds', e6)).un.includes('synced')) await H('useHere', e6, M('synced'));
await shareHere('synced', true);
const T0 = await H('stamp', e6);
// The same copy at the same stamp first, so the fork point is known and later copies apply one-sided.
await p.evaluate(async ([id, T]) => window.__mh.apply(await window.__mh.parcel(id, T, {})), [e6, T0]);
const syncedRow = (await H('rows', e6)).find((l) => /synced$/.test(l.to));
const s6a = await H('shared');
control('P4b. shared here before anything arrives', has(s6a, 'synced'), J(s6a));
const viaParcel = (T, x) => p.evaluate(async ([id, T, x]) =>
	window.__mh.apply(await window.__mh.parcel(id, T, x)), [e6, T, x]);
await viaParcel(T0 + 1e6, { set: { [syncedRow.id]: { share: false } } });
const s6b = await H('shared');
await viaParcel(T0 + 2e6, { set: { [syncedRow.id]: { share: true } } });
const s6c = await H('shared');
control('P4b. share off arriving stops it here', !has(s6b, 'synced'), J(s6b));
check('P4b. the old shared row arriving after it shares nothing', !has(s6c, 'synced'), J(s6c));
step = 'P5b';
const b6a = await H('bounds', e6);
await viaParcel(T0 + 3e6, { drop: [syncedRow.id] });
const b6b = await H('bounds', e6);
const rowBack = { id: syncedRow.id, ts: syncedRow.ts || 5, from: syncedRow.from, to: syncedRow.to, rel: 'holds', note: '', by: 'user', share: true };
await viaParcel(T0 + 4e6, { add: [rowBack] });
const b6c = await H('bounds', e6);
const s6d = await H('shared');
control('P5b. in force before the removal arrives, gone after', has(b6a.at, 'synced') && !has(b6b.at, 'synced'), J({ b6a, b6b }));
check('P5b. the row arriving back waits, and shares nothing', !has(b6c.at, 'synced') && has(b6c.un, 'synced') && !has(s6d, 'synced'), J({ b6c, s6d }));
step = 'P1c';
await viaParcel(T0 + 5e6, { add: [{ id: 'forged9', ts: 5, from: 'diamond:' + e6, to: M('viasync'), rel: 'holds', note: '', by: 'user', share: true }] });
const b6e = await H('bounds', e6);
const s6e = await H('shared');
check('P1c. a forged row in a newer parcel is neither in force nor shared',
	!has(b6e.at, 'viasync') && has(b6e.un, 'viasync') && !has(s6e, 'viasync'), J({ b6e, s6e }));

// ── P8: a confirmation writes no row and moves no stamp ───────────────────────
step = 'P8';
const e8 = await H('create', 'MH confirm');
await H('add', e8, M('theirs', OTHER), 'holds', 'user');
await openDiamond(e8);
const side8 = await H('sidecar', e8), st8 = await H('stamp', e8);
const b8a = await H('bounds', e8);
control('P8. a mark made on another device waits here', has(b8a.un, 'theirs') && !has(b8a.at, 'theirs'), J(b8a));
const pr8 = await press('#mark-notice .mark-notice-row[data-path="theirs"] [data-act="mark-use-here"]');
await install();
const b8b = await H('bounds', e8);
control('P8. the notice\'s Use here brings it into force', pr8 && has(b8b.at, 'theirs'), J({ pr8, b8b }));
const side8b = await H('sidecar', e8), st8b = await H('stamp', e8);
check('P8. the press leaves the sidecar byte-identical', side8b === side8, side8b === side8 ? '' : J({ before: side8.slice(0, 200), after: side8b.slice(0, 300) }));
check('P8. and moves no stamp', st8b === st8, J({ st8, st8b }));

// ── P3 (machine): a chat record naming this device ────────────────────────────
step = 'P3m';
const cm = await newChat(s);
await install();
await H('chatParcel', cm, [{ ref: M('chatm'), path: 'chatm', dir: true, ws: true, state: 'note' }]);
const scopeM = await p.evaluate((cid) => DaimondAttach.chatScope(cid), cm);
check('P3. a chat record from a parcel naming this device marks nothing in', !has(scopeM, 'chatm'), J(scopeM));
const nm = await notice();
check('P3. and the notice lists it', nm.shown && has(nm.rows, 'chatm'), J(nm));

// ── P7 (machine): the record lost, with a shared folder ───────────────────────
step = 'P7m';
const e7 = await H('create', 'MH lost machine');
await H('add', e7, M('lostshare'), 'holds', 'user');
await H('add', e7, M('lostplain'), 'holds', 'user');
await openDiamond(e7);
for (const x of ['lostshare', 'lostplain']) if ((await H('bounds', e7)).un.includes(x)) await H('useHere', e7, M(x));
await shareHere('lostshare', true);
const s7a = await H('shared');
control('P7. the shared folder is shared before the record is lost', has(s7a, 'lostshare'), J(s7a));
await H('recDrop');
await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'markshere');
await sleep(3500);
await install();
await openDiamond(e7);
const b7m = await H('bounds', e7);
const s7b = await H('shared');
check('P7. after a reload with no record, every mark in the folder waits', !has(b7m.at, 'lostshare') && !has(b7m.at, 'lostplain')
	&& has(b7m.un, 'lostshare') && has(b7m.un, 'lostplain'), J(b7m));
check('P7. and nothing is shared from the folder', !has(s7b, 'lostshare'), J(s7b));
const n7m = await notice();
check('P7. the notice says this device holds no record', n7m.shown && n7m.why === noRec, J({ why: n7m.why }));
await press('#mark-notice [data-act="mark-use-all"]');
await install();
const b7n = await H('bounds', e7);
const s7c = await H('shared');
control('P7. "Use all here" restores the marks', has(b7n.at, 'lostshare') && has(b7n.at, 'lostplain'), J(b7n));
check('P7. and the shared folder stays unshared until its own ⇄', !has(s7c, 'lostshare'), J(s7c));
await shareHere('lostshare', true);
const s7d = await H('shared');
control('P7. its ⇄ shares it again', has(s7d, 'lostshare'), J(s7d));

// ── P9 (machine) ──────────────────────────────────────────────────────────────
step = 'P9m';
const cellsB = gridCells((x) => M(x), B('x-other'));
// The page's own key for the folder, id and all.
const gB = await buildGrid('MH grid machine', cellsB, await p.evaluate(() => DaimondAttach.root()));
await readGrid(gB, cellsB, 'P9 machine', true);

// ── Tidy ──────────────────────────────────────────────────────────────────────
step = 'tidy';
await p.evaluate(async (folder) => {
	const root = await navigator.storage.getDirectory();
	try { await root.removeEntry(folder, { recursive: true }); } catch (e) { /* tidy */ }
}, FOLDER);
const errs = errors(s).filter((e) => !/401|502|404|net::ERR|Failed to load resource/.test(e));
console.log('\nconsole errors:', errs.slice(0, 4));
await s.close();

console.log(`\nroute checks: ${tally.route[0]} held, ${tally.route[1]} failed; controls: ${tally.control[0]} held, ${tally.control[1]} failed`);
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);

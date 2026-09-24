// verify_markshere_sync.mjs — a mark pressed on one device is not a grant on another, over a
// real sync, and what a change on one device does on the other (R2, the design's P6 and P12).
//
// ── WHY ──────────────────────────────────────────────────────────────────────
//
// `dev/verify_markshere.mjs` proves the rule on one device against rows it forges. This proves it
// where it has to hold: devices of one account, paired, syncing through a real gateway. The design
// (`specs/daimond_signed_marks_design_20260923.md`) says a grant here is the synced row AND this
// device's own record, that confirming writes only the record, that a removal or a narrowing
// travels while a widening never does, and that sharing is pressed on each computer that holds
// the folder (owner decision O2) while turning it off anywhere turns it off everywhere.
//
// ── WHAT IT ASSERTS ──────────────────────────────────────────────────────────
//
//   P12 A desktop marks a folder in its browser workspace. On the phone, on its first start after
//       R2, the mark waits and the notice says the phone holds no record; one press brings it into
//       force there, and the desktop is unaffected.
//   P6  Two computers with a folder of one name. B presses Use here on A's mark: B's sidecar is
//       byte-identical and its stamp unmoved, the rounds settle at a fixed point, and the mark is
//       in force on both.
//   P6b A legacy row (`by:""`) confirmed on both between syncs stays one row, in force on both;
//       after A removes it and one round, it is in force and waiting nowhere.
//   S3  A removal crosses: after it arrives, a replay of the old copy on B comes back waiting.
//   S4  A narrowing crosses (holds -> consulted) and a widening does not.
//   S5  O2: A's ⇄ does not share on B; B's ⇄ is drawn as shared from another device until pressed
//       there.
//   S6  ⇄ off travels to every device; B's ⇄ on again after it does not share on A.
//   S7  A destroyed Diamond's tombstone drops B's entries: B's replay of it waits.
//   W   The record on WebKit, the engine an iPhone runs: written by a press, read back, kept
//       across a reload.
//
// ENGINES. Playwright's WebKit has no OPFS (`navigator.storage.getDirectory` is absent; see
// `dev/verify_compile_handoff.mjs`), and the store refuses to create a Diamond without it, so the
// phone that HOLDS a Diamond is a Chromium mobile context (an iPhone's UA, `isMobile`, touch), and
// the WebKit leg proves only the record, which is all of this that needs no store. Checks marked
// `route` fail at the base (124ef8d0); the others are controls.
//
// Needs the dev stack: the app (DAIMOND_PORT), the mock, and a gateway on DAIMOND_GW_PORT. Sync is
// Pro-gated, so the account is granted Pro the way the gateway trusts (dev/pro.mjs).
import fs from 'node:fs';
import { open, signInAs, scratch } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';

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
const has = (a, x) => Array.isArray(a) && a.includes(x);
const J = (x) => JSON.stringify(x);

const NAME   = 'mhsync';
const FOLDER = 'mhsync-usr';
const SUBS   = ['both', 'legacy', 'gone', 'narrow', 'share', 'tomb'];
const GWDIR  = new URL('../gateway', import.meta.url).pathname;
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 '
	+ '(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const PROFILE = (x) => scratch('pw', 'mhsync-' + x + '-' + process.pid);

// ── Page helpers, installed again after every reload ─────────────────────────
const install = (s) => s.page.evaluate(() => {
	const app = () => DaimondCore.diamondApp();
	const side = (exp) => Object.keys(exp.files || {}).find((k) => /\.daimond\/links\.jsonl$/.test(k));
	window.__mh = {
		async refresh() {
			await DaimondCore.loadDiamonds();
			document.dispatchEvent(new CustomEvent('daimond-links-changed'));
			if (DaimondCore.syncClearWalkCache) DaimondCore.syncClearWalkCache();
			await new Promise((r) => setTimeout(r, 250));
		},
		async ids() { return JSON.parse(await app().list_diamonds()).map((d) => d.id); },
		async stamp(id) { return (JSON.parse(await app().list_diamonds()).find((d) => d.id === id) || {}).touched; },
		async sidecar(id) {
			try { const e = JSON.parse(await app().export_diamond(id)); const k = side(e); return k ? String(e.files[k] || '') : ''; }
			catch (e) { return null; }
		},
		async rows(id) { return JSON.parse(await app().links_touching('diamond:' + id) || '[]').filter((l) => l.owner === id); },
		async exportOf(id) { return app().export_diamond(id); },
		async importOf(text) { await app().import_diamond(text, false); await window.__mh.refresh(); },
		async forge(id, rows) {
			const e = JSON.parse(await app().export_diamond(id));
			const k = side(e) || '.daimond/links.jsonl';
			e.files = e.files || {};
			e.files[k] = String(e.files[k] || '') + rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
			await app().import_diamond(JSON.stringify(e), false);
			await window.__mh.refresh();
		},
		async bounds(id) {
			const b = await DaimondDiamond.bounds(id);
			return { at: (b.attached || []).slice().sort(), ro: (b.read_only || []).slice().sort(),
				un: (b.unconfirmed || []).slice().sort() };
		},
		async shared() {
			if (DaimondCore.syncClearWalkCache) DaimondCore.syncClearWalkCache();
			if (window.DaimondFiles && DaimondFiles.shareRoots) return (await DaimondFiles.shareRoots()).slice().sort();
			// With no folder open there is nothing to measure; with one open and nothing
			// flagged the census has no plan, and says `folder: false`, and nothing is shared.
			if ((await import('/pkg/oxedyne_daimond.js')).workspace_mode() !== 'folder') return null;
			const sh = await DaimondCore.syncFolderShare();
			return (sh.flagged || []).slice().sort();
		},
		// A mark made here, as the paperclip makes it: the row, then (on a build that keeps
		// one) the press recorded here. On the base the row naming this device is the grant.
		async mark(id, path, rel) {
			const ref = DaimondAttach.ref('dir', path);
			await app().add_link(id, 'diamond:' + id, ref, rel || 'holds', '', 'user');
			await window.__mh.refresh();
			await DaimondAttach.confirmHere(id, ref);
			await window.__mh.refresh();
			return ref;
		},
		async relOf(id, path, rel) {
			const l = (await window.__mh.rows(id)).find((x) => x.other && x.other.endsWith(']' + path));
			if (!l) return false;
			await app().update_link(id, l.id, rel, l.note || '');
			await window.__mh.refresh();
			return true;
		},
		dev() { return (window.DaimondIdentity && DaimondIdentity.deviceId && DaimondIdentity.deviceId()) || ''; },
	};
	return true;
});
const H = (s, name, ...args) => s.page.evaluate(([n, a]) => window.__mh[n](...a), [name, args]);

/// The notice, as drawn: `drawn` is whether it is up at all, whatever the shell's layout.
const notice = (s) => s.page.evaluate(() => {
	const box = document.getElementById('mark-notice');
	if (!box) return { drawn: false, rows: [] };
	return { drawn: !box.hidden, why: ((box.querySelector('.mark-notice-why') || {}).textContent) || '',
		rows: [...box.querySelectorAll('.mark-notice-row')].map((x) => x.dataset.path).sort() };
});
const press = async (s, sel) => {
	const el = await s.page.$(sel);
	if (!el) return false;
	await el.click({ force: true });
	await sleep(1500);
	await install(s);
	return true;
};
async function openDiamond(s, id) {
	await s.page.evaluate((id) => { const b = document.querySelector('.diamond-box[data-id="' + id + '"]'); if (b) b.click(); }, id);
	await sleep(1500);
	return s.page.evaluate(() => (DaimondDiamond.current() || {}).id || '');
}
/// Use here on one mark: the notice's press, which is the door a person uses.
async function useHere(s, id, path) {
	await openDiamond(s, id);
	return press(s, '#mark-notice .mark-notice-row[data-path="' + path + '"] [data-act="mark-use-here"]');
}
async function panelRows(s) {
	await s.page.evaluate(() => window.DaimondPanels && DaimondPanels.show('work'));
	await sleep(500);
	await s.page.click('#panel-work [data-act="refresh"]', { force: true }).catch(() => {});
	await sleep(700);
	await s.page.click('.files-scope-chip[data-scope="diamond"]', { force: true }).catch(() => {});
	await sleep(1400);
	return s.page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#panel-work .files-row.attached')].map((e) => {
		const b = e.querySelector('[data-act="share"]');
		const badge = e.querySelector('.files-badge.files-shared');
		return [e.dataset.path || '', { share: b ? b.getAttribute('aria-pressed') === 'true' : null,
			pressable: b ? !b.disabled : null, badge: badge ? badge.title : '' }];
	})));
}
/// This device's ⇄ on a folder of the open Diamond, pressed only where it is not already `on`.
async function shareHere(s, id, path, on) {
	await openDiamond(s, id);
	const rows = await panelRows(s);
	if (!rows[path] || rows[path].share === on) return false;
	return press(s, '#panel-work .files-row.attached[data-path="' + path + '"] [data-act="share"]');
}
/// The Workspace panel's ◈ on a folder of the open Diamond: the removal door a person uses.
async function removeHere(s, id, path) {
	await openDiamond(s, id);
	await panelRows(s);
	return press(s, '#panel-work .files-row.attached[data-path="' + path + '"] [data-act="hold-dir"]');
}

/// Cut a device off from the mailbox, or put it back: every `/api/sync` call fails meanwhile.
const offline = (s, on) => on ? s.page.route('**/api/sync**', (r) => r.abort())
	: s.page.unroute('**/api/sync**');

/// One sync round from one device to another: push and confirm, pull, until `until` holds on the
/// receiver or the time is up. Answers whether it held.
async function round(from, to, until, ms = 40000) {
	const t0 = Date.now();
	do {
		await from.page.evaluate(() => window.DaimondSync.flush ? window.DaimondSync.flush() : window.DaimondSync.push()).catch(() => {});
		await to.page.evaluate(() => window.DaimondSync.pull()).catch(() => {});
		await sleep(700);
		await install(to);
		await H(to, 'refresh');
		if (!until || await until()) return true;
	} while (Date.now() - t0 < ms);
	return false;
}
const settle = async (x, y) => { await round(x, y, null); await round(y, x, null); await round(x, y, null); };

/// A stand-in folder of this name, reconnected at boot the way a granted folder is.
const standIn = (s) => s.page.evaluate(async ([folder, subs]) => {
	const root = await navigator.storage.getDirectory();
	const dir = await root.getDirectoryHandle(folder, { create: true });
	for (const d of subs) {
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
}, [FOLDER, SUBS]);
const ready = (s) => s.page.waitForFunction(() => !!(window.DaimondSync && window.DaimondCore && window.DaimondGateway
	&& DaimondGateway.state().authed), null, { timeout: 30000 }).catch(() => {});
const mode = (s) => s.page.evaluate(async () => (await import('/pkg/oxedyne_daimond.js')).workspace_mode());

/// A second device of the account: paired with `lead`, optionally holding the stand-in folder.
async function pairedDevice(lead, label, opts) {
	const d = await open(Object.assign({ name: NAME + '-' + label, signIn: false, connect: false, defaults: false,
		profile: PROFILE(label) }, opts || {}));
	await d.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 30000 }).catch(() => {});
	if (opts && opts.folder) await standIn(d);
	const code = await lead.page.evaluate(() => DaimondPairing.create());
	await d.page.evaluate((c) => DaimondPairing.redeem(c), code.code);
	await d.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(d, NAME);
	await ready(d);
	await sleep(2500);
	await install(d);
	return d;
}

let A = null, P = null, Bd = null, W = null;
try {
	// ═══ The desktop, in its browser workspace ═════════════════════════════════
	A = await open({ name: NAME, connect: false, defaults: false, profile: PROFILE('a') });
	await ready(A);
	const pro = await makePagePro(A.page, GWDIR, GW_URL);
	control('the account holds Pro, so sync can run at all', pro.pro === true, J(pro));
	await install(A);

	// ═══ P12: the phone ═══════════════════════════════════════════════════════
	P = await pairedDevice(A, 'phone', { isMobile: true, touch: true, ua: IPHONE });
	const devA = await H(A, 'dev'), devP = await H(P, 'dev');
	control('the phone is paired with its own device id, and reads as a phone',
		!!devP && devA !== devP && await P.page.evaluate(() => !!(window.DaimondShell && DaimondShell.isMobileDevice
			&& DaimondShell.isMobileDevice())), J({ devA, devP }));
	await A.page.evaluate(async () => (await import('/pkg/oxedyne_daimond.js')).write_file('notes/x.md', 'the desktop\'s notes'));
	await P.page.evaluate(async () => (await import('/pkg/oxedyne_daimond.js')).write_file('notes/x.md', 'the phone\'s notes'));
	const d12 = await A.page.evaluate(async () => { const id = await DaimondCore.diamondApp().create_diamond('MHS phone'); await DaimondCore.loadDiamonds(); return id; });
	await H(A, 'mark', d12, 'notes');
	const a12 = await H(A, 'bounds', d12);
	control('P12. the desktop\'s mark is in force on the desktop', has(a12.at, 'notes'), J(a12));
	const got12 = await round(A, P, async () => has(await H(P, 'ids'), d12));
	control('P12. the Diamond reaches the phone', got12, '');
	const p12 = await H(P, 'bounds', d12);
	check('P12. on the phone the mark waits and is not in force', !has(p12.at, 'notes') && has(p12.un, 'notes'), J(p12));
	// A Diamond's first open on a device writes to it (its daimon's conversation), which moves
	// its stamp and travels: not the press under test, so it is let settle before measuring.
	await openDiamond(P, d12);
	await settle(P, A);
	const sideA12 = await H(A, 'sidecar', d12), stA12 = await H(A, 'stamp', d12);
	const stP12 = await H(P, 'stamp', d12);
	const n12 = await notice(P);
	const noRec = await P.page.evaluate(() => DaimondI18n.t('marks.no_record'));
	check('P12. the phone\'s notice lists it and says the phone holds no record',
		n12.drawn && has(n12.rows, 'notes') && n12.why === noRec, J(n12));
	const pr12 = await press(P, '#mark-notice .mark-notice-row[data-path="notes"] [data-act="mark-use-here"]');
	const p12b = await H(P, 'bounds', d12);
	control('P12. one press on the phone brings it into force there', has(p12b.at, 'notes'), J({ pr12, p12b }));
	control('P12. the press moves no stamp on the phone', (await H(P, 'stamp', d12)) === stP12, J({ stP12, now: await H(P, 'stamp', d12) }));
	await settle(P, A);
	const a12b = await H(A, 'bounds', d12);
	control('P12. the desktop is unaffected: its sidecar and stamp unmoved, the mark in force',
		(await H(A, 'sidecar', d12)) === sideA12 && (await H(A, 'stamp', d12)) === stA12 && has(a12b.at, 'notes'),
		J({ a12b, stA12, now: await H(A, 'stamp', d12), same: (await H(A, 'sidecar', d12)) === sideA12 }));
	await P.close(); P = null;

	// ═══ Two computers, one folder name ════════════════════════════════════════
	await standIn(A);
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(A, NAME);
	await ready(A);
	await sleep(2500);
	await install(A);
	Bd = await pairedDevice(A, 'b', { folder: true });
	const B = Bd;
	const devB = await H(B, 'dev');
	control('both computers have a folder of one name open, and two device ids',
		(await mode(A)) === 'folder' && (await mode(B)) === 'folder' && devA !== devB, J({ devA, devB }));

	// ── P6: B confirms A's mark ────────────────────────────────────────────────
	const d2 = await A.page.evaluate(async () => { const id = await DaimondCore.diamondApp().create_diamond('MHS two'); await DaimondCore.loadDiamonds(); return id; });
	await H(A, 'mark', d2, 'both');
	control('P6. A\'s mark is in force on A', has((await H(A, 'bounds', d2)).at, 'both'), '');
	await round(A, B, async () => has((await H(B, 'bounds', d2)).un, 'both'));
	const b6 = await H(B, 'bounds', d2);
	control('P6. it arrives on B waiting', !has(b6.at, 'both') && has(b6.un, 'both'), J(b6));
	const stOpen0 = await H(B, 'stamp', d2);
	await openDiamond(B, d2);
	await settle(B, A);
	console.log('        · B\'s stamp before its first open ' + stOpen0 + ', after it ' + await H(B, 'stamp', d2));
	const sideB6 = await H(B, 'sidecar', d2), stB6 = await H(B, 'stamp', d2);
	const sideA6 = await H(A, 'sidecar', d2), stA6 = await H(A, 'stamp', d2);
	const pr6 = await useHere(B, d2, 'both');
	const b6b = await H(B, 'bounds', d2);
	control('P6. B\'s Use here brings it into force on B', pr6 && has(b6b.at, 'both'), J(b6b));
	check('P6. the press leaves B\'s sidecar byte-identical', (await H(B, 'sidecar', d2)) === sideB6, '');
	check('P6. and moves no stamp on B', (await H(B, 'stamp', d2)) === stB6, J({ stB6, now: await H(B, 'stamp', d2) }));
	await settle(B, A);
	check('P6. the rounds settle at a fixed point: A\'s sidecar and stamp are as they were',
		(await H(A, 'sidecar', d2)) === sideA6 && (await H(A, 'stamp', d2)) === stA6, J({ stA6, now: await H(A, 'stamp', d2) }));
	control('P6. and the mark is in force on both', has((await H(A, 'bounds', d2)).at, 'both') && has((await H(B, 'bounds', d2)).at, 'both'), '');

	// ── P6b: a legacy row confirmed on both between syncs, then removed on A ────
	await H(A, 'forge', d2, [{ id: 'leg1', ts: 5, from: 'diamond:' + d2, to: 'dir:[machine:' + FOLDER + ']legacy', rel: 'holds', note: '', by: '' }]);
	await round(A, B, async () => (await H(B, 'sidecar', d2) || '').includes('leg1'));
	// Between syncs: neither device hears the other while both press, as two computers that
	// confirm one row before either has pushed.
	await offline(A, true); await offline(B, true);
	await useHere(A, d2, 'legacy');
	await useHere(B, d2, 'legacy');
	const legLines = async (s) => String(await H(s, 'sidecar', d2) || '').split('\n').filter((l) => l.includes(']legacy'))
		.map((l) => { try { const j = JSON.parse(l); return j.id + ' ' + j.to.replace(/^.*\[/, '[') + ' by:' + j.by; } catch (e) { return l; } });
	console.log('        · legacy rows after both presses, before any sync: A ' + J(await legLines(A)) + ' B ' + J(await legLines(B)));
	await offline(A, false); await offline(B, false);
	await settle(A, B);
	await settle(B, A);
	const legRows = async (s) => String(await H(s, 'sidecar', d2) || '').split('\n').filter((l) => l.includes(']legacy')).length;
	const lr = [await legRows(A), await legRows(B)];
	console.log('        · legacy rows after the rounds: A ' + J(await legLines(A)) + ' B ' + J(await legLines(B)));
	const la = await H(A, 'bounds', d2), lb = await H(B, 'bounds', d2);
	check('P6b. after both confirm and sync: one legacy row on each device, in force on both',
		lr[0] === 1 && lr[1] === 1 && has(la.at, 'legacy') && has(lb.at, 'legacy'), J({ rows: lr, A: la.at, B: lb.at }));
	await removeHere(A, d2, 'legacy');
	await round(A, B, async () => !(await H(B, 'sidecar', d2) || '').includes(']legacy'));
	const ba = await H(A, 'bounds', d2), bb = await H(B, 'bounds', d2);
	control('P6b. after A removes it and one round it is in force and waiting nowhere',
		!has(ba.at, 'legacy') && !has(ba.un, 'legacy') && !has(bb.at, 'legacy') && !has(bb.un, 'legacy'), J({ ba, bb }));

	// ── S3: a removal crosses, and a replay of the old copy waits on B ──────────
	await H(A, 'mark', d2, 'gone');
	await round(A, B, async () => has((await H(B, 'bounds', d2)).un, 'gone'));
	await useHere(B, d2, 'gone');
	const old3 = await H(B, 'exportOf', d2);
	control('S3. the mark is in force on both before it is removed',
		has((await H(A, 'bounds', d2)).at, 'gone') && has((await H(B, 'bounds', d2)).at, 'gone'), '');
	await removeHere(A, d2, 'gone');
	await round(A, B, async () => !(await H(B, 'sidecar', d2) || '').includes(']gone'));
	const b3 = await H(B, 'bounds', d2);
	control('S3. A\'s removal reaches B', !has(b3.at, 'gone') && !has(b3.un, 'gone'), J(b3));
	await H(B, 'importOf', old3);
	const b3b = await H(B, 'bounds', d2);
	check('S3. and B\'s replay of the copy from before it comes back waiting, not in force',
		!has(b3b.at, 'gone') && has(b3b.un, 'gone'), J(b3b));
	// Put B's store back to the account's copy before the next leg.
	await settle(A, B);

	// ── S4: a narrowing crosses, a widening does not ───────────────────────────
	await H(A, 'mark', d2, 'narrow');
	await round(A, B, async () => has((await H(B, 'bounds', d2)).un, 'narrow'));
	await useHere(B, d2, 'narrow');
	control('S4. in force on B as a working mark', has((await H(B, 'bounds', d2)).at, 'narrow') && !has((await H(B, 'bounds', d2)).ro, 'narrow'), '');
	await H(A, 'relOf', d2, 'narrow', 'consulted');
	await round(A, B, async () => has((await H(B, 'bounds', d2)).ro, 'narrow'));
	control('S4. A narrows it to consulted, and B reads it read-only', has((await H(B, 'bounds', d2)).ro, 'narrow'), '');
	await H(A, 'relOf', d2, 'narrow', 'holds');
	await round(A, B, async () => (await H(B, 'sidecar', d2) || '').split('\n').some((l) => l.includes(']narrow') && l.includes('"holds"')));
	const b4 = await H(B, 'bounds', d2);
	check('S4. A widens it back to holds, and on B it stays read-only', has(b4.at, 'narrow') && has(b4.ro, 'narrow'), J(b4));

	// ── S5: ⇄ is pressed per device (O2) ──────────────────────────────────────
	await H(A, 'mark', d2, 'share');
	await round(A, B, async () => has((await H(B, 'bounds', d2)).un, 'share'));
	await useHere(B, d2, 'share');
	// Both devices hold the same copy before A shares, as they would after an ordinary round.
	await settle(B, A);
	await shareHere(A, d2, 'share', true);
	control('S5. A\'s ⇄ shares it from A', has(await H(A, 'shared'), 'share'), J(await H(A, 'shared')));
	await round(A, B, async () => (await H(B, 'sidecar', d2) || '').split('\n').some((l) => l.includes(']share') && l.includes('"share":true')));
	const s5 = await H(B, 'shared');
	check('S5. on B, the row arriving shared shares nothing', !has(s5, 'share'), J(s5));
	await openDiamond(B, d2);
	const r5 = (await panelRows(B)).share || {};
	const there = await B.page.evaluate(() => DaimondI18n.t('dws.shared_there'));
	check('S5. B\'s ⇄ is off and pressable, drawn as shared from another device',
		r5.share === false && r5.pressable === true && r5.badge === there, J({ r5, there }));
	await shareHere(B, d2, 'share', true);
	control('S5. B\'s own ⇄ shares it from B', has(await H(B, 'shared'), 'share'), J(await H(B, 'shared')));

	// ── S6: ⇄ off travels everywhere; ⇄ on again does not ─────────────────────
	await shareHere(A, d2, 'share', false);
	await round(A, B, async () => !has(await H(B, 'shared'), 'share'));
	control('S6. A\'s ⇄ off stops the share on B too', !has(await H(B, 'shared'), 'share'), J(await H(B, 'shared')));
	await shareHere(B, d2, 'share', true);
	control('S6. B turns it on again, for B', has(await H(B, 'shared'), 'share'), J(await H(B, 'shared')));
	await round(B, A, async () => (await H(A, 'sidecar', d2) || '').split('\n').some((l) => l.includes(']share') && l.includes('"share":true')));
	const s6 = await H(A, 'shared');
	check('S6. and it does not come back on on A', !has(s6, 'share'), J(s6));

	// ── S7: a tombstone drops the entries ──────────────────────────────────────
	const d7 = await A.page.evaluate(async () => { const id = await DaimondCore.diamondApp().create_diamond('MHS tomb'); await DaimondCore.loadDiamonds(); return id; });
	await H(A, 'mark', d7, 'tomb');
	await round(A, B, async () => has((await H(B, 'bounds', d7)).un, 'tomb'));
	await useHere(B, d7, 'tomb');
	control('S7. in force on B before the Diamond is destroyed', has((await H(B, 'bounds', d7)).at, 'tomb'), '');
	const old7 = await H(B, 'exportOf', d7);
	await A.page.evaluate(async (id) => { await DaimondCore.trashPurge(id); await DaimondCore.loadDiamonds(); }, d7);
	const gone7 = await round(A, B, async () => !has(await H(B, 'ids'), d7));
	control('S7. A destroys it and the tombstone reaches B', gone7, '');
	await H(B, 'importOf', old7);
	const b7 = await H(B, 'bounds', d7);
	check('S7. B\'s replay of the destroyed Diamond waits, its entry gone with the tombstone',
		!has(b7.at, 'tomb') && has(b7.un, 'tomb'), J(b7));
	await Bd.close(); Bd = null;

	// ═══ W: the record on WebKit ═══════════════════════════════════════════════
	// Playwright's WebKit is built for an older Ubuntu than this one; the libraries it lacks are
	// supplied by dev/setup-webkit-libs.sh, and its host check is skipped as dev/verify_webkit.mjs does.
	process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';
	W = await open({ name: 'mhsync-webkit', connect: false, defaults: false, browser: 'webkit', touch: true, ua: IPHONE,
		profile: PROFILE('w') });
	// A Diamond id in the store's own shape (hex, `generate_session_id`): the record refuses a key
	// the store never mints (QA 2026-09-24, F6), so the old `wkd` would measure that refusal.
	const WKD = '0ebb17000001';
	const w1 = await W.page.evaluate((WKD) => {
		const M = window.DaimondMarksHere;
		if (!M) return { module: false };
		const row = { id: 'wk1', owner: WKD, from: 'diamond:' + WKD, to: 'dir:[browser]notes', rel: 'holds', by: 'user', share: false };
		const absent = M.absent();
		const granted = M.grant(WKD, row, 'browser', { share: false });
		return { module: true, absent, granted, force: M.force(WKD, row, 'browser') };
	}, WKD);
	control('W. on WebKit the first start holds no record, and a press writes one that grants',
		w1.module && w1.absent === true && w1.granted === true && !!w1.force && w1.force.rel === 'holds', J(w1));
	await W.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(W, 'mhsync-webkit');
	await sleep(2000);
	const w2 = await W.page.evaluate((WKD) => {
		const M = window.DaimondMarksHere;
		if (!M) return { module: false };
		const row = { id: 'wk1', owner: WKD, from: 'diamond:' + WKD, to: 'dir:[browser]notes', rel: 'holds', by: 'user', share: false };
		return { module: true, absent: M.absent(), force: M.force(WKD, row, 'browser') };
	}, WKD);
	control('W. and it is kept across a reload', w2.module && w2.absent === false && !!w2.force, J(w2));
} catch (e) {
	console.log('VERIFY THREW:', e && (e.stack || e.message || e));
	bad.push('verify threw: ' + (e && e.message));
} finally {
	for (const s of [A, P, Bd, W]) { try { await s?.close?.(); } catch (e) { /* closing */ } }
	for (const x of ['a', 'phone', 'b', 'w']) { try { fs.rmSync(PROFILE(x), { recursive: true, force: true }); } catch (e) { /* tidy */ } }
}

console.log(`\nroute checks: ${tally.route[0]} held, ${tally.route[1]} failed; controls: ${tally.control[0]} held, ${tally.control[1]} failed`);
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);

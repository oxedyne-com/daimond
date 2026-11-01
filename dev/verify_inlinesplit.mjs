// gateway: live
// verify_inlinesplit.mjs -- a file a desktop carries inline while the phone offloads it: the desktop's first
// adoption of the phone's manifest places the bytes it holds (lane REV2, 2026-09-27;
// specs/daimond_fixbrief_r522_rev_20260927.md, S10). A computer and a phone, one tab each.
//
// The phone's inline ceiling is a quarter of a desktop's, so past the phone's first 256 kB of text a file rides
// inline from the desktop and as a manifest from the phone. The mailbox holds only the latest parcel, so a desktop
// that is closed while the phone pushes twice sees the phone's edit only as a manifest, adopted for the first time.
//   S   the phone edits notes/p.md (the edit takes it past its inline ceiling) and pushes twice while the desktop is
//       closed; the desktop, in its Browser storage, comes back and syncs. The phone's edit must end on both.
//   C   both edit notes/p.md while apart (the desktop in its Browser storage): both versions must survive.
//   G   as S, but the phone's edit takes the file past the per-file inline ceiling (128 kB), so no device can
//       carry it inline again (lane REV3b: the phone's first manifest named no inline parent for such bytes,
//       and the desktop read the phone's edit as a conflict; foldershare's guard 4 caught it).
//   None of S, G may leave a copy beside the file: a one-sided edit is not a conflict.
//   C2  (S13) the file is split -- the desktop carries it inline, the phone has offloaded it -- and the phone
//       edits it offline while the desktop edits it and pushes; the phone comes back and merges before it
//       pushes. Both versions must survive on both devices.
//   C2P the same, but the phone's first act on coming back is its push (collect, upload, 409, merge).
//
//   node dev/verify_inlinesplit.mjs [--arms=S,C,G,C2,C2P]
//   (The machine-folder arms F, CF, GF, C2F left with the Machine folder, unit G5.)
//   node dev/verify_inlinesplit.mjs --break nofirst    # no settle on a first adoption: S, C fail
//   node dev/verify_inlinesplit.mjs --break nogrown    # a phone's edit past the inline ceiling names no parent: G fails
//   node dev/verify_inlinesplit.mjs --break nosplit    # no placement of a held split copy (S13): C2P fails
//   node dev/verify_inlinesplit.mjs --break renameedit # a kept edit re-names V1's manifest as newest: the ancestor returns
//   --trace                                            # each device's notes/p* index entries, round by round (C2*)
import { readPage } from './pagesrc.mjs';
import { open, signInAs, scratch } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BREAK = (() => { const i = process.argv.indexOf('--break'); return i > 0 ? process.argv[i + 1] : ''; })();
const BREAKS = {
	// The settle for a manifest named here for the first time, gone: S, C and CF fail.
	nofirst: [
		{ file: 'js/daimond.js', find: "Object.keys(ix).forEach(function (k) { if (!was || !Object.prototype.hasOwnProperty.call(was, k)) keys.push(k); });", with: '' },
	],
	// A phone's edit past the per-file inline ceiling names no inline parent (ab175b54 as it was): G fails.
	nogrown: [
		{ file: 'js/daimond.js', find: "var ivNow = !agreedIn ? null : (f.size > SYNC_FILE_MAX ? '' : await inlineVerOf(f));", with: 'var ivNow = agreedIn ? await inlineVerOf(f) : null;' },
	],
	// A kept edit re-names the replaced manifest (V1's) as having seen theirs (fdd3371f): the ancestor returns in C2P.
	renameedit: [
		{ file: 'js/daimond.js', find: "await DaimondCloud.keepOurs(p, st.state === 'stale' ? (l || null) : null, r);", with: 'await DaimondCloud.keepOurs(p, l || null, r);' },
	],
	// The placement of bytes held here off the inline section, gone (S13): C2P fails.
	nosplit: [
		{ file: 'js/daimond.js', find: "var hf = null;\n\t\t\t\ttry { hf = await syncFileAt(plan, p); } catch (e) { hf = null; }", with: 'var hf = null;' },
	],
};
if (BREAK && !BREAKS[BREAK]) { console.error(`unknown break '${BREAK}'`); process.exit(2); }
const WWW = new URL('../www', import.meta.url).pathname;
const PATCHED = new Map();
for (const spec of (BREAKS[BREAK] || [])) {
	const s0 = PATCHED.get(spec.file) ?? readPage(path.join(WWW, spec.file), 'utf8');
	if (s0.split(spec.find).length !== 2) { console.error(`break '${BREAK}': anchor not unique in ${spec.file}`); process.exit(2); }
	PATCHED.set(spec.file, s0.replace(spec.find, spec.with));
}
const route = PATCHED.size ? async (page) => {
	for (const [f, body] of PATCHED) await page.route('**/' + f, (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body }));
} : null;
if (BREAK) console.log(`\n*** RUNNING UNDER --break ${BREAK}: failures below are the point ***\n`);

const ARMS = ((process.argv.find((a) => a.startsWith('--arms=')) || '--arms=S,C,G,C2,C2P').slice(7)).split(',').filter(Boolean);
const GWDIR = new URL('../gateway', import.meta.url).pathname;
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 '
	+ '(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const J = (x) => JSON.stringify(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tally = { defect: [], clean: [], ok: 0, bad: [] };
const say = (arm, defect, what, detail) => { (defect ? tally.defect : tally.clean).push(arm);
	console.log(`  ${defect ? 'DEFECT' : 'clean '} ${arm}  ${what}${detail ? ' -- ' + String(detail).slice(0, 900) : ''}`); };
const ctl = (arm, pass, what, detail) => { if (pass) tally.ok++; else tally.bad.push(arm);
	console.log(`  ${pass ? 'ok  ' : 'FAIL'} [ctl] ${arm}  ${what}${detail ? ' -- ' + String(detail).slice(0, 900) : ''}`); };
const note = (t) => console.log('  note ' + String(t).slice(0, 3000));

const ready = (s) => s.page.waitForFunction(() => !!(window.DaimondSync && window.DaimondCore && window.DaimondGateway
	&& window.DaimondCloud && DaimondGateway.state().authed), null, { timeout: 30000 }).catch(() => {});
async function paired(lead, name, label, extra = {}) {
	const d = await open({ name: name + '-' + label, signIn: false, connect: false, defaults: false,
		profile: scratch('pw', name + '-' + label), route, ...extra });
	await d.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 30000 }).catch(() => {});
	const code = await lead.page.evaluate(() => DaimondPairing.create());
	await d.page.evaluate((c) => DaimondPairing.redeem(c), code.code);
	await d.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(d, name);
	await ready(d);
	await sleep(2000);
	return d;
}
const tool = (s, name, args) => s.page.evaluate(async (a) => {
	const r = await DaimondCore.toolsApp().run_tool_outcome(a.name, JSON.stringify(a.args));
	return r ? r.outcome : 'none';
}, { name, args });
const write = async (s, p, text) => { const cut = p.lastIndexOf('/'); if (cut > 0) await tool(s, 'dir_create', { path: p.slice(0, cut) }); return tool(s, 'file_write', { path: p, content: text }); };
// What the device holds at `p` in its Browser storage (null: not held here).
const held = (s, p) => s.page.evaluate(async (p) => {
	try { const f = await DaimondCloud.fileAt(p); return f ? await f.text() : null; } catch (e) { return null; }
}, p);
// The file's content as the device would open it: held, or fetched from cloud storage.
const opened = (s, p) => s.page.evaluate(async (p) => {
	try {
		let f = await DaimondCloud.fileAt(p);
		if (!f && DaimondCloud.index()[p]) { await DaimondCloud.fetch(p); f = await DaimondCloud.fileAt(p); }
		return f ? await f.text() : null;
	} catch (e) { return null; }
}, p);
const man = (s, p) => s.page.evaluate((p) => { const m = DaimondCloud.index()[p]; return m ? { hash: m.hash, ver: m.ver || null, anc: m.anc || [] } : null; }, p);
const push = (s) => s.page.evaluate(async () => {
	try { DaimondCore.syncClearWalkCache(); } catch (e) { /* older build */ }
	const r = window.DaimondSync.flush ? await DaimondSync.flush() : await DaimondSync.push();
	return r && typeof r === 'object' ? { ok: r.ok, version: r.version } : r;
}).then(async (r) => { await sleep(400); return r; }).catch((e) => 'threw ' + e);
const pull = (s) => s.page.evaluate(async () => {
	try { DaimondCore.syncClearWalkCache(); } catch (e) { /* older build */ }
	return DaimondSync.pull();
}).then(() => sleep(400)).catch(() => {});
const offline = (s, on) => s.page.context().setOffline(!!on);
// The account's latest parcel, opened: is `p` inline in it, and which manifest names it.
const mailbox = (s, p) => s.page.evaluate(async (p) => {
	const r = await DaimondGateway.gwFetch('/api/sync', { method: 'GET', credentials: 'same-origin',
		headers: { 'x-daimond-api': String(DaimondGateway.clientApi()) } });
	const g = await r.json().catch(() => null);
	if (!g || !g.blob) return null;
	const st = JSON.parse(await DaimondIdentity.unwrap(g.blob));
	const f = (st.files || {})[p], m = (st.chunked || {})[p];
	return { v: g.version | 0, inline: typeof f === 'string' ? f.length : null, man: m ? m.hash : null };
}, p);
// Text of an exact length, distinct per tag: each line names it, so no two versions share content.
const TEXT = (tag, n) => { let s = '# ' + tag + '\n\n'; let i = 0; while (s.length < n) s += tag + ' line ' + (i++) + ' of a note that rides inline from the desktop\n'; return s.slice(0, n - 1) + '\n'; };
const P = 'notes/p.md';
const tagOf = (t, V) => { for (const [k, v] of Object.entries(V)) if (t === v) return k; return t === null ? '-' : '?(' + String(t).slice(0, 24) + ')'; };

// Anything filed beside notes/p.md: a `.synced` copy or conflict manifest in the index, or a held `.synced`.
async function beside(s) {
	const keys = await s.page.evaluate(() => Object.keys(DaimondCloud.index()).filter((k) => /^notes\/p\./.test(k) && k !== 'notes/p.md'));
	if ((await held(s, P + '.synced')) !== null && keys.indexOf(P + '.synced') < 0) keys.push(P + '.synced (held)');
	return keys;
}
// Every version of notes/p.md a device can open: at the path or beside it.
async function versionsOn(s, V) {
	const out = [];
	const keys = await s.page.evaluate(() => Object.keys(DaimondCloud.index()));
	const names = new Set([P, P + '.synced', ...keys.filter((k) => /^notes\/p/.test(k))]);
	for (const n of names) out.push(tagOf(await opened(s, n), V));
	out.push(tagOf(await held(s, P + '.synced'), V));
	return out;
}

// --trace: each device's index entries for notes/p* and what it holds there, round by round.
const TRACE = process.argv.includes('--trace');
async function trace(s, V) {
	const ix = await s.page.evaluate(async (hashes) => {
		const out = {}, ix = DaimondCloud.index();
		for (const k of Object.keys(ix).filter((k) => /^notes\/p/.test(k))) {
			const m = ix[k]; out[k] = { h: String(m.hash || '').slice(0, 8), v: m.ver || null, a: m.anc || [] };
		}
		return out;
	}, null);
	const at = { p: tagOf(await held(s, P), V), synced: tagOf(await held(s, P + '.synced'), V) };
	return { at, ix };
}
// C2, C2P (S13): the file is split -- inline from the desktop, offloaded by the phone -- and both edit it.
async function armSplit(tag) {
	const pushFirst = tag === 'C2P';
	console.log(`\n── ${tag}: notes/p.md rides inline from the desktop and is offloaded by the phone; the phone edits it offline, `
		+ `the desktop edits it and pushes; the phone comes back and ${pushFirst ? 'pushes first' : 'merges first'} ──`);
	const NAME = 'isplit' + tag.toLowerCase() + '-' + process.pid;
	let D = null, Ph = null;
	const V = { V1: TEXT('version-one', 60000), V2: TEXT('version-two-phone', 61000), VD: TEXT('version-desk', 62000) };
	const where = async () => ({ phone: tagOf(await held(Ph, P), V), desk: tagOf(await held(D, P), V) });
	try {
		D = await open({ name: NAME, connect: false, defaults: false, profile: scratch('pw', NAME + '-d'), route });
		await ready(D);
		ctl(tag, (await makePagePro(D.page, GWDIR, GW_URL)).pro === true, 'the account holds Pro');
		Ph = await paired(D, NAME, 'p', { ua: IPHONE, isMobile: true, touch: true });
		// Ballast at the phone's root, walked before notes/: 220 kB of the phone's 256 kB inline ceiling, so
		// the phone offloads V1 (60 kB) while the desktop carries it inline.
		await write(Ph, 'fill1.md', TEXT('fill-one', 110000));
		await write(Ph, 'fill2.md', TEXT('fill-two', 110000));
		await write(D, P, V.V1);
		let mb = null;
		for (let i = 0; i < 8; i++) {
			await push(D); await pull(Ph); await push(Ph); await pull(D); await push(D);
			mb = await mailbox(D, P);
			const w = await where();
			if (w.phone === 'V1' && w.desk === 'V1' && (await man(Ph, P)) && mb && mb.inline !== null) break;
		}
		ctl(tag, J(await where()) === J({ phone: 'V1', desk: 'V1' }), 'setup: notes/p.md (V1) on both', J(await where()));
		const m1 = await man(Ph, P);
		ctl(tag, !!m1 && !!mb && mb.inline !== null,
			'setup: split -- the phone has offloaded V1, the desktop carries it inline', J({ phone: m1, mb }));
		// V1's manifest offered at the path again after both edited: the common ancestor, which nobody holds.
		const ancestor = [];
		const watchAncestor = async (when) => { for (const [who, s] of [['phone', Ph], ['desk', D]]) { const m = await man(s, P); if (m1 && m && m.hash === m1.hash) ancestor.push(when + ':' + who); } };

		// The phone is offline and edits; the desktop edits and pushes.
		await offline(Ph, true);
		ctl(tag, (await write(Ph, P, V.V2)) === 'done', 'the phone edits notes/p.md offline (V2)');
		await sleep(1500);
		ctl(tag, (await write(D, P, V.VD)) === 'done', 'the desktop edits notes/p.md (VD)');
		for (let i = 0; i < 4; i++) {
			await push(D); await sleep(600);
			mb = await mailbox(D, P);
			if (mb && mb.inline === V.VD.length) break;
		}
		ctl(tag, !!mb && mb.inline === V.VD.length, 'the latest parcel carries VD inline', J(mb));
		ctl(tag, (await held(Ph, P)) === V.V2, 'the phone still holds its unpushed V2', tagOf(await held(Ph, P), V));

		// The phone comes back.
		await offline(Ph, false);
		if (TRACE) note(`${tag} before: phone ${J(await trace(Ph, V))} desk ${J(await trace(D, V))}`);
		if (pushFirst) note(`${tag}: the phone's push ${J(await push(Ph))}`);
		else await pull(Ph);
		const phoneAfter = { at: tagOf(await held(Ph, P), V), beside: await beside(Ph, false) };
		note(`${tag}: the phone after its merge holds ${J(phoneAfter)}; index ${J(await man(Ph, P))}`);
		for (let i = 0; i < 3; i++) {
			await push(Ph); if (TRACE) note(`${tag} r${i} phone pushed: ${J(await trace(Ph, V))}`);
			await pull(D); if (TRACE) note(`${tag} r${i} desk pulled: ${J(await trace(D, V))}`);
			await push(D); await pull(Ph); if (TRACE) note(`${tag} r${i} phone pulled: ${J(await trace(Ph, V))}`);
			await watchAncestor('r' + i);
		}
		const tP = await versionsOn(Ph, V), tD = await versionsOn(D, V);
		note(`${tag}: versions on the phone ${J(tP)}, on the desktop ${J(tD)}`);
		say(tag, !(tP.includes('V2') && tP.includes('VD') && tD.includes('V2') && tD.includes('VD')),
			'the phone\'s unpushed edit of a split file, or the desktop\'s, is lost when both edit it', J({ phoneAfterMerge: phoneAfter, phone: tP, desk: tD }));
		say(tag, ancestor.length > 0, 'the index offers the common ancestor (V1) at the path after both edited it', J(ancestor));
	} catch (e) {
		ctl(tag, false, 'the run completes', (e && e.stack) || e);
	} finally {
		for (const d of [Ph, D]) if (d) await d.close().catch(() => {});
	}
}

async function arm(tag) {
	const both = tag === 'C', grown = tag === 'G';
	console.log(`\n── ${tag}: the phone's edit takes notes/p.md past ${grown ? 'the per-file' : 'its'} inline ceiling while the desktop is closed`
		+ `${both ? ', and the desktop edits it too' : ''} ──`);
	const NAME = 'isplit' + tag.toLowerCase() + '-' + process.pid;
	let D = null, Ph = null;
	const V = { V1: TEXT('version-one', 10000), V2: TEXT('version-two-phone', grown ? 200000 : 60000), VD: TEXT('version-desk', 12000) };
	const where = async () => ({ phone: tagOf(await held(Ph, P), V), desk: tagOf(await held(D, P), V) });
	try {
		D = await open({ name: NAME, connect: false, defaults: false, profile: scratch('pw', NAME + '-d'), route });
		await ready(D);
		ctl(tag, (await makePagePro(D.page, GWDIR, GW_URL)).pro === true, 'the account holds Pro');
		Ph = await paired(D, NAME, 'p', { ua: IPHONE, isMobile: true, touch: true });
		// Ballast at the phone's root, walked before notes/: 220 kB of the phone's 256 kB inline ceiling.
		await write(Ph, 'fill1.md', TEXT('fill-one', 110000));
		await write(Ph, 'fill2.md', TEXT('fill-two', 110000));
		await write(D, P, V.V1);
		for (let i = 0; i < 8; i++) {
			await push(D); await pull(Ph); await push(Ph); await pull(D);
			const w = await where();
			if (w.phone === 'V1' && w.desk === 'V1') break;
		}
		ctl(tag, J(await where()) === J({ phone: 'V1', desk: 'V1' }), 'setup: notes/p.md (V1) on both', J(await where()));
		ctl(tag, !(await man(Ph, P)) && !(await man(D, P)), 'setup: V1 rides inline both ways (no manifest names it)', J({ phone: await man(Ph, P), desk: await man(D, P) }));

		// The desktop is closed; the phone edits, and its sync runs twice.
		await offline(D, true);
		if (both) ctl(tag, (await write(D, P, V.VD)) === 'done', 'the desktop edits notes/p.md while apart (VD)');
		ctl(tag, (await write(Ph, P, V.V2)) === 'done', 'the phone edits notes/p.md (V2, past its inline ceiling)');
		let mb = null;
		for (let i = 0; i < 6; i++) {
			await push(Ph); await sleep(600);
			mb = await mailbox(Ph, P);
			if (mb && mb.inline === null && mb.man) break;
		}
		const m2 = await man(Ph, P);
		ctl(tag, !!m2 && mb && mb.inline === null && mb.man === m2.hash, 'the latest parcel names V2 by its manifest only', J({ mb, m2 }));

		// The desktop comes back.
		await offline(D, false);
		await pull(D);
		note(`${tag}: the desktop after its pull: index ${J(await man(D, P))}, holds ${(await where()).desk}`);
		note(`${tag}: the desktop's push ${J(await push(D))}; the latest parcel ${J(await mailbox(D, P))}`);
		await pull(Ph);
		const phoneAfter = tagOf(await held(Ph, P), V);
		note(`${tag}: the phone after pulling the desktop's parcel holds ${phoneAfter}; index ${J(await man(Ph, P))}`);
		for (let i = 0; i < 3; i++) { await push(Ph); await pull(D); await push(D); await pull(Ph); }
		const end = { phone: tagOf(await opened(Ph, P), V), desk: tagOf(await opened(D, P), V) };
		const side = { phone: await Ph.page.evaluate(() => Object.keys(DaimondCloud.index()).filter((k) => /^notes\/p/.test(k))) };
		note(`${tag}: after three more rounds ${J(end)}; beside it ${J(side)}`);
		if (!both) {
			say(tag, phoneAfter !== 'V2' || end.phone !== 'V2' || end.desk !== 'V2',
				'the phone\'s edit is reverted by the copy the desktop carried inline', J({ phoneAfterDesktopPush: phoneAfter, end }));
			const bes = { phone: await beside(Ph), desk: await beside(D) };
			say(tag, bes.phone.length > 0 || bes.desk.length > 0,
				'a one-sided edit leaves a copy beside the file, as if both had edited it', J(bes));
		} else {
			// Both versions survive: one at the path, the other beside it (a conflict copy), on both devices.
			const texts = async (s) => {
				const out = [];
				const keys = await s.page.evaluate(() => Object.keys(DaimondCloud.index()));
				const names = new Set([P, P + '.synced', ...keys.filter((k) => /^notes\/p/.test(k))]);
				for (const n of names) out.push(tagOf(await opened(s, n), V));
				for (const n of ['notes/p.md.synced']) out.push(tagOf(await held(s, n), V));
				return out;
			};
			const tP = await texts(Ph), tD = await texts(D);
			note(`${tag}: versions on the phone ${J(tP)}, on the desktop ${J(tD)}`);
			say(tag, !(tP.includes('V2') && tP.includes('VD') && tD.includes('V2') && tD.includes('VD')),
				'an edit made on one side is lost when both edit a file the desktop carries inline', J({ phone: tP, desk: tD }));
		}
	} catch (e) {
		ctl(tag, false, 'the run completes', (e && e.stack) || e);
	} finally {
		for (const d of [Ph, D]) if (d) await d.close().catch(() => {});
	}
}

for (const a of ARMS) await (/^C2/.test(a) ? armSplit(a) : arm(a));
const failed = tally.defect.length + tally.bad.length;
console.log(failed ? `\n${tally.clean.length + tally.ok} passed, ${failed} failed (defects ${tally.defect.join(',') || 'none'}; controls ${tally.bad.join(',') || 'ok'})`
	: `\nall ${tally.clean.length + tally.ok} checks passed`);
process.exit(failed ? 1 : 0);

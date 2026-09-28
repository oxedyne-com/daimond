// gateway: none
// verify_filerecords.mjs -- one law for every file's deletion (fix/r53-faultb3,
// specs/daimond_fixbrief_r53_faultb3_20260927.md).
//
// A deletion or a return of a workspace path is one stamped record, `path -> { d, h, s }`, in the
// set js/cloud.js keeps (`chunkedTombs` in the parcel), relayed by every device, joined from every
// parcel by stamp. Before it, an inline file's deletion was an unstamped tomb that travelled only in
// its author's parcel: one push by a second device lost the news (QFB2-3), nothing could overrule it
// once the file was restored (QFB2-1), and it was honoured only from a complete census (QFB2-5).
// And the agreed-files record (the fork point) is written only into the storage location it was
// taken in (QFB2-2).
//
// One page in its own storage, the other devices stood in by parcels handed to `applySync`: a
// sender that keeps the law says `fileTombsStamped: true`; one without it is an older page.
//
//   node dev/verify_filerecords.mjs
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777). No gateway.
import fs from 'node:fs';
import { open, scratch } from './harness.mjs';

const PROFILE = scratch('pw', 'filerecords');
fs.rmSync(PROFILE, { recursive: true, force: true });

let bad = 0, good = 0;
const check = (pass, name, detail) => {
	if (pass) good++; else bad++;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' -- ' + String(detail).slice(0, 400) : ''));
};
const J = (x) => JSON.stringify(x);

const s = await open({ name: 'filerecords', profile: PROFILE, connect: false });
const { page } = s;

try {
	await page.waitForFunction(() => !!(window.DaimondCore && DaimondCore.collectSync && window.DaimondCloud
		&& DaimondCloud.tombs), null, { timeout: 20000 });
	await page.waitForTimeout(900);

	const tool = (name, args) => page.evaluate(async (a) => {
		const r = await DaimondCore.toolsApp().run_tool_outcome(a.name, JSON.stringify(a.args));
		return r ? r.outcome : 'none';
	}, { name, args });
	const write = async (p, text) => {
		const cut = p.lastIndexOf('/');
		if (cut > 0) await tool('dir_create', { path: p.slice(0, cut) });
		return tool('file_write', { path: p, content: text });
	};
	const read = (p) => page.evaluate(async (p) => {
		try { const f = await DaimondCloud.fileAt(p); return f ? await f.text() : null; } catch (e) { return null; }
	}, p);
	const collect = () => page.evaluate(async () => {
		try { DaimondCore.syncClearWalkCache(); } catch (e) { /* older build */ }
		const st = await DaimondCore.collectSync();
		return { files: Object.keys(st.files || {}), old: st.fileTombs || {}, recs: st.chunkedTombs || {},
			stamped: st.fileTombsStamped === true };
	});
	// A landing: the fork point becomes what this device holds now (in the Browser).
	const land = () => page.evaluate(async () => {
		try { DaimondCore.syncClearWalkCache(); } catch (e) { /* older build */ }
		await DaimondCore.syncCommitBaseline();
	});
	const fork = () => page.evaluate(() => { try { return JSON.parse(localStorage.getItem('daimond-sync-filebase') || '{}'); } catch (e) { return {}; } });
	// The record held for a path, read from the parcel's own set (a build before this one
	// has the set for offloaded files alone, so its checks fail one by one rather than at load).
	const rec = (p) => page.evaluate((p) => { const t = DaimondCloud.tombs()[p]; return t ? { d: t.d, h: t.h, s: t.s } : null; }, p);
	const apply = (parcel) => page.evaluate(async (parcel) => {
		try { DaimondCore.syncClearWalkCache(); } catch (e) { /* older build */ }
		const r = await DaimondCore.applySync(Object.assign({ v: 3, chats: [], tombs: {}, msgTombs: {}, diamonds: [],
			diamondTombs: {}, chunked: {} }, parcel));
		return r && r.failed ? r.failed : [];
	}, parcel);
	const now = () => page.evaluate(() => Date.now());

	// ── setup: four files agreed with the other devices ───────────────────────
	const TXT = { a: 'alpha\n', b: 'bravo\n', c: 'charlie\n', e: 'echo\n', r: 'restored\n' };
	for (const k of Object.keys(TXT)) await write('law/' + k + '.md', TXT[k]);
	await land();
	const f0 = await fork();
	check(['a', 'b', 'c', 'e', 'r'].every((k) => !!f0['law/' + k + '.md']), 'setup: every file is in the fork point', J(Object.keys(f0)));
	const c0 = await collect();
	check(c0.stamped, 'this device\'s parcel says it keeps the law (`fileTombsStamped`)');

	// ── QFB2-5: a record is valid whatever the sender's census ─────────────────
	let s0 = (await now()) + 1000;
	let rep = await apply({ files: {}, filesComplete: false, fileTombsStamped: true,
		chunkedTombs: { 'law/a.md': { d: 1, h: f0['law/a.md'], s: s0 } } });
	check(rep.length === 0, 'an incomplete parcel carrying a record merges cleanly', rep.join(','));
	check((await read('law/a.md')) === null, 'QFB2-5: a record from an incomplete census deletes the agreed copy at those bytes');
	check(!(await fork())['law/a.md'], 'and the path leaves the fork point');

	// ── control: absence deletes nothing ───────────────────────────────────────
	await apply({ files: {}, filesComplete: true, fileTombsStamped: true, chunkedTombs: {} });
	check((await read('law/b.md')) === TXT.b, '[ctl] a complete census that merely lacks a file deletes nothing');

	// ── relay: what this device joined rides its own parcel ────────────────────
	const c1 = await collect();
	check(!!c1.recs['law/a.md'] && c1.recs['law/a.md'].d === 1 && c1.recs['law/a.md'].s === s0,
		'QFB2-3: a deletion this device heard rides its own parcel (relayed)', J(c1.recs['law/a.md']));
	check(!c1.old['law/a.md'], 'and not in the old field, which carries only this device\'s own deletions');

	// ── a copy of deleted content from a sender that keeps the law is not a write ──
	await apply({ files: { 'law/a.md': TXT.a }, filesComplete: true, fileTombsStamped: true, chunkedTombs: {} });
	check((await read('law/a.md')) === null, 'a sender that keeps the law and still carries the deleted bytes does not bring them back');

	// ── QFB2-1: a restore after the deletion was carried out is a return ───────
	await write('law/a.md', TXT.a);
	const c2 = await collect();
	const ra = await rec('law/a.md');
	check(ra && ra.d === 0 && ra.s > s0, 'QFB2-1: the restored file is written back as a return, stamped past the deletion', J(ra));
	check(c2.recs['law/a.md'] && c2.recs['law/a.md'].d === 0, 'and the return rides this device\'s parcel');
	await apply({ files: {}, filesComplete: true, fileTombsStamped: true,
		chunkedTombs: { 'law/a.md': { d: 1, h: f0['law/a.md'], s: s0 } } });
	check((await read('law/a.md')) === TXT.a, 'a stale copy of the deletion relayed late does not delete the restore');

	// ── this device's own deletion ─────────────────────────────────────────────
	await tool('file_delete', { path: 'law/b.md' });
	const c3 = await collect();
	const rb = await rec('law/b.md');
	check(rb && rb.d === 1 && rb.h === f0['law/b.md'], 'this device\'s deletion is a record at the fingerprint it held', J(rb));
	check(c3.old['law/b.md'] === f0['law/b.md'], 'and rides the old field for 5.2/5.2.1 receivers, from the location it was made in');
	// Restored before its push lands: the fork point still names it, and it is not owed.
	await write('law/b.md', TXT.b);
	await collect();
	const rb2 = await rec('law/b.md');
	check(rb2 && rb2.d === 0 && rb2.s > rb.s, 'a restore of this device\'s own deletion before the push lands is a return', J(rb2));
	await apply({ files: {}, filesComplete: true, fileTombsStamped: true, chunkedTombs: { 'law/b.md': rb } });
	check((await read('law/b.md')) === TXT.b, 'and its own deletion, relayed back, does not delete the restore');
	const c4 = await collect();
	check(!c4.old['law/b.md'], 'and the old field no longer carries it');

	// ── an edit beats a delete ─────────────────────────────────────────────────
	await write('law/c.md', 'charlie, edited here\n');
	s0 = (await now()) + 1000;
	await apply({ files: {}, filesComplete: true, fileTombsStamped: true,
		chunkedTombs: { 'law/c.md': { d: 1, h: f0['law/c.md'], s: s0 } } });
	check((await read('law/c.md')) === 'charlie, edited here\n', 'a file edited here since the deletion is kept');
	await collect();
	const rc = await rec('law/c.md');
	check(rc && rc.d === 0 && rc.s > s0, 'and returned, so the edit reaches the devices that deleted it', J(rc));

	// ── a return from elsewhere overrules a held deletion ──────────────────────
	s0 = (await now()) + 1000;
	await apply({ files: {}, filesComplete: true, fileTombsStamped: true,
		chunkedTombs: { 'law/new.md': { d: 1, h: 'x1:1', s: s0 } } });
	await apply({ files: { 'law/new.md': 'made again elsewhere\n' }, filesComplete: true, fileTombsStamped: true,
		chunkedTombs: { 'law/new.md': { d: 0, h: '', s: s0 + 5 } } });
	check((await read('law/new.md')) === 'made again elsewhere\n', 'a path written again elsewhere, with its return, is adopted');

	// ── an older page ──────────────────────────────────────────────────────────
	// Its own tombstone, from a complete census, still deletes (the 5.2.1 rule).
	await land();
	const f1 = await fork();
	await apply({ files: {}, filesComplete: true, fileTombs: { 'law/e.md': f1['law/e.md'] } });
	check((await read('law/e.md')) === null, 'an older page\'s own tombstone from a complete census still deletes');
	// Not from an incomplete one.
	await apply({ files: {}, filesComplete: false, fileTombs: { 'law/r.md': f1['law/r.md'] } });
	check((await read('law/r.md')) === TXT.r, '[ctl] nor from an incomplete census (the 5.2.1 rule)');
	// Its copy of deleted content is a write: adopted and returned.
	s0 = (await now()) + 1000;
	await apply({ files: {}, filesComplete: false, fileTombsStamped: true,
		chunkedTombs: { 'law/r.md': { d: 1, h: f1['law/r.md'], s: s0 } } });
	check((await read('law/r.md')) === null, 'setup: law/r.md deleted by a record');
	await apply({ files: { 'law/r.md': TXT.r }, filesComplete: true });
	const rr = await rec('law/r.md');
	check((await read('law/r.md')) === TXT.r && rr && rr.d === 0 && rr.s > s0,
		'an older page\'s copy of a deleted file is taken as its write, and returned', J(rr));
	// Not deleted by an older page's tombstone once a return is held.
	await land();
	await apply({ files: {}, filesComplete: true, fileTombs: { 'law/r.md': (await fork())['law/r.md'] } });
	check((await read('law/r.md')) === TXT.r, 'an older page\'s unstamped tombstone does not overrule a return held here');

	// ── QFB2-2: the agreed-files record is written into the location it was taken in ──
	const before = await fork();
	await page.evaluate(async () => {
		await DaimondCore.syncCommitBaseline({ files: { 'shared/elsewhere.md': 'zz:1' }, cloud: {},
			loc: 'folder:verify:shared', left: [], taken: true });
	});
	const after = await fork();
	const there = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('daimond-sync-filebase@folder:verify:shared') || '{}'); } catch (e) { return {}; } });
	check(J(after) === J(before), 'QFB2-2: a landing collected in another location leaves this location\'s fork point alone',
		J({ before: Object.keys(before).length, after: Object.keys(after).length }));
	check(there['shared/elsewhere.md'] === 'zz:1', 'and writes that location\'s own', J(there));
	await page.evaluate(async () => {
		await DaimondCore.syncCommitBaseline({ files: {}, cloud: {}, loc: null, left: [], taken: false });
	});
	check(J(await fork()) === J(before), 'a landing whose parcel had no census agrees nothing about files');
	const c5 = await collect();
	check(!Object.keys(c5.recs).some((p) => p.startsWith('shared/')), 'and this location tombs nothing it never held', J(Object.keys(c5.recs)));

	// ── QFB3-1 (fix/r53-faultb4): what one merge agreed and then deleted ─────────
	// A copy found identical on both sides and then deleted by a record leaves the fork point.
	const Y = 'y: agreed, then deleted by a record while a sender still carried it\n';
	await write('law/y.md', Y);
	await land();
	const fy = (await fork())['law/y.md'];
	s0 = (await now()) + 1000;
	await apply({ files: { 'law/y.md': Y }, filesComplete: true, fileTombsStamped: true,
		chunkedTombs: { 'law/y.md': { d: 1, h: fy, s: s0 } } });
	check((await read('law/y.md')) === null && !(await fork())['law/y.md'],
		'QFB3-1: a copy agreed and deleted in one merge leaves the fork point', J((await fork())['law/y.md']));
	await apply({ files: { 'law/y.md': Y }, filesComplete: true, fileTombsStamped: true,
		chunkedTombs: { 'law/y.md': { d: 0, h: '', s: s0 + 4000 } } });
	await collect();
	const ry = await rec('law/y.md');
	check((await read('law/y.md')) === Y && ry && ry.d === 0,
		'and a byte-for-byte restore arriving later is taken, not deleted again past its return', J(ry));
	// An older page's copy of deleted content, identical to the copy here, is its write.
	const X = 'x: an older page holds this too\n';
	await write('law/x.md', X);
	await land();
	const fx = (await fork())['law/x.md'];
	s0 = (await now()) + 1000;
	await apply({ files: { 'law/x.md': X }, filesComplete: true, chunkedTombs: { 'law/x.md': { d: 1, h: fx, s: s0 } } });
	const rx = await rec('law/x.md');
	check((await read('law/x.md')) === X && rx && rx.d === 0 && rx.s > s0,
		'QFB3-1: an older page\'s identical copy of deleted content is its write: kept here and returned', J(rx));
	const cx = await collect();
	check(!cx.old['law/x.md'] && cx.recs['law/x.md'] && cx.recs['law/x.md'].d === 0,
		'and this device sends the return, never the deletion as its own', J({ old: cx.old['law/x.md'] || null, rec: cx.recs['law/x.md'] }));

	// ── fixed point ────────────────────────────────────────────────────────────
	const k1 = await page.evaluate(async () => { const st = await DaimondCore.collectSync(); return JSON.stringify([st.chunkedTombs, st.fileTombs, st.files]); });
	const k2 = await page.evaluate(async () => { const st = await DaimondCore.collectSync(); return JSON.stringify([st.chunkedTombs, st.fileTombs, st.files]); });
	check(k1 === k2, 'two collects agree (the parcel is a fixed point)');
} catch (e) {
	check(false, 'the run completes', (e && e.stack) || e);
} finally {
	await s.close().catch(() => {});
}
console.log(`\nverify_filerecords: ${good} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);

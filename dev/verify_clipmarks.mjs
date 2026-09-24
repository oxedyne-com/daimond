// verify_clipmarks.mjs -- the paperclip acts on this workspace's mark, and asks before a grant.
//
// Four findings of the marks QA (specs/daimond_r3_qa_marks_20260924.md, R2 QA 2026-09-24),
// each proved failing at 7d36f8be and passing after (sessions A-C):
//
//   M1     Keep's transcript row waited for "Use here" on the device that kept it: a row in
//          the Diamond's own directory is a listing, never a mark.
//   M3     the paperclip on `books` took another workspace's mark on `books` off -- a removal,
//          which travels -- and added nothing; the chat's paperclip and the `+` did the same,
//          and the away text said "this machine" of another device's mark.
//   TOUCH  on a waiting mark one tap on the paperclip granted it, where a touch screen shows
//          no title to warn of it: the tap now opens "Use here".
//   M4     the Help seed was in force read-only in any machine folder, with no press there.
//
// The marks r5 QA round 2 (specs/daimond_fixqa_marks_r5_20260925.md) and its own build
// record (specs/daimond_fixbrief_marks_r5_20260925.md), proved failing at 2052fdd6 and
// passing after (sessions D-F, and item 4 appended to session C):
//
//   F1     one held Enter opened "Use here" AND granted it in the same stroke: the dialog
//          now takes R6's guard, focused on Cancel with the yes disabled for a second.
//   F2     of two rows for one folder, the paperclip drew the row in force but a press acted
//          on the first row in sidecar order; "Use here" now names what it would grant.
//   F3     a legacy, machine-rooted Keep transcript row read as living on another workspace;
//          a store path is now reachable from any workspace, whatever root it was written
//          under.
//   item4  Forget left a machine folder's marks in force until reload; it now drops this
//          device's record of them at once (M2-R2-1).
//   item7  the paperclip matched a fold's `produced` row and deleted it on a press, granting
//          nothing; it now acts only on the person's own marks.
//   item8  a chat's Doc-header paperclip never drew a waiting holding as waiting; it now
//          reads the tree's own test.
//
// item 5 (M2-R2-2, the cloud index left out of "Forget this identity") has its own probe:
// dev/verify_forgetkeys.mjs, extended with the seed and the check rather than duplicated
// here, since it already drives the real "Forget this identity" flow item 5 needs.
//
//   item6  the guide mirror and the usage digest were written into whatever folder was
//          open at seeding, and the seed grant named it; both are the app's own store now,
//          whatever was open (session G).
//
//   node dev/verify_clipmarks.mjs        (inside a world: eval "$(bash dev/world.sh N --up)")
//
// Exits 1 unless every check passed AND there were exactly EXPECTED of them, so a check
// that silently fell away fails the run too.
import { open, newChat, chat, scratch, storedChats, standInFolders } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (x) => JSON.stringify(x);
const EXPECTED = 58;

const ok = [], bad = [];
function check(name, cond, detail) {
	if (cond) { ok.push(name); console.log('  ok   ' + name); }
	else { bad.push(name); console.log('  FAIL ' + name + (detail ? ' -- ' + String(detail).slice(0, 400) : '')); }
}

const DEV = '0123456789abcdef';	// a device that is not this one

/// Every row a Diamond keeps of its own, as `[to, rel, by]`.
const rowsOf = (p, id) => p.evaluate(async (id) => JSON.parse(await DaimondCore.diamondApp().links_touching('diamond:' + id) || '[]')
	.filter((l) => l.owner === id && l.from === 'diamond:' + id), id);

async function makeDiamond(p, name, rows) {
	return p.evaluate(async ({ name, rows }) => {
		const app = DaimondCore.diamondApp();
		const id = await app.create_diamond(name);
		for (const r of rows) await app.add_link(id, 'diamond:' + id, r.to, r.rel || 'holds', '', r.by || 'user');
		await DaimondCore.loadDiamonds();
		document.dispatchEvent(new CustomEvent('daimond-links-changed'));
		return id;
	}, { name, rows });
}

async function openDiamond(p, id) {
	await p.evaluate((id) => { const b = document.querySelector('.diamond-box[data-id="' + id + '"]'); if (b) b.click(); }, id);
	await sleep(1500);
}

async function showWork(p) {
	await p.evaluate(() => window.DaimondPanels && DaimondPanels.show('work'));
	await sleep(600);
	await p.click('#panel-work [data-act="refresh"]', { force: true }).catch(() => {});
	await sleep(1200);
}

const clipSel = (path) => '#panel-work .files-row [data-act="attach"][data-path="' + path + '"]';
const clipState = (p, path) => p.evaluate((sel) => {
	const b = document.querySelector(sel);
	return b ? { pressed: b.getAttribute('aria-pressed'), cls: b.className, title: b.title } : null;
}, clipSel(path));

const askUp = (p) => p.evaluate(() => {
	const m = document.querySelector('.modal.dlg[data-ask="mark-use-here"]');
	if (!m) return null;
	return { ok: (m.querySelector('.dlg-ok') || {}).textContent || '', msg: (m.querySelector('.dlg-msg') || {}).textContent || '',
		title: (m.querySelector('h2') || {}).textContent || '' };
});
const anyDialog = (p) => p.evaluate(() => !!document.querySelector('.modal.dlg'));

// ════════════════════════════════════════════════════════════════════════
// Session A: a desktop, the browser workspace. M1 and M3.
// ════════════════════════════════════════════════════════════════════════
{
	const s = await open({ name: 'r5a', defaults: false, profile: scratch('pw', 'r5a-' + process.pid) });
	const p = s.page;
	try {
		// ── M1: Keep ────────────────────────────────────────────────────
		await newChat(s);
		await chat(s, 'hello for keep');
		await sleep(1500);
		const cur = await p.evaluate(() => (window.DaimondCore.currentChatId && DaimondCore.currentChatId()) || null);
		const cid = cur || ((await storedChats(s)).map((c) => c.id)[0]);
		await p.evaluate((cid) => { window.__kept = DaimondCore.keepAsDiamond(cid); }, cid);
		await sleep(1500);
		await p.keyboard.type('KeepProbe');
		await p.keyboard.press('Enter');
		await sleep(4000);
		const kid = await p.evaluate(async () => {
			const list = JSON.parse(await DaimondCore.diamondApp().list_diamonds() || '[]');
			const d = list.find((x) => x.name === 'KeepProbe');
			return d ? d.id : '';
		});
		const krows = kid ? await rowsOf(p, kid) : [];
		const tr = krows.find((l) => /transcript\.md$/.test(l.to)) || null;
		check('M1. control: Keep made the Diamond and its transcript row (holds, the user\'s)',
			!!kid && !!tr && tr.rel === 'holds' && tr.by === 'user', J({ kid, krows }));
		const k1 = await p.evaluate(({ kid, tr }) => ({
			waiting: DaimondMarksHere.waiting(kid, tr, DaimondAttach.root()),
			force: DaimondMarksHere.force(kid, tr, DaimondAttach.root()),
		}), { kid, tr });
		check('M1. the transcript does not wait for "Use here" on the device that kept it',
			tr && k1.waiting === false, J(k1));
		// Another device: every press it made is in its own record, and it made none here.
		const k2 = await p.evaluate(({ kid, tr }) => {
			const key = ((window.DaimondAccounts && DaimondAccounts.prefix()) || '') + 'daimond-marks-here';
			const was = localStorage.getItem(key);
			localStorage.setItem(key, '{"v":1,"d":{},"c":{}}');
			const w = DaimondMarksHere.waiting(kid, tr, DaimondAttach.root());
			if (was === null) localStorage.removeItem(key); else localStorage.setItem(key, was);
			return w;
		}, { kid, tr });
		check('M1. nor on a device whose record holds no press of it', tr && k2 === false, J(k2));
		check('M1. its reference names no workspace, since diamonds/ is the store and follows no folder',
			tr && tr.to === 'file:diamonds/' + kid + '/transcript.md', tr && tr.to);
		const kb = await p.evaluate(async (kid) => {
			const b = await DaimondDiamond.bounds(kid);
			return { un: b.unconfirmed || [], at: b.attached || [] };
		}, kid);
		check('M1. control: the daimon is not told the transcript is unconfirmed',
			!kb.un.some((x) => /transcript/.test(x)), J(kb));
		// The file's own paperclip, in the Doc header.
		await p.evaluate((kid) => window.DaimondDoc.show('diamonds/' + kid + '/transcript.md'), kid);
		await sleep(1800);
		const hc = await p.evaluate(() => {
			const b = document.querySelector('#doc-view [data-act="attach"]');
			return b ? { on: b.classList.contains('on'), away: b.classList.contains('away'), title: b.title } : null;
		});
		check('M1. the transcript\'s paperclip reads held, not waiting to be confirmed',
			!!hc && hc.on && !hc.away, J(hc));
		// And in the tree of the Diamond's own directory, where a press on it acts on that row.
		await showWork(p);
		await p.click('#panel-work [data-scope="diamond"]', { force: true }).catch(() => {});
		await sleep(1500);
		const tc = await clipState(p, 'diamonds/' + kid + '/transcript.md');
		await p.click('#panel-work [data-scope="all"]', { force: true }).catch(() => {});
		await sleep(1000);
		check('M1. in the Diamond\'s own tree the transcript\'s paperclip reads held too',
			!!tc && tc.pressed === 'true' && !/\baway\b/.test(tc.cls), J(tc));

		// ── M3: the tree's paperclip in the browser workspace ─────────────
		await p.evaluate(async () => {
			const m = await import('/pkg/oxedyne_daimond.js');
			await m.store_write('books/a.txt', 'x');
			await m.store_write('shelf/a.txt', 'x');
			await m.store_write('tbooks/a.txt', 'x');
		});
		const machBooks = 'dir:[machine:usr@' + DEV + ']books';
		const d3 = await makeDiamond(p, 'M3 clip', [{ to: machBooks }]);
		await openDiamond(p, d3);
		await showWork(p);
		const c0 = await clipState(p, 'books');
		check('M3. the paperclip on books is not drawn pressed for another workspace\'s mark',
			!!c0 && c0.pressed === 'false', J(c0));
		await p.click(clipSel('books'), { force: true }).catch(() => {});
		await sleep(2500);
		const r3 = await rowsOf(p, d3);
		check('M3. the press leaves the other workspace\'s mark in place (no removal to travel)',
			r3.some((l) => l.to === machBooks), J(r3.map((l) => l.to)));
		const f3 = await p.evaluate((id) => DaimondAttach.inForce(id, 'dir:[browser]books'), d3);
		check('M3. and adds this workspace\'s own mark, in force here',
			r3.some((l) => l.to === 'dir:[browser]books') && !!f3 && f3.rel === 'holds', J({ rows: r3.map((l) => l.to), f3 }));
		const b3 = await p.evaluate((id) => DaimondDiamond.bounds(id), d3);
		check('M3. the fence holds books here, and nothing waits', (b3.attached || []).includes('books')
			&& !(b3.unconfirmed || []).includes('books'), J(b3));
		const c1 = await clipState(p, 'books');
		check('M3. the paperclip now reads pressed and in force', !!c1 && c1.pressed === 'true' && !/\baway\b/.test(c1.cls), J(c1));
		// A second press takes off this workspace's mark, and only it.
		await p.click(clipSel('books'), { force: true }).catch(() => {});
		await sleep(2000);
		const r3b = (await rowsOf(p, d3)).map((l) => l.to);
		check('M3. a second press takes this workspace\'s mark off and leaves the other\'s',
			r3b.includes(machBooks) && !r3b.includes('dir:[browser]books'), J(r3b));

		// ── M3: where the other device's mark lives ──────────────────────
		const wh = await p.evaluate(({ ref }) => ({
			where: DaimondAttach.where(ref),
			want: DaimondI18n.t('dws.on_device', { name: 'usr', device: '012345' }),
			local: DaimondI18n.t('dws.in_machine', { name: 'usr' }),
		}), { ref: machBooks });
		check('M3. the away text names the device from the reference, not "this machine"',
			wh.where === wh.want && wh.where !== wh.local, J(wh));

		// ── M3: the `+` picker ───────────────────────────────────────────
		const machShelf = 'dir:[machine:usr@' + DEV + ']shelf';
		const dp = await makeDiamond(p, 'M3 plus', [{ to: machShelf }]);
		await openDiamond(p, dp);
		await p.evaluate(() => {
			const strip = document.getElementById('arte-strip');
			if (strip) strip.dataset.open = '1';
			return window.DaimondArtefacts && DaimondArtefacts.render();
		});
		await sleep(900);
		await p.click('#arte-list [data-act="attach-add"]', { force: true }).catch(() => {});
		await p.waitForSelector('.attach-pick-row', { timeout: 10000 }).catch(() => {});
		await sleep(700);
		const pk = await p.evaluate(() => {
			const rows = [...document.querySelectorAll('.attach-pick-row')];
			const r = rows.find((x) => /(^|\s)shelf$/.test((x.querySelector('.attach-pick-name') || {}).textContent || ''));
			if (!r) return { found: false, rows: rows.map((x) => (x.querySelector('.attach-pick-name') || {}).textContent) };
			const i = r.querySelector('input');
			const was = { ticked: i.checked, fixed: i.disabled };
			if (!i.disabled && !i.checked) i.click();
			return { found: true, was };
		});
		await p.click('.dlg-ok', { force: true }).catch(() => {});
		await sleep(1500);
		const rp = (await rowsOf(p, dp)).map((l) => l.to);
		const fp = await p.evaluate((id) => DaimondAttach.inForce(id, 'dir:[browser]shelf'), dp);
		check('M3. the `+` offers shelf, marked only in another workspace, and marks it here',
			pk.found && !pk.was.fixed && rp.includes('dir:[browser]shelf') && rp.includes(machShelf) && !!fp,
			J({ pk, rp, fp }));

		// ── M3: a chat's paperclip ───────────────────────────────────────
		const cc = await newChat(s);
		await p.evaluate(({ cc, ref }) => {
			DaimondAttach.chatList(cc).push({ ref, dir: true, path: 'books', state: 'note', ws: true });
			DaimondAttach.render();
		}, { cc, ref: machBooks });
		await showWork(p);
		const cc0 = await clipState(p, 'books');
		await p.click(clipSel('books'), { force: true }).catch(() => {});
		await sleep(1500);
		const ch = await p.evaluate((cc) => (DaimondAttach.chatList(cc) || []).map((a) => a.ref), cc);
		check('M3. a chat\'s paperclip leaves another workspace\'s holding and adds this one\'s',
			ch.includes(machBooks) && ch.includes('dir:[browser]books'), J({ cc0, ch }));
	} catch (e) { check('session A ran to the end', false, e && e.stack); }
	await s.browser.close().catch(() => {});
}

// ════════════════════════════════════════════════════════════════════════
// Session B: a touch screen. The paperclip on a waiting mark.
// ════════════════════════════════════════════════════════════════════════
{
	const s = await open({ name: 'r5b', defaults: false, touch: true, isMobile: true, profile: scratch('pw', 'r5b-' + process.pid) });
	const p = s.page;
	try {
		await p.evaluate(async () => {
			const m = await import('/pkg/oxedyne_daimond.js');
			await m.store_write('tbooks/a.txt', 'x');
			await m.store_write('tchat/a.txt', 'x');
			await m.store_write('tnote.md', '# note\n');
		});
		// Marks made on another device: rows in the sidecar, nothing pressed here.
		const tb = 'dir:[browser]tbooks', tn = 'file:[browser]tnote.md';
		const dt = await makeDiamond(p, 'Touch clip', [{ to: tb }, { to: tn }]);
		await openDiamond(p, dt);
		await showWork(p);
		const w0 = await p.evaluate(async ({ id, tb }) => {
			const b = await DaimondDiamond.bounds(id);
			return { un: b.unconfirmed || [], f: await DaimondAttach.inForce(id, tb), touch: matchMedia('(pointer: coarse)').matches };
		}, { id: dt, tb });
		check('TOUCH. control: a coarse pointer, and tbooks waits here', w0.touch && w0.un.includes('tbooks') && !w0.f, J(w0));
		await p.tap(clipSel('tbooks')).catch((e) => console.log('tap failed', String(e.message).slice(0, 200)));
		await sleep(1500);
		const f1 = await p.evaluate(({ id, tb }) => DaimondAttach.inForce(id, tb), { id: dt, tb });
		check('TOUCH. one tap on a waiting mark\'s paperclip grants nothing', !f1, J(f1));
		const a1 = await askUp(p);
		const want = await p.evaluate(() => DaimondI18n.t('marks.use_here'));
		check('TOUCH. it opens "Use here", naming the mark', !!a1 && a1.ok.trim() === want && /tbooks/.test(a1.msg), J(a1));
		await p.tap('.modal.dlg .dlg-cancel').catch(() => {});
		await sleep(900);
		const c2 = await p.evaluate(async ({ id, tb }) => ({
			f: await DaimondAttach.inForce(id, tb),
			rows: JSON.parse(await DaimondCore.diamondApp().links_touching('diamond:' + id) || '[]').map((l) => l.to),
			dlg: !!document.querySelector('.modal.dlg'),
		}), { id: dt, tb });
		check('TOUCH. Cancel leaves it waiting, and its row in place', !c2.f && c2.rows.includes(tb) && !c2.dlg, J(c2));
		await p.tap(clipSel('tbooks')).catch(() => {});
		await sleep(1200);
		await p.tap('.modal.dlg[data-ask="mark-use-here"] .dlg-ok').catch(() => {});
		await sleep(1500);
		const f3 = await p.evaluate(({ id, tb }) => DaimondAttach.inForce(id, tb), { id: dt, tb });
		check('TOUCH. "Use here" in it brings the mark into force, unshared', !!f3 && f3.rel === 'holds' && f3.share === false, J(f3));

		// The Doc header's paperclip on a waiting file mark.
		await p.evaluate(() => window.DaimondDoc.show('tnote.md'));
		await sleep(1800);
		await p.tap('#doc-view [data-act="attach"]').catch((e) => console.log('tap failed', String(e.message).slice(0, 200)));
		await sleep(1500);
		const hf = await p.evaluate(({ id, tn }) => DaimondAttach.inForce(id, tn), { id: dt, tn });
		const ha = await askUp(p);
		check('TOUCH. the Doc header\'s paperclip on a waiting file asks, and grants nothing', !hf && !!ha, J({ hf, ha }));
		await p.keyboard.press('Escape');
		await sleep(600);
		const hr = await p.evaluate(async ({ id, tn }) => ({
			f: await DaimondAttach.inForce(id, tn),
			rows: JSON.parse(await DaimondCore.diamondApp().links_touching('diamond:' + id) || '[]').map((l) => l.to),
		}), { id: dt, tn });
		check('TOUCH. dismissed, the file mark still waits, and its row is in place', !hr.f && hr.rows.includes(tn), J(hr));

		// A chat's holding claimed on another device.
		const cc = await newChat(s);
		const tc = 'dir:[browser]tchat';
		await p.evaluate(({ cc, tc }) => {
			DaimondAttach.chatList(cc).push({ ref: tc, dir: true, path: 'tchat', state: 'note', ws: true });
			DaimondAttach.render();
		}, { cc, tc });
		await showWork(p);
		await p.tap(clipSel('tchat')).catch((e) => console.log('tap failed', String(e.message).slice(0, 200)));
		await sleep(1500);
		const cf = await p.evaluate(({ cc, tc }) => ({ f: DaimondAttach.chatInForce(cc, tc), list: DaimondAttach.chatList(cc).map((a) => a.ref) }), { cc, tc });
		const ca = await askUp(p);
		check('TOUCH. a chat\'s paperclip on a waiting holding asks, and grants nothing', !cf.f && cf.list.includes(tc) && !!ca, J({ cf, ca }));
		await p.tap('.modal.dlg[data-ask="mark-use-here"] .dlg-ok').catch(() => {});
		await sleep(1200);
		const cf2 = await p.evaluate(({ cc, tc }) => DaimondAttach.chatInForce(cc, tc), { cc, tc });
		check('TOUCH. and "Use here" in it brings the holding into force', !!cf2 && cf2.ws === true, J(cf2));

		// "Mark here" says what it does, so it confirms at once.
		const tm = 'dir:[browser]tmark';
		await p.evaluate(async () => { const m = await import('/pkg/oxedyne_daimond.js'); await m.store_write('tmark/a.txt', 'x'); });
		const dm = await makeDiamond(p, 'Touch mark', [{ to: tm }]);
		await openDiamond(p, dm);
		await showWork(p);
		await p.evaluate(() => {
			const r = [...document.querySelectorAll('#panel-work .files-row')].find((x) => /tmark/.test((x.querySelector('.files-name') || {}).textContent || ''));
			if (r) r.click();
		});
		await sleep(1500);
		const mh = await p.evaluate(() => !!document.querySelector('#panel-work [data-act="mark-here"]'));
		await p.tap('#panel-work [data-act="mark-here"]').catch(() => {});
		await sleep(1500);
		const fm = await p.evaluate(({ id, tm }) => DaimondAttach.inForce(id, tm), { id: dm, tm });
		check('TOUCH. control: "Mark here", which names what it does, confirms a waiting mark at once',
			mh && !!fm && !(await anyDialog(p)), J({ mh, fm }));
	} catch (e) { check('session B ran to the end', false, e && e.stack); }
	await s.browser.close().catch(() => {});
}

// ════════════════════════════════════════════════════════════════════════
// Session C: the seeds, in the browser and in a machine folder. M4.
// ════════════════════════════════════════════════════════════════════════
{
	const s = await open({ name: 'r5c', defaults: true, profile: scratch('pw', 'r5c-' + process.pid) });
	const p = s.page;
	const HELP = '0da1000000e1';
	let folders = null;
	try {
		let seeded = false;
		for (let i = 0; i < 40 && !seeded; i++) {
			seeded = await p.evaluate(async (h) => {
				const rows = JSON.parse(await DaimondCore.diamondApp().links_touching('diamond:' + h) || '[]');
				return rows.some((l) => /system\/guide$/.test(l.to));
			}, HELP);
			if (!seeded) await sleep(500);
		}
		const b0 = await p.evaluate((h) => DaimondDiamond.bounds(h), HELP);
		check('M4. control: in the browser workspace Help reads its guide with no press',
			seeded && (b0.read_only || []).includes('system/guide') && !(b0.unconfirmed || []).includes('system/guide'), J({ seeded, b0 }));
		folders = await standInFolders(s, { tag: 'r5m4', name: 'usr', which: ['a'], dirs: ['system'] });
		const pk = await folders.pick('a');
		// A Help row naming this machine folder: what the seeding wrote on a device that
		// booted with the folder open, or what a sync or a forged parcel brings.
		const onDisk = await p.evaluate(() => DaimondAttach.ref('dir', 'system/guide'));
		await p.evaluate(async ({ h, ref }) => {
			await DaimondCore.diamondApp().add_link(h, 'diamond:' + h, ref, 'consulted', '', 'user');
			document.dispatchEvent(new CustomEvent('daimond-links-changed'));
		}, { h: HELP, ref: onDisk });
		await sleep(600);
		const m1 = await p.evaluate(async ({ h, ref }) => ({
			root: DaimondAttach.root(),
			f: await DaimondAttach.inForce(h, ref),
			b: await DaimondDiamond.bounds(h),
		}), { h: HELP, ref: onDisk });
		check('M4. control: a machine folder called usr is open', pk.landed && /^machine:usr#[0-9a-f]{32}$/.test(m1.root)
			&& /^dir:\[machine:usr@[0-9a-f]+\]system\/guide$/.test(onDisk), J({ pk, root: m1.root, onDisk }));
		check('M4. there, a Help row naming the folder grants nothing with no press',
			!m1.f && !(m1.b.attached || []).includes('system/guide') && !(m1.b.read_only || []).includes('system/guide'), J(m1));
		check('M4. it waits for "Use here", and the daimon is told so', (m1.b.unconfirmed || []).includes('system/guide'), J(m1.b));
		const m2 = await p.evaluate(async ({ h, ref }) => {
			const c = await DaimondAttach.confirmHere(h, ref);
			return { c, f: await DaimondAttach.inForce(h, ref), b: await DaimondDiamond.bounds(h) };
		}, { h: HELP, ref: onDisk });
		check('M4. pressed here, it is in force read-only in this folder', !!m2.f && m2.f.rel === 'consulted' && m2.f.share === false
			&& (m2.b.read_only || []).includes('system/guide'), J(m2));
		const m3 = await p.evaluate((h) => DaimondAttach.inForce(h, 'dir:[browser]system/guide'), HELP);
		check('M4. control: the browser seed row grants nothing in the machine folder', !m3, J(m3));

		// ── item 4 (M2-R2-1): Forget drops this device's marks at once ────
		//
		// A second Diamond's mark, pressed in this same machine folder, so Forget's
		// effect is seen on a row `showMachineInfo` never touches directly.
		const d4 = await p.evaluate(() => DaimondCore.diamondApp().create_diamond('Forget probe'));
		const fref = await p.evaluate(() => DaimondAttach.ref('dir', 'system'));
		await p.evaluate(async ({ id, ref }) => {
			await DaimondCore.diamondApp().add_link(id, 'diamond:' + id, ref, 'holds', '', 'user');
			document.dispatchEvent(new CustomEvent('daimond-links-changed'));
			await DaimondAttach.confirmHere(id, ref);
		}, { id: d4, ref: fref });
		await sleep(600);
		const before4 = await p.evaluate(async ({ id, ref }) => ({
			f: await DaimondAttach.inForce(id, ref),
			b: await DaimondDiamond.bounds(id),
		}), { id: d4, ref: fref });
		check('item4. control: a second Diamond\'s mark is in force in this machine folder',
			!!before4.f && (before4.b.attached || []).includes('system'), J(before4));
		// The active chip opens `showMachineInfo`, which draws the Forget button.
		// Clicked in the page (`el.click()`), not through Playwright's mouse -- the
		// mode row sits under other rows this fixture never scrolls to, and a
		// coordinate click lands on whatever is actually on top at that point.
		await showWork(p);
		await p.evaluate(() => { const c = document.querySelector('#panel-work .files-mode-chip.active'); if (c) c.click(); });
		await sleep(700);
		const sawForget = await p.evaluate(() => !!document.querySelector('#panel-work .files-mode-forget'));
		await p.evaluate(() => { const b = document.querySelector('#panel-work .files-mode-forget'); if (b) b.click(); });
		await sleep(1000);
		const after4 = await p.evaluate(async ({ id, ref }) => ({
			f: await DaimondAttach.inForce(id, ref),
			b: await DaimondDiamond.bounds(id),
		}), { id: d4, ref: fref });
		check('item4 (M2-R2-1). Forget drops this device\'s mark at once, with no reload',
			sawForget && !after4.f && !(after4.b.attached || []).includes('system'), J({ sawForget, after4 }));
	} catch (e) { check('session C ran to the end', false, e && e.stack); }
	if (folders) await folders.tidy();
	await s.browser.close().catch(() => {});
}

// ════════════════════════════════════════════════════════════════════════
// Session D: F1 -- a held Enter must not grant "Use here" in the same stroke.
// ════════════════════════════════════════════════════════════════════════
{
	const s = await open({ name: 'r5d', defaults: false, profile: scratch('pw', 'r5d-' + process.pid) });
	const p = s.page;
	try {
		await p.evaluate(async () => {
			const m = await import('/pkg/oxedyne_daimond.js');
			await m.store_write('kb1/a.txt', 'x');
		});
		const kb1 = 'dir:[browser]kb1';
		const dk = await makeDiamond(p, 'F1 clip', [{ to: kb1 }]);
		await openDiamond(p, dk);
		await showWork(p);
		const t0 = Date.now();
		await p.click(clipSel('kb1'), { force: true }).catch(() => {});
		await p.waitForSelector('.dlg-card', { timeout: 8000 }).catch(() => {});
		const s0 = await p.evaluate(() => {
			const c = [...document.querySelectorAll('.dlg-card')].filter((x) => x.getClientRects().length).pop();
			const a = document.activeElement;
			const ok = c && c.querySelector('.dlg-ok');
			return { up: !!c, focusCancel: !!(a && a.classList && a.classList.contains('dlg-cancel')), okDisabled: !!(ok && ok.disabled) };
		});
		check('F1. "Use here" opens focused on Cancel, not on the grant', s0.up && s0.focusCancel, J(s0));
		check('F1. and its yes cannot be pressed for the guard\'s first moment', s0.okDisabled, J(s0));
		// The OS's own key-repeat: two Enters close together, exactly the QA reproduction,
		// both well inside GUARD_MS (1000ms) from the dialog's own open.
		await p.keyboard.press('Enter');
		await sleep(120);
		await p.keyboard.press('Enter');
		const f0 = await p.evaluate((id) => DaimondAttach.inForce(id, 'dir:[browser]kb1'), dk);
		const stillUp = await p.evaluate(() => !!document.querySelector('.dlg-card'));
		check('F1. one held Enter grants nothing, and the question stands',
			!f0 && stillUp && Date.now() - t0 < 900, J({ f0, stillUp, ms: Date.now() - t0 }));
		await sleep(Math.max(200, 1200 - (Date.now() - t0)));	// past GUARD_MS from the dialog's own open
		const s1 = await p.evaluate(() => {
			const c = [...document.querySelectorAll('.dlg-card')].filter((x) => x.getClientRects().length).pop();
			const ok = c && c.querySelector('.dlg-ok');
			return !!ok && !ok.disabled;
		});
		check('F1. past the first second the yes can be pressed', s1, String(s1));
		// A real, deliberate press -- past the guard, on the button itself -- still grants.
		await p.click('.dlg-card .dlg-ok', { force: true }).catch(() => {});
		await sleep(1200);
		const f1 = await p.evaluate((id) => DaimondAttach.inForce(id, 'dir:[browser]kb1'), dk);
		check('F1. control: a deliberate press past the guard still grants it', !!f1 && f1.rel === 'holds', J(f1));
	} catch (e) { check('session D ran to the end', false, e && e.stack); }
	await s.browser.close().catch(() => {});
}

// ════════════════════════════════════════════════════════════════════════
// Session E: F2 -- of two rows for one path, the paperclip paints and acts
// on the same one; "Use here" names what it would grant.
// ════════════════════════════════════════════════════════════════════════
{
	const s = await open({ name: 'r5e', defaults: false, profile: scratch('pw', 'r5e-' + process.pid) });
	const p = s.page;
	try {
		await p.evaluate(async () => {
			const m = await import('/pkg/oxedyne_daimond.js');
			await m.store_write('wide/a.txt', 'x');
			await m.store_write('solo/a.txt', 'x');
		});
		// `wide`: a `holds` row nobody has pressed here (first in sidecar order, so
		// the unranked bug picked it), and a `consulted` row this device holds.
		const wide = 'dir:[browser]wide';
		const dw = await makeDiamond(p, 'F2 wide', [{ to: wide, rel: 'holds' }, { to: wide, rel: 'consulted' }]);
		// Granted BY ROW (`DaimondMarksHere.grant`), not by ref: both rows share one
		// `to`, so a ref-based grant (`DaimondAttach.confirmHere`) cannot say which of
		// the two it means -- this is the fixture reaching past that ambiguity to put
		// this device's OWN record on the exact row the test is about.
		const grantedId = await p.evaluate(async (id) => {
			const links = JSON.parse(await DaimondCore.diamondApp().links_touching('diamond:' + id) || '[]')
				.filter((l) => l.owner === id && l.rel === 'consulted');
			DaimondMarksHere.grant(id, links[0], DaimondAttach.root(), { share: false });
			return links[0].id;
		}, dw);
		await openDiamond(p, dw);
		await showWork(p);
		const b0 = await p.evaluate((id) => DaimondDiamond.bounds(id), dw);
		check('F2. control: two rows for `wide`, the pressed one read-only and in force',
			(b0.attached || []).includes('wide') && (b0.read_only || []).includes('wide'), J(b0));
		const c0 = await clipState(p, 'wide');
		check('F2. control: the paperclip paints in force, not away', !!c0 && c0.pressed === 'true' && !/\baway\b/.test(c0.cls), J(c0));
		// One press must act on the row the paperclip DREW -- the one in force --
		// and take it off, never opening a question about the other, waiting row.
		await p.click(clipSel('wide'), { force: true }).catch(() => {});
		await sleep(1800);
		const rw1 = (await rowsOf(p, dw)).map((l) => ({ to: l.to, rel: l.rel, id: l.id }));
		const dlgAfter1 = await anyDialog(p);
		const b1 = await p.evaluate((id) => DaimondDiamond.bounds(id), dw);
		check('F2. one press takes off the row it drew, and asks no question',
			!dlgAfter1 && !rw1.some((l) => l.id === grantedId) && rw1.some((l) => l.rel === 'holds')
				&& !(b1.read_only || []).includes('wide'),
			J({ rw1, dlgAfter1, b1 }));
		// What is left is the `holds` twin, still waiting: a second press must ask,
		// and must name it "read and change" -- the wider of the two, never assumed
		// to be the read-only one the first press just removed.
		await p.click(clipSel('wide'), { force: true }).catch(() => {});
		await p.waitForSelector('.modal.dlg[data-ask="mark-use-here"]', { timeout: 8000 }).catch(() => {});
		await sleep(400);
		const a1 = await askUp(p);
		const rw = await p.evaluate(() => DaimondI18n.t('dws.readwrite'));
		check('F2. the second press asks, naming "read and change" for the `holds` twin',
			!!a1 && a1.msg.indexOf(rw) >= 0, J({ a1, rw }));
		await p.click('.modal.dlg .dlg-cancel', { force: true }).catch(() => {});
		await sleep(600);
		const f2cancel = await p.evaluate((id) => DaimondAttach.inForce(id, 'dir:[browser]wide'), dw);
		check('F2. Cancel grants nothing', !f2cancel, J(f2cancel));
		await p.click(clipSel('wide'), { force: true }).catch(() => {});
		await p.waitForSelector('.modal.dlg[data-ask="mark-use-here"]', { timeout: 8000 }).catch(() => {});
		await sleep(1200);	// past F1's GUARD_MS: the yes is disabled for its first second
		await p.click('.modal.dlg .dlg-ok', { force: true }).catch(() => {});
		await sleep(1200);
		const f2use = await p.evaluate((id) => DaimondAttach.inForce(id, 'dir:[browser]wide'), dw);
		check('F2. "Use here" grants exactly what it named: read and change',
			!!f2use && f2use.rel === 'holds', J(f2use));

		// `solo`: one `consulted` row, waiting -- the read-only branch of the wording.
		const solo = 'dir:[browser]solo';
		const ds = await makeDiamond(p, 'F2 solo', [{ to: solo, rel: 'consulted' }]);
		await openDiamond(p, ds);
		await showWork(p);
		await p.click(clipSel('solo'), { force: true }).catch(() => {});
		await p.waitForSelector('.modal.dlg[data-ask="mark-use-here"]', { timeout: 8000 }).catch(() => {});
		await sleep(400);
		const a2 = await askUp(p);
		const ro = await p.evaluate(() => DaimondI18n.t('dws.readonly'));
		check('F2. a waiting `consulted` row asks, naming "read only"',
			!!a2 && a2.msg.indexOf(ro) >= 0 && a2.msg.indexOf(rw) < 0, J({ a2, ro }));
	} catch (e) { check('session E ran to the end', false, e && e.stack); }
	await s.browser.close().catch(() => {});
}

// ════════════════════════════════════════════════════════════════════════
// Session F: F3 (a store path is reachable from any workspace), item 7 (the
// paperclip leaves a fold's `produced` row to the daimon group's Drop), and
// item 8 (a chat's Doc-header paperclip draws a waiting holding as waiting).
// ════════════════════════════════════════════════════════════════════════
{
	const s = await open({ name: 'r5f', defaults: false, profile: scratch('pw', 'r5f-' + process.pid) });
	const p = s.page;
	try {
		// ── F3: a legacy, machine-rooted Keep transcript row ──────────────
		const kid = await p.evaluate(async () => {
			const id = await DaimondCore.diamondApp().create_diamond('Legacy keep');
			await DaimondCore.loadDiamonds();	// so its tile exists for openDiamond to click
			return id;
		});
		const legacyRef = 'file:[machine:usr@' + DEV + ']diamonds/' + kid + '/transcript.md';
		await p.evaluate(async ({ kid, ref }) => {
			const m = await import('/pkg/oxedyne_daimond.js');
			await m.store_write('diamonds/' + kid + '/transcript.md', '# transcript\n');
			await DaimondCore.diamondApp().add_link(kid, 'diamond:' + kid, ref, 'holds', '', 'user');
			document.dispatchEvent(new CustomEvent('daimond-links-changed'));
		}, { kid, ref: legacyRef });
		const reach = await p.evaluate((ref) => DaimondAttach.reachable(ref), legacyRef);
		check('F3. control: a store path is reachable from the browser workspace whatever its root',
			reach === true, String(reach));
		// `wireHold`'s diamond branch reads `currentDiamond`, which a raw `create_diamond`
		// never sets -- the Diamond has to be OPEN for the Doc header's paperclip to paint
		// against it at all.
		await openDiamond(p, kid);
		await p.evaluate((kid) => window.DaimondDoc.show('diamonds/' + kid + '/transcript.md'), kid);
		await sleep(1800);
		const hc = await p.evaluate(() => {
			const b = document.querySelector('#doc-view [data-act="attach"]');
			return b ? { on: b.classList.contains('on'), away: b.classList.contains('away') } : null;
		});
		check('F3. the Doc header\'s paperclip reads held, not away, for the legacy row',
			!!hc && hc.on && !hc.away, J(hc));
		await p.click('#doc-view [data-act="attach"]', { force: true }).catch(() => {});
		await sleep(1500);
		const rowsAfter = (await rowsOf(p, kid)).map((l) => l.to);
		check('F3. one press removes the row it found rather than adding a second one',
			rowsAfter.length === 0, J(rowsAfter));

		// ── item 7: a fold's `produced` row is not the paperclip's to remove ──
		await p.evaluate(async () => { const m = await import('/pkg/oxedyne_daimond.js'); await m.store_write('folded.txt', 'x'); });
		const foldRef = 'file:[browser]folded.txt';
		const fd = await p.evaluate(async (ref) => {
			const app = DaimondCore.diamondApp();
			const id = await app.create_diamond('Fold probe');
			await app.add_link(id, 'diamond:' + id, ref, 'produced', '', 'fold');
			await DaimondCore.loadDiamonds();	// so its tile exists for openDiamond to click
			return id;
		}, foldRef);
		await openDiamond(p, fd);
		await showWork(p);
		await p.click(clipSel('folded.txt'), { force: true }).catch(() => {});
		let rf1 = [];
		for (let i = 0; i < 10; i++) {
			rf1 = (await rowsOf(p, fd)).map((l) => ({ rel: l.rel, by: l.by, to: l.to }));
			if (rf1.some((l) => l.rel === 'holds')) break;
			await sleep(500);
		}
		const ff1 = await p.evaluate((id) => DaimondAttach.inForce(id, 'file:[browser]folded.txt'), fd);
		check('item7. a press on a fold-harvested file ADDS a mark, not removes the fold row',
			rf1.some((l) => l.rel === 'produced' && l.by === 'fold') && rf1.some((l) => l.rel === 'holds' && l.by === 'user') && !!ff1,
			J({ rf1, ff1 }));
		await p.click(clipSel('folded.txt'), { force: true }).catch(() => {});
		await sleep(1500);
		const rf2 = (await rowsOf(p, fd)).map((l) => ({ rel: l.rel, by: l.by }));
		check('item7. a second press takes only the user\'s mark off, and the fold row stays',
			rf2.length === 1 && rf2[0].rel === 'produced' && rf2[0].by === 'fold', J(rf2));

		// ── item 8: a chat's Doc-header paperclip on a waiting holding ────
		const cc = await newChat(s);
		await p.evaluate(async () => { const m = await import('/pkg/oxedyne_daimond.js'); await m.store_write('cf.txt', 'x'); });
		const cfRef = 'file:[browser]cf.txt';
		await p.evaluate(({ cc, ref }) => {
			DaimondAttach.chatList(cc).push({ ref, dir: false, path: 'cf.txt', state: 'note', ws: true });
		}, { cc, ref: cfRef });
		await p.evaluate(() => window.DaimondDoc.show('cf.txt'));
		await sleep(1800);
		const hc2 = await p.evaluate(() => {
			const b = document.querySelector('#doc-view [data-act="attach"]');
			return b ? { on: b.classList.contains('on'), away: b.classList.contains('away') } : null;
		});
		check('item8. a chat holding nobody pressed here draws the Doc header paperclip as waiting',
			!!hc2 && hc2.on && hc2.away, J(hc2));
		await p.click('#doc-view [data-act="attach"]', { force: true }).catch(() => {});
		await p.waitForSelector('.modal.dlg[data-ask="mark-use-here"]', { timeout: 8000 }).catch(() => {});
		await sleep(400);
		const ca = await askUp(p);
		const cf0 = await p.evaluate((cc) => DaimondAttach.chatInForce(cc, 'file:[browser]cf.txt'), cc);
		check('item8. the press asks before granting, rather than granting on the one tap',
			!!ca && !cf0, J({ ca, cf0 }));
		await sleep(800);	// past F1's GUARD_MS: the yes is disabled for its first second
		await p.click('.modal.dlg .dlg-ok', { force: true }).catch(() => {});
		await sleep(1200);
		const cf1 = await p.evaluate((cc) => DaimondAttach.chatInForce(cc, 'file:[browser]cf.txt'), cc);
		check('item8. "Use here" then brings the holding into force', !!cf1 && cf1.ws === true, J(cf1));
	} catch (e) { check('session F ran to the end', false, e && e.stack); }
	await s.browser.close().catch(() => {});
}

// ════════════════════════════════════════════════════════════════════════
// Session G: item 6 -- the guide mirror and the usage digest are the app's
// own store, never the folder that happens to be open when they are seeded.
// ════════════════════════════════════════════════════════════════════════
{
	const s = await open({ name: 'r5g', defaults: false, profile: scratch('pw', 'r5g-' + process.pid) });
	const p = s.page;
	const HELP = '0da1000000e1';
	let folders = null;
	try {
		folders = await standInFolders(s, { tag: 'r5item6', name: 'usr6', which: ['a'] });
		const pk = await folders.pick('a');
		check('item6. control: a machine folder is open before the account is seeded',
			pk.landed, J(pk));
		// Seeded with the machine folder already open -- the scenario the old
		// `rootedRef` write would have named, and did on a device that booted with
		// a folder open. `open({ defaults: false })` seeds on the ordinary boot and
		// then DELETES the two Diamonds, marking them offered so they never return
		// -- the flag that marker sets is cleared here so this seeding is a fresh
		// first offer, now that a folder is open.
		await p.evaluate(() => { try { localStorage.removeItem('daimond-defaults-seeded-2'); } catch (e) {} });
		await p.evaluate(() => window.DaimondDiamond.seedDefaults());
		let seeded = false, row = null;
		for (let i = 0; i < 40 && !seeded; i++) {
			row = await p.evaluate(async (h) => {
				const rows = JSON.parse(await DaimondCore.diamondApp().links_touching('diamond:' + h) || '[]');
				return rows.find((l) => /system\/guide$/.test(l.to)) || null;
			}, HELP);
			seeded = !!row;
			if (!seeded) await sleep(500);
		}
		check('item6. the seed grant always names the browser workspace, whatever was open',
			seeded && row.to === 'dir:[browser]system/guide', J(row));
		// The mirror and the digest landed in the app's OWN store...
		const inStore = await p.evaluate(async () => {
			const m = await import('/pkg/oxedyne_daimond.js');
			const guide = String(await m.store_list('system/guide') || '');
			const usage = String(await m.store_list('system/usage') || '');
			return { guide: guide.split('\n').filter(Boolean).length, usage: usage.split('\n').filter(Boolean).length };
		});
		check('item6. the guide mirror and the usage digest are in the app\'s own store',
			inStore.guide > 0 && inStore.usage > 0, J(inStore));
		// ...and NOT on the stand-in "disk" the machine folder was open on.
		const onDisk = await p.evaluate(async ({ tag, name }) => {
			const root = await navigator.storage.getDirectory();
			const top = await (await root.getDirectoryHandle(tag + '-a')).getDirectoryHandle(name);
			const names = [];
			for await (const [n] of top.entries()) names.push(n);
			return names;
		}, { tag: 'r5item6', name: 'usr6' });
		check('item6. nothing was written into the folder that happened to be open',
			!onDisk.includes('system'), J(onDisk));
	} catch (e) { check('session G ran to the end', false, e && e.stack); }
	if (folders) await folders.tidy();
	await s.browser.close().catch(() => {});
}

console.log(`\n${ok.length} passed, ${bad.length} failed (${ok.length + bad.length} of ${EXPECTED} expected)`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length || ok.length + bad.length !== EXPECTED ? 1 : 0);

// gateway: none
// verify_history_gate.mjs — a restore's act on the person's file goes only under a restore that
// is open, at a file it handed out, and only once he has answered yes to the bytes he was asked
// about (hist-safe, QA A F1-F3, 2026-10-12).
//
// The arms are QA A's probe (`~/usr/code/ai/claude/specs/daimond_histsafe_qa_a_probe_20261012.mjs`),
// each a door into `run_diamond_tool` the page itself never takes but a script can:
//
//   P1W. NO TICKET, NO MARK FLOW: a write over his file with no ticket, or a made-up one, is refused.
//   P1.  A TICKET THAT IS NOT OPEN (none, made up, closed): a write, a put-back and a delete of his
//        file are each refused, and his edit stands.                                          (F1)
//   P2.  BESIDE AN OPEN QUESTION: an act at a path the open never handed out is refused, and so is
//        a ticketless write of the very file being asked about.                               (F1)
//   P3.  TWO TABS: A asks, B edits, A says yes: re-asked, and his answer holds.
//   P4.  A LOOK UNDER AN OPEN QUESTION binds nothing: a yes given to the earlier bytes does not go
//        over his later edit.                                                                 (F3)
//   P5.  THE ANSWER IS THE ENGINE'S: on the open ticket, before he answers, a put-back over his
//        flagged edit is refused, with `over` or without; and Keep keeps it.                  (F2)
//   P6.  ONE RESTORE A DIAMOND, across failed opens, a double press, a closed tab and a reload.
//   P7.  THE MARK AS IT IS AT THE ACT: withdrawn (P7) or made read-only (P7r) while the question
//        is open, then yes: his file is untouched and in the refused list.             (HIST-SAFE U2)
//   P8.  FAIL CLOSED: this device's record of the marks damaged (P8) or the account locked (P8L)
//        while the question is open, then yes: refused in the UNREAD sentence, disk unchanged.
//
// Seeded test Diamonds only; a world with no owner data:
//   eval "$(bash dev/world.sh 98 --up)"; node dev/verify_history_gate.mjs
// `ONLY=P1,P5` runs only the arms named.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { open, scratch, errors, steerDiamond, pressRowMark, signInAs } from './harness.mjs';

const ok = [], bad = [];
let ran = 0;
const check = (name, pass, detail) => {
	ran++;
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ── Page-side doors ──────────────────────────────────────────────────
const glue = (page, fn, ...args) => page.evaluate(async (a) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	try { return await m[a.fn](...a.args); } catch (e) { return null; }
}, { fn, args });
const rows = (page, id) => page.evaluate((i) => DaimondVersions.rows(i), id);

/// Every question a restore puts to the person, kept with the answer `window.__answer` gives.
const captureAsks = (page) => page.evaluate(() => {
	window.__asks = [];
	window.__answer = false;
	DaimondCore.confirm = async function (msg, okLabel, opts) {
		window.__asks.push({ msg: String(msg), ok: String(okLabel || ''), opts: opts || {} });
		return window.__answer;
	};
});
const asks = (page) => page.evaluate(() => window.__asks.slice());
const answer = (page, yes) => page.evaluate((y) => { window.__asks = []; window.__answer = y; }, yes);

const diamondId = (page, name) => page.evaluate(async (n) => {
	const d = JSON.parse(await DaimondCore.diamondApp().list_diamonds()).find((x) => x.name === n);
	return d ? d.id : '';
}, name);
const closeModals = (page) => page.evaluate(() => {
	document.querySelectorAll('.modal').forEach((m) => m.remove());
	document.body.classList.remove('modal-open');
});
const selectDiamond = async (page, name) => {
	await page.evaluate((n) => {
		const box = [...document.querySelectorAll('#diamond-list .diamond-box')]
			.find((e) => (e.getAttribute('aria-label') || '') === n);
		if (box) box.click();
	}, name);
	await page.waitForTimeout(900);
};
const newDiamond = async (page, name) => {
	await closeModals(page);
	await page.waitForFunction(() => {
		try { const d = window.DaimondModels && DaimondModels.getDefault(); return !!(d && d.model); }
		catch (e) { return false; }
	}, null, { timeout: 20000 }).catch(() => {});
	await page.click('#new-diamond-btn', { force: true });
	await page.waitForSelector('.dlg-input', { timeout: 10000 });
	await page.fill('.dlg-input', name);
	await page.click('.dlg-ok', { force: true });
	const t0 = Date.now();
	while (Date.now() - t0 < 15000 && !(await diamondId(page, name))) await page.waitForTimeout(250);
	await page.waitForTimeout(400);
	await selectDiamond(page, name);
	return diamondId(page, name);
};

/// A steer through the composer, waited to its end (as verify_versions.mjs's own).
///
/// `allow`: answer "Let <Diamond> change <folder>?" Allow, as the person does. A ◈ mark grants
/// reading; the first write into the folder asks (daimond.js, "A WRITE ON FIRST USE").
async function steer(s, text, timeout = 30000, allow = false) {
	await steerDiamond(s, text);
	await s.page.waitForTimeout(300);
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		if (allow) await s.page.evaluate(() => {
			const ok = document.querySelector('[data-ask="place"] .dlg-ok');
			if (ok) ok.click();
		});
		const busy = await s.page.evaluate(() => {
			const b = document.getElementById('chat-send');
			if (!b) return false;
			const t = (b.getAttribute('title') || '') + (b.className || '');
			return /stop/i.test(t) || b.disabled;
		});
		if (!busy) break;
		await s.page.waitForTimeout(250);
	}
	await s.page.waitForTimeout(600);
}

// ── The world ────────────────────────────────────────────────────────
const H_SEED = {
	p1: { 'f.txt': 'his original' },
	p2: { 'f.txt': 'two-orig' },
	p3: { 'f.txt': 'r1' },
	p4: { 'f.txt': 's1' },
	p7: { 'f.txt': 'p7 original' },
	p7r: { 'f.txt': 'p7r original' },
	p8: { 'f.txt': 'p8 original' },
	p8l: { 'f.txt': 'p8l original' },
	p6: { 'f.txt': 't1' },
	p5: { 'f.txt': 'u1' },
};
const PROFILE = scratch('pw', 'histgate');
fs.rmSync(PROFILE, { recursive: true, force: true });
const s = await open({ name: 'histgate', profile: PROFILE, defaults: false });
const { page } = s;
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const want = (k) => ONLY.length === 0 || ONLY.includes(k);
try {
	await page.waitForFunction(() => !!(window.DaimondCore && DaimondCore.diamondApp && window.DaimondVersions), null, { timeout: 15000 });
	for (const [dir, files] of Object.entries(H_SEED))
		for (const [f, b] of Object.entries(files)) await glue(page, 'write_file', `${dir}/${f}`, b);
	// ── The person's own folders, as verify_history_restore.mjs's H1-H4 ──
	// Each on a real file in the person's own folder (`h1/` … `h4/`, seeded from `H_SEED`, the OPFS
	// root standing in for it), its bytes checked by hash and its mtime read off the file itself.
	// The Workspace tree's own row for root folder `dir`, the panel shown and the tree back at the
	// root by its crumb, as a person does: a steer's write leaves the tree inside the folder it
	// wrote in. Scoped to `.files-tree`, because the store view in the same panel lists the same
	// root names in rows of its own with no ◈.
	const treeRow = async (dir) => {
		const row = `#panel-work .files-tree .files-row[data-path="${dir}"]`;
		for (let k = 0; k < 3 && !(await page.$(row)); k++) {
			// Shown only where it is hidden: `show` toggles.
			await page.evaluate(() => {
				const p = document.getElementById('panel-work');
				if (!p || p.getClientRects().length === 0) DaimondPanels.show('work');
			});
			await page.waitForTimeout(700);
			// DOM clicks: a control may have no box, and Playwright's click then throws.
			await page.evaluate(() => {
				const c = document.querySelector('#panel-work .files-path .path-crumb:not([disabled])');
				if (c) c.click();
				const b = document.querySelector('#panel-work [data-act="refresh"]');
				if (b) b.click();
			});
			await page.waitForSelector(row, { timeout: 4000 }).catch(() => {});
		}
	};
	const folderFile = async (name, dir) => {
		const id = await newDiamond(page, name);
		await treeRow(dir);
		const clipped = await pressRowMark(s, dir);
		if (!clipped) console.log('    rows: ' + JSON.stringify(await page.evaluate((d) =>
			[(document.querySelector('#panel-work .files-path') || {}).textContent]
				.concat([...document.querySelectorAll('#panel-work .files-row[data-path]')].map((r) => r.dataset.path))
				.concat([...document.querySelectorAll(`.files-row[data-path="${d}"]`)].map((r) => r.outerHTML.slice(0, 400))), dir)).slice(0, 1200));
		await page.waitForTimeout(1000);
		await selectDiamond(page, name);
		return { id, clipped };
	};
	const steerWrite = async (id, rel, content) => {
		await steer(s, `@tool file_write ${JSON.stringify({ path: rel, content })}`, 30000, true);
		return (await rows(page, id))[0];
	};
	const onDisk = (pg, rel) => glue(pg, 'read_file', rel);
	const mtime = (pg, rel) => pg.evaluate(async (r) => {
		try {
			const [d, f] = r.split('/');
			const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(d);
			return (await (await dir.getFileHandle(f)).getFile()).lastModified;
		} catch (e) { return -1; }
	}, rel);
	const wrote = (top, rel) => !!top && (top.files || []).some((e) => e.path === rel);

	// ── Doors a script can take ──
	const capTickets = (pg) => pg.evaluate(() => {
		window.__tickets = [];
		const eng = DaimondCore.diamondApp();
		const proto = Object.getPrototypeOf(eng);
		for (const fn of ['versions_restore_open', 'versions_undo_open']) {
			if (proto['__orig_' + fn]) continue;
			const o = proto[fn];
			proto['__orig_' + fn] = o;
			proto[fn] = async function (...a) {
				const r = await o.apply(this, a);
				try { window.__tickets.push(JSON.parse(r).ticket); } catch (e) { window.__tickets.push('?'); }
				return r;
			};
		}
	});
	const door = (pg, id, tool, args, ticket) => pg.evaluate(async (a) => {
		// The marks are the engine's to read at the act (HIST-SAFE U2).
		const r = DaimondCore.diamondApp(a.id).run_diamond_tool(String(a.id),
			a.tool, JSON.stringify(a.args), a.ticket === null ? undefined : a.ticket);
		const o = await r;
		return { outcome: o.outcome, text: String(o.text).slice(0, 200) };
	}, { id, tool, args, ticket: ticket === undefined ? null : ticket });
	const holdFirst = (pg, call) => pg.evaluate((c) => {
		window.__asks = [];
		window.__released = false;
		window.__later = c.later;
		DaimondCore.confirm = function (msg, okLabel, opts) {
			window.__asks.push({ msg: String(msg), ok: String(okLabel || ''), opts: opts || {} });
			if (window.__released) return Promise.resolve(typeof window.__later === 'function' ? window.__later(opts) : !!window.__later);
			return new Promise((r) => { window.__release = r; });
		};
		window.__pending = (c.undo
			? DaimondVersions.undoVersion(c.id, c.v, c.paths)
			: DaimondVersions.restore(c.id, c.v, { ask: false })).catch((e) => 'threw ' + e);
	}, call);
	const waitAsk = async (pg) => {
		const t0 = Date.now();
		while (Date.now() - t0 < 15000 && !(await pg.evaluate(() => window.__asks.length))) await pg.waitForTimeout(200);
		return pg.evaluate(() => window.__asks.map((x) => x.opts.ask));
	};
	const release = (pg, yes, later) => pg.evaluate(async (a) => {
		window.__released = true; window.__later = a.later;
		if (window.__release) window.__release(a.yes);
		const r = await window.__pending;
		return { r: JSON.stringify(r).slice(0, 300), asks: window.__asks.map((x) => x.opts.ask) };
	}, { yes, later });
	const tabB = async () => {
		const b = await s.browser.newPage();
		await b.goto(page.url(), { waitUntil: 'domcontentloaded' });
		await b.waitForFunction(() => !!(window.DaimondCore && DaimondCore.diamondApp && window.DaimondVersions), null, { timeout: 20000 });
		await signInAs({ page: b }, s.name);
		await b.waitForFunction(() => { try { return !!DaimondCore.diamondApp(); } catch (e) { return false; } }, null, { timeout: 20000, polling: 250 }).catch(() => {});
		return b;
	};
	const showDisk = async (rel) => JSON.stringify(await onDisk(page, rel));

	if (want('P1W')) {
		console.log('\nP1W. no mark flow: a Diamond, his file, run_diamond_tool with no / made-up ticket');
		const id = await newDiamond(page, 'QA P1W');
		const raw = (pg, t, tool, args) => pg.evaluate(async (a) => {
			const o = await DaimondCore.diamondApp(a.id).run_diamond_tool(String(a.id),
				a.tool, JSON.stringify(a.args), a.t === null ? undefined : a.t);
			return { outcome: o.outcome, text: String(o.text).slice(0, 160) };
		}, { id, t, tool, args });
		for (const [label, t] of [['no ticket', null], ['made-up 424242', 424242]]) {
			await glue(page, 'write_file', 'p1/f.txt', 'HIS EDIT W');
			const r = await raw(page, t, 'file_write', { path: 'p1/f.txt', content: 'UNASKED W ' + label });
			check(`P1W: ${label}: a file_write over his file is refused`, (await onDisk(page, 'p1/f.txt')) === 'HIS EDIT W',
				`id ${id} ${JSON.stringify(r)} disk ${await showDisk('p1/f.txt')}`);
		}
	}

	if (want('P1')) {
		console.log('\nP1. a ticket that is not open (none, made up, closed) at run_diamond_tool');
		// Seeded again: P1W wrote over it, and the closed ticket's put-back below needs a row the
		// store holds the body of, so it is refused by the ticket and not by a missing copy.
		await glue(page, 'write_file', 'p1/f.txt', 'his original');
		const { id, clipped } = await folderFile('QA P1', 'p1');
		const v = await steerWrite(id, 'p1/f.txt', 'daimon wrote');
		check('P1 setup', clipped && wrote(v, 'p1/f.txt'), `clipped ${clipped}`);
		await capTickets(page);
		await captureAsks(page); await answer(page, false);
		await page.evaluate((a) => DaimondVersions.undoVersion(a.id, a.v, ['p1/f.txt']), { id, v: v ? v.v : 0 });
		const closed = await page.evaluate(() => window.__tickets.slice());
		console.log('    tickets seen ' + JSON.stringify(closed) + ' asks ' + JSON.stringify((await asks(page)).map((x) => x.opts.ask)));
		for (const [label, t] of [['no ticket', undefined], ['made-up 987654', 987654], ['closed ' + closed[0], closed[0]]]) {
			await glue(page, 'write_file', 'p1/f.txt', 'HIS EDIT');
			const r = await door(page, id, 'file_write', { path: 'p1/f.txt', content: 'UNASKED ' + label }, t);
			check(`P1: ${label}: a file_write over his edit is refused and writes nothing`,
				(await onDisk(page, 'p1/f.txt')) === 'HIS EDIT', `${JSON.stringify(r)} disk ${await showDisk('p1/f.txt')}`);
		}
		await glue(page, 'write_file', 'p1/f.txt', 'HIS EDIT');
		const rp = await door(page, id, 'file_put_back', { path: 'p1/f.txt', hash: sha('his original') }, closed[0]);
		check('P1: closed ticket: a put_back of an old row over his edit is refused',
			(await onDisk(page, 'p1/f.txt')) === 'HIS EDIT', `${JSON.stringify(rp)} disk ${await showDisk('p1/f.txt')}`);
		await glue(page, 'write_file', 'p1/f.txt', 'HIS EDIT');
		const rd = await door(page, id, 'file_delete', { path: 'p1/f.txt' }, undefined);
		check('P1: no ticket: a delete of his file is refused',
			(await onDisk(page, 'p1/f.txt')) === 'HIS EDIT', `${JSON.stringify(rd)} disk ${await showDisk('p1/f.txt')}`);
		await glue(page, 'write_file', 'p1/f.txt', 'HIS EDIT');
	}

	if (want('P2')) {
		console.log('\nP2. acts beside an open restore question of the same Diamond');
		const { id, clipped } = await folderFile('QA P2', 'p2');
		const v = await steerWrite(id, 'p2/f.txt', 'two-daimon');
		check('P2 setup', clipped && wrote(v, 'p2/f.txt'));
		await glue(page, 'write_file', 'p2/f.txt', 'HIS P2 EDIT');
		await capTickets(page);
		await holdFirst(page, { id, v: v.v, paths: ['p2/f.txt'], undo: true, later: false });
		const held = await waitAsk(page);
		const tk = await page.evaluate(() => window.__tickets.slice(-1)[0]);
		console.log('    held ' + JSON.stringify(held) + ' ticket ' + tk);
		const rn = await door(page, id, 'file_write', { path: 'p2/new.txt', content: 'unhanded' }, tk);
		check('P2: open ticket, a path never handed out: refused (Act::Unasked)',
			rn.outcome !== 'done' && (await onDisk(page, 'p2/new.txt')) == null, `${JSON.stringify(rn)} ${await showDisk('p2/new.txt')}`);
		const rl = await door(page, id, 'file_write', { path: 'p2/f.txt', content: 'LONE WHILE OPEN' }, undefined);
		check('P2: no ticket, the very file whose question is open: refused (one restore at a time)',
			(await onDisk(page, 'p2/f.txt')) === 'HIS P2 EDIT', `${JSON.stringify(rl)} disk ${await showDisk('p2/f.txt')}`);
		const out = await release(page, false, false);
		console.log('    A answered keep: ' + JSON.stringify(out) + ' disk ' + await showDisk('p2/f.txt'));
	}

	if (want('P3')) {
		console.log('\nP3. two tabs: A asks, B edits, A says yes');
		const { id, clipped } = await folderFile('QA P3', 'p3');
		const v = await steerWrite(id, 'p3/f.txt', 'r2');
		check('P3 setup', clipped && wrote(v, 'p3/f.txt'));
		await glue(page, 'write_file', 'p3/f.txt', 'HIS P3 EDIT');
		const b = await tabB();
		for (const [label, lat, bEdit2] of [['re-ask answered keep', false, null], ['re-ask answered yes', true, null], ['B edits again during the re-ask, yes', 'edit2', 'B SECOND EDIT']]) {
			await glue(page, 'write_file', 'p3/f.txt', 'HIS P3 EDIT');
			await holdFirst(page, { id, v: v.v, paths: ['p3/f.txt'], undo: true, later: false });
			const held = await waitAsk(page);
			await b.evaluate(async () => { const m = await import('/pkg/oxedyne_daimond.js'); await m.write_file('p3/f.txt', 'TAB B EDIT'); });
			const later = lat === 'edit2' ? null : lat;
			if (bEdit2) {
				await page.exposeFunction('__bEdit_' + label.length, async () => {
					await b.evaluate(async (t) => { const m = await import('/pkg/oxedyne_daimond.js'); await m.write_file('p3/f.txt', t); }, bEdit2);
				}).catch(() => {});
				await page.evaluate((n) => { window.__later = async (opts) => { if (opts && opts.ask === 'restore-changed') await window[n](); return true; }; }, '__bEdit_' + label.length);
			}
			const out = await page.evaluate(async (a) => {
				window.__released = true;
				if (a.later !== undefined && a.later !== null) window.__later = a.later;
				if (window.__release) window.__release(true);
				const r = await window.__pending;
				return { r: JSON.stringify(r).slice(0, 300), asks: window.__asks.map((x) => x.opts.ask) };
			}, { later: bEdit2 ? null : later });
			const disk = await onDisk(page, 'p3/f.txt');
			const expect = bEdit2 ? 'B SECOND EDIT' : (later ? 'r1' : 'TAB B EDIT');
			check(`P3: ${label}: first held ${JSON.stringify(held)}; ends ${expect}`, disk === expect,
				`disk ${JSON.stringify(disk)} asks ${JSON.stringify(out.asks)} r ${out.r.slice(0, 160)}`);
		}
		await b.close();
	}

	if (want('P4')) {
		console.log('\nP4. file_restore_look under an open question rebinds the answer');
		const { id, clipped } = await folderFile('QA P4', 'p4');
		const v = await steerWrite(id, 'p4/f.txt', 's2');
		check('P4 setup', clipped && wrote(v, 'p4/f.txt'));
		await glue(page, 'write_file', 'p4/f.txt', 'HIS P4 EDIT');
		await capTickets(page);
		await holdFirst(page, { id, v: v.v, paths: ['p4/f.txt'], undo: true, later: false });
		const held = await waitAsk(page);
		const tk = await page.evaluate(() => window.__tickets.slice(-1)[0]);
		await glue(page, 'write_file', 'p4/f.txt', 'HIS LATER EDIT');
		const lk = await door(page, id, 'file_restore_look', { path: 'p4/f.txt' }, tk);
		const out = await release(page, true, false);
		check('P4: his later edit is not written over on a yes given to the earlier bytes',
			(await onDisk(page, 'p4/f.txt')) === 'HIS LATER EDIT',
			`held ${JSON.stringify(held)} look ${JSON.stringify(lk)} asks ${JSON.stringify(out.asks)} disk ${await showDisk('p4/f.txt')}`);
	}

	if (want('P5')) {
		console.log('\nP5. the open ticket, while his answer is still unasked, over his flagged edit');
		const { id, clipped } = await folderFile('QA P5', 'p5');
		const v = await steerWrite(id, 'p5/f.txt', 'u2');
		check('P5 setup', clipped && wrote(v, 'p5/f.txt'));
		await glue(page, 'write_file', 'p5/f.txt', 'HIS P5');
		await capTickets(page);
		await holdFirst(page, { id, v: v.v, paths: ['p5/f.txt'], undo: true, later: false });
		const held = await waitAsk(page);
		const tk = await page.evaluate(() => window.__tickets.slice(-1)[0]);
		const r0 = await door(page, id, 'file_put_back', { path: 'p5/f.txt', hash: sha('u1') }, tk);
		check('P5: put_back on the open ticket with no answer yet: refused, his edit stands',
			(await onDisk(page, 'p5/f.txt')) === 'HIS P5', `held ${JSON.stringify(held)} ${JSON.stringify(r0)} disk ${await showDisk('p5/f.txt')}`);
		await glue(page, 'write_file', 'p5/f.txt', 'HIS P5');
		const r1 = await door(page, id, 'file_put_back', { path: 'p5/f.txt', hash: sha('u1'), over: true }, tk);
		check('P5: the same with over:true and no answer: refused, his edit stands',
			(await onDisk(page, 'p5/f.txt')) === 'HIS P5', `${JSON.stringify(r1)} disk ${await showDisk('p5/f.txt')}`);
		// His Keep keeps the bytes he was asked about: "Keep them" kept nothing when a put-back had
		// already gone over them unanswered.
		const out = await release(page, false, false);
		check('P5: he then answers Keep, and his edit is what stands',
			(await onDisk(page, 'p5/f.txt')) === 'HIS P5', `asks ${JSON.stringify(out.asks)} disk ${await showDisk('p5/f.txt')}`);
	}

	if (want('P6')) {
		console.log('\nP6. the claim across errors, a double press, reload and a closed tab');
		const { id, clipped } = await folderFile('QA P6', 'p6');
		const v = await steerWrite(id, 'p6/f.txt', 't2');
		check('P6 setup', clipped && wrote(v, 'p6/f.txt'));
		await captureAsks(page); await answer(page, false);
		const bad1 = await page.evaluate((a) => DaimondVersions.restore(a.id, 99999, { ask: false }).catch((e) => 'threw ' + e), { id });
		const bad2 = await page.evaluate((a) => DaimondVersions.undoVersion(a.id, 99999, ['p6/nope.txt']).catch((e) => 'threw ' + e), { id });
		const bad3 = await page.evaluate((a) => DaimondVersions.restore(a.id, a.v, { ask: false, path: 'p6/none.txt' }).catch((e) => 'threw ' + e), { id, v: v.v });
		console.log('    early errors: ' + JSON.stringify([bad1, bad2, bad3]).slice(0, 300));
		// QA A F6: a version the history does not hold is refused, never opened as a real restore.
		check('P6: a restore or undo of a version the history does not hold is refused',
			bad1 === null && bad2 === null, JSON.stringify([bad1, bad2]).slice(0, 200));
		const after = await page.evaluate((a) => DaimondVersions.undoVersion(a.id, a.v, ['p6/f.txt']).catch((e) => 'threw ' + e), { id, v: v.v });
		check('P6: after three failed opens, a restore still opens (not refused busy)', after !== null && !/threw/.test(String(after)),
			JSON.stringify(after).slice(0, 200));
		// Double press in one tab.
		await glue(page, 'write_file', 'p6/f.txt', 'HIS P6');
		const dbl = await page.evaluate(async (a) => {
			window.__said = [];
			const t = DaimondCore.toast;
			DaimondCore.toast = function (x, e) { window.__said.push(String(x)); if (t) t(x, e); };
			DaimondCore.confirm = async () => false;
			const rs = await Promise.all([DaimondVersions.undoVersion(a.id, a.v, ['p6/f.txt']), DaimondVersions.undoVersion(a.id, a.v, ['p6/f.txt'])]);
			return { rs: rs.map((r) => r === null ? null : 'ran'), said: window.__said };
		}, { id, v: v.v });
		check('P6: a double press: one runs, one is refused busy, his file stands',
			dbl.rs.filter((r) => r === null).length === 1 && (await onDisk(page, 'p6/f.txt')) === 'HIS P6', JSON.stringify(dbl) + ' ' + await showDisk('p6/f.txt'));
		// Tab B holds a question, then is closed; A must be able to restore.
		const b = await tabB();
		await holdFirst(b, { id, v: v.v, paths: ['p6/f.txt'], undo: true, later: false });
		const heldB = await waitAsk(b);
		await captureAsks(page); await answer(page, false);
		const whileB = await page.evaluate((a) => DaimondVersions.undoVersion(a.id, a.v, ['p6/f.txt']), { id, v: v.v });
		await b.close();
		await page.waitForTimeout(800);
		const afterB = await page.evaluate((a) => DaimondVersions.undoVersion(a.id, a.v, ['p6/f.txt']), { id, v: v.v });
		check('P6: refused while B holds a question, runs once B is closed', whileB === null && afterB !== null,
			`heldB ${JSON.stringify(heldB)} while ${JSON.stringify(whileB).slice(0, 80)} after ${JSON.stringify(afterB).slice(0, 80)}`);
		// A holds, then A reloads: A again must run.
		await holdFirst(page, { id, v: v.v, paths: ['p6/f.txt'], undo: true, later: false });
		await waitAsk(page);
		await page.reload({ waitUntil: 'domcontentloaded' });
		await page.waitForFunction(() => !!(window.DaimondCore && DaimondCore.diamondApp && window.DaimondVersions), null, { timeout: 20000 });
		await page.waitForFunction(() => { try { return !!DaimondCore.diamondApp(); } catch (e) { return false; } }, null, { timeout: 20000, polling: 250 }).catch(() => {});
		await page.waitForTimeout(1500);
		await captureAsks(page); await answer(page, false);
		const afterR = await page.evaluate((a) => DaimondVersions.undoVersion(a.id, a.v, ['p6/f.txt']).catch((e) => 'threw ' + e), { id, v: v.v });
		check('P6: after a reload with a question open, a restore runs', afterR !== null && !/threw/.test(String(afterR)),
			JSON.stringify(afterR).slice(0, 200) + ' disk ' + await showDisk('p6/f.txt'));
	}
	// ── The engine reads the marks at the act (HIST-SAFE U2) ──
	// The answer, released, with the restore's own refused list read back whole.
	const releaseRefused = (pg, yes) => pg.evaluate(async (y) => {
		window.__released = true; window.__later = y;
		if (window.__release) window.__release(y);
		const r = await window.__pending;
		const o = (typeof r === 'string') ? (() => { try { return JSON.parse(r); } catch (e) { return { raw: r }; } })() : r;
		return { refused: (o && o.refused) || [], raw: JSON.stringify(o).slice(0, 300), asks: window.__asks.map((x) => x.opts.ask) };
	}, yes);
	const refusedOf = (out, rel) => (out.refused || []).find((e) => String(e.path || '') === rel);
	// The Diamond's `holds` row on `dir`, as the panel's own steps act on it.
	const markOn = (pg, id, dir, how) => pg.evaluate(async (a) => {
		const eng = DaimondCore.diamondApp();
		const ls = JSON.parse(await eng.links_touching('diamond:' + a.id) || '[]');
		const pathOf = (to) => String(to).replace(/^(file|dir):(\[[^\]]*\])?/, '').trim();
		const row = ls.find((l) => l.owner === a.id && l.from === 'diamond:' + a.id && l.rel === 'holds' && pathOf(l.to) === a.dir);
		if (!row) return 'no row';
		if (a.how === 'readonly') {
			// `setReadOnly`: a `consulted` row pressed here, then the `holds` row removed.
			const lid = await eng.add_link(a.id, 'diamond:' + a.id, row.to, 'consulted', '', 'user');
			const ls2 = JSON.parse(await eng.links_touching('diamond:' + a.id) || '[]');
			const c = ls2.find((l) => l.id === lid && l.owner === a.id);
			if (!c || !DaimondMarksHere.grant(a.id, c, DaimondAttach.root(), { share: false })) return 'consulted not pressed';
		}
		// `removeLinkHere`: the press dropped, then the row.
		DaimondMarksHere.drop(a.id, row.id, row.to);
		await eng.remove_link(a.id, row.id);
		const b = await DaimondDiamond.bounds(a.id);
		return JSON.stringify([b.attached || [], b.read_only || []]);
	}, { id, dir, how });
	for (const [arm, how] of [['P7', 'withdraw'], ['P7r', 'readonly']]) {
		if (!want(arm)) continue;
		const dir = arm.toLowerCase();
		const rel = dir + '/f.txt';
		console.log('\n' + arm + '. the mark ' + (how === 'readonly' ? 'made read-only' : 'withdrawn') + ' while the question is open, then yes');
		const { id, clipped } = await folderFile('QA ' + arm, dir);
		const v = await steerWrite(id, rel, 'daimon ' + arm);
		check(arm + ' setup', clipped && wrote(v, rel));
		const his = 'HIS ' + arm + ' EDIT';
		await glue(page, 'write_file', rel, his);
		await holdFirst(page, { id, v: v.v, paths: [rel], undo: true, later: true });
		const held = await waitAsk(page);
		const after = await markOn(page, id, dir, how);
		check(arm + ': the question was open, and the mark ' + how + ' while it was',
			held.length > 0 && after === (how === 'readonly' ? JSON.stringify([[dir], [dir]]) : '[[],[]]'),
			`held ${JSON.stringify(held)} bounds ${after}`);
		const out = await releaseRefused(page, true);
		check(arm + ': he says yes, and his file is untouched', (await onDisk(page, rel)) === his,
			`${out.raw} disk ${await showDisk(rel)}`);
		const e = refusedOf(out, rel);
		check(arm + ': and the file is in the refused list', !!e, JSON.stringify(out.refused).slice(0, 300));
	}
	for (const [arm, how] of [['P8', 'damaged'], ['P8L', 'locked']]) {
		if (!want(arm)) continue;
		const dir = arm.toLowerCase();
		const rel = dir + '/f.txt';
		console.log('\n' + arm + '. this device\'s record ' + (how === 'locked' ? 'locked away' : 'damaged') + ' while the question is open, then yes');
		const { id, clipped } = await folderFile('QA ' + arm, dir);
		const v = await steerWrite(id, rel, 'daimon ' + arm);
		check(arm + ' setup', clipped && wrote(v, rel));
		const his = 'HIS ' + arm + ' EDIT';
		await glue(page, 'write_file', rel, his);
		await holdFirst(page, { id, v: v.v, paths: [rel], undo: true, later: true });
		const held = await waitAsk(page);
		// Broken the way the engine meets it: the record's own key holding no record (through the
		// page's Storage, so the account prefix applies), or the identity saying it is locked.
		const broke = await page.evaluate((h) => {
			if (h === 'locked') {
				window.__origUnlocked = DaimondIdentity.isUnlocked;
				DaimondIdentity.isUnlocked = () => false;
				return DaimondIdentity.isUnlocked() === false;
			}
			window.__origMarks = localStorage.getItem('daimond-marks-here');
			localStorage.setItem('daimond-marks-here', '{"v":1,"d":');
			return window.__origMarks !== null;
		}, how);
		const lone = await door(page, id, 'file_write', { path: rel, content: 'LONE WHILE BROKEN' }, undefined);
		const out = await releaseRefused(page, true);
		await page.evaluate((h) => {
			if (h === 'locked') DaimondIdentity.isUnlocked = window.__origUnlocked;
			else localStorage.setItem('daimond-marks-here', window.__origMarks);
		}, how);
		check(arm + ': the question was open, and the record ' + how + ' while it was', held.length > 0 && broke,
			`held ${JSON.stringify(held)} broke ${broke}`);
		const UNREAD = /record of the folders marked here could not be read/;
		check(arm + ': a ticketless write meanwhile is refused in the UNREAD sentence',
			lone.outcome !== 'done' && UNREAD.test(lone.text), JSON.stringify(lone));
		check(arm + ': he says yes, and his file is untouched', (await onDisk(page, rel)) === his,
			`${out.raw} disk ${await showDisk(rel)}`);
		const e = refusedOf(out, rel);
		check(arm + ': the file is refused, in the UNREAD sentence', !!e && UNREAD.test(String(e.said || '')),
			JSON.stringify(out.refused).slice(0, 400));
	}
	const errs = errors(s).filter((e) => !/favicon/i.test(e) && !/Failed to load resource/.test(e) && !/502 \(Bad Gateway\)/.test(e));
	console.log('    page errors: ' + (errs.slice(0, 3).join(' | ') || 'none'));
} finally {
	await s.close();
}
console.log(bad.length === 0 ? '\nall arms held' : `\n${bad.length} arm(s) FAILED: ` + bad.join(' ; '));
process.exit(bad.length === 0 ? 0 : 1);

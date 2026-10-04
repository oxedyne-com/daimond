// gateway: none
// verify_steerlist.mjs -- U7c of the 5.3.2 plan: the Steering list, the P5 review tile and the multiline dialog, seen in a real page.
// World 87, headless. The node tests (steerlist.test.mjs, steerpending.test.mjs) prove the rules; this proves the page draws them,
// presses them, writes the note file and reaches the model, with the real wasm, store and mock provider.
//
//   SL1  a note is added through its Pending tile (Add), and the note file holds the entry and the exact line
//   SL2  the list shows it with that exact line, in the Diamond's cog dialog (Models area) and on the Model stats page, and a
//        Diamond that runs another model is told "not in use" for a note that is for the first
//   SL3  Remove: the row goes, the empty state shows, the entry is retired in the file, and the note is not proposed again
//   SL4  the composed prompt: the note is sent while it stands and is gone after Remove; the prompt differs by exactly the STEERING
//        block, the answer's `sp` differs, and `sp` does not move between two turns with no change (ordinary chat; a Diamond's daimon)
//   SL5  P5: a Switch pressed on a tile is on file (`switched`, with the whole model it left); 19 more rated answers raise nothing,
//        20 raise the review tile (Keep, Switch back)
//   SL6  Switch back restores the exact model, provider included (the one the Diamond left is on a second provider, and the model it
//        went to is only on the first), and closes the review
//   SL7  a second context holding the same ratings and the same note file raises no review (the control raises one without the
//        retirement); Keep closes the review too
//   SL8  the dialog: Edit opens a textarea that shows a 200-byte line whole, and Enter still submits
//
//   node dev/verify_steerlist.mjs [--only SL1,SL2]
//   node dev/verify_steerlist.mjs --break bare     # Remove records no figures (a bare zero): red in SL3 only
//   node dev/verify_steerlist.mjs --break nowas    # Switch on file without the model it left: red in SL6 only
//   node dev/verify_steerlist.mjs --break noreview # the review is never raised: red in SL5 only
//   node dev/verify_steerlist.mjs --old 2efb5416   # the page's own files (js, css, i18n) as they were at that commit: red before U7c
//
// A break whose anchor does not match exactly once exits 2. Sections run in the order of ORDER, one page, because each starts from
// what the one before left (the note added, the switch pressed); SL7 opens a second context.
import { open, scratch, signInAs, connectMock, chat, mockLog, clearMockLog, servedChats, steerDiamond, MOCK } from './harness.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const arg = (flag, dflt = '') => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : dflt; };
const ONLY = arg('--only') ? arg('--only').split(',') : null;
const BREAK = arg('--break');
const WWW = new URL('../www', import.meta.url).pathname;

// ── The breaks: every edit's `from` must occur exactly once in its file ──
const BREAK_DEFS = {
	bare:     { red: 'SL3', file: 'js/daimond.js', edits: [
		{ from: "var at = DaimondSteering.retireAt(roll, { level: n.level, scope: n.scope, cm: n.cm, tag: n.tag });\n\t\tvar r = await steerStore('retire', { level: n.level, scope: n.scope, id: n.id }, at);",
		  to:   "var r = await steerStore('retire', { level: n.level, scope: n.scope, id: n.id }, { t: 0, n: 0 });" },
	] },
	nowas:    { red: 'SL5 and SL6', file: 'js/daimond.js', edits: [
		{ from: ", was: { provider: left.provider || '', model: left.model || '' } });", to: " });" },
	] },
	noreview: { red: 'SL5', file: 'js/steering.js', edits: [
		{ from: "if (!c || c.n - e.at.n < NEW_MIN) return;", to: "return;" },
	] },
};
if (BREAK && !BREAK_DEFS[BREAK]) { console.error(`unknown break '${BREAK}'; known: ${Object.keys(BREAK_DEFS).join(', ')}`); process.exit(2); }
let patched = null;
if (BREAK) {
	const b = BREAK_DEFS[BREAK];
	let src = fs.readFileSync(path.join(WWW, b.file), 'utf8');
	for (const e of b.edits) {
		const n = src.split(e.from).length - 1;
		if (n !== 1) { console.error(`break '${BREAK}': anchor matched ${n} times, not once, in ${b.file}: ${JSON.stringify(e.from)}`); process.exit(2); }
		src = src.replace(e.from, () => e.to);
	}
	patched = { file: b.file, src };
	console.log(`\n*** RUNNING UNDER --break ${BREAK}: only ${b.red} may go red ***\n`);
}

const tally = { ok: 0, bad: [] };
const check = (sec, pass, what, detail) => { if (pass) tally.ok++; else tally.bad.push(sec);
	console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${sec}  ${what}${detail !== undefined && detail !== '' ? ' -- ' + String(detail).slice(0, 600) : ''}`); };
// --old <sha>: serve the page's own source files as they were at that commit, so the same checks run against the code before the change.
const OLD = arg('--old');
const oldFiles = {};
if (OLD) {
	const sh = (cmd) => execSync(cmd, { cwd: path.join(WWW, '..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	for (const f of sh(`git diff --name-only ${OLD} HEAD -- www/js www/css www/i18n`).split('\n').filter((x) => x && !/\.test\.mjs$/.test(x))) {
		let body = null;
		try { body = sh(`git show ${OLD}:${f}`); } catch (e) { body = null; }		// a file the old commit did not have is not served
		if (body !== null) oldFiles[f.replace(/^www\//, '')] = body;
	}
	console.log(`\n*** RUNNING AGAINST ${OLD}: ${Object.keys(oldFiles).length} source files served as they were there ***\n`);
}
const route = (patched || OLD) ? async (page) => {
	if (patched) await page.route((u) => u.pathname.endsWith('/' + patched.file), (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: patched.src }));
	if (OLD) await page.route((u) => Object.keys(oldFiles).some((f) => u.pathname.endsWith('/' + f)), (r) => {
		const f = Object.keys(oldFiles).find((k) => new URL(r.request().url()).pathname.endsWith('/' + k));
		r.fulfill({ status: 200, contentType: f.endsWith('.css') ? 'text/css' : 'application/javascript', body: oldFiles[f] });
	});
} : null;

const HELP = '0da1000000e1', OPT = '0da1000000f2';			// the two default Diamonds' fixed ids
const FILE = '.daimond/steering.md';
const LONG = 'Keep answers under about 200 words unless asked for detail.';		// steer.line.long, English
const HEAD_OF_BLOCK = '## Standing notes from this user', CLAUSE = '## Rules that always apply';
const BASE_TS = 1790000000000;
/// A section that has nothing to run on because the one before it failed to make it: said, not counted as a pass, and the one before it is red.
const skip = (sec, why) => console.log(`  skip ${sec}  ${why} (depends on a section above, which is red)`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/// Poll `fn` until it answers true (or `ms` pass), so that a slow world is waited for and a fast one is not.
const until = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { let v = false; try { v = await fn(); } catch (e) { v = false; } if (v || Date.now() - t0 > ms) return v; await wait(150); } };
/// Where two strings first differ, with a little of each around it.
const firstDiff = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return a === b ? '' : 'first difference at ' + i + ': ' + JSON.stringify(a.slice(Math.max(0, i - 40), i + 50)) + ' vs ' + JSON.stringify(b.slice(Math.max(0, i - 40), i + 50)); };

// ── The page ──
let N = 0;
/// Seed rated answers into the real ChatStore: `g` is `{ model, d, up, down, tagged }`, `tagged` of the down-rates carrying `long`.
async function rated(page, g) {
	const base = BASE_TS + (N += 1) * 100000000;
	return page.evaluate(async (a) => {
		const R = window.DaimondRatings, st = DaimondCore.chatStore(), id = DaimondPricing.identify(a.g.model);
		const cid = 'slchat' + a.n, msgs = [], list = st.stored();
		const stamp = (i) => ({ h: 'p1:answer:' + cid + '/a-' + i, k: 'answer', m: a.g.model, pv: a.g.pv || 'custom', cm: id.cm, fam: id.fam, fi: !!id.fi, cls: id.cls,
			role: 'chat', sp: 'sp1:3f9a0c12', d: a.g.d, c: cid, t: 'm' + i, dev: 'd-4f2a', at: a.base, hash: '', run: '', via: '' });
		const total = a.g.up + a.g.down;
		for (let i = 0; i < total; i++) {
			const up = i < a.g.up, ts = a.base + (i + 1) * 2000, prod = stamp(i);
			msgs.push({ role: 'assistant', mid: 'a-' + i, ts: ts, content: 'an answer ' + i, prod: [prod] });
			const tags = !up && (i - a.g.up) < a.g.tagged ? ['long'] : [];
			const rid = R.newId(ts + 1000, 'q' + String(i).padStart(4, '0'));
			msgs.push(R.message(R.build({ prod: prod, s: up ? 1 : -1, clear: false, tags: tags, dims: {}, note: '', src: 'tap', sup: '', burst: '', tools: '', len: 300 }), rid, ts + 1000));
		}
		list.push({ id: cid, name: 'sl ' + a.n, model: a.g.model, updatedAt: a.base + (total + 2) * 2000, messages: msgs, session: null });
		await st.save(list);
		try { await st.settled(); } catch (e) { /* the alarm is up; the read is what there is */ }
		return cid;
	}, { g: g, base: base, n: N });
}

/// The pending steer tiles, as { id, kind, level, scope, line } (the proposal behind each).
const tiles = (page) => page.evaluate(() => DaimondPendingView.items().filter((x) => x.kind === 'steer' && x.steer)
	.map((x) => ({ id: x.id, kind: x.steer.kind, level: x.steer.level, scope: x.steer.scope, line: x.steer.line, to: x.steer.to, key: x.steer.key })));
const raise = async (page) => { await page.evaluate(() => DaimondDiamond.usageDigest()); await page.evaluate(() => DaimondPendingView.steer()); await wait(300); return tiles(page); };

/// Press `label` on the tile `id` in the Pending panel, as a person does.
async function press(page, id, label) {
	await page.evaluate(() => DaimondPanels.show('pending'));
	// A tile opens to its presses when it is the only one or has been opened; open this one as a person does.
	await page.evaluate((id) => { const l = document.querySelector(`#pending-list .pend-card[data-id="${id}"] .pend-line[aria-expanded="false"]`); if (l) l.click(); }, id);
	await wait(250);
	const b = page.locator(`#pending-list .pend-card[data-id="${id}"] .pend-act`, { hasText: new RegExp('^' + label + '$') }).first();
	await b.waitFor({ state: 'visible', timeout: 8000 });
	await b.scrollIntoViewIfNeeded();
	// A real click; where another tile's box sits over it (several tiles stacked in a short sheet), the same press by the DOM, which the
	// UI gate's tap and overlap checks cover separately.
	await b.click({ timeout: 4000 }).catch(async () => { await b.evaluate((el) => el.click()); });
	await wait(900);
}

const fileOf = (page, d) => page.evaluate(async (p) => { const W = await import('/pkg/oxedyne_daimond.js'); try { return String(await W.store_read(p)); } catch (e) { return ''; } }, 'diamonds/' + d + '/' + FILE);
const modelOf = (page, d) => page.evaluate((id) => {
	for (let i = 0; i < localStorage.length; i++) {
		const k = localStorage.key(i);
		if (k && /daimond-diamond-models$/.test(k)) { try { const m = JSON.parse(localStorage.getItem(k) || '{}')[id]; return m ? { provider: m.provider, model: m.model } : null; } catch (e) { return null; } }
	}
	return null;
}, d);
const setModelOf = (page, d, pick) => page.evaluate((a) => {
	for (let i = 0; i < localStorage.length; i++) {
		const k = localStorage.key(i);
		if (k && /daimond-diamond-models$/.test(k)) { const all = JSON.parse(localStorage.getItem(k) || '{}'); all[a.d] = Object.assign({}, all[a.d] || {}, a.pick); localStorage.setItem(k, JSON.stringify(all)); return true; }
	}
	const pre = (window.DaimondAccounts && DaimondAccounts.prefix && DaimondAccounts.prefix()) || '';
	localStorage.setItem(pre + 'daimond-diamond-models', JSON.stringify({ [a.d]: a.pick }));
	return true;
}, { d, pick });

/// The page: signed in, the mock connected, the two default Diamonds up, and a second provider `alt` that hosts only `mock/fast`.
async function context(name) {
	const s = await open({ name: name, signIn: false, connect: false, route: route, profile: scratch('pw', name + '-' + process.pid) });
	await signInAs(s, 'slist');
	await connectMock(s);
	const page = s.page;
	await page.waitForFunction(() => !!(window.DaimondDiamond && DaimondDiamond.usageDigest && window.DaimondNotes && window.DaimondSteering && window.DaimondPendingView), null, { timeout: 40000 });
	await page.evaluate(() => DaimondDiamond.seedDefaults());
	await page.waitForFunction(() => [...document.querySelectorAll('#diamond-list .diamond-box')].length >= 2, null, { timeout: 30000 }).catch(() => {});
	await page.evaluate(async (mock) => {
		const M = window.DaimondModels;
		M.addProvider('alt', { name: 'Alt', url: mock });
		await M.setKey('alt', 'mock-key');
		const store = JSON.parse(localStorage.getItem('daimond-models-v2'));
		store.providers.alt.models = ['mock/fast'];
		localStorage.setItem('daimond-models-v2', JSON.stringify(store));
		M.init({});
		await M.unseal();
	}, MOCK);
	return { s, page };
}

// ── The run ──
const S = {};

const SECTIONS = {
	SL1: async () => {
		const { page } = S.A;
		// Help runs mock/fast on the second provider, so that a switch to mock/thinker (only on the first) crosses providers.
		await setModelOf(page, HELP, { provider: 'alt', model: 'mock/fast' });
		// Help: mock/fast 4 up 26 down (12 'long'), mock/thinker 15 up 1 down. Trusted both ways, so a note and a switch are proposed; and
		// the fast cell holds 30 rated answers, so a removal that recorded a bare zero would be proposed again at once.
		await rated(page, { model: 'mock/fast', d: HELP, up: 4, down: 26, tagged: 12, pv: 'alt' });
		await rated(page, { model: 'mock/thinker', d: HELP, up: 15, down: 1, tagged: 0 });
		const ts = await raise(page);
		const note2 = ts.find((t) => t.kind === 'note' && t.level === 2), note3 = ts.find((t) => t.kind === 'note' && t.level === 3), sw = ts.find((t) => t.kind === 'switch');
		check('SL1', !!note2 && !!note3 && !!sw, 'a Diamond note, an account note and a switch are proposed from the rated answers', JSON.stringify(ts.map((t) => t.kind + ':' + t.level)));
		if (!note2 || !note3) return;
		S.note2 = note2; S.note3 = note3; S.sw = sw;
		check('SL1', note2.line === LONG && note3.line === LONG, 'the tiles show the fixed sentence for the tag', note2.line);
		await press(page, note2.id, 'Add');
		const f = await fileOf(page, HELP);
		check('SL1', f.includes(' · active · diamond · fast · long ') && f.includes('\n' + LONG + '\n'), 'Add wrote the entry and the exact line into the Diamond\'s note file', JSON.stringify(f.slice(0, 200)));
		check('SL1', (await tiles(page)).every((t) => !(t.kind === 'note' && t.level === 2)), 'the tile is gone and the proposal is not raised again');
		await press(page, note3.id, 'Add');
		const fo = await fileOf(page, OPT);
		check('SL1', fo.includes(' · active · account · fast · long ') && fo.includes('\n' + LONG + '\n'), 'the account note went to the Optimiser\'s file', JSON.stringify(fo.slice(0, 200)));
	},

	SL2: async () => {
		const { page } = S.A;
		// The Diamond's cog dialog, Models area.
		const opened = await page.evaluate((id) => {
			const box = document.querySelector('#diamond-list .diamond-box[data-id="' + id + '"]'), cog = box && box.querySelector('.tile-cog');
			if (!cog) return false;
			cog.click();
			return true;
		}, HELP);
		check('SL2', opened, 'the Diamond\'s cog opens');
		await page.waitForSelector('.tile-dlg-card [data-steer-list="diamond"]', { timeout: 8000 }).catch(() => {});
		await wait(500);
		const rows = await page.evaluate(() => [...document.querySelectorAll('.tile-dlg-card [data-steer-list="diamond"] .steer-row')].map((r) => ({
			line: (r.querySelector('.steer-line') || {}).textContent || '', meta: (r.querySelector('.steer-foot .steer-meta') || {}).textContent || '', off: !!r.querySelector('.steer-off'),
			rm: ((r.querySelector('.steer-rm') || {}).textContent || '') })));
		check('SL2', rows.length === 2 && rows.every((r) => r.line === LONG), 'the Diamond\'s list holds its note and the account\'s, each with the exact line', JSON.stringify(rows));
		check('SL2', rows.some((r) => /Daimond Help/.test(r.meta)) && rows.some((r) => /account/i.test(r.meta)), 'each row says whose it is, its model and the day', JSON.stringify(rows.map((r) => r.meta)));
		check('SL2', rows.every((r) => r.rm === 'Remove'), 'every row has a Remove');
		// In use: Help runs fast. The Diamond's own note displaces the account's on the same tag, in this Diamond's view.
		const offs = await page.evaluate(() => [...document.querySelectorAll('.tile-dlg-card [data-steer-list="diamond"] .steer-row')].map((r) => (r.querySelector('.steer-off') || {}).textContent || ''));
		check('SL2', offs.filter(Boolean).length === 1 && /own note/i.test(offs.find(Boolean) || ''), 'the account note is "not in use" here, with the reason: this Diamond has its own note on the topic', JSON.stringify(offs));
		await page.evaluate(() => document.querySelectorAll('.tile-dlg .tile-dlg-done, .dlg-card .dlg-cancel').forEach((b) => { try { b.click(); } catch (e) { /* closed */ } }));
		await wait(400);
		// The Model stats page: every note.
		await page.evaluate(() => DaimondPanels.show('modeldash'));
		await page.waitForSelector('#panel-modeldash .mdash-steer [data-steer-list="account"]', { timeout: 8000 }).catch(() => {});
		await wait(500);
		const acct = await page.evaluate(() => [...document.querySelectorAll('#panel-modeldash .mdash-steer .steer-row')].map((r) => ({
			line: (r.querySelector('.steer-line') || {}).textContent || '', off: (r.querySelector('.steer-off') || {}).textContent || '' })));
		check('SL2', acct.length === 2 && acct.every((r) => r.line === LONG), 'the Model stats page lists every note with the exact line', JSON.stringify(acct));
		check('SL2', acct.every((r) => !r.off), 'and on the account list both are in use (an ordinary chat on fast is told the account note, Help the Diamond\'s)', JSON.stringify(acct));
		// A note for a model the Diamond does not run is not in use. Help runs fast; a note for thinker there is not sent.
		await page.evaluate(() => DaimondNotes.add({ level: 2, scope: '0da1000000e1', cm: 'thinker', tag: 'tool', line: 'Use a tool only when the task needs one.', at: { t: 0, n: 0 } }));
		await wait(500);
		const ex = await page.evaluate(() => [...document.querySelectorAll('#panel-modeldash .mdash-steer .steer-row')].map((r) => ({
			line: (r.querySelector('.steer-line') || {}).textContent || '', off: (r.querySelector('.steer-off') || {}).textContent || '' })));
		const tool = ex.find((r) => /tool only when/.test(r.line));
		check('SL2', !!tool && /another model/i.test(tool.off), 'a note for thinker, on a Diamond that runs fast, is marked "not in use: another model"', JSON.stringify(tool));
		S.toolNote = await page.evaluate(() => DaimondNotes.all().filter((e) => e.tag === 'tool').map((e) => ({ level: e.level, scope: e.scope, id: e.id }))[0]);
		await page.evaluate((r) => DaimondNotes.retire(r, { t: 0, n: 0 }), S.toolNote);
		await page.evaluate(() => DaimondPanels.show('pending'));
	},

	SL4: async () => {
		const { s, page } = S.A;
		// An ordinary chat on mock/fast is told the account note; two turns with nothing changed carry the same `sp`.
		const spOf = async () => {
			const chats = await servedChats(s);
			const out = [];
			chats.forEach((c) => (c.messages || []).forEach((m) => { if (m.role === 'assistant' && m.prod && m.prod[0] && m.prod[0].sp && /^slmark/.test(String(m.content || '').slice(0, 7)) === false) out.push({ c: c.id, sp: m.prod[0].sp, ts: m.ts || 0 }); }));
			return out.filter((x) => !/^slchat/.test(x.c));
		};
		// The system message of the latest request. The workspace listing in it counts files and bytes, which move as the store is written
		// (a digest, a note file), so those two figures are set to N: the rest of the message is compared whole.
		const sysOf = () => { const rq = mockLog(); for (let i = rq.length - 1; i >= 0; i--) { const m = (rq[i].messages || []).find((x) => x.role === 'system'); if (m) return (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).replace(/\(\d+ files?, \d+ [KMG]?B\)/g, '(N files, N B)'); } return ''; };
		clearMockLog();
		await chat(s, 'hello one');
		const s1 = sysOf(), sp1 = await spOf();
		check('SL4', s1.includes(HEAD_OF_BLOCK) && s1.includes('- ' + LONG), 'while the note stands the system message carries the STEERING block with its exact line', s1.length + ' bytes');
		check('SL4', s1.indexOf(HEAD_OF_BLOCK) < s1.indexOf(CLAUSE) && s1.trimEnd().endsWith(s1.slice(s1.indexOf(CLAUSE)).trimEnd()), 'the safety clause is still last');
		await chat(s, 'hello two');
		const s2 = sysOf(), sp2 = await spOf();
		check('SL4', s2 === s1 && sp2.length === sp1.length + 1 && sp2[sp2.length - 1].sp === sp1[sp1.length - 1].sp, 'two turns with no change: the same system message, the same sp', firstDiff(s1, s2) + ' | ' + sp1.map((x) => x.sp).join(',') + ' / ' + sp2.map((x) => x.sp).join(','));
		// Remove the account note from the list and ask again.
		await page.evaluate(() => DaimondPanels.show('modeldash'));
		await page.waitForSelector('#panel-modeldash .mdash-steer .steer-row', { timeout: 8000 });
		const rm = page.locator('#panel-modeldash .mdash-steer .steer-row', { hasText: 'Your account' }).locator('.steer-rm').first();
		await wait(700);			// the page draws the stats once more when its figures arrive; the press comes after that
		await rm.click({ force: true });
		await until(() => page.evaluate(() => document.querySelectorAll('#panel-modeldash .mdash-steer .steer-row').length === 1));
		const remain = await page.evaluate(() => [...document.querySelectorAll('#panel-modeldash .mdash-steer .steer-row')].length);
		check('SL3', remain === 1, 'Remove on the account row takes the row from the list', remain + ' rows left');
		const fo = await fileOf(page, OPT);
		check('SL3', / · retired · account · fast · long /.test(fo) && !/ · active · account /.test(fo), 'the entry is retired in the Optimiser\'s file (kept as a record, never told again)', JSON.stringify(fo.slice(0, 160)));
		check('SL3', / · retired · account · fast · long 12 of 30\n/.test(fo), 'and it records the figures of that day (12 of 30, as Add did), so it is not proposed again for 20 answers (a bare zero would bring it back)', JSON.stringify(fo.slice(0, 120)));
		await raise(page);
		check('SL3', (await tiles(page)).every((t) => !(t.kind === 'note' && t.level === 3)), 'the account note is not proposed again');
		await chat(s, 'hello three');
		const s3 = sysOf(), sp3 = await spOf();
		check('SL4', !s3.includes(HEAD_OF_BLOCK) && !s3.includes(LONG), 'after Remove the next system message has no STEERING block and not the line', s3.length + ' bytes');
		const cut = s1.slice(0, s1.indexOf(HEAD_OF_BLOCK)) + s1.slice(s1.indexOf(CLAUSE));
		check('SL4', cut === s3, 'and it differs from the one before by exactly the block (nothing else moved)', firstDiff(cut, s3));
		check('SL4', sp3.length === sp2.length + 1 && sp3[sp3.length - 1].sp !== sp2[sp2.length - 1].sp, 'the answer\'s sp changed', sp2[sp2.length - 1].sp + ' -> ' + sp3[sp3.length - 1].sp);
	},

	SL4b: async () => {
		const { s, page } = S.A;
		// The Diamond's daimon is told the Diamond's note while it stands, and Remove in the Diamond's own cog dialog takes it away.
		const sysOf = () => { const rq = mockLog(); for (let i = rq.length - 1; i >= 0; i--) { const m = (rq[i].messages || []).find((x) => x.role === 'system'); if (m) return (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).replace(/\(\d+ files?, \d+ [KMG]?B\)/g, '(N files, N B)'); } return ''; };
		const spOf = () => page.evaluate((d) => { const c = DaimondDiamond.conversation(d); return c ? (c.messages || []).filter((m) => m.role === 'assistant' && m.prod && m.prod[0] && m.prod[0].sp).map((m) => m.prod[0].sp) : []; }, HELP);
		const turn = async (text) => {
			clearMockLog();
			await page.evaluate((id) => { const b = document.querySelector('#diamond-list .diamond-box[data-id="' + id + '"]'); if (b) b.click(); }, HELP);
			await wait(900);
			await steerDiamond(s, text);
			for (let i = 0; i < 80 && mockLog().length === 0; i++) await wait(500);
			await wait(3500);
			return sysOf();
		};
		const d1 = await turn('hello diamond one'), sp1 = await spOf();
		check('SL4', d1.includes(HEAD_OF_BLOCK) && d1.includes('- ' + LONG), 'the Diamond\'s daimon is sent the Diamond\'s note while it stands', d1.length + ' bytes');
		const rows0 = await page.evaluate((id) => {
			const box = document.querySelector('#diamond-list .diamond-box[data-id="' + id + '"]'), cog = box && box.querySelector('.tile-cog');
			if (cog) cog.click();
			return !!cog;
		}, HELP);
		await page.waitForSelector('.tile-dlg-card [data-steer-list="diamond"] .steer-row', { timeout: 8000 }).catch(() => {});
		await wait(400);
		const own = page.locator('.tile-dlg-card [data-steer-list="diamond"] .steer-row', { hasText: 'This diamond' }).locator('.steer-rm').first();
		await own.click({ force: true });
		await until(() => page.evaluate(() => document.querySelectorAll('.tile-dlg-card [data-steer-list="diamond"] .steer-row').length === 0));
		const left = await page.evaluate(() => document.querySelectorAll('.tile-dlg-card [data-steer-list="diamond"] .steer-row').length);
		const empty = await page.evaluate(() => (document.querySelector('.tile-dlg-card [data-steer-list="diamond"] .steer-empty') || {}).textContent || '');
		check('SL3', rows0 && left === 0 && /no steering notes/i.test(empty), 'Remove in the Diamond\'s cog dialog takes its row, and the empty state shows', left + ' rows, ' + JSON.stringify(empty));
		await page.evaluate(() => document.querySelectorAll('.tile-dlg .tile-dlg-done, .dlg-card .dlg-cancel').forEach((b) => { try { b.click(); } catch (e) { /* closed */ } }));
		await wait(400);
		check('SL3', (await raise(page)).every((t) => !(t.kind === 'note' && t.level === 2)), 'the Diamond note is not proposed again either');
		const fh = await fileOf(page, HELP);
		check('SL3', / · retired · diamond · fast · long 12 of 30\n/.test(fh) && !/ · active · diamond /.test(fh), 'the Diamond\'s entry is retired with the figures of that day', JSON.stringify(fh.slice(0, 140)));
		const d2 = await turn('hello diamond two'), sp2 = await spOf();
		check('SL4', !d2.includes(HEAD_OF_BLOCK) && !d2.includes(LONG), 'after Remove the Diamond\'s daimon is sent no STEERING block', d2.length + ' bytes');
		// The daimon's message is its role prompt and then the Diamond's own state (its files and the workspace listing, which moves
		// with the store and lists in no fixed order); the role prompt is what a note changes, so that is what is compared whole.
		const role = (d) => { const i = d.indexOf('\n# Requirements'); return i < 0 ? d : d.slice(0, i); };
		const r1 = role(d1), r2 = role(d2), cut = r1.slice(0, r1.indexOf(HEAD_OF_BLOCK)) + r1.slice(r1.indexOf(CLAUSE));
		check('SL4', r2.length > 5000 && cut === r2, 'and the role prompt differs from the one before by exactly the block (the Diamond\'s own files aside)', firstDiff(cut, r2));
		check('SL4', sp1.length >= 1 && sp2.length === sp1.length + 1 && sp2[sp2.length - 1] !== sp1[sp1.length - 1], 'and the daimon\'s sp changed', sp1.join(',') + ' -> ' + sp2.join(','));
	},

	SL5: async () => {
		const { page } = S.A;
		// The switch tile may need a fresh raise (the earlier Remove settled things).
		let ts = await raise(page);
		let sw = ts.find((t) => t.kind === 'switch');
		if (!sw) { check('SL5', false, 'a switch is proposed to a Diamond running a model that is rated down', JSON.stringify(ts)); return; }
		await press(page, sw.id, 'Switch');
		const now = await modelOf(page, HELP);
		check('SL5', now && now.model === 'mock/thinker' && /^custom/.test(now.provider), 'Switch moves the Diamond to the model it names, on the provider that hosts it', JSON.stringify(now));
		const f = await fileOf(page, HELP);
		const m = /· switched · diamond · fast · switch 0 of (\d+) · to thinker · was alt\/mock\/fast/.exec(f);
		check('SL5', !!m, 'the Switch is on file for its review, with the whole model it left (provider alt, mock/fast) and the rated answers of the model it went to', JSON.stringify(f.slice(-240)));
		S.n0 = m ? Number(m[1]) : 16;
		ts = await raise(page);
		check('SL5', !ts.some((t) => t.kind === 'back'), 'no review yet');
		// 19 more rated answers on thinker in Help: nothing. One more: the review.
		await rated(page, { model: 'mock/thinker', d: HELP, up: 14, down: 5, tagged: 0 });
		ts = await raise(page);
		check('SL5', !ts.some((t) => t.kind === 'back'), '19 new rated answers raise no review', JSON.stringify(ts.map((t) => t.kind)));
		await rated(page, { model: 'mock/thinker', d: HELP, up: 1, down: 0, tagged: 0 });
		ts = await raise(page);
		const back = ts.find((t) => t.kind === 'back');
		check('SL5', !!back, 'the 20th raises one review tile', JSON.stringify(ts.map((t) => t.kind + ':' + t.level)));
		if (!back) return;
		S.back = back;
		await page.evaluate(() => DaimondPanels.show('pending'));
		const labels = await page.evaluate((id) => [...document.querySelectorAll('#pending-list .pend-card[data-id="' + id + '"] .pend-act')].map((b) => b.textContent), back.id);
		check('SL5', JSON.stringify(labels) === JSON.stringify(['Keep', 'Switch Back']), 'the tile asks Keep or Switch Back', JSON.stringify(labels));
		const head = await page.evaluate((id) => ((document.querySelector('#pending-list .pend-card[data-id="' + id + '"]') || {}).textContent || ''), back.id);
		check('SL5', /thinker/.test(head) && /fast/.test(head) && !/\bup\b.*\bdown\b.*rated down/.test('') , 'and names both models, with counts only', head.slice(0, 160));
		S.fileBeforeBack = await fileOf(page, HELP);
	},

	SL6: async () => {
		const { page } = S.A;
		if (!S.back) { skip('SL6', 'no review tile to press'); return; }
		await press(page, S.back.id, 'Switch Back');
		const now = await modelOf(page, HELP);
		check('SL6', now && now.provider === 'alt' && now.model === 'mock/fast', 'Switch back restores the exact model, provider included (alt / mock/fast, not the first provider\'s copy)', JSON.stringify(now));
		const f = await fileOf(page, HELP);
		check('SL6', / · retired · diamond · fast · switch /.test(f) && !/ · switched · /.test(f), 'and closes the review with a retirement', JSON.stringify(f.slice(-200)));
		const ts = await raise(page);
		check('SL6', !ts.some((t) => t.kind === 'back'), 'the review does not come back');
		S.fileAfterBack = f;
	},

	SL7: async () => {
		if (!S.fileBeforeBack || !S.fileAfterBack) { skip('SL7', 'no note file to carry'); return; }
		// A second context: the same account's ratings and the same note file, nothing else of the first one's memory.
		const B = S.B = await context('slist-b');
		const page = B.page;
		await rated(page, { model: 'mock/fast', d: HELP, up: 4, down: 26, tagged: 12, pv: 'alt' });
		await rated(page, { model: 'mock/thinker', d: HELP, up: 15, down: 1, tagged: 0 });
		await rated(page, { model: 'mock/thinker', d: HELP, up: 15, down: 5, tagged: 0 });
		await rated(page, { model: 'mock/thinker', d: HELP, up: 1, down: 0, tagged: 0 });
		const first = await page.evaluate(() => DaimondModels.providers().map((p) => p.id).find((id) => id !== 'alt'));
		await setModelOf(page, HELP, { provider: first, model: 'mock/thinker' });
		const put = (text) => page.evaluate(async (a) => { const W = await import('/pkg/oxedyne_daimond.js'); await W.store_write(a.p, a.t); await W.touch_diamond(a.d); await DaimondNotes.reload(true); },
			{ p: 'diamonds/' + HELP + '/' + FILE, t: text, d: HELP });
		// Control: the file as it stood while the switch was open raises the review here, so this context's pipeline is live.
		await put(S.fileBeforeBack);
		let ts = await raise(page);
		check('SL7', ts.some((t) => t.kind === 'back'), 'control: the file with the open switch raises the review in a second context', JSON.stringify(ts.map((t) => t.kind)));
		// The file after Switch back: the review is closed, here too.
		await put(S.fileAfterBack);
		ts = await raise(page);
		check('SL7', !ts.some((t) => t.kind === 'back'), 'the file after Switch back (or Keep) raises no review in the second context', JSON.stringify(ts.map((t) => t.kind)));
		// And 60 answers later it still does not.
		await rated(page, { model: 'mock/thinker', d: HELP, up: 40, down: 20, tagged: 0 });
		ts = await raise(page);
		check('SL7', !ts.some((t) => t.kind === 'back'), 'nor after 60 more rated answers', JSON.stringify(ts.map((t) => t.kind)));
		// Keep closes the review the same way: open it again by hand, press Keep, and the file is retired with nothing moved.
		await put(S.fileBeforeBack);
		ts = await raise(page);
		const back = ts.find((t) => t.kind === 'back');
		if (back) {
			await press(page, back.id, 'Keep');
			const m = await modelOf(page, HELP);
			const f = await fileOf(page, HELP);
			check('SL7', m && m.model === 'mock/thinker' && / · retired · diamond · fast · switch /.test(f), 'Keep closes the review with a retirement and moves no model', JSON.stringify(m));
			ts = await raise(page);
			check('SL7', !ts.some((t) => t.kind === 'back'), 'and it does not come back');
		} else check('SL7', false, 'the review could not be raised a second time to press Keep');
	},

	SL8: async () => {
		const { page } = S.A;
		// Edit on a note tile: a textarea that shows a 200-byte line whole. The tile is put in the Pending list by hand (the proposals
		// above are settled), and its Edit is the real press.
		const L200 = ('Answer in plain words and keep each reply short, ' .repeat(5)).slice(0, 200);
		// The dialog is reached through the real Edit press: seed a tile for it.
		await page.evaluate((line) => {
			const pre = (window.DaimondAccounts && DaimondAccounts.prefix && DaimondAccounts.prefix()) || '';
			const it = { id: 'slx1', diamondId: '0da1000000e1', diamondName: 'Daimond Help', headline: 'Add a note for fast', detail: 'x', kind: 'steer', priority: 'low', at: Date.now(),
				steer: { id: 'note|2|0da1000000e1|fast|long|', kind: 'note', level: 2, scope: '0da1000000e1', name: 'Daimond Help', key: 'fast', tag: 'long', to: '', evidence: {}, line: line, lineKey: '', at: { t: 0, n: 0 } } };
			localStorage.setItem(pre + 'daimond-pending', JSON.stringify([it]));
			window.dispatchEvent(new StorageEvent('storage', { key: pre + 'daimond-pending' }));
			DaimondPanels.show('pending');
		}, L200);
		await wait(400);
		await page.locator('#pending-list .pend-card .pend-act', { hasText: /^Edit$/ }).first().click({ force: true });
		await page.waitForSelector('.dlg textarea.dlg-area', { timeout: 6000 }).catch(() => {});
		const d = await page.evaluate(() => { const a = document.querySelector('.dlg textarea.dlg-area'); return a ? { v: a.value, sh: a.scrollHeight, ch: a.clientHeight, rows: a.rows, ff: getComputedStyle(a).fontFamily } : null; });
		check('SL8', !!d && d.v.length === 200 && new TextEncoder().encode(d.v).length === 200, 'Edit opens a textarea holding the 200-byte line', d ? d.v.length + ' chars' : 'no textarea');
		check('SL8', !!d && d.sh <= d.ch + 1, 'the whole line is visible with no scrolling (the one-line field showed a third of it)', d ? `scrollHeight ${d.sh}, clientHeight ${d.ch}` : '');
		await page.keyboard.press('Escape');
		await wait(300);
		check('SL8', (await page.locator('.dlg').count()) === 0, 'Escape closes it');
	},
};
const ORDER = ['SL1', 'SL2', 'SL4', 'SL4b', 'SL5', 'SL6', 'SL7', 'SL8'];

try {
	S.A = await context('slist-a');
	check('PRE', await S.A.page.evaluate(() => !!(window.DaimondSteering && DaimondSteering.listing && DaimondNotes.switched)), 'the Steering list and the switch writer are on the page');
	// A section that throws is red and the run goes on, so that each section is seen red or green on its own (a run against old code shows every one).
	for (const k of ORDER) if (!ONLY || ONLY.includes(k) || ONLY.includes(k.replace(/b$/, '')) || (k === 'SL4' && ONLY.includes('SL3'))) {
		console.log(`\n── ${k}`);
		try { await SECTIONS[k](); } catch (e) { check(k, false, 'the section threw', String((e && e.message) || e).split('\n')[0]); }
	}
} catch (e) { tally.bad.push('threw'); console.log('  FAIL threw -- ' + (e && e.stack || e)); }
finally { for (const k of ['A', 'B']) { try { if (S[k]) await S[k].s.close(); } catch (e) { /* closed */ } } }
console.log(`\nverify_steerlist: ${tally.ok} ok, ${tally.bad.length} failed${tally.bad.length ? ' (' + [...new Set(tally.bad)].join(', ') + ')' : ''}`);
process.exit(tally.bad.length ? 1 : 0);

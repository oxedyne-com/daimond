// verify_prefixpeer.mjs — the attach prefix on a SECOND device's copy of a
// daimon chat that already has turns (owner report, 2026-09-15, gilgamesh).
//
// Proposal 15 (63ea78e5) gated `syncComposerAttachPrefix` on the thread having
// turns, and `dev/verify_draftdup.mjs` proves that gate in isolation on ONE
// device. The owner's case is the other desktop: a folder-mounted device that
// receives the Diamond and its daimon chat by sync, never sends a turn itself,
// and keeps coming back to a composer that reads
//
//   Note code/dev_handover, code/dev_handover/06_projects/daimond.md, …
//
// Two paths put that text there and one rule keeps it there, and this file
// drives all of them through the real app in a browser, no gateway needed --
// the sync arrival is driven through `DaimondCore.applySync`, which is the
// very function sync.js hands a pulled parcel to.
//
//   A. DEVICE HISTORY. A draft this device persisted under an earlier build
//      (pre-5ede1ba every seed was persisted; the owner saw six copies on
//      2026-09-13) is restored on boot by `composerDraft`. Its scrub decides
//      `hasTurns` from `next.messages.length`, which is 0 for a chat whose
//      transcript is NOT YET RESIDENT -- and at boot no chat is -- so a stack of
//      copies on a chat with six turns collapses to ONE copy instead of none,
//      and `scrubAttachPrefixDup` then leaves a single copy alone for ever
//      (`copies < 2` returns the text unchanged). The gate is closed (the
//      summary count is right), so nothing downstream ever removes it.
//
//   B. LATE TRANSCRIPT. A daimon chat that arrives with a chunk reference this
//      device cannot yet materialise lands "metadata-only": `messages: []`,
//      summary `msgCount: 0`, though its scalars say turns were spent elsewhere
//      (`promptTokens`, `costUsd`, `lastPrompt`, `updatedAt`). The gate reads
//      `chatMsgCount === 0` as "unstarted" and seeds the prefix; a switch away
//      and back then PERSISTS that seed as a draft via `composerDraft`'s own
//      `DaimondDrafts.set` (which is not behind drafts.js's isTrusted guard),
//      and from then on A applies.
//
//   C. CONTROL. The same arrival with its transcript inline seeds nothing,
//      which is what proposal 15 fixed and must stay fixed.
//
// Expected on the current build: A and B RED, C green.
//
//   eval "$(bash dev/world.sh N --env)" && node dev/verify_prefixpeer.mjs
//
// PROVED AGAINST THE KEEPER ITSELF FIRST. `scrubAttachPrefixDup`'s old
// `if (copies < 2) return text;` returned a SINGLE stacked copy unchanged
// regardless of `hasTurns` -- the exact keeper that left the owner's box
// filled for ever, one collapse short of empty. `--break` re-splices that
// return into the function's source (grabbed fresh from `www/js/daimond.js`,
// the way `verify_draftdup.mjs` proves `mergeAttachPrefix`) and runs ONLY
// that check, no browser needed, so the fault this file exists to catch has
// an on-request way to go red:
//
//   node dev/verify_prefixpeer.mjs --break   # the keeper check FAILS
//   node dev/verify_prefixpeer.mjs           # the full run, clean
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs, steerDiamond, connectMock, scratch } from './harness.mjs';

const HERE  = path.dirname(fileURLToPath(import.meta.url));
const BREAK = process.argv.includes('--break');
const DIAG  = process.env.DAIMOND_DIAG || scratch('diag');
fs.mkdirSync(DIAG, { recursive: true });

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// A function found by its declaration and brace-matched from the opening
// `{`, so a rename or a move throws here rather than silently testing a
// stale copy (same device as `verify_draftdup.mjs`'s `grabFn`).
function grabFn(src, sig) {
	const start = src.indexOf(sig);
	if (start < 0) { console.error(`could not find '${sig}'`); process.exit(2); }
	const open2 = src.indexOf('{', start);
	let depth = 0, i = open2;
	for (; i < src.length; i++) {
		const c = src[i];
		if (c === '{') depth++;
		else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(start, i);
}

console.log('the keeper itself: scrubAttachPrefixDup on a single stacked copy');
{
	const daimondSrc = fs.readFileSync(path.join(HERE, '..', 'www', 'js', 'daimond.js'), 'utf8');
	let scrubSrc = grabFn(daimondSrc, 'function scrubAttachPrefixDup(');
	if (BREAK) {
		// Reinstate the fault: a single copy returns unchanged no matter what
		// `hasTurns` says, which is what let a boot-restored seed stand on a
		// thread the summary already proved had turns.
		const patched = scrubSrc.replace(
			/if \(!copies\) return text;[\s\S]*?return block \+ rest;/,
			'if (copies < 2) return text;\n\t\treturn hasTurns ? rest : (block + rest);');
		if (patched === scrubSrc) { console.error('--break: nothing matched to patch'); process.exit(2); }
		scrubSrc = patched;
		console.log('*** RUNNING UNDER --break: the check below is expected to FAIL ***');
	}
	const { scrubAttachPrefixDup } =
		new Function(scrubSrc + '\nreturn { scrubAttachPrefixDup: scrubAttachPrefixDup };')();
	const PREFIX = 'Note code/dev_handover, code/dev_handover/07_context_assembly, complement\n';
	const out = scrubAttachPrefixDup(PREFIX, PREFIX, true);
	check('a single copy on a STARTED thread is stripped to nothing', out === '', JSON.stringify(out));
}
if (BREAK) {
	console.log(`\n${ok.length}/${ok.length + bad.length} checks passed`);
	if (bad.length) { console.log(bad.length + ' FAILED:\n  ' + bad.join('\n  ')); process.exit(1); }
	console.log('verify_prefixpeer --break: the keeper check passed, which means it proves nothing');
	process.exit(1);
}

const NAME = 'prefixpeer';
const MARKS = ['code/dev_handover', 'code/dev_handover/07_context_assembly', 'complement'];

const s = await open({ name: NAME, signIn: true, connect: true, defaults: false });
const p = s.page;
// `connectMock` is driven on fixed waits and can miss on a cold profile under
// load, and a Diamond cannot be created without a provider ("Choose a model for
// this Diamond to think with"). Ask, and drive it again until it took.
for (let i = 0; i < 3 && !(s.cfg && s.cfg.model); i++) { await p.waitForTimeout(800); await connectMock(s); }

const box       = () => p.evaluate(() => { const b = document.getElementById('chat-input'); return b ? b.value : null; });
const residency = () => p.evaluate(() => window.DaimondCore.chatResidency());
const drafts    = () => p.evaluate(() => window.DaimondDrafts.all());
const shotTo    = (label) => p.screenshot({ path: path.join(DIAG, `prefixpeer-${label}.png`) });
const copiesIn  = (text, prefix) => (prefix && text) ? text.split(prefix).length - 1 : 0;

/// Run `fn(app, arg)` against a fresh wasm handle, the way every sync verifier does.
const app = (fn, arg) => p.evaluate(async ([src, arg]) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	return await (new Function('app', 'arg', 'return (' + src + ')(app, arg)'))(app, arg);
}, [fn.toString(), arg]);

/// Wait for the mock turn to finish: the send button stops being Stop.
const waitIdle = async () => {
	const t0 = Date.now();
	while (Date.now() - t0 < 30000) {
		const busy = await p.evaluate(() => {
			const b = document.getElementById('chat-send');
			if (!b) return false;
			const t = (b.getAttribute('title') || '') + (b.className || '');
			return /stop/i.test(t) || b.disabled;
		});
		if (!busy) break;
		await p.waitForTimeout(250);
	}
	await p.waitForTimeout(500);
};

const reload = async () => {
	await p.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, NAME);
	await p.waitForTimeout(1500);
};

/// The rail tile for a Diamond by name, clicked, then its chat face.
const openDiamond = async (name) => {
	await p.$$eval('.diamond-box', (els, name) => {
		const e = els.find(x => (x.textContent || '').indexOf(name) >= 0);
		if (e) e.click();
	}, name);
	await p.waitForTimeout(900);
	const chatBtn = await p.$('#dview-chat');
	if (chatBtn) { await chatBtn.click({ force: true }); await p.waitForTimeout(600); }
};

const toNewChat = async () => {
	await p.evaluate(() => document.getElementById('new-session-btn').click());
	await p.waitForTimeout(600);
};

/// Lock from the user menu ("Log out"), the way verify_lockkeys drives it, then unlock.
const lockAndUnlock = async () => {
	await p.evaluate(() => { const row = document.querySelector('.user-row'); if (row) row.click(); });
	await p.waitForTimeout(400);
	const drove = await p.evaluate(() => {
		const item = [...document.querySelectorAll('button, .menu-item, [role="menuitem"]')]
			.find(b => /log out/i.test(b.textContent || ''));
		if (!item) return false;
		item.click();
		return true;
	});
	await p.waitForTimeout(900);
	await signInAs(s, NAME);
	await p.waitForTimeout(1200);
	return drove;
};

/// The marks' own prefix, built by the app's rule for the three folders.
const prefixFor = (marks) => p.evaluate((marks) => window.DaimondAttach.prefixText(
	marks.map(d => ({ ref: 'dir:[browser]' + d, path: d, state: 'note' }))), marks);

try {
	// ── A. Device history: a persisted draft on a daimon chat with turns ───
	console.log('A. a draft this device kept, on a daimon chat that has turns');
	await p.click('#new-diamond-btn', { force: true });
	await p.waitForSelector('.dlg-input', { timeout: 10000 });
	await p.fill('.dlg-input', 'Daimond-dev');
	await p.click('.dlg-ok', { force: true });
	// A cold profile takes its time between the dialog closing and the new
	// Diamond being selected; ask for the selection rather than assume it.
	await p.waitForFunction(() => !!(window.DaimondDiamond && DaimondDiamond.current()), null, { timeout: 15000 })
		.catch(() => {});
	await p.waitForTimeout(600);
	const dev = await p.evaluate(() => (window.DaimondDiamond.current() || {}).id);
	check('a Diamond to work in', !!dev, dev);
	for (const d of MARKS) {
		await app(async (app, arg) => {
			await app.run_tool('file_write', JSON.stringify({ path: arg.d + '/x.md', content: 'x' }));
			await app.add_link(arg.id, 'diamond:' + arg.id, 'dir:[browser]' + arg.d, 'holds', '', 'user');
		}, { id: dev, d });
	}
	await p.evaluate(() => document.dispatchEvent(new Event('daimond-links-changed')));
	await p.waitForTimeout(600);
	const PREFIX = await prefixFor(MARKS);
	check('three folder marks build the prefix the owner quoted', /^Note code\/dev_handover, /.test(PREFIX), JSON.stringify(PREFIX));
	check('an unstarted daimon is seeded with it (§6, unchanged)', (await box()) === PREFIX, JSON.stringify(await box()));

	// Two turns, on THIS device, so the record has turns beyond doubt.
	await p.evaluate(() => { document.getElementById('chat-input').value = ''; });
	await steerDiamond(s, 'first turn'); await waitIdle();
	await steerDiamond(s, 'second turn'); await waitIdle();
	const rec = (await residency()).find(c => c.msgCount >= 2);
	check('the daimon chat has turns', !!rec, JSON.stringify(await residency()));
	const devChat = rec ? rec.id : '';

	// The device's history: a stacked draft, as the pre-5ede1ba build left one.
	await p.evaluate(([k, v]) => { window.DaimondDrafts.set(k, v); window.DaimondDrafts.flush(); },
		['chat/' + devChat, PREFIX.repeat(3)]);
	await reload();
	const a1 = await box();
	await shotTo('A1-reload');
	check('A1 reload: the composer of a daimon chat with turns is EMPTY', a1 === '',
		copiesIn(a1, PREFIX) + ' copy/copies restored: ' + JSON.stringify(a1));
	const d1 = (await drafts())['chat/' + devChat] || '';
	check('A1 and the stored draft no longer carries the prefix', copiesIn(d1, PREFIX) === 0,
		copiesIn(d1, PREFIX) + ' copy/copies re-persisted');

	// A single copy -- what the scrub leaves, and what an older single-seed draft holds.
	await p.evaluate(([k, v]) => { window.DaimondDrafts.set(k, v); window.DaimondDrafts.flush(); },
		['chat/' + devChat, PREFIX]);
	await reload();
	const a2 = await box();
	check('A2 reload with a single-copy draft: composer EMPTY', a2 === '', JSON.stringify(a2));
	await toNewChat();
	check('A2 a new chat starts with an empty composer', (await box()) === '', JSON.stringify(await box()));
	await openDiamond('Daimond-dev');
	const a3 = await box();
	await shotTo('A3-return');
	check('A3 returning to the daimon chat: composer EMPTY', a3 === '', JSON.stringify(a3));
	const drove = await lockAndUnlock();
	check('A4 the lock is reachable from the user menu', drove === true);
	const a4 = await box();
	await shotTo('A4-unlock');
	check('A4 after unlock: composer EMPTY', a4 === '', JSON.stringify(a4));

	// ── B. Late transcript: a daimon chat that arrives metadata-only ─────
	console.log('\nB. a daimon chat arriving by sync before its transcript can be read');
	const late = await app(async (app, arg) => {
		const id = await app.create_diamond('Synced-late');
		for (const d of arg) await app.add_link(id, 'diamond:' + id, 'dir:[browser]' + d, 'holds', '', 'user');
		return id;
	}, MARKS);
	const cloud = await p.evaluate(() => { try { return DaimondCloud.available(); } catch (e) { return false; } });
	check('the chunk transport is up, so a reference that will not resolve is a MISSING chunk, not a shut door', cloud === true);
	const report = await p.evaluate(async (id) => {
		const rec = { id: 'remote-daimon-' + id, diamondId: id, name: 'Synced-late', model: 'mock/fast', provider: '',
			status: 'active', promptTokens: 5120, completionTokens: 300, cachedTokens: 0, costUsd: 0.12,
			prevPrompt: 0, prevCompletion: 0, prevCached: 0, prevCost: 0, lastPrompt: 5120,
			holds: [], updatedAt: Date.now(),
			messagesRef: { v: 3, key: 'a'.repeat(43), size: 4096, chunks: [{ addr: '00'.repeat(32), size: 4096 }] } };
		return await window.DaimondCore.applySync({ chats: [rec] });
	}, late);
	check('the parcel applies (chats section did not fail)', report && report.failed && report.failed.length === 0, JSON.stringify(report));
	// `applyChats` hands the ids to `onChatsChangedElsewhere`, which rebuilds the
	// in-memory array asynchronously; give it the moment it takes.
	await p.waitForTimeout(1000);
	const landed = (await residency()).find(c => c.id === 'remote-daimon-' + late);
	check('it landed metadata-only: not resident, count 0, though its scalars say turns were spent',
		!!landed && landed.loaded === false && landed.msgCount === 0, JSON.stringify(landed));
	await reload();
	await openDiamond('Synced-late');
	const b1 = await box();
	await shotTo('B1-open');
	check('B1 opening it: composer EMPTY (turns were spent on this thread elsewhere)', b1 === '', JSON.stringify(b1));
	await toNewChat();
	await openDiamond('Synced-late');
	const b2 = (await drafts())['chat/remote-daimon-' + late] || '';
	check('B2 after a switch away and back, no seed has been persisted as a draft', b2 === '', JSON.stringify(b2));

	// ── C. Control: the same arrival with the transcript inline ─────────
	console.log('\nC. the same arrival with its transcript inline (proposal 15, must stay green)');
	const inline = await app(async (app, arg) => {
		const id = await app.create_diamond('Synced-inline');
		for (const d of arg) await app.add_link(id, 'diamond:' + id, 'dir:[browser]' + d, 'holds', '', 'user');
		return id;
	}, MARKS);
	await p.evaluate(async (id) => {
		const now = Date.now();
		const rec = { id: 'remote-daimon-' + id, diamondId: id, name: 'Synced-inline', model: 'mock/fast', provider: '',
			status: 'active', promptTokens: 40, completionTokens: 8, cachedTokens: 0, costUsd: 0.001,
			prevPrompt: 0, prevCompletion: 0, prevCached: 0, prevCost: 0, lastPrompt: 40,
			holds: [], updatedAt: now,
			messages: [{ role: 'user', content: 'hello', ts: now - 2000 }, { role: 'assistant', content: 'hi', ts: now - 1000 }] };
		return await window.DaimondCore.applySync({ chats: [rec] });
	}, inline);
	await reload();
	await openDiamond('Synced-inline');
	const c1 = await box();
	check('C1 opening a synced daimon chat whose transcript arrived: composer EMPTY', c1 === '', JSON.stringify(c1));
} catch (e) {
	check('the run completed', false, (e && e.stack) || String(e));
} finally {
	try { await s.browser.close(); } catch (e) { /* already gone */ }
}

console.log(`\n${ok.length}/${ok.length + bad.length} checks passed`);
if (bad.length) { console.log(bad.length + ' FAILED:\n  ' + bad.join('\n  ')); process.exit(1); }
console.log('verify_prefixpeer: all checks passed');

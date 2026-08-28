// verify_sweep_used.mjs — the same questions, asked of an app that has been used.
//
// THIS IS THE HALF THE SUITE DID NOT HAVE, and it is the half that would have
// caught the defects nobody could see in the code. Every fixture in this tree
// seeds a world and looks at it. The owner does not: he opens the app, works in
// it for an afternoon, and the faults he reports are the ones that ACCUMULATE.
//
//   "The hamburger stops working after modestly long chat use."
//   "When a daimon initiates a new agent worker, the Agents panel should be
//    toggled visible; currently this is not happening."   -- and it did happen,
//    exactly once, on the first fan-out that browser ever ran, remembered in
//    `localStorage` under `daimond-agents-revealed`. Nobody could see that from
//    the code: the call was there, on the right line, in the right function. A
//    fresh profile passes it every time, for ever.
//   Four "Daimond Optimiser" tiles, which arrive through a MERGE -- a second
//    device's pair, under minted ids -- and not through a first boot.
//
// So this file drives the app into a used state first: several chats, a dozen
// turns, panels opened and closed and opened again, a second device's records
// merged in, and a reload standing in for the app being left and come back to.
// Then it asks the four families of dev/sweepkit.mjs all over again, and asks
// three behaviours that only mean anything the SECOND time.
//
// The rule, stated once so it can be argued with: A CHECK THAT ONLY EVER RUNS
// AGAINST A NEWLY SEEDED WORLD CANNOT FIND A FAULT THAT ACCUMULATES.
//
//   node dev/verify_sweep_used.mjs             # the run
//   node dev/verify_sweep_used.mjs --quick     # fewer turns
//   node dev/verify_sweep_used.mjs --headed    # under a real display
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777) and dev/mockllm.mjs
// (DAIMOND_MOCK_PORT, default 9099). No gateway.
//
// LIMITS. A reload is not an app switch on a phone, where the tab may be
// discarded and the process killed; a Chromium at 390x844 is not iOS Safari;
// and "modestly long use" here is a dozen turns of a mock provider in a few
// minutes, not an afternoon of a real one. What accumulates in wasm heap or in
// a service worker over hours is out of reach of this file and is not claimed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, chat, newChat, signInAs, shot, errors } from './harness.mjs';
import { audit, showPanels, openPanels, seedNotes } from './sweepkit.mjs';

const HERE  = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, 'shots', 'nsweep');
fs.mkdirSync(SHOTS, { recursive: true });

const QUICK  = process.argv.includes('--quick');
const HEADED = process.argv.includes('--headed');
const TURNS  = QUICK ? 2 : 4;			// per chat
const CHATS  = QUICK ? 2 : 3;

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const say = (fs_) => { for (const f of fs_) console.log(`         ${f.family} ${f.what} @ ${f.where} — ${f.detail}`); };
const hard = (found) => found.filter((f) => f.family !== 'BEHIND');

const s = await open({ name: 'nsweepused', headed: HEADED });
const p = s.page;
const findings = [];

const agentsOpen = () => p.evaluate(() => { try { return !!window.DaimondPanels.isOpen('agents'); } catch (e) { return false; } });
const quiet = async (ms = 60000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		const busy = await p.evaluate(() => { try { return window.DaimondCore.busy(); } catch (e) { return false; } });
		if (!busy) return true;
		await p.waitForTimeout(300);
	}
	return false;
};

// ── 1. A control, taken before the app has been used ──────────────────────
//
// Everything below is a comparison, and a comparison needs the other end of it.
// Without this a file that found the fresh app broken would report it as a
// fault of use.
console.log('\n1. the app as the rest of the suite meets it\n');
await seedNotes(p, 20);
await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, s.name);
await p.waitForTimeout(800);
await showPanels(p, ['social', 'trash']);
{
	const fresh = hard(await audit(p));
	check('fresh: nothing hidden, stranded, covered or doubled', fresh.length === 0, `${fresh.length} finding(s)`);
	if (fresh.length) { say(fresh); findings.push(...fresh.map((f) => ({ ...f, when: 'fresh' }))); }
}

// ── 2. Use it ─────────────────────────────────────────────────────────────
console.log(`\n2. ${CHATS} chats, ${TURNS} turns each, panels opened and closed\n`);
const PANEL_CYCLE = ['web', 'doc', 'tools', 'graph', 'social', 'trash', 'work', 'spend'];
for (let c = 0; c < CHATS; c++) {
	await newChat(s);
	for (let t = 0; t < TURNS; t++) {
		await chat(s, `Turn ${t + 1} of chat ${c + 1}: say something back.`, { timeout: 40000 });
	}
	// A panel opened and closed between turns, which is what a person does and
	// what no fixture in this suite does twice.
	const id = PANEL_CYCLE[c % PANEL_CYCLE.length];
	await showPanels(p, ['ai', id]);
	await p.evaluate((id) => { const b = document.querySelector(`[data-close="${id}"]`); if (b) b.click(); }, id);
	await p.waitForTimeout(300);
}
check('the turns landed', (await p.evaluate(() => document.querySelectorAll('#chat-output .msg, #chat-output .chat-msg').length)) > 0,
	`${await p.evaluate(() => document.querySelectorAll('#chat-output .msg, #chat-output .chat-msg').length)} message node(s)`);

// A SECOND DEVICE'S RECORDS, arriving through the merge. This is how the four
// tiles were made: a per-device seed flag plus a minted id, so each device made
// its own pair and the merge -- knowing nothing about names -- kept them all.
const minted = await p.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	return [await app.create_diamond('Daimond Help'), await app.create_diamond('Daimond Optimiser')];
});
check('a second device\'s default Diamonds were merged in', minted.length === 2, minted.join(', '));

// ── 3. Left, and come back to ─────────────────────────────────────────────
console.log('\n3. the app left and come back to\n');
await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, s.name);
await p.waitForTimeout(2500);
await showPanels(p, ['social', 'trash']);
{
	const used = await audit(p);
	const h = hard(used);
	check('used: nothing hidden, stranded, covered or doubled', h.length === 0, `${h.length} finding(s)`);
	if (h.length) { say(h); findings.push(...h.map((f) => ({ ...f, when: 'used' }))); }
	await p.screenshot({ path: path.join(SHOTS, 'used-desktop.png') }).catch(() => {});
}

// THE RAIL, COUNTED. Two default Diamonds is the offer; four is the defect, and
// it survives a reload because they are four distinct records. This is asked
// after the merge and after the boot, which is the only place it can be asked.
{
	const names = await p.evaluate(() => {
		const list = document.getElementById('diamond-list');
		if (!list) return {};
		const n = {};
		for (const tile of list.children) {
			if (tile.classList.contains('rail-note')) continue;
			const t = (tile.textContent || '').trim().split('\n')[0].trim();
			if (t) n[t] = (n[t] || 0) + 1;
		}
		return n;
	});
	const doubled = Object.keys(names).filter((k) => names[k] > 1);
	check('no rail tile name is drawn twice after a merge and a reload',
		doubled.length === 0, doubled.map((k) => `"${k}" x${names[k]}`).join(', '));
	console.log('         rail: ' + JSON.stringify(names));
	await p.screenshot({ path: path.join(SHOTS, 'used-rail.png'),
		clip: await p.evaluate(() => {
			const r = document.getElementById('panel-rail').getBoundingClientRect();
			return { x: Math.round(r.left), y: 40, width: Math.round(r.width), height: 420 };
		}) }).catch(() => {});
}

// ── 4. The behaviours that only mean anything the SECOND time ─────────────
console.log('\n4. twice, because once is what the defect looked like\n');
{
	await p.evaluate(() => window.DaimondPanels.hide('agents'));
	await p.waitForTimeout(300);
	check('the control: the Agents panel is shut', (await agentsOpen()) === false);

	await chat(s, '@tool spawn_agent {"name":"sweep1","task":"@slow 2000"}', { timeout: 45000 });
	await p.waitForTimeout(1200);
	check('the first fan-out opens the Agents panel', (await agentsOpen()) === true);

	// Shut by hand with nothing running, which is a tidy-up and not a refusal.
	await quiet();
	await p.evaluate(() => { const b = document.querySelector('[data-close="agents"]'); if (b) b.click(); else window.DaimondPanels.hide('agents'); });
	await p.waitForTimeout(400);
	check('the control: it is shut again, by hand, with nothing running', (await agentsOpen()) === false);

	await chat(s, '@tool spawn_agent {"name":"sweep2","task":"@slow 2000"}', { timeout: 45000 });
	await p.waitForTimeout(1200);
	const twice = await agentsOpen();
	check('THE SECOND fan-out opens it too', twice === true,
		twice ? '' : 'it opened once per browser lifetime and never again');
	if (!twice) findings.push({ family: 'USED', what: 'a panel that reveals itself once per browser',
		where: '#panel-agents', detail: 'the second fan-out left it shut', when: 'used' });
	await quiet();
}

// A PANEL OPENED AND CLOSED TEN TIMES still draws what it holds. Nothing in the
// suite opens one twice, and a surface that is built on show and not torn down
// on hide is the shape of half the faults in this file's header.
{
	await showPanels(p, ['social', 'trash']);
	let worst = null;
	for (let i = 0; i < 10; i++) {
		await p.evaluate(() => { const b = document.querySelector('[data-close="social"]'); if (b) b.click(); });
		await p.waitForTimeout(120);
		await showPanels(p, ['social', 'trash']);
	}
	const found = hard(await audit(p));
	check('the Social panel, opened and closed ten times, still shows its notes',
		found.length === 0, found.length ? `${found.length} finding(s)` : '');
	if (found.length) { say(found); findings.push(...found.map((f) => ({ ...f, when: 'ten cycles' }))); }
	void worst;
}

// ── 5. On a phone, after all of that ──────────────────────────────────────
//
// The hamburger is the owner's own report -- "it stops working after modestly
// long chat use" -- and it is only a control on a phone. Pressed for real, and
// the drawer asked whether it actually came out.
console.log('\n5. a phone, after the same use\n');
{
	await p.setViewportSize({ width: 390, height: 844 });
	await p.waitForTimeout(700);
	const btn = await p.$('#drawer-btn');
	const shown = await p.evaluate(() => {
		const b = document.getElementById('drawer-btn');
		if (!b) return false;
		const r = b.getBoundingClientRect();
		return r.width > 0 && r.height > 0;
	});
	check('the hamburger is drawn on a phone', shown);
	if (shown) {
		// The point is hit-tested before it is pressed: a button under a stale
		// overlay takes a forced click and does nothing, which is exactly what
		// "it stops working" looks like from the outside.
		const atPoint = await p.evaluate(() => {
			const b = document.getElementById('drawer-btn');
			const r = b.getBoundingClientRect();
			const e = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
			return e ? (b.contains(e) || e.contains(b) ? 'itself' : (e.id || e.className || e.tagName)) : 'nothing';
		});
		check('the point you would press belongs to the hamburger', atPoint === 'itself', String(atPoint));
		await btn.click({ force: true });
		await p.waitForTimeout(600);
		const drawer = await p.evaluate(() => {
			const r = document.getElementById('panel-rail');
			if (!r) return { out: false, why: 'no rail' };
			const b = r.getBoundingClientRect();
			return { out: b.width > 40 && b.left > -40 && b.right > 0, left: Math.round(b.left), width: Math.round(b.width) };
		});
		check('the rail drawer comes out after all that use', drawer.out === true, JSON.stringify(drawer));
		await p.screenshot({ path: path.join(SHOTS, 'used-iphone-drawer.png') }).catch(() => {});
	}
	const phone = hard(await audit(p));
	check('phone, used: nothing hidden, stranded, covered or doubled', phone.length === 0, `${phone.length} finding(s)`);
	if (phone.length) { say(phone); findings.push(...phone.map((f) => ({ ...f, when: 'phone, used' }))); }
	await p.screenshot({ path: path.join(SHOTS, 'used-iphone.png') }).catch(() => {});
}

// ── The report ────────────────────────────────────────────────────────────
const REPORT = path.join(HERE, 'sweep_used_report.md');
let md = '# What a person would see, after using it\n\n'
	+ `Written by \`dev/verify_sweep_used.mjs\`, ${new Date().toISOString().slice(0, 10)}.\n\n`;
md += findings.length
	? '| when | where | what | detail |\n|---|---|---|---|\n'
		+ findings.map((f) => `| ${f.when || ''} | \`${f.where}\` | ${f.what} | ${f.detail} |`).join('\n') + '\n'
	: 'Nothing found.\n';
fs.writeFileSync(REPORT, md);
console.log(`\nreport: ${REPORT}`);

const errs = errors(s).filter((e) => !(/status of 502/.test(e) && /\/api\//.test(e)));
check('nothing threw in the page while it was used', errs.length === 0, errs.slice(0, 2).join(' | '));
await shot(s, 'nsweep-used-last');
await s.close();

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) { for (const b of bad) console.log('  FAIL ' + b); process.exit(1); }

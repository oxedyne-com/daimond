// verify_diamondwalk.mjs — the store is never walked twice at once.
//
// WHY. `list_diamonds` walks the whole Diamond root and reads each Diamond's
// metadata: one OPFS round trip per Diamond. On a desktop each is a few
// milliseconds and nobody notices. On the iPhone that looped for four sessions
// each was 100-500ms across FIFTEEN Diamonds, and the durable trail from the
// device showed this:
//
//     16:37:46.046  list_diamonds start
//     16:37:46.126  list  15 entries
//     16:37:46.126  list entry 19fb11892cdc
//     16:37:47.185  list entry 19fad130b973      <- still on the fourth
//     16:37:47.345  list_diamonds start          <- and a SECOND walk begins
//
// Fourteen callers reach `loadDiamonds` and most are event-driven, so on a slow
// store they overlap by construction rather than by accident. Every walk holds
// the whole list, redraws the rail and reloads the triggers, and they pile up.
//
// WHAT IS LOCKED DOWN.
//
//  A. Concurrent asks produce ONE walk, not one each.
//  B. No two walks ever overlap — measured from the trail's own start/finish
//     markers, not from a count, because a count cannot tell three sequential
//     walks from three simultaneous ones and simultaneous is the fault.
//  C. An ask that arrives DURING a walk still gets fresh data. A caller that
//     has just written to the store must not be handed a walk that began before
//     its write, so a trailing walk runs afterwards.
//  D. The rail ends up right: every Diamond in the store is on it.
//
// PROVED RED with `--break`, which restores the un-coalesced function.
//
//   node dev/verify_diamondwalk.mjs
//   node dev/verify_diamondwalk.mjs --break     # must fail, loudly
//
// Needs dev/serve.mjs. No gateway, no model.

import fs from 'node:fs';
import { open, scratch } from './harness.mjs';

const BREAK = process.argv.includes('--break');

const out = [];
let bad = 0;
const check = (ok, what, detail) => {
	out.push(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail != null ? ' — ' + detail : ''}`);
	if (!ok) bad++;
	return ok;
};

const PROFILE = scratch('pw', 'diamondwalk-' + process.pid);
fs.rmSync(PROFILE, { recursive: true, force: true });
const s = await open({ name: 'diamondwalk', connect: false, profile: PROFILE });
const p = s.page;

// Enough Diamonds that a walk takes long enough to be overlapped. The phone had
// fifteen; eight is enough to make the window real without making the test slow.
const NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel'];
await p.evaluate(async (names) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	for (const n of names) { try { await app.create_diamond(n); } catch (e) { /* enough */ } }
}, NAMES);
await p.waitForTimeout(600);

if (BREAK) {
	// The un-coalesced original, put back on the page: every ask starts a walk.
	await p.evaluate(() => {
		window.__origLoad = window.DaimondCore.loadDiamonds;
		window.DaimondCore.loadDiamonds = async function () {
			var m = await import('/pkg/oxedyne_daimond.js');
			var app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
			try { await app.list_diamonds(); } catch (e) { /* the walk is the point */ }
		};
	});
}

// ── A + B. Five asks at once ────────────────────────────────────────
await p.evaluate(() => { try { DaimondTrail.clear(); } catch (e) {} });
await p.evaluate(() => {
	var f = window.DaimondCore.loadDiamonds;
	for (var i = 0; i < 5; i++) { try { f(); } catch (e) {} }
});
await p.waitForTimeout(4000);

const rows = await p.evaluate(() => {
	try { return window.DaimondTrail.rows() || []; } catch (e) { return []; }
});

const starts = rows.filter((r) => r.w === 'list_diamonds');
check(starts.length > 0, 'the walk reports itself at all', `${starts.length} start(s)`);
check(starts.length <= 2,
	'FIVE asks at once produce at most TWO walks — one now, one after, never five',
	`${starts.length} walks`);

// Overlap, measured properly: between one walk's start and the next walk's
// start there must be a "N entries" line AND the last entry of that walk. A
// second start arriving before the first walk's entries are done is the fault.
{
	let overlapped = null;
	for (let i = 0; i < starts.length - 1; i++) {
		const a = starts[i].t, b = starts[i + 1].t;
		const between = rows.filter((r) => r.t >= a && r.t < b && r.w === 'list entry').length;
		const total = Number(((rows.find((r) => r.t >= a && r.w === 'list' && / entries$/.test(r.d || '')) || {}).d || '0').split(' ')[0]);
		if (total > 0 && between < total) {
			overlapped = { walk: i, sawEntries: between, of: total };
			break;
		}
	}
	check(overlapped === null,
		'and no walk begins while another is still reading entries',
		overlapped ? JSON.stringify(overlapped) : `${starts.length} walk(s), each finished before the next`);
}

// ── C. An ask during a walk still gets fresh data ───────────────────
if (!BREAK) {
	await p.evaluate(() => { try { DaimondTrail.clear(); } catch (e) {} });
	const seen = await p.evaluate(async () => {
		var f = window.DaimondCore.loadDiamonds;
		var first = f();                       // a walk is now running
		// Write DURING it, then ask again: the second ask must not be handed the
		// walk that began before the write.
		var m = await import('/pkg/oxedyne_daimond.js');
		var app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		await app.create_diamond('Written-Mid-Walk');
		await f();
		await first;
		return [...document.querySelectorAll('#diamond-list .diamond-box')]
			.map((b) => (b.querySelector('.session-box-name') || {}).textContent);
	});
	check(seen.indexOf('Written-Mid-Walk') !== -1,
		'a Diamond written DURING a walk is on the rail afterwards — the ask is coalesced, not dropped',
		JSON.stringify(seen.slice(0, 4)) + ` (${seen.length} tiles)`);

	// ── D. And the rail agrees with the store ───────────────────────
	const store = await p.evaluate(async () => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		return JSON.parse(await app.list_diamonds()).length;
	});
	check(seen.length === store, 'and the rail shows every Diamond the store holds',
		`${seen.length} tiles, ${store} in the store`);
}

const noise = /favicon|401|402|502|Unauthorized|Payment|Bad Gateway/i;
const errs = s.errs.filter((e) => !noise.test(e));
check(errs.length === 0, 'no console errors', JSON.stringify(errs.slice(0, 2)));

await s.close();
try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* gone */ }

console.log(out.join('\n'));
const total = out.filter((l) => /^(PASS|FAIL)/.test(l)).length;
if (BREAK) {
	console.log(`\nBROKEN RUN: ${bad} of ${total} failed. `
		+ (bad > 0 ? 'Good — coalescing is what stops the pile-up.' : 'BAD — a check that cannot fail is not evidence.'));
	process.exit(bad > 0 ? 0 : 1);
}
console.log(bad === 0 ? `\nALL ${total} CHECKS PASSED` : `\n${bad} of ${total} FAILED`);
process.exit(bad === 0 ? 0 : 1);

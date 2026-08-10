// probe_diamondheap.mjs — where does `list_diamonds` put 1.6 GB?
//
// THE MEASUREMENT THIS IS CHASING. An iPhone's trail, seq 82:
//
//     ok panels.reflow   heap 1M
//     list_diamonds start
//     list 15 entries
//     list entry …  ×3
//     ok connectGateway  heap 235M
//     …
//     heap high  1639M
//     boot                       <- the tab is gone, ~1.5s later
//
// Wasm linear memory only grows, so 1.6 GB is 1.6 GB for the rest of the tab's
// life, and iOS kills it. Safe mode ruled SYNC out: with the engine off and no
// pull at all, the heap still reached 1639 MB.
//
// AND THIS FILE RULED THE WALK OUT TOO, which is why it exists. The trail named
// `list_diamonds` only because its `list entry` lines were the only clock ticks
// visible while the heap climbed — correlation read as location. Measured here,
// fifteen Diamonds carrying seven hundred and fifty version files between them
// cost NOTHING. What remains is `connectGateway`, across which the phone reaches
// 235 MB; and since `heap_bytes()` reports WASM linear memory and nothing else,
// whatever does it is on the Rust side, where no amount of JavaScript can reach.
//
// A PROBE, NOT A VERIFIER. It asserts nothing about a correct app; it prints a
// curve. The desktop will not kill the tab at 1.6 GB, but `heap_bytes()` reports
// the same number here as there — so if the growth reproduces at all, the
// culprit can be found tonight instead of after another round trip through a
// phone the author cannot inspect.
//
// It walks up in steps, because the shape of the curve is the diagnosis:
//
//   * flat with 0 Diamonds        -> nothing in the walk's fixed cost
//   * a step per Diamond          -> a per-entry allocation, and the trail's
//                                    `HEAP GREW <phase>` lines name which call
//   * flat until content is added -> it is proportional to what a Diamond HOLDS,
//                                    not to how many there are
//
//   node dev/probe_diamondheap.mjs            # 15 empty Diamonds
//   node dev/probe_diamondheap.mjs --fat      # …each with a crystal and versions
//
// Needs dev/serve.mjs. No gateway; nothing spends.

import { open, scratch } from './harness.mjs';
import fs from 'node:fs';

const FAT = process.argv.includes('--fat');
const N   = 15;                       // the phone holds fifteen

const PROFILE = scratch('pw', 'dheap-' + process.pid);
fs.rmSync(PROFILE, { recursive: true, force: true });

const s = await open({ name: 'dheap', connect: false, profile: PROFILE });
const p = s.page;

/// The wasm heap, in whole megabytes, straight from the module.
const heap = () => p.evaluate(() => {
	try { return Math.round(DaimondCore.heapBytes() / 1048576); } catch (e) { return -1; }
});

/// One walk of the store, through the app's own door.
const walk = () => p.evaluate(() => DaimondCore.loadDiamonds());

if ((await heap()) < 0) {
	console.log('the engine cannot report its heap — is this build older than seq 81?');
	await s.close();
	process.exit(1);
}

// ── FIRST, PROVE THE GAUGE ──────────────────────────────────────────
//
// Everything below is read off `heap_bytes()`, and it has reported exactly 1 MB
// through every local experiment so far. A number that never moves cannot be
// told from a number that CANNOT move, and this project has already lost four
// sessions to instruments nobody had watched working — the panic hook meant
// nothing until `panic_on_purpose` made it fire.
//
// So: allocate 64 MB inside the wasm on purpose and require the gauge to say so.
// If it does not, nothing else this file prints is evidence of anything, and the
// 235M/1639M on the phone would need re-reading too.
{
	const g = await p.evaluate(() => {
		const mb = () => Math.round(DaimondCore.heapBytes() / 1048576);
		const before = mb();
		try { DaimondCore.growOnPurpose(64); } catch (e) { return { err: String(e) }; }
		return { before, after: mb() };
	});
	if (g.err) {
		console.log('GAUGE UNPROVED: ' + g.err + '\n');
	} else {
		const moved = g.after - g.before;
		console.log(`gauge self-test: asked wasm for 64M, gauge went ${g.before}M -> ${g.after}M (+${moved}M)`);
		console.log(moved >= 60
			? '  the gauge tracks a real allocation. Everything below is evidence.\n'
			: '  IT DID NOT MOVE. Nothing below is evidence, and the phone trail needs re-reading.\n');
	}
}

console.log(`probe: ${N} Diamonds, ${FAT ? 'each with a crystal and 5 versions' : 'empty'}\n`);
console.log(`  after boot, before any walk        ${await heap()}M`);
await walk();
console.log(`  one walk, empty store              ${await heap()}M`);

for (let i = 1; i <= N; i++) {
	await p.evaluate(async (fat) => {
		const app = DaimondCore.diamondApp();
		const id = await app.create_diamond('Probe ' + Math.random().toString(36).slice(2, 8));
		if (!fat) return;
		// A crystal at very nearly the cap, snapshotted many times over. The
		// crystal itself CANNOT be the source — `crystal_write_refused` holds it
		// to 16 KiB, so fifteen of them are a quarter of a megabyte — but every
		// write snapshots, and NOTHING PRUNES THE SNAPSHOTS. Version history is
		// the one thing in a Diamond that grows without bound, which makes it the
		// only candidate on the phone that could be measured in hundreds of
		// megabytes. Fifty each here is ~11 MB across the store: if the walk
		// allocates in proportion to what is on disk, that is enough to show a
		// slope, and if the curve stays flat the history is exonerated too.
		const body = 'lorem ipsum dolor sit amet '.repeat(555);                  // ~15 KB
		// A fact per pass, so no two versions are the same bytes and the store cannot
		// quietly collapse fifty writes into one.
		for (let v = 0; v < 50; v++) {
			await app.write_crystal_data(id, JSON.stringify(
				{ title: 'Probe', summary: body, facts: [{ k: 'pass', v: String(v) }] }));
		}
	}, FAT);

	// Every third, so the output is a curve rather than a wall.
	if (i % 3 === 0 || i === N) {
		const before = await heap();
		await walk();
		const after = await heap();
		console.log(`  ${String(i).padStart(2)} Diamonds: before ${String(before).padStart(5)}M`
			+ `   after walk ${String(after).padStart(5)}M   (+${after - before}M)`);
	}
}

// The trail carries the per-call breakdown that seq 83 added; print whatever of
// it names a phase, because that is the line this whole exercise is for.
const grew = await p.evaluate(() => {
	try {
		return (DaimondTrail.rows() || [])
			.filter((r) => r.w === 'HEAP GREW')
			.map((r) => r.w + '  ' + r.d);
	} catch (e) { return []; }
});
console.log(grew.length
	? '\nper-call growth, from the app\'s own trail:\n  ' + grew.join('\n  ')
	: '\nno HEAP GREW rows: nothing in the per-entry loop grew the heap by a megabyte.');

const errs = s.errs.filter((e) => !/favicon|401|402|502/i.test(e));
if (errs.length) console.log('\nconsole errors:\n  ' + errs.slice(0, 5).join('\n  '));

// ── What does ONE wasm object cost? ─────────────────────────────────
//
// `heap_bytes()` reports WASM LINEAR MEMORY and nothing else, which narrows the
// hunt sharply: whatever takes the phone to 235 MB and then 1639 MB is on the
// Rust side, because no amount of JavaScript can move this number. The trail
// puts the first jump across `connectGateway`, and the wasm-side thing that
// function can multiply is a `DaimondApp` — one per model a balance buys, and
// the comment above `syncCredits` says "several hundred models".
//
// So: what is one worth? If a DaimondApp is hundreds of kilobytes, several
// hundred of them is the 235 MB, and the arithmetic says so without anyone
// having to believe a story about it.
{
	const step = await p.evaluate(async () => {
		const mb = () => Math.round(DaimondCore.heapBytes() / 1048576);
		const before = mb();
		const apps = [];
		// Twenty, not several hundred: enough to divide, cheap enough to be sure
		// the cost is per-object rather than a one-off first-touch.
		for (let i = 0; i < 20; i++) {
			apps.push(DaimondCore.newApp('http://127.0.0.1/v1/chat/completions', '', 'probe-' + i));
		}
		const after = mb();
		window.__probeApps = apps;      // held, so nothing is collected before it is read
		return { before, after, n: apps.length };
	}).catch((e) => ({ err: String(e).split('\n')[0] }));
	if (step.err) {
		console.log('\nDaimondApp probe unavailable: ' + step.err);
	} else {
		const each = step.n ? (step.after - step.before) / step.n : 0;
		console.log(`\n${step.n} DaimondApps: ${step.before}M -> ${step.after}M`
			+ `  (~${each.toFixed(1)}M each)`);
		console.log(`  at that rate, 300 of them would be ~${Math.round(each * 300)}M`
			+ '  — the phone reaches 235M across connectGateway.');
	}
}

await s.close();
try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* gone */ }

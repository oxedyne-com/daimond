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
// life, and iOS kills it. Safe mode proved it is the WALK and not the sync: with
// the engine off and only one walk running, the heap still reached 1639 MB.
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
		const body = '# Probe\n\n' + 'lorem ipsum dolor sit amet '.repeat(560);   // ~15 KB
		for (let v = 0; v < 50; v++) await app.write_crystal(id, body + '\n\n<!-- ' + v + ' -->');
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

await s.close();
try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* gone */ }

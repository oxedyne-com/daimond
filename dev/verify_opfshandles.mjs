// gateway: none
// verify_opfshandles.mjs — a watched Typst project must not grow Chrome's shared memory.
//
// THE FAULT (OPFSLEAK, 2026-10-24; diagnosis in
// ~/usr/code/ai/claude/notes/daimond_sync_20261017/diag_browsercrash_20261024.md).
// The owner's tab held 10.8 GB of /dev/shm after four days.  Every OPFS operation
// re-walked its path from `navigator.storage.getDirectory()`, so each one minted fresh
// `FileSystem*Handle`s, each a Mojo route between the browser and the renderer.  Chrome
// keeps a small block of a shared pool per live route, grows that pool in 64 KiB pages
// under /dev/shm, frees the blocks only when a major GC collects the dropped handles --
// which a page with a small heap almost never runs -- and never hands a page back.  The
// Typst watch polls every watched file once a second, so a book of sixty files minted
// about 440 handles a second, for as long as the preview was open.
//
// THE CHECK.  The real page, the real Doc panel and the real Compile button, on a
// project of sixty files, so the watch the button arms follows all sixty.  Then nothing
// is touched for the run, and the renderer's 64 KiB shared regions are counted from
// OUTSIDE the browser, out of `/proc/<pid>/maps`: the regions are the leak itself, and
// nothing inside the page can see them.  PASS: the count rises by at most +5 over the run
// (5 minutes by default).  The build before the handle cache rose about +100 in that time.
//
//   eval "$(bash dev/world.sh 13 --up)"
//   node dev/verify_opfshandles.mjs               # 300 s, the gate
//   node dev/verify_opfshandles.mjs --secs 180    # a shorter run for a probe
//
// Its own profile, its own headless Chromium (through dev/pw.mjs, so its shared
// memory is in /dev/shm and is what is counted).  Linux only: it reads /proc.
import { readPage } from './pagesrc.mjs';
import fs from 'node:fs';
import { open, scratch } from './harness.mjs';
import { guardRan } from './verdict.mjs';

const ARGV = process.argv.slice(2);
const SECS = (() => {
	// `--secs`, else OPFSHANDLES_SECS (a shorter probe through `dk arms`, which passes no arguments); the gate's default is 300.
	const i = ARGV.indexOf('--secs');
	const v = i >= 0 ? ARGV[i + 1] : process.env.OPFSHANDLES_SECS;
	return v ? Math.max(30, Number(v) || 300) : 300;
})();
const FILES  = 60;		// the watched project: main.typ and 59 chapters
const LIMIT  = 5;		// regions the run may add
const SAMPLE = 15;		// seconds between counts

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const PROFILE = scratch('pw', 'opfshandles');
fs.rmSync(PROFILE, { recursive: true, force: true });

// ── Counting the regions ────────────────────────────────────────────
//
// A browser↔renderer shared region is a `rw-s` mapping of exactly 64 KiB of a deleted
// Chromium shared-memory file: `/dev/shm/.org.chromium.Chromium.*` (or the branded
// `.com.google.Chrome.*`).  Matched by NAME, not directory, so a launch that put its
// shared memory elsewhere is still counted rather than read as zero.

const SHM = /\.(org\.chromium\.Chromium|com\.google\.Chrome)\.[^ ]* \(deleted\)$/;

/// The pids of every process whose ancestry includes the browser launched on PROFILE.
function ours() {
	const all = new Map();		// pid → { ppid, cmd }
	for (const d of fs.readdirSync('/proc')) {
		if (!/^\d+$/.test(d)) continue;
		try {
			const cmd = readPage(`/proc/${d}/cmdline`, 'utf8').split('\0').join(' ');
			const stat = readPage(`/proc/${d}/stat`, 'utf8');
			const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
			all.set(Number(d), { ppid, cmd });
		} catch (e) { /* gone between the listing and the read */ }
	}
	const mine = (pid) => {
		for (let p = pid, n = 0; p > 1 && n < 64; n++) {
			const r = all.get(p);
			if (!r) return false;
			if (r.cmd.includes('--user-data-dir=' + PROFILE)) return true;
			p = r.ppid;
		}
		return false;
	};
	return [...all.entries()]
		.filter(([pid, r]) => r.cmd.includes('--type=renderer') && mine(pid))
		.map(([pid]) => pid);
}

/// The 64 KiB shared regions mapped by `pid`.
function regions(pid) {
	let n = 0;
	let text = '';
	try { text = readPage(`/proc/${pid}/maps`, 'utf8'); } catch (e) { return 0; }
	for (const line of text.split('\n')) {
		const sp = line.indexOf(' ');
		if (sp < 0 || line.slice(sp + 1, sp + 5) !== 'rw-s' || !SHM.test(line)) continue;
		const [a, b] = line.slice(0, sp).split('-').map(h => parseInt(h, 16));
		if (b - a === 65536) n++;
	}
	return n;
}

/// The regions of every renderer of this browser, summed.
const count = () => ours().reduce((n, pid) => n + regions(pid), 0);

// ── The project ─────────────────────────────────────────────────────

const chapter = (k) => `= Chapter ${k}\n\n#lorem(30)\n`;
const MAIN = '#set page(width: 120mm, height: 160mm, margin: 12mm)\n'
	+ Array.from({ length: FILES - 1 }, (_, i) => `#include "c${String(i + 1).padStart(2, '0')}.typ"`)
		.join('\n') + '\n';

const s = await open({ name: 'opfshandles', profile: PROFILE });
const { page } = s;
await page.waitForTimeout(1200);

const put = (p, text) => page.evaluate(async ({ p, text }) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	await m.write_file(p, text);
}, { p, text });
const st = () => page.evaluate(() => window.DaimondTypstWatch.state());

try {
	check('this browser\'s renderer can be found from outside it', ours().length > 0,
		`${ours().length} renderer(s)`);

	for (let i = 1; i < FILES; i++) await put(`book/c${String(i).padStart(2, '0')}.typ`, chapter(i));
	await put('book/main.typ', MAIN);

	// Armed the way a person arms it: the Doc panel's own Compile, on a desktop-wide page
	// (verify_typstwatch's size), where the panel and its button are laid out.
	await page.setViewportSize({ width: 1900, height: 1000 });
	await page.evaluate(() => window.DaimondDoc.show('book/main.typ'));
	// Clicked as a person can: once the Compile control is laid out and visible, never forced.
	await page.locator('[data-act="compile"]').first().waitFor({ state: 'visible', timeout: 30000 });
	await page.locator('[data-act="compile"]').first().click();
	for (let i = 0; i < 120 && !(await st()).drawn; i++) await sleep(500);
	const s0 = await st();
	if (s0.mode !== 'live') console.log('  watch state: ' + JSON.stringify(s0).slice(0, 600)
		+ '\n  compile button: ' + !!(await page.$('[data-act="compile"]'))
		+ '\n  panel: ' + JSON.stringify(await page.evaluate(() => {
			const b = document.querySelector('[data-act="compile"]');
			const p = b && (b.closest('section,aside,[id]') || b.parentElement);
			return p ? p.innerText.slice(0, 800) : '';
		}))
		+ '\n  page log: ' + s.logs.filter(l => /typst|compile|watch|error/i.test(l)).slice(-12).join('\n    '));
	check(`the watch is live and follows all ${FILES} files`,
		s0.mode === 'live' && s0.files >= FILES,
		JSON.stringify({ mode: s0.mode, files: s0.files, drawn: s0.drawn }));

	// Settled first: the compile itself is not what is measured.
	await sleep(10000);
	const c0 = count();
	const series = [c0];
	console.log(`  regions at the start: ${c0}; watching for ${SECS} s`);
	for (let t = SAMPLE; t <= SECS; t += SAMPLE) {
		await sleep(SAMPLE * 1000);
		const c = count();
		series.push(c);
		console.log(`  t=${String(t).padStart(4)} s  regions ${c}  (${c - c0 >= 0 ? '+' : ''}${c - c0})`);
	}
	const s1 = await st();
	check('the watch was still live at the end, so the run measured a watch',
		s1.mode === 'live', JSON.stringify({ mode: s1.mode }));
	const grew = series[series.length - 1] - c0;
	check(`THE 64 KiB SHARED REGIONS STAY FLAT — at most +${LIMIT} over ${SECS} s`,
		grew <= LIMIT, `${c0} → ${series[series.length - 1]} (${grew >= 0 ? '+' : ''}${grew})`);
} finally {
	await s.close();
}

console.log(`\nchecks: ${ok.length} ok, ${bad.length} failed`);
guardRan(ok.length + bad.length);
console.log(bad.length === 0 ? '\nall checks passed' : `\n${bad.length} check(s) FAILED`);
process.exit(bad.length === 0 ? 0 : 1);

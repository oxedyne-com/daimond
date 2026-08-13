// probe_typstloop.mjs — why the live view rebuilds with nothing edited, and what
// the vendored packages cost the heap.
//
// Two reports to settle, on the author's own book:
//
//   1. the status bar cycles `Live` / `Rebuilding` every 1-2 s with nothing being
//      written, so something the loop reads is changing when nothing has;
//   2. the compiler reached 2427 MB and the budget stopped the loop, against the
//      191 MB dev/TYPST_WATCH.md measured for the same book.
//
// So: seed the book, arm the watch through the shipped path, then SIT STILL and
// count rebuilds; and compile the same project over and over reading the heap after
// each, with the cetz packages live and with them stubbed out, which is the
// difference `7194f43` made.
//
// It asserts nothing and is not a verifier.
//
//     eval "$(bash dev/world.sh 5 --env)"
//     node dev/probe_typstloop.mjs            # packages live
//     node dev/probe_typstloop.mjs --stub     # the two cetz imports removed
//     node dev/probe_typstloop.mjs --idle     # the idle-rebuild count only
import fs from 'node:fs';
import path from 'node:path';
import { open, scratch } from './harness.mjs';

const BOOK = process.env.HOME + '/usr/books/elearnity';
if (!fs.existsSync(BOOK)) { console.log('no book at ' + BOOK); process.exit(0); }
const STUB = process.argv.includes('--stub');
const IDLE = process.argv.includes('--idle');
const REPS = (() => { const i = process.argv.indexOf('--reps');
	return i > 0 ? parseInt(process.argv[i + 1], 10) : 5; })();
const CEIL = 1800;			// MB of compiler heap at which this stops, to spare the box

function collect(dir, prefix, keep, depth) {
	const out = [];
	for (const name of fs.readdirSync(path.join(BOOK, dir))) {
		if (/^(archive|revision|audit|evaluations|plan|dev|cover|ref|__pycache__)/i.test(name)) continue;
		const abs = path.join(BOOK, dir, name);
		const rel = prefix + '/' + name;
		let st;
		try { st = fs.statSync(abs); } catch (e) { continue; }
		if (st.isDirectory()) {
			if (depth > 0) out.push(...collect(dir + '/' + name, rel, keep, depth - 1));
			continue;
		}
		if (!keep(name)) continue;
		const buf = fs.readFileSync(abs);
		out.push([rel, /\.(typ|svg|bib|csv|json|yaml|yml|toml|xml|txt)$/i.test(name)
			? buf.toString('utf8') : Array.from(buf)]);
	}
	return out;
}
const typOnly = (n) => /\.typ$/i.test(n);
const seed = [
	...collect('CheapThinking', 'elearnity/CheapThinking', typOnly, 0),
	...collect('style', 'elearnity/style', typOnly, 2),
	...collect('assets/svg', 'elearnity/assets/svg', (n) => /\.svg$/i.test(n), 1),
	...collect('assets/thinking', 'elearnity/assets/thinking', (n) => /\.svg$/i.test(n), 1),
	...collect('assets/fonts', 'elearnity/assets/fonts', (n) => /\.(ttf|otf|ttc|otc)$/i.test(n), 2),
	['elearnity/terms.typ', fs.readFileSync(path.join(BOOK, 'terms.typ'), 'utf8')],
];
console.log(`seeding ${seed.length} files; packages ${STUB ? 'STUBBED OUT' : 'LIVE'}`);

const MAIN = 'elearnity/CheapThinking/thinking.typ';
const s = await open({ name: 'typstloop' });
const p = s.page;
await p.setViewportSize({ width: 1700, height: 1050 });
await p.waitForTimeout(1500);
await p.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	m.set_locked_packs('');
	m.set_account_ns('d~typstloop');
});
for (let i = 0; i < seed.length; i += 20) {
	await p.evaluate(async (files) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		for (const f of files) {
			if (typeof f[1] === 'string') await m.write_file(f[0], f[1]);
			else await app.write_bytes(f[0], new Uint8Array(f[1]));
		}
	}, seed.slice(i, i + 20));
}
if (STUB) {
	await p.evaluate(async () => {
		const m = await import('/pkg/oxedyne_daimond.js');
		let t = await m.read_file('elearnity/style/template/book_template.typ');
		t = t.split('#import "@preview/cetz:0.3.4"').join('// cetz removed')
			.split('#import "@preview/cetz-plot:0.1.1": plot, chart').join('// cetz-plot removed');
		await m.write_file('elearnity/style/template/book_template.typ', t);
		await m.write_file('elearnity/CheapThinking/thinking_chap_02_figures.typ',
			'#let fig-ceilings = rect(width: 100%, height: 6cm)\n'
			+ '#let fig-thinking-time = rect(width: 100%, height: 6cm)\n');
	});
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── What one compile hands back, over and over ──────────────────────
console.log('\n=== the same project, compiled repeatedly, nothing edited ===');
let prevWatch = null;
for (let i = 0; i < REPS; i++) {
	const r = await p.evaluate(async (main) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const before = window.DaimondTypst.heapMB();
		const t = performance.now();
		const out = await m.typst_compile_project_vector(main);
		const ms = performance.now() - t;
		const stamps = out.watch ? Array.from(await m.typst_watch_stamps(Array.from(out.watch))) : [];
		return { ms, before, after: window.DaimondTypst.heapMB(),
			watch: out.watch ? Array.from(out.watch) : [],
			stamps,
			bytes: out.vector ? out.vector.length : 0,
			error: out.error ? String(out.error).slice(0, 300) : '' };
	}, MAIN);
	const w = r.watch;
	let drift = '';
	if (prevWatch) {
		if (prevWatch.length !== w.length) drift = ` WATCH LENGTH ${prevWatch.length} → ${w.length}`;
		else {
			const n = w.filter((x, k) => x !== prevWatch[k]).length;
			if (n) drift = ` WATCH ORDER MOVED at ${n} of ${w.length} positions`;
		}
	}
	prevWatch = w;
	console.log(`  ${i + 1}: ${r.ms.toFixed(0)} ms, heap ${r.before.toFixed(0)} → ${r.after.toFixed(0)} MB`
		+ ` (+${(r.after - r.before).toFixed(0)}), ${(r.bytes / 1048576).toFixed(1)} MB vector,`
		+ ` watch ${w.length}${drift}${r.error ? '  REFUSED: ' + r.error : ''}`);
	if (r.error) break;
	if (r.after > CEIL) { console.log(`  stopping: past the ${CEIL} MB self-imposed ceiling`); break; }
}

// ── The stamps, asked twice with nothing between ────────────────────
console.log('\n=== the watch stamps, asked twice, nothing written ===');
const twice = await p.evaluate(async (main) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const out = await m.typst_compile_project_vector(main);
	const files = Array.from(out.watch || []);
	const a = Array.from(await m.typst_watch_stamps(files));
	await new Promise(r => setTimeout(r, 1200));
	const b = Array.from(await m.typst_watch_stamps(files));
	const moved = [];
	for (let i = 0; i < files.length; i++) if (a[i] !== b[i]) moved.push([files[i], a[i], b[i]]);
	return { n: files.length, moved: moved.slice(0, 10), total: moved.length };
}, MAIN);
console.log(`  ${twice.n} files; ${twice.total} changed with nothing written`);
for (const [f, a, b] of twice.moved) console.log(`    ${f}: ${a} → ${b}`);

// ── What the heap costs per REAL edit, which is the wall's own slope ─
//
// A rebuild on unchanged bytes is free: comemo hashes the text and hands back the
// layout it already has. An edit is not, and the heap NEVER SHRINKS, so the figure
// below is the one that decides how many edits a session gets before the budget
// stops it. 2427 MB divided by it is how long the author had.
if (process.argv.includes('--edits')) {
	console.log('\n=== the heap, one real edit at a time ===');
	const CHAP = 'elearnity/CheapThinking/thinking_chap_07.typ';
	for (let i = 0; i < 15; i++) {
		const r = await p.evaluate(async ({ main, chap, word }) => {
			const m = await import('/pkg/oxedyne_daimond.js');
			const t = await m.read_file(chap);
			await m.write_file(chap, t.replace(/\n([A-Z][a-z]+ )/, '\n$1' + word + ' '));
			const before = window.DaimondTypst.heapMB();
			const t0 = performance.now();
			const out = await m.typst_compile_project_vector(main);
			return { ms: performance.now() - t0, before, after: window.DaimondTypst.heapMB(),
				error: out.error ? String(out.error).slice(0, 200) : '' };
		}, { main: MAIN, chap: CHAP, word: 'probe' + i });
		console.log(`  edit ${i + 1}: ${r.ms.toFixed(0)} ms, heap ${r.before.toFixed(0)}`
			+ ` → ${r.after.toFixed(0)} MB (+${(r.after - r.before).toFixed(0)})`
			+ (r.error ? '  REFUSED: ' + r.error : ''));
		if (r.after > CEIL) { console.log('  stopping: past the ceiling'); break; }
	}
}

// ── The shipped loop, armed, and then left alone ────────────────────
if (IDLE || true) {
	console.log('\n=== the loop, armed through the button, then left alone ===');
	await p.evaluate(() => window.DaimondDoc.show('elearnity/CheapThinking/thinking.typ'));
	await p.waitForTimeout(1200);
	const st = () => p.evaluate(() => window.DaimondTypstWatch.state());
	await p.click('[data-act="compile"]', { force: true });
	for (let i = 0; i < 240 && !(await st()).drawn; i++) await sleep(500);
	const a = await st();
	console.log(`  armed: ${a.pages} pages, ${a.files} watched, heap ${a.heap.toFixed(0)} MB,`
		+ ` builds ${a.builds}, drawn ${a.drawn}, failed ${a.failed}`);
	for (let i = 0; i < 8; i++) {
		await sleep(2500);
		const n = await st();
		console.log(`  +${((i + 1) * 2.5).toFixed(1)}s  mode ${n.mode} building ${n.building}`
			+ ` builds ${n.builds} drawn ${n.drawn} failed ${n.failed}`
			+ ` heap ${n.heap.toFixed(0)} MB rheap ${n.rheap.toFixed(0)} MB`
			+ (n.error ? '  err: ' + n.error.slice(0, 90) : ''));
		if (n.heap > CEIL) { console.log('  stopping: past the ceiling'); break; }
	}
}

// ── And what the reader actually sees, on the pages that were wrong ──
//
// The three rendering faults were reported on the CONTENTS page and the copyright
// page of this book, which is where a `#link` per line and three inline ones are.
// So those are the pages photographed, rather than a fixture that has neither.
{
	const shots = process.argv.includes('--shot')
		? process.argv[process.argv.indexOf('--shot') + 1].split(',').map(Number)
		: [2, 5];
	const WORK = scratch('typstloop');
	fs.mkdirSync(WORK, { recursive: true });
	for (const n of shots) {
		const r = await p.evaluate((n) => {
			window.DaimondTypstWatch.goToPage(n);
			const sc = document.querySelector('#typst-live .tl-scroll').getBoundingClientRect();
			return { x: sc.x, y: sc.y, w: sc.width, h: sc.height };
		}, n);
		await sleep(900);
		const f = `${WORK}/page-${n}.png`;
		await p.screenshot({ path: f, clip: { x: Math.floor(r.x), y: Math.floor(r.y),
			width: Math.floor(r.w), height: Math.floor(Math.min(r.h, 900)) } });
		console.log('  wrote ' + f);
	}
}

await p.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	m.set_account_ns('');
});
await s.close();

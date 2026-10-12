// verify_austpreview.mjs -- the Austenite live preview lays a real document out.
//
// Found on the 12 Oct recipe-card drive (D-20261011-34): the vendored Austenite wasm
// was the 21 Sep fixed-point reader, not the evaluator. It skipped `#let`, `#set page`,
// `#text`, `#grid` and `#align`, so an A5 recipe card previewed as an A4 page holding
// two rules and a "1". Nothing failed: the pages drew, they were just not the document.
//
// So this asks what a reader would: for each fixture, the preview's first page has the
// fixture's paper size, the text the reader typed is on it, and Austenite skipped
// nothing. Through the app (Doc panel, Compile here, the delta path the default engine
// draws), in Chromium and WebKit.
//
//   DAIMOND_APP=http://localhost:<port> node dev/verify_austpreview.mjs
//   AUSTPREVIEW_BROWSERS=chromium node dev/verify_austpreview.mjs   # one engine only
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, scratch } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX  = path.join(HERE, 'fixtures');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  PASS ' : '  FAIL ') + name + (detail ? ' -- ' + detail : ''));
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const bin = (buf) => Array.from(buf);
const MM = 72 / 25.4;		// points a millimetre

// ── Fixtures ─────────────────────────────────────────────────────────────────
// `size` is the first page in points, `words` must all be on it (whitespace
// ignored, since the SVG text layer splits runs where it likes).
const BOOK_MAIN = `#import "one.typ": one
#import "two.typ": two
#set page(width: 120mm, height: 160mm, margin: 12mm)
#set text(size: 10pt)
#set par(justify: true)
= The book
#one
#pagebreak()
#two
`;
const BOOK_ONE = `#let one = [
== Chapter one
Alpha lorem ipsum dolor sit amet, consectetur adipiscing elit.

#lorem(90)
]
`;
const BOOK_TWO = `#let two = [
== Chapter two
Zulu consectetur adipiscing elit, sed do eiusmod tempor.

#lorem(120)
]
`;
const TP = (rel) => fs.readFileSync(path.join(FIX, 'typstproj', rel));

const FIXTURES = [
	{
		name:	'recipe card (drive 12 Oct)',
		main:	'card/pancakes.typ',
		root:	'card/',
		files:	[['card/pancakes.typ', fs.readFileSync(path.join(FIX, 'austpreview', 'pancakes.typ'), 'utf8')]],
		size:	[148 * MM, 210 * MM],
		words:	['Perfect Pancakes', 'INGREDIENTS', 'Plain flour', 'Mixing bowl',
			'Sift the flour', 'Page width 148 mm'],
	},
	{
		name:	'two-chapter book (ab_austenite)',
		main:	'book/main.typ',
		root:	'book/',
		files:	[['book/main.typ', BOOK_MAIN], ['book/one.typ', BOOK_ONE], ['book/two.typ', BOOK_TWO]],
		size:	[120 * MM, 160 * MM],
		words:	['The book', 'Chapter one', 'Alpha lorem ipsum'],
	},
	{
		name:	'project with template, import and font (typstproj/books)',
		main:	'books/proj/main.typ',
		root:	'books/',
		files:	[
			['books/proj/main.typ',		TP('books/proj/main.typ').toString('utf8')],
			['books/proj/template.typ',	TP('books/proj/template.typ').toString('utf8')],
			['books/proj/parts/util.typ',	TP('books/proj/parts/util.typ').toString('utf8')],
			['books/proj/chap01.typ',	TP('books/proj/chap01.typ').toString('utf8')],
			['books/shared/glo.typ',	TP('books/shared/glo.typ').toString('utf8')],
			['books/assets/mark.svg',	TP('books/assets/mark.svg').toString('utf8')],
			['books/assets/fonts/Radley-Regular.ttf', bin(TP('books/assets/fonts/Radley-Regular.ttf'))],
		],
		size:	[100 * MM, 140 * MM],
		words:	['A project, not a file'],
	},
];

/// The four claims, from the engine's answer `d` (`error`, `head` -- the first page's
/// `<svg>` tag -- and `skipped`) and the text a browser read out of the drawn page.
function judge(tag, fx, d, seen, drew) {
	check(`${tag}: compiled and drew`, drew, d.error || '');
	// The first page's size, from the page SVG's own width/height (in pt).
	const wm = d.head.match(/\bwidth="([\d.]+)(?:pt)?"/);
	const hm = d.head.match(/\bheight="([\d.]+)(?:pt)?"/);
	const vb = d.head.match(/viewBox="[\d.\-]+ [\d.\-]+ ([\d.]+) ([\d.]+)"/);
	const w = wm ? +wm[1] : (vb ? +vb[1] : NaN), h = hm ? +hm[1] : (vb ? +vb[2] : NaN);
	check(`${tag}: page is ${(fx.size[0] / MM).toFixed(0)}x${(fx.size[1] / MM).toFixed(0)} mm`,
		Math.abs(w - fx.size[0]) < 1 && Math.abs(h - fx.size[1]) < 1,
		`${isNaN(w) ? '?' : w.toFixed(2)} x ${isNaN(h) ? '?' : h.toFixed(2)} pt; ${seen.svg}`);
	const flat = seen.text.replace(/\s+/g, '');
	const missing = fx.words.filter(t => flat.indexOf(t.replace(/\s+/g, '')) < 0);
	check(`${tag}: the text is on the page`, missing.length === 0,
		missing.length ? 'missing ' + JSON.stringify(missing) + `; ${seen.text.length} chars drawn` : `${fx.words.length} phrases`);
	const skip = d.skipped;
	check(`${tag}: nothing skipped`, !skip || skip === '[]' || skip === '{}' || skip === '""' || skip === 'null',
		skip ? skip.slice(0, 200) : '');
}

const BROWSERS =(process.env.AUSTPREVIEW_BROWSERS || 'chromium,webkit').split(',').map(s => s.trim()).filter(Boolean);

async function run(browser) {
	console.log(`\n== ${browser} ==`);
	const PROFILE = scratch('pw', 'austpreview-' + browser);
	fs.rmSync(PROFILE, { recursive: true, force: true });
	const s = await open({ name: 'austpreview-' + browser, profile: PROFILE, browser });
	const { page } = s;
	try {
		await page.waitForTimeout(1200);
		await page.setViewportSize({ width: 1400, height: 1000 });
		// The default engine is the one under test; a profile pinned elsewhere would test
		// typst.ts and pass for the wrong reason.
		const eng = await page.evaluate(() => window.DaimondTypst && window.DaimondTypst.engine());
		check(`${browser}: the live preview's default engine is austenite`, eng === 'austenite', `engine ${eng}`);

		// Record what each delta said, so the page size and the skips are read from the
		// engine's own answer as well as from the screen.
		await page.evaluate(() => {
			window.__ap = [];
			const orig = window.DaimondTypst.compileProjectDelta.bind(window.DaimondTypst);
			window.DaimondTypst.compileProjectDelta = async function (p) {
				const r = await orig(p);
				try {
					const first = (r && Array.isArray(r.changed) && r.changed[0]) ? String(r.changed[0].svg || '') : '';
					const head = (first.match(/<svg\b[^>]*>/) || [''])[0];
					window.__ap.push({
						error:	(r && r.error) ? String(r.error) : '',
						pages:	r && r.pages,
						head,
						skipped: r && r.skipped ? JSON.stringify(r.skipped) : '',
					});
				} catch (e) {}
				return r;
			};
		});

		await page.evaluate(async () => {
			const m = await import('/pkg/oxedyne_daimond.js');
			m.set_locked_packs('');
		});

		// ── The engine itself, in this browser's wasm and SVG ────────────────────
		// The vendored module through `DaimondTypst.compileProjectDelta`, given the
		// project as the gather door gives it. It needs no OPFS, which Playwright's
		// WebKit lacks, so this is the arm that runs in both engines.
		for (const fx of FIXTURES) {
			const proj = { main: '/' + fx.main.slice(fx.root.length), sources: [], assets: [], fonts: [], known: [] };
			for (const [p, c] of fx.files) {
				const rel = '/' + p.slice(fx.root.length);
				if (/\.typ$/.test(p)) proj.sources.push([rel, c]);
				else if (/\.(ttf|otf)$/.test(p)) proj.fonts.push([rel, c]);
				else proj.assets.push([rel, typeof c === 'string' ? Array.from(new TextEncoder().encode(c)) : c]);
			}
			const r = await page.evaluate(async (proj) => {
				for (const k of ['assets', 'fonts']) proj[k] = proj[k].map(([p, b]) => [p, new Uint8Array(b)]);
				const raw = await window.DaimondTypst.compileProjectDelta(proj);
				const o = raw instanceof Map ? Object.fromEntries(raw) : raw;
				const ch = (o && Array.isArray(o.changed)) ? o.changed.map(x => x instanceof Map ? Object.fromEntries(x) : x) : [];
				const svg = ch[0] ? String(ch[0].svg || '') : '';
				// Parsed by this browser, so the text is what its SVG engine reads out.
				const doc = svg ? new DOMParser().parseFromString(svg, 'image/svg+xml') : null;
				const el = doc && doc.documentElement;
				return {
					error:	 o && o.error ? String(o.error) : '',
					head:	 (svg.match(/<svg\b[^>]*>/) || [''])[0],
					parsed:	 !!(el && el.nodeName === 'svg'),
					text:	 doc ? [...doc.querySelectorAll('.tsel')].map(e => e.textContent).join('') : '',
					skipped: o && o.skipped ? JSON.stringify(o.skipped) : '',
				};
			}, proj);
			judge(`${browser} engine: ${fx.name}`, fx, r, { text: r.text, svg: r.parsed ? 'parsed' : 'NOT PARSED' }, !r.error && r.parsed);
		}

		// ── Through the app: Doc panel, Compile here, the watch loop ─────────────
		// Needs OPFS, so Chromium only (Playwright's WebKit has none; see harness.mjs).
		if (browser !== 'chromium') return;
		for (const fx of FIXTURES) {
			await page.evaluate(async (files) => {
				const m = await import('/pkg/oxedyne_daimond.js');
				m.set_locked_packs('');
				let app = null;
				for (const [p, c] of files) {
					if (typeof c === 'string') { await m.write_file(p, c); continue; }
					if (!app) app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
					await app.write_bytes(p, new Uint8Array(c));
				}
			}, fx.files);
			const n0 = await page.evaluate(() => window.__ap.length);
			await page.evaluate((p) => window.DaimondDoc.show(p), fx.main);
			await page.waitForTimeout(800);
			const btn = await page.$('[data-act="compile"]');
			if (btn) await page.click('[data-act="compile"]', { force: true });
			let st = null;
			for (let i = 0; i < 120; i++) {
				st = await page.evaluate(() => window.DaimondTypstWatch && window.DaimondTypstWatch.state());
				const got = await page.evaluate((n0) => window.__ap.length > n0, n0);
				if (st && st.path && st.path.endsWith(fx.main) && st.drawn > 0 && got && !st.building) break;
				await sleep(500);
			}
			await page.waitForTimeout(600);
			const d = await page.evaluate((n0) => window.__ap[window.__ap.length - 1] && window.__ap.length > n0
				? window.__ap[window.__ap.length - 1] : null, n0);
			const dom = await page.evaluate(() => {
				const h = document.querySelector('#typst-live .tl-pages');
				if (!h || !h.shadowRoot) return { text: '', svg: '' };
				const svg = h.shadowRoot.querySelector('svg');
				return {
					text: [...h.shadowRoot.querySelectorAll('.tsel')].map(e => e.textContent).join(''),
					svg:  svg ? (svg.getAttribute('viewBox') || '') + ' ' + (svg.getAttribute('width') || '') + 'x' + (svg.getAttribute('height') || '') : '',
				};
			});
			judge(`${browser} app: ${fx.name}`, fx, d || { error: 'no delta', head: '', skipped: '' }, dom,
				!!(d && !d.error && st && st.drawn > 0));
			await page.screenshot({ path: scratch('austpreview', `${browser}-${fx.main.replace(/\W+/g, '_')}.png`) }).catch(() => {});
		}
	} finally {
		await s.close().catch(() => {});
	}
}

try {
	for (const b of BROWSERS) await run(b);
} catch (e) {
	check('the run completed', false, String(e && e.stack || e).slice(0, 400));
}
console.log(`\n${ok.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);

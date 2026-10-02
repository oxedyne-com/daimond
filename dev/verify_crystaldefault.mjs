// gateway: none
// verify_crystaldefault — a Diamond's default crystal page wears the person's look, and nothing is written to do it.
//
// WHY THIS EXISTS. The shipped page's own `:root{--tx:#777;--fo:system-ui,...}` came after the theme's
// `<style id="dc-theme">` and won, so every default page drew #777 on the system sans in every look
// (2026-08-11 to 2026-10-02). The fix moves those neutrals into `var()` fallbacks at their use sites,
// and a STORED default page (a Diamond's own file, copied from the default when it first rendered) is
// DRAWN as today's default by `DaimondCrystal.adopt`, a byte-exact match and never a write: a stored
// page syncs with its Diamond (whole, by `touched`), and `write_crystal_page` is a version, a log record
// and a moved `touched`, which two devices doing before they meet make a conflict version. An EDITED page
// is drawn by `draw`: `adopt`, else `restyle` (its style block, if still byte for byte a shipped one, is
// swapped for today's), else `soften` (its shipped :root made a fallback), else as it is.
//
//   node dev/verify_crystaldefault.mjs [--phone] [--shots DIR] [--break cascade|inline|linkat|writeback|rootany|nolink|nofill|nohead|noswap|swapany]
//
// --break cascade    the page keeps a `:root{--tx:#777...}` of its own again: the look check goes red.
// --break inline     the page applies the theme as inline style (the pre-08-11 function): the check that a
//                    page declaring its own `:root` still wins goes red.
// --break linkat    the link colour back on `--at` (the text drawn ON an accent fill, dark on Obsidian): the
//                    links check goes red.
// --break rootany   the neutraliser softens ANY :root, not only the shipped block: a hand-edited value is lost.
// --break nolink    an edited page's shipped link rule is left on `--at`: its links go dark on Obsidian.
// --break nofill    the outlines of .field, code and pre back: rule 1 goes red.
// --break nohead    the heads back on the body face: rule 5 goes red.
// --break noswap    `draw` no longer swaps an intact shipped style block for today's: an old default with a paragraph
//                    added is drawn with the palette only, so its outlines, quote bar and heads are the old ones.
// --break swapany   the swap matches a block that is NOT byte for byte the shipped one (any block opening on the
//                    shipped `:root`): a block with one changed byte loses its other rules instead of keeping them.
// --break writeback  an upgrade that WRITES, as `renderCrystal` did for the 08-11 block: the stored page,
//                    `touched` and the version move, differently on each device: the no-write and the
//                    two-device checks go red.
import { open } from './harness.mjs';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE  = dirname(fileURLToPath(import.meta.url));
const argv  = process.argv.slice(2);
const arg   = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const PHONE = argv.includes('--phone');
const SHOTS = arg('--shots');
const BREAK = arg('--break');
const fx = (n) => readFileSync(join(HERE, 'fixtures', 'crystaldefaults', n + '.html'), 'utf8');
const OLD = { '08-10 a': fx('20260810a'), '08-10 b': fx('20260810b'), '08-11': fx('20260811'), '09-15 (live 5.2.9)': fx('20260915') };

let ok = 0, bad = 0;
const check = (name, cond, detail) => {
	if (cond) { ok++; console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`); }
	else { bad++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const vp = PHONE ? { width: 390, height: 844 } : { width: 1440, height: 900 };
const NAME = 'DefaultsAB';
const PALETTE = { porcelain: 'rgb(30, 26, 27)', obsidian: 'rgb(238, 233, 229)' };
const DATA = {
	title: 'Harbour survey',
	summary: 'Soundings for the **north mole**, taken at `02:40:17` on the ebb.',
	sections: [{ heading: 'Readings', body: 'Depth held at 7.2 m across the channel.\n\n```\nmole.north  7.2 m\n```\n\n> Hold the line at the mole.' }],
	facts: [{ k: 'Tide', v: 'ebb' }, { k: 'Crew', v: 'three' }],
	links: [{ label: 'Chart notes', href: 'https://example.com/chart' }],
	soundings: { depth: '7.2 m' },
};

async function device(tag, theme) {
	const s = await open({
		name: 'crystaldefault' + tag, signIn: true, connect: true, defaults: false,
		...(PHONE ? { isMobile: true, touch: true } : {}),
		route: async (page) => {
			await page.setViewportSize(vp);
			await page.addInitScript((th) => {
				try { localStorage.setItem('daimond-skin', 'daylight'); localStorage.setItem('daimond-theme', th); } catch (e) {}
			}, theme);
			if (BREAK === 'linkat') {
				await page.route('**/js/crystal.js', async (r) => {
					const res = await r.fetch(); let t = await res.text();
					await r.fulfill({ response: res, body: t.replace("'a{color:var(--ac,#4a7fd0);", "'a{color:var(--at,#4a7fd0);") });
				});
			}
			const patch = async (fn) => page.route('**/js/crystal.js', async (r) => {
				const res = await r.fetch(); await r.fulfill({ response: res, body: fn(await res.text()) });
			});
			if (BREAK === 'rootany') await patch((t) => t.replace('function soften(html) {',
				"function soften(html) { var a = String(html), b = a.split(/^:root\\{[^}]*\\}/gm).join(':where(:root){}'); return b === a ? null : b; }\n\tfunction soften_real(html) {"));
			if (BREAK === 'noswap') await patch((t) => t.replace('adopt(html) || restyle(html) || soften(html)', 'adopt(html) || soften(html)'));
			if (BREAK === 'swapany') await patch((t) => t.replace('function restyle(html) {',
				"function restyle(html) { var a = String(html), b = a.replace(/<style>\\n:root\\{--bg:transparent[\\s\\S]*?<\\/style>/, STYLE_NOW); return b === a ? null : b; }\n\tfunction restyle_real(html) {"));
			if (BREAK === 'nolink') await patch((t) => t.replace('.split(LINK_WAS).join(LINK_NOW)', ''));
			if (BREAK === 'nofill') await patch((t) => t.replace("'border-radius:4px;padding:.05em .3em}',", "'border:1px solid #888;border-radius:4px;padding:.05em .3em}',")
				.replace("'border-radius:var(--rd,8px);padding:10px 12px;',", "'border:1px solid #888;border-radius:var(--rd,8px);padding:10px 12px;',")
				.replace(".field{border-radius:", ".field{border:1px solid #888;border-radius:"));
			if (BREAK === 'nohead') await patch((t) => t.replace(/'h1,h2,h3\{font-family:[^\n]*\n/, ''));
			if (BREAK === 'cascade') {
				// The old page's own :root back in, after the theme.
				await page.route('**/js/crystal.js', async (r) => {
					const res = await r.fetch(); let t = await res.text();
					t = t.replace("'*{box-sizing:border-box}',", "':root{--tx:#777;--fo:system-ui,sans-serif}',\n\t\t'*{box-sizing:border-box}',");
					await r.fulfill({ response: res, body: t });
				});
			}
		},
	});
	return s;
}

// A Diamond holding `html` as its page (a person's own copy, as a first render leaves it).
async function makeDiamond(page, html) {
	await page.evaluate(() => { const b = document.getElementById('new-diamond-btn'); if (b) b.click(); });
	await page.waitForTimeout(900);
	await page.fill('.dlg-input', NAME).catch(() => {});
	await page.click('.dlg-ok', { force: true }).catch(() => {});
	await page.waitForTimeout(2500);
	return page.evaluate(async ({ data, html }) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		const d = JSON.parse(await app.list_diamonds()).find(x => x.name === 'DefaultsAB');
		if (!d) return '';
		await app.run_tool('file_write', JSON.stringify({ path: 'diamonds/' + d.id + '/crystal.json', content: JSON.stringify(data) }));
		await app.write_crystal_page(d.id, html);
		return d.id;
	}, { data: DATA, html });
}
// The Diamond as it would travel: the export pack, whole, meta included.
const pack = (page, id) => page.evaluate(async (id) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	return await app.export_diamond(id);
}, id);
const metaOf = (p) => { try { const f = JSON.parse(p).files; const m = JSON.parse(f['.daimond/meta.json'] || f['.red/meta.json'] || '{}'); return { v: m.crystal_version, touched: m.touched, updated: m.updated }; } catch (e) { return {}; } };
const storedPage = (page, id) => page.evaluate(async (id) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	return await app.read_crystal_page(id);
}, id);

async function showCrystal(page) {
	await page.evaluate(() => { const c = document.getElementById('dview-chat'); if (c) c.click(); });
	await page.waitForTimeout(700);
	await page.evaluate(() => { const c = document.getElementById('dview-crystal'); if (c) c.click(); });
	for (let i = 0; i < 40; i++) {
		const st = await page.evaluate(() => window.DaimondCrystal ? DaimondCrystal._state() : null);
		if (st && st.mode === 'frame' && st.keys.length) break;
		await page.waitForTimeout(250);
	}
	await page.waitForTimeout(600);
	const h = await page.$('iframe.crystal-frame');
	const fr = h ? await h.contentFrame() : null;
	if (!fr) return null;
	return fr.evaluate(() => {
		const cs = getComputedStyle(document.body), h1 = document.querySelector('h1'), bq = document.querySelector('blockquote');
		const edge = (sel) => { const e = document.querySelector(sel); if (!e) return null; const c = getComputedStyle(e);
			return { line: ['Top', 'Right', 'Bottom', 'Left'].map(k => c['border' + k + 'Width']).join(' '), fill: c.backgroundColor }; };
		const wd = (fam, text) => { const sp = document.createElement('span'); sp.textContent = text;
			sp.style.cssText = 'position:absolute;left:-9999px;visibility:hidden;white-space:nowrap;font-size:40px;font-weight:400;font-family:' + fam;
			document.body.appendChild(sp); const px = sp.getBoundingClientRect().width; sp.remove(); return px; };
		const t1 = h1 ? h1.textContent : '', stk = h1 ? getComputedStyle(h1).fontFamily : '';
		return document.fonts.ready.then(() => ({
			color: cs.color, font: cs.fontFamily, h1: h1 ? getComputedStyle(h1).fontFamily : '',
			bqLeft: bq ? getComputedStyle(bq).borderLeftWidth : 'none', bqFill: bq ? getComputedStyle(bq).backgroundColor : null,
			root: getComputedStyle(document.documentElement).getPropertyValue('--tx').trim(),
			link: (() => {
				const a = document.querySelector('a'), p = document.createElement('i');
				document.body.appendChild(p); p.style.color = 'var(--ac)'; const ac = getComputedStyle(p).color; p.style.color = 'var(--at)';
				const at = getComputedStyle(p).color; p.remove();
				return a ? { color: getComputedStyle(a).color, ac, at } : null;
			})(),
			edges: { code: edge('p code'), pre: edge('pre'), field: edge('.field') },
			head: { stack: stk, drawn: wd(stk, t1), cond: wd('"Sofia Sans Condensed", monospace', t1), sans: wd('"Sofia Sans", monospace', t1), mono: wd('monospace', t1),
				faces: [...document.fonts].map(f => f.family.replace(/["']/g, '') + ':' + f.status) },
			para: (() => { const m = document.querySelector('p.mine'); return m ? getComputedStyle(m).color : null; })(),
		}));
	});
}
const shot = async (page, name) => { if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, name + '.png') }); } };

// ── (1) the substitution, as a pure function over every default ever shipped ──
const A = await device('a', 'porcelain');
const pa = A.page;
const pure = await pa.evaluate((olds) => {
	const C = DaimondCrystal, out = {};
	const sf = C.soften || (() => null), dr = C.draw || ((x) => C.adopt(x) || x);
	for (const k in olds) { out[k] = C.adopt(olds[k]) === C.DEFAULT_PAGE; }
	const live = olds['09-15 (live 5.2.9)'];
	out.edited     = C.adopt(live + '<!-- mine -->') === null;
	out.ownRoot    = C.adopt(live.replace('</style>', ':root{--bg:#fff}</style>')) === null;
	out.current    = C.adopt(C.DEFAULT_PAGE) === null && C.isDefault(C.DEFAULT_PAGE);
	out.idem       = C.adopt(C.adopt(live)) === null;
	// A page whose style block differs by ONE byte (outside :root) is no intact block: `soften`, not `restyle`.
	const pg = live.replace('h1{font-size:1.45em', 'h1{font-size:1.46em') + '<p class="mine">x</p>', so = sf(pg) || '';
	out.soft      = so.indexOf(':where(:root){--bg:transparent') >= 0 && !/(^|\n):root\{/.test(so) && sf(so) === null && dr(pg) === so;
	out.softLink  = so.indexOf('a{color:var(--ac,#4a7fd0)') >= 0 && so.indexOf('a{color:var(--at);') < 0;
	out.oneByte   = sf(pg.replace('--tx:#777', '--tx:#778')) === null && dr(pg.replace('--tx:#777', '--tx:#778')) === pg.replace('--tx:#777', '--tx:#778');
	// restyle: an intact shipped block, swapped; a block with a byte changed or a rule added inside it, never.
	const added = live + '<p class="mine">x</p>', rs = C.restyle ? C.restyle(added) : null;
	out.swapEvery = Object.keys(olds).every((k) => { const r = C.restyle ? C.restyle(olds[k]) : null;
		return r !== null && r.indexOf('"Sofia Sans Condensed"') >= 0 && r.indexOf('border-left:2px') < 0 && r.indexOf('--tx:#777;') < 0; });
	out.swapOnlyStyle = rs !== null && rs === live.split(live.slice(live.indexOf('<style>'), live.indexOf('</style>') + 8)).join(C.DEFAULT_PAGE.slice(C.DEFAULT_PAGE.indexOf('<style>'), C.DEFAULT_PAGE.indexOf('</style>') + 8)) + '<p class="mine">x</p>';
	out.swapFixed = rs !== null && C.restyle(rs) === null && dr(rs) === rs;
	out.swapDraw  = dr(added) === rs && dr(live) === C.DEFAULT_PAGE;
	out.byteNone  = !!C.restyle && C.restyle(pg) === null && dr(pg) === so
		&& C.restyle(live.replace('</style>', 'h1{color:red}</style>')) === null
		&& C.restyle(live.replace('<style>', '<style id="x">')) === null;
	const two = live.replace('</style>', '</style><style>.mine{color:red}</style>'), tw = C.restyle ? C.restyle(two) : null;
	out.second    = tw !== null && tw.indexOf('<style>.mine{color:red}</style>') >= 0 && tw.indexOf('"Sofia Sans Condensed"') >= 0;
	const own = dr(live.replace('</style>', ':root{--tx:#123456}</style>'));
	out.ownKept   = own.indexOf(':root{--tx:#123456}') >= 0 && own.indexOf(':where(:root){--bg:transparent') >= 0;
	out.drawFixed = dr(so) === so && dr(C.DEFAULT_PAGE) === C.DEFAULT_PAGE && dr(live) === C.DEFAULT_PAGE && dr('') === '';
	out.noRootNeutral = !/:root\{[^}]*--(tx|fo|mu|sf|bd|at)\s*:/.test(C.DEFAULT_PAGE);
	return out;
}, OLD);
for (const k of Object.keys(OLD)) check(`the ${k} default is adopted, byte for byte`, pure[k]);
check('a page anyone edited is not adopted', pure.edited);
check('a page that declares its own :root is not adopted', pure.ownRoot);
check('today\'s default is left as it is, and a second adoption changes nothing', pure.current && pure.idem);
check('the shipped page declares no neutral in a :root of its own', pure.noRootNeutral);
check('an edited page with the shipped :root has it softened to :where(:root), once, and drawn so', pure.soft);
check('and its shipped link rule moves to the accent', pure.softLink);
check('a :root that differs by ONE BYTE is not touched', pure.oneByte);
check('a daimon\'s own :root after the shipped one is kept, the shipped one softened', pure.ownKept);
check('restyle: every shipped default\'s style block is swapped for today\'s (fills, no quote bar, Condensed heads)', pure.swapEvery);
check('restyle swaps the style element and nothing else, and a second pass changes nothing', pure.swapOnlyStyle && pure.swapFixed);
check('a page with a second <style> of the daimon\'s keeps it, its shipped block swapped', pure.second);
check('a block with one changed byte, a rule added inside it or an attribute on its tag is NOT swapped: soften only', pure.byteNone);
check('draw takes adopt, then restyle, then soften', pure.swapDraw);
check('draw is a fixed point: a default, a softened page and an empty page change no further', pure.drawFixed);

// ── (2) a stored OLD default is drawn in the look, and nothing is written ─────
const idA = await makeDiamond(pa, OLD['09-15 (live 5.2.9)']);
check('a Diamond holding the live 5.2.9 default page was made', !!idA);
const before = await pack(pa, idA), mb = metaOf(before);
let drew = await showCrystal(pa);
check('porcelain: the stored default draws the palette text, not #777', drew && drew.color === PALETTE.porcelain, drew && `text ${drew.color}`);
check('porcelain: and Sofia Sans, not the system sans', drew && /Sofia Sans/.test(drew.font), drew && drew.font.slice(0, 40));
check('links are drawn in the accent, not in the text-on-accent colour (invisible on Obsidian)', drew && drew.link
	&& drew.link.color === drew.link.ac && drew.link.color !== drew.link.at, drew && drew.link && `link ${drew.link.color}, accent ${drew.link.ac}, on-accent ${drew.link.at}`);
check('the quote has no left bar (rule 1)', drew && /^0px$/.test(drew.bqLeft), drew && drew.bqLeft);
const flat = (e) => !!e && e.line === '0px 0px 0px 0px' && e.fill !== 'rgba(0, 0, 0, 0)';
check('rule 1: inline code, pre and .field have no outline and a light fill', drew && ['code', 'pre', 'field'].every(k => flat(drew.edges[k])),
	drew && JSON.stringify(drew.edges));
const nr = (a, b) => Math.abs(a - b) < 0.5;
check('rule 5: Sofia Sans Condensed is registered and loaded in the frame', drew && drew.head.faces.includes('Sofia Sans Condensed:loaded'), drew && drew.head.faces.join(' '));
check('rule 5: THE HEADS ARE DRAWN IN CONDENSED, not Sofia Sans and not the fallback',
	drew && drew.head.drawn > 0 && nr(drew.head.drawn, drew.head.cond) && !nr(drew.head.cond, drew.head.sans) && !nr(drew.head.cond, drew.head.mono),
	drew && `as drawn ${Math.round(drew.head.drawn)}, Condensed ${Math.round(drew.head.cond)}, Sofia Sans ${Math.round(drew.head.sans)}, fallback ${Math.round(drew.head.mono)}`);
await shot(pa, 'default-porcelain');
if (BREAK === 'writeback') await pa.evaluate(async (id) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	await app.write_crystal_page(id, DaimondCrystal.DEFAULT_PAGE);
}, idA);
const afterA = await pack(pa, idA), ma = metaOf(afterA);
check('the stored page is byte-identical after the render', (await storedPage(pa, idA)) === OLD['09-15 (live 5.2.9)']);
check('no version, no touch: the Diamond\'s pack is byte-identical, so nothing goes on the wire', afterA === before,
	`version ${mb.v} -> ${ma.v}, touched ${mb.touched} -> ${ma.touched}`);

// ── (3) the 08-11 rule: a page that declares its own :root wins over the theme ─
const own = await pa.evaluate((brk) => {
	let p = DaimondCrystal.DEFAULT_PAGE.replace('</style>', ':root{--tx:#123456}</style>');
	if (brk) p = p.split(/function theme[\s\S]*?el\.textContent=":root\{"\+css\+"\}";\}/)
		.join('function theme(t){if(!t)return;var m={text:"--tx"};for(var k in m)if(t[k])document.documentElement.style.setProperty(m[k],t[k]);}');
	return p;
}, BREAK === 'inline');
const idO = await pa.evaluate(async ({ own, data }) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const d = JSON.parse(await app.list_diamonds()).find(x => x.name === 'DefaultsAB');
	await app.write_crystal_page(d.id, own);
	return d.id;
}, { own, data: DATA });
const ownDrew = await showCrystal(pa);
check('a page declaring its own :root{--tx:#123456} still wins over the theme', ownDrew && ownDrew.color === 'rgb(18, 52, 86)', ownDrew && `text ${ownDrew.color}`);
// Put the stored default back for the two-device part.
await pa.evaluate(async ({ id, html }) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	await app.write_crystal_page(id, html);
}, { id: idO, html: OLD['09-15 (live 5.2.9)'] });

// ── (4) an EDITED page: the shipped grey :root is softened, whatever else is the page's own is kept ─
const put = (id, html) => pa.evaluate(async ({ id, html }) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	await app.write_crystal_page(id, html);
}, { id, html });
const live0 = OLD['09-15 (live 5.2.9)'];
const EDIT = (h) => h.replace('<div id="r"></div>', '<div id="r"></div><p class="mine">Added by the daimon.</p>');
await put(idO, EDIT(live0));
const packE0 = await pack(pa, idO);
const e1 = await showCrystal(pa);
if (BREAK === 'writeback') await put(idO, await pa.evaluate((h) => DaimondCrystal.draw(h), EDIT(live0)));
check('an old default with one paragraph added draws in the look: porcelain text, not #777',
	e1 && e1.color === PALETTE.porcelain && e1.para === PALETTE.porcelain, e1 && `text ${e1.color}, the added paragraph ${e1.para}`);
check('and in Sofia Sans, not the system sans', e1 && /Sofia Sans/.test(e1.font), e1 && e1.font.slice(0, 40));
check('and its links are the accent, legible, not the text-on-accent colour', e1 && e1.link && e1.link.color === e1.link.ac && e1.link.color !== e1.link.at,
	e1 && e1.link && `link ${e1.link.color}, accent ${e1.link.ac}, on-accent ${e1.link.at}`);
check('and with NO OUTLINE: inline code, pre and .field are fills (rule 1, by the swapped style block)', e1 && ['code', 'pre', 'field'].every(k => flat(e1.edges[k])),
	e1 && JSON.stringify(e1.edges));
check('and the quote is a fill, with no left bar', e1 && /^0px$/.test(e1.bqLeft) && e1.bqFill && e1.bqFill !== 'rgba(0, 0, 0, 0)', e1 && `bar ${e1.bqLeft}, fill ${e1.bqFill}`);
check('and its HEADS ARE DRAWN IN CONDENSED (rule 5), not Sofia Sans and not the fallback',
	e1 && e1.head.drawn > 0 && nr(e1.head.drawn, e1.head.cond) && !nr(e1.head.cond, e1.head.sans) && !nr(e1.head.cond, e1.head.mono),
	e1 && `as drawn ${Math.round(e1.head.drawn)}, Condensed ${Math.round(e1.head.cond)}, Sofia Sans ${Math.round(e1.head.sans)}, fallback ${Math.round(e1.head.mono)}`);
check('nothing was written: the stored page and the pack are as they were', (await storedPage(pa, idO)) === EDIT(live0) && (await pack(pa, idO)) === packE0);
await shot(pa, 'edited-porcelain');
// One byte changed in the style block (outside :root): no swap, so `soften` only. It keeps its OTHER rules.
const BYTE = (h) => EDIT(h).replace('h1{font-size:1.45em', 'h1{font-size:1.46em');
await put(idO, BYTE(live0));
const packB0 = await pack(pa, idO);
const e4 = await showCrystal(pa);
check('a style block with ONE CHANGED BYTE falls back to soften: the palette applies (porcelain text, not #777)', e4 && e4.color === PALETTE.porcelain, e4 && `text ${e4.color}`);
check('and keeps its other rules: outlines on code, pre and .field, the quote\'s left bar, the heads off Condensed',
	e4 && ['code', 'pre', 'field'].every(k => e4.edges[k] && e4.edges[k].line === '1px 1px 1px 1px') && e4.bqLeft === '2px' && !nr(e4.head.drawn, e4.head.cond),
	e4 && `outlines ${['code', 'pre', 'field'].map(k => e4.edges[k] && e4.edges[k].line).join(' | ')}, bar ${e4.bqLeft}, heads ${Math.round(e4.head.drawn)} vs Condensed ${Math.round(e4.head.cond)}`);
check('and its links are the accent (soften moves the shipped link rule)', e4 && e4.link && e4.link.color === e4.link.ac && e4.link.color !== e4.link.at,
	e4 && e4.link && `link ${e4.link.color}, accent ${e4.link.ac}, on-accent ${e4.link.at}`);
check('nothing was written for it either', (await storedPage(pa, idO)) === BYTE(live0) && (await pack(pa, idO)) === packB0);
await put(idO, EDIT(live0).replace('--tx:#777', '--tx:#778'));
const e2 = await showCrystal(pa);
check('a :root differing by one byte (--tx:#778) keeps its own value', e2 && e2.color === 'rgb(119, 119, 136)', e2 && `text ${e2.color}`);
await put(idO, EDIT(live0).replace('--tx:#777', '--tx:#123456'));
const e3 = await showCrystal(pa);
check('a hand-edited :root value (--tx:#123456) keeps its value', e3 && e3.color === 'rgb(18, 52, 86)'
	&& (await storedPage(pa, idO)) === EDIT(live0).replace('--tx:#777', '--tx:#123456'), e3 && `text ${e3.color}`);
await put(idO, live0);

// ── (5) two devices: the same Diamond, both draw it, nothing moves, the packs agree ─
const packA0 = await pack(pa, idO);
const B = await device('b', 'obsidian');
const pb = B.page;
await pb.evaluate(async (p) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	await app.import_diamond(p, false);
}, packA0);
await pb.reload(); await pb.waitForTimeout(3500);
await pb.evaluate((n) => { const e = [...document.querySelectorAll('*')].find(x => !x.children.length && x.textContent.trim() === n); if (e) e.click(); }, NAME);
await pb.waitForTimeout(1500);
const drewB = await showCrystal(pb);
check('device B (obsidian) draws the same stored page in its own palette', drewB && drewB.color === PALETTE.obsidian, drewB && `text ${drewB.color}`);
await shot(pb, 'default-obsidian');
if (BREAK === 'writeback') await pb.evaluate(async (id) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	await app.write_crystal_page(id, DaimondCrystal.DEFAULT_PAGE);
}, idO);
const drewA2 = await showCrystal(pa);
const packA1 = await pack(pa, idO), packB1 = await pack(pb, idO);
check('after both devices drew it, neither pack moved', packA1 === packA0 && packB1 === packA0,
	`A touched ${metaOf(packA0).touched} -> ${metaOf(packA1).touched}, B -> ${metaOf(packB1).touched}`);
check('the two devices converge: identical packs, so no two-sided change and no conflict version', packA1 === packB1);
check('a second draw on each device changes nothing either', (await pack(pa, idO)) === packA1 && (await pack(pb, idO)) === packB1
	&& drewA2 && drewA2.color === PALETTE.porcelain);

console.log(`\n${ok} ok, ${bad} failed`);
await A.browser.close().catch(() => {}); await B.browser.close().catch(() => {});
process.exit(bad ? 1 : 0);

// gateway: none
// SHELVED, its "Sharp and Warm: exactly as before" block only (2026-09-29,
// D-20260929-02): Daylight is the only skin now, so `DaimondSkin.set('sharp'
// | 'warm')` no longer moves the page away from Daylight, and every check
// in that block -- mounted without the prelude, no face registered, no
// `faces` key -- asserts exactly the opposite of what now happens. Kept, not
// deleted, for the day Sharp/Warm are migrated away properly; skipped unless
// run with --force-shelved. Every other check here (Daylight itself, the
// sandbox and policy, a theme-wearing page) still runs and still passes.
//
// verify_crystalfont — a diamond's own page sets in the Daylight faces, and nothing else moves.
//
// WHY THIS EXISTS. The page runs in a sandboxed frame from an opaque origin under
// `font-src data:`. It was handed Daylight's family names in `_theme.font` but could not
// fetch the woff2 files the app serves, so it set in the system sans under a stack that
// named Sofia Sans, and nothing said so: a computed `font-family` reads the same either way.
// The fix carries the bytes over in `_theme.faces` and registers them with `FontFace` from
// an ArrayBuffer (crystal.js, `FACE_PRELUDE`). So the checks here MEASURE glyphs rather than
// read names, and they hold the sandbox and the policy to their exact old values.
//
//   node dev/verify_crystalfont.mjs [--phone] [--shots DIR] [--break prelude|names]
//
// `--phone` runs at 390x844 as a phone (Chromium's client hint, WebKit's iPhone UA);
// otherwise 1440x900. `--shots DIR` writes one picture per palette. `--break prelude`
// takes `FontFace` away inside every frame, which is the fault this guards against: the
// page is told the names and cannot register the faces. The glyph checks must go red.
// `--break names` makes the parent hand over only the faces `_theme.font` and `_theme.mono`
// name, not those the page names itself: Sofia Sans Condensed (the shipped heads) is then
// never registered and the heads draw in the fallback. The Condensed checks must go red.
import { open, shot } from './harness.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const argv  = process.argv.slice(2);
const arg   = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const PHONE = argv.includes('--phone');
const SHOTS = arg('--shots');
const BREAK = arg('--break');
const ENGINE = process.env.DAIMOND_BROWSER || 'chromium';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 '
	+ '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

// The policy and the sandbox as they were before this change, written out rather than read
// from the build, so a widened policy cannot pass by agreeing with itself.
const CSP_WAS = 'default-src \'none\'; script-src \'unsafe-inline\'; '
	+ 'style-src \'unsafe-inline\'; img-src data:; font-src data:';
const SANDBOX_WAS = 'allow-scripts';

let ok = 0, bad = 0;
const check = (name, cond, detail) => {
	if (cond) { ok++; console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`); }
	else { bad++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const vp = PHONE ? { width: 390, height: 844 } : { width: 1440, height: 900 };
const s = await open({
	name: 'crystalfont', signIn: true, connect: true, defaults: false,
	...(PHONE ? (ENGINE === 'webkit' ? { ua: IPHONE, touch: true } : { isMobile: true, touch: true }) : {}),
	route: async (page) => {
		await page.setViewportSize(vp);
		await page.addInitScript(() => {
			try {
				localStorage.setItem('daimond-skin', 'daylight');
				localStorage.setItem('daimond-theme', 'porcelain');
			} catch (e) { /* the app's default then; the checks below will say so */ }
		});
		if (BREAK === 'names') {
			await page.route('**/js/crystal.js', async (r) => {
				const res = await r.fetch(), t = await res.text();
				await r.fulfill({ response: res, body: t.replace("out.font + ',' + out.mono + ',' + names", "out.font + ',' + out.mono") });
			});
		}
		if (BREAK === 'prelude') {
			// Every frame, the sandboxed one included: Playwright runs init scripts in
			// each frame as it is attached.
			await page.addInitScript(() => { try { window.FontFace = undefined; } catch (e) {} });
		}
	},
});
const { page } = s;

// Every page the parent builds, as the bytes that went into the blob.
await page.evaluate(() => {
	window.__blobs = [];
	const make = URL.createObjectURL.bind(URL);
	URL.createObjectURL = (b) => { try { window.__blobs.push(b); } catch (e) {} return make(b); };
});

// ── A Diamond with a crystal, opened as a person would ───────────────
await page.evaluate(() => { const b = document.getElementById('new-diamond-btn'); if (b) b.click(); });
await page.waitForTimeout(900);
await page.fill('.dlg-input', 'FontFrame').catch(() => {});
await page.click('.dlg-ok', { force: true }).catch(() => {});
await page.waitForTimeout(2500);

const made = await page.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const d = JSON.parse(await app.list_diamonds()).find(x => x.name === 'FontFrame');
	if (!d) return '';
	await app.run_tool('file_write', JSON.stringify({
		path: 'diamonds/' + d.id + '/crystal.json',
		content: JSON.stringify({
			title: 'Harbour survey',
			summary: 'Soundings for the **north mole**, taken at `02:40:17` on the ebb.',
			sections: [{ heading: 'Readings', body: 'Depth held at 7.2 m across the channel.\n\n```\nmole.north  7.2 m  02:40:17\n```' }],
			facts: [{ k: 'Tide', v: 'ebb' }, { k: 'Crew', v: 'three' }],
		}),
	}));
	return d.id;
});
// Playwright's WebKit has no OPFS, so no Diamond can be made there ("Could not create
// diamond"). The page is then mounted directly with `DaimondCrystal.mount`, the same call
// the app makes, into a sheet laid over the stage: every check below is about the frame,
// and the frame is the same either way.
const DIRECT = !made && ENGINE === 'webkit';
if (DIRECT) console.log('  note no OPFS in this engine: the page is mounted directly');
else check('a Diamond was made with a crystal to draw', !!made);

const DATA = {
	title: 'Harbour survey',
	summary: 'Soundings for the **north mole**, taken at `02:40:17` on the ebb.',
	sections: [{ heading: 'Readings', body: 'Depth held at 7.2 m across the channel.\n\n```\nmole.north  7.2 m  02:40:17\n```' }],
	facts: [{ k: 'Tide', v: 'ebb' }, { k: 'Crew', v: 'three' }],
};

async function mountDirect(html) {
	await page.evaluate(({ data, html, phone }) => {
		document.querySelectorAll('.dlg-ok').forEach(b => b.click());
		let host = document.getElementById('cf-host');
		if (!host) {
			host = document.createElement('div');
			host.id = 'cf-host';
			host.style.cssText = 'position:fixed;z-index:9000;overflow:auto;padding:18px 22px;'
				+ 'border-radius:12px;background:var(--bg-secondary);'
				+ (phone ? 'left:0;right:0;top:56px;bottom:0;' : 'left:342px;top:74px;width:384px;bottom:12px;');
			document.body.appendChild(host);
		}
		DaimondCrystal.mount(host, { id: 'cf', data, page: html || DaimondCrystal.DEFAULT_PAGE });
	}, { data: DATA, html, phone: PHONE });
	for (let i = 0; i < 40; i++) {
		const st = await page.evaluate(() => DaimondCrystal._state());
		if (st.mode === 'fallback' || st.keys.length) return st;
		await page.waitForTimeout(250);
	}
	return page.evaluate(() => DaimondCrystal._state());
}

async function reopen() {
	if (DIRECT) return mountDirect(null);
	await page.evaluate(() => { const c = document.getElementById('dview-chat'); if (c) c.click(); });
	await page.waitForTimeout(900);
	await page.evaluate(() => { const c = document.getElementById('dview-crystal'); if (c) c.click(); });
	for (let i = 0; i < 40; i++) {
		const st = await page.evaluate(() => window.DaimondCrystal ? DaimondCrystal._state() : null);
		if (st && st.mode !== 'none' && (st.mode === 'fallback' || st.keys.length)) return st;
		await page.waitForTimeout(250);
	}
	return page.evaluate(() => window.DaimondCrystal ? DaimondCrystal._state() : null);
}

async function frameOf() {
	const h = await page.$('iframe.crystal-frame');
	return h ? h.contentFrame() : null;
}

// What the frame actually draws with. A span in `"<face>", <generic>` against the generic
// alone: equal widths mean the face is not there and the generic stood in.
async function glyphs() {
	const fr = await frameOf();
	if (!fr) return null;
	return fr.evaluate(async () => {
		if (document.fonts && document.fonts.ready) await document.fonts.ready;
		const w = (fam, text) => {
			const sp = document.createElement('span');
			sp.textContent = text || 'Hamburgefonstiv 0123 WMgq';
			sp.style.cssText = 'position:absolute;left:-9999px;visibility:hidden;white-space:nowrap;'
				+ 'font-size:40px;font-weight:400;font-family:' + fam;
			document.body.appendChild(sp);
			const px = sp.getBoundingClientRect().width;
			sp.remove();
			return px;
		};
		const faces = [];
		if (document.fonts) document.fonts.forEach(f => faces.push({
			family: f.family.replace(/["']/g, ''), status: f.status }));
		const cs = getComputedStyle(document.body);
		// The page's own title, in the stack the page itself resolved, against the same
		// words in Sofia Sans Condensed alone: equal only when the title really is drawn in it.
		const h1 = document.querySelector('h1');
		const stack = h1 ? getComputedStyle(h1).fontFamily : cs.fontFamily;
		const t = h1 ? h1.textContent : '';
		return {
			stack,
			faces,
			color:   cs.color,
			sans:    [w('"Sofia Sans", monospace'), w('monospace')],
			mono:    [w('"Sometype Mono", serif'), w('serif')],
			title:   h1 ? [w(stack, t), w('"Sofia Sans Condensed", monospace', t), w('"Sofia Sans", monospace', t), w('monospace', t)] : [0, 0, 0, 0],
			cond:    [w('"Sofia Sans Condensed", serif'), w('serif')],
			body:    [w(cs.fontFamily), w('"Sofia Sans", monospace'), w('monospace')],
			// `self.origin`, not `location.origin`: a blob: URL names its creator's origin,
			// while the document it loaded into is opaque.
			origin:  self.origin,
			storage: (() => { try { localStorage.length; return 'open'; } catch (e) { return 'refused'; } })(),
			metas:   Array.from(document.querySelectorAll('meta[http-equiv]'))
				.filter(m => /content-security-policy/i.test(m.getAttribute('http-equiv')))
				.map(m => m.getAttribute('content')),
			prelude: Array.from(document.scripts).some(x => x.textContent.indexOf('new FontFace') >= 0),
		};
	});
}

// Can the page reach the app's own server? It must not, faces or no faces.
async function netRefused() {
	const fr = await frameOf();
	if (!fr) return false;
	const origin = await page.evaluate(() => location.origin);
	return fr.evaluate(async (u) => {
		try { await fetch(u); return false; } catch (e) { return true; }
	}, origin + '/fonts/sofia-sans-latin.woff2');
}

async function frameAttrs() {
	return page.evaluate(() => {
		const f = document.querySelector('iframe.crystal-frame');
		if (!f) return null;
		return {
			sandbox:  f.getAttribute('sandbox'),
			tokens:   f.sandbox ? f.sandbox.length : -1,
			allow:    f.hasAttribute('allow'),
			csp:      f.hasAttribute('csp'),
			referrer: f.getAttribute('referrerpolicy'),
			policy:   DaimondCrystal.PAGE_CSP,
			state:    DaimondCrystal._state(),
		};
	});
}

// The last page that went into a blob, and what the old armour would have made of it.
async function lastBlob() {
	return page.evaluate(async () => {
		const b = window.__blobs[window.__blobs.length - 1];
		const text = b ? await b.text() : '';
		const P = DaimondCrystal.DEFAULT_PAGE;
		const meta = '<meta http-equiv="Content-Security-Policy" content="' + DaimondCrystal.PAGE_CSP + '">';
		const m = /<head\b[^>]*>/i.exec(P);
		const was = m ? P.slice(0, m.index + m[0].length) + meta + P.slice(m.index + m[0].length) : '';
		return { text, was, meta };
	});
}

const near = (a, b) => Math.abs(a - b) < 0.5;

// ── Daylight, both palettes ──────────────────────────────────────────
let st = await reopen();
check('the page is up in its frame under Daylight', st && st.mode === 'frame', st && st.mode);
check('it was mounted with the faces prelude', st && st.faces === true);
const skin0 = await page.evaluate(() => document.documentElement.getAttribute('data-skin'));
check('the skin is Daylight', skin0 === 'daylight', skin0);

const blobDl = await lastBlob();
check('DAYLIGHT: the page went in as the old armour plus the prelude, and nothing else',
	blobDl.text.length > blobDl.was.length
	&& blobDl.text.replace(/<script>\(function\(\)\{var got=\{\};[\s\S]*?<\/script>/, '') === blobDl.was);

for (const pal of ['porcelain', 'obsidian']) {
	await page.evaluate((p) => DaimondTheme.set(p), pal);
	await page.waitForTimeout(1200);
	const g = await glyphs();
	const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
	console.log(`\n--- ${pal} (${ENGINE}, ${vp.width}x${vp.height})`);
	check(`${pal}: the palette is on`, theme === pal, theme);
	const ink = await page.evaluate(() => {
		const d = document.createElement('div');
		d.style.color = 'var(--text-primary)';
		document.body.appendChild(d);
		const c = getComputedStyle(d).color;
		d.remove();
		return c;
	});
	check(`${pal}: the shipped page sets in Sofia Sans`, g && /^"?sofia sans/i.test(g.stack),
		g && `${g.stack}; text ${g.color}, palette text ${ink}`);
	check(`${pal}: Sofia Sans is registered and loaded in the frame`,
		g && g.faces.some(f => f.family === 'Sofia Sans' && f.status === 'loaded'),
		g && JSON.stringify(g.faces));
	check(`${pal}: Sometype Mono is registered and loaded in the frame`,
		g && g.faces.some(f => f.family === 'Sometype Mono' && f.status === 'loaded'));
	check(`${pal}: SOFIA SANS DRAWS — its glyphs are not monospace's`,
		g && !near(g.sans[0], g.sans[1]), g && g.sans.map(Math.round).join(' vs '));
	check(`${pal}: SOMETYPE MONO DRAWS — its glyphs are not serif's`,
		g && !near(g.mono[0], g.mono[1]), g && g.mono.map(Math.round).join(' vs '));
	check(`${pal}: Sofia Sans Condensed is registered and loaded in the frame`,
		g && g.faces.some(f => f.family === 'Sofia Sans Condensed' && f.status === 'loaded'), g && JSON.stringify(g.faces));
	check(`${pal}: SOFIA SANS CONDENSED DRAWS — its glyphs are not serif's`,
		g && !near(g.cond[0], g.cond[1]), g && g.cond.map(Math.round).join(' vs '));
	check(`${pal}: THE PAGE'S OWN TITLE IS DRAWN IN SOFIA SANS CONDENSED, NOT SOFIA SANS AND NOT THE SYSTEM SANS`,
		g && g.title[0] > 0 && near(g.title[0], g.title[1]) && !near(g.title[1], g.title[2]) && !near(g.title[1], g.title[3]),
		g && `as drawn ${Math.round(g.title[0])}, Condensed ${Math.round(g.title[1])}, Sofia Sans ${Math.round(g.title[2])}, fallback ${Math.round(g.title[3])}`);
	check(`${pal}: THE PAGE'S TEXT IS DRAWN IN SOFIA SANS, NOT THE SYSTEM SANS`,
		g && near(g.body[0], g.body[1]) && !near(g.body[1], g.body[2]), g && g.body.map(Math.round).join(' / '));
	if (SHOTS) {
		mkdirSync(SHOTS, { recursive: true });
		const f = join(SHOTS, `crystal_daylight_${pal}_${ENGINE}_${vp.width}x${vp.height}${BREAK ? '_break' : ''}.png`);
		await page.screenshot({ path: f });
		console.log(`  shot ${f}`);
	}
}

// ── The sandbox and the policy, exactly as they were ─────────────────
const fa = await frameAttrs();
const g0 = await glyphs();
check('sandbox is still exactly "allow-scripts", one token', fa && fa.sandbox === SANDBOX_WAS && fa.tokens === 1,
	fa && fa.sandbox);
check('no allow= and no csp= attribute on the frame', fa && !fa.allow && !fa.csp);
check('referrerpolicy is still no-referrer', fa && fa.referrer === 'no-referrer');
check('PAGE_CSP is the old policy, byte for byte', fa && fa.policy === CSP_WAS);
check('the mounted page records that policy', fa && fa.state.csp && fa.state.csp.policy === CSP_WAS);
check('the first policy in the frame is ours and unchanged', g0 && g0.metas[0] === CSP_WAS, g0 && g0.metas[0]);
check('the frame is still an opaque origin', g0 && g0.origin === 'null', g0 && g0.origin);
check('the frame still cannot open storage', g0 && g0.storage === 'refused');
check('THE FRAME STILL CANNOT FETCH — not even the font file it now draws with', await netRefused());

// ── Sharp and Warm: exactly as before ────────────────────────────────
// SHELVED (D-20260929-02): see the file header. `DaimondSkin.set` no longer
// moves the page off Daylight, so this block's premise -- that Sharp/Warm
// stay byte-identical to the old armour, with no face and no prelude -- is
// no longer true of anything reachable in the app.
if (argv.includes('--force-shelved')) {
for (const sk of ['sharp', 'warm']) {
	await page.evaluate((k) => DaimondSkin.set(k), sk);
	await page.waitForTimeout(500);
	st = await reopen();
	const b = await lastBlob();
	const g = await glyphs();
	console.log(`\n--- ${sk}`);
	check(`${sk}: the page is up`, st && st.mode === 'frame', st && st.mode);
	check(`${sk}: mounted without the prelude`, st && st.faces === false);
	check(`${sk}: THE PAGE WENT IN BYTE FOR BYTE AS THE OLD ARMOUR MADE IT`, b.text === b.was,
		b.text === b.was ? '' : `${b.text.length} vs ${b.was.length}`);
	check(`${sk}: no face is registered in the frame`, g && g.faces.length === 0, g && JSON.stringify(g.faces));
	// What the wire carries now: a `data` reply caught inside the frame.
	const fr = await frameOf();
	await fr.evaluate(() => {
		window.__keys = null;
		addEventListener('message', (e) => {
			const m = e.data;
			if (m && m.cmd === 'data' && m.data && m.data._theme) window.__keys = Object.keys(m.data._theme);
		});
	});
	await page.evaluate(() => DaimondTheme.set(DaimondTheme.get()));
	await page.waitForTimeout(500);
	const keys = await fr.evaluate(() => window.__keys);
	check(`${sk}: _theme has no faces key`, Array.isArray(keys) && keys.indexOf('faces') < 0, keys && keys.join(','));
}
} else {
	console.log('\n--- sharp/warm: SHELVED -- Daylight is the only skin now (D-20260929-02)');
}

// ── Choosing Daylight with the page up brings the faces in ───────────
await page.evaluate(() => DaimondSkin.set('daylight'));
await page.evaluate(() => DaimondTheme.set('porcelain'));
await page.waitForTimeout(2000);
st = await page.evaluate(() => DaimondCrystal._state());
const g2 = await glyphs();
check('switching to Daylight mounts the page again with the prelude', st && st.mode === 'frame' && st.faces === true);
check('and Sofia Sans draws there without leaving the Diamond',
	g2 && !near(g2.sans[0], g2.sans[1]), g2 && g2.sans.map(Math.round).join(' vs '));

// ── A page that wears `_theme.font` draws in the faces ───────────────
//
// The shipped page does not: its own `:root{--fo:system-ui,…}` comes after the `dc-theme`
// rule its `theme()` writes, so its neutral defaults win (see the record). A page that
// applies the theme inline -- every page written before 2026-08-11, and the Life log capp
// -- does wear it, and that is the page these checks hold to the faces.
const THEME_NOW = [
	'function theme(t){if(!t)return;var m={bg:"--bg",surface:"--sf",text:"--tx",',
	'muted:"--mu",border:"--bd",accent:"--ac",accentText:"--at",font:"--fo",',
	'mono:"--mo",size:"--fs",radius:"--rd"};',
	'var css="";for(var k in m)if(m.hasOwnProperty(k)&&t[k])',
	'css+=m[k]+":"+t[k]+";";',
	'var el=document.getElementById("dc-theme");',
	'if(!el){el=document.createElement("style");el.id="dc-theme";',
	'document.head.insertBefore(el,document.head.firstChild);}',
	'el.textContent=":root{"+css+"}";}',
].join('\n');
const THEME_INLINE = [
	'function theme(t){if(!t)return;var m={bg:"--bg",surface:"--sf",text:"--tx",',
	'muted:"--mu",border:"--bd",accent:"--ac",accentText:"--at",font:"--fo",',
	'mono:"--mo",size:"--fs",radius:"--rd"};',
	'for(var k in m)if(m.hasOwnProperty(k)&&t[k])',
	'document.documentElement.style.setProperty(m[k],t[k]);}',
].join('\n');
const wearing = await page.evaluate(({ a, b }) => {
	const P = DaimondCrystal.DEFAULT_PAGE;
	return P.indexOf(a) >= 0 ? P.split(a).join(b) : '';
}, { a: THEME_NOW, b: THEME_INLINE });
check('a theme-wearing page was built from the shipped one', !!wearing);
for (const pal of ['porcelain', 'obsidian']) {
	await page.evaluate((p) => DaimondTheme.set(p), pal);
	const stw = await mountDirect(wearing);
	await page.waitForTimeout(1200);
	const g = await glyphs();
	console.log(`\n--- theme-wearing page, ${pal}`);
	check(`wearing ${pal}: up in its frame with the prelude`, stw.mode === 'frame' && stw.faces === true, stw.mode);
	check(`wearing ${pal}: the page sets in Sofia Sans`, g && /^"?sofia sans/i.test(g.stack), g && g.stack);
	check(`wearing ${pal}: THE TITLE IS DRAWN IN SOFIA SANS CONDENSED, NOT THE SYSTEM SANS`,
		g && g.title[0] > 0 && near(g.title[0], g.title[1]) && !near(g.title[1], g.title[3]),
		g && `as drawn ${Math.round(g.title[0])}, Condensed ${Math.round(g.title[1])}, fallback ${Math.round(g.title[3])}`);
	if (SHOTS) {
		const f = join(SHOTS, `crystal_wearing_daylight_${pal}_${ENGINE}_${vp.width}x${vp.height}${BREAK ? '_break' : ''}.png`);
		await page.screenshot({ path: f });
		console.log(`  shot ${f}`);
	}
}

// ── The faces are read once ──────────────────────────────────────────
const fetches = await page.evaluate(() => performance.getEntriesByType('resource')
	.filter(e => /\/fonts\/.*\.woff2/.test(e.name)).map(e => e.name.replace(/^.*\/fonts\//, '')));
const counts = {};
for (const f of fetches) counts[f] = (counts[f] || 0) + 1;
check('each face file was fetched at most twice (the sheet once, the frame\'s copy once), after four mounts',
	Object.values(counts).every(n => n <= 2), JSON.stringify(counts));

await shot(s, 'crystalfont');
console.log(`\ncrystalfont: ${ok} ok / ${bad} failed${BREAK ? ' (--break ' + BREAK + ')' : ''}`);
await s.browser.close();
process.exit(bad ? 1 : 0);

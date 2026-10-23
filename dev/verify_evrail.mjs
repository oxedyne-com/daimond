// gateway: none
// verify_evrail.mjs -- the rail's money pools as electric cars (D-20261020-14 EV,
// owner refinements D-20261022-07).
//
// Each money pool on the rail is a battery (how full since its last top-up), a dial
// (the 15-min mean pace against the pool's own full scale) and a range ("6 h left",
// "idle") and its own Today, local midnight to now (D-20261023-05: no total Today),
// and the rail shows nothing else of money.
//
// THE CHECKS, each a property a user can see:
//   rail    per pool a battery, a dial, a range and a Today; no total, no runway line; no Week
//           or Month; the dial face always in thirds -- the lower uncoloured, the middle
//           the app's orange (--warn), the upper its red (--danger) -- whatever the
//           needle reads, like a rev counter's redline; an idle pool rests at 180°.
//   needle  the needle's angle rises with the 15-min pace, monotonically.
//   level   the battery follows D-20261015-14 after a seeded top-up: a rise is a new
//           full height, a fall reads against it; nearly empty reads amber.
//   words   each pool's title names pool, amount, pace and range.
//   clock   the minute timer: a quiet pool's needle falls as its window empties, and
//           Today starts again at local midnight (Playwright's clock).
//   sync    two contexts, one account, one in-process cloud: spend made on B moves A's
//           Today and A's dial within one sync round (rulings §14).
//
// --break <arm> serves an edited file through page.route (Chromium only); each must
// redden at least one check:
//   lit       the face lit only up to the needle (the commit's first drawing)
//   needle    the needle never moves
//   week      Week and Month back on the rail
//   total     a total Today back beside the pools (owner, 23 Oct: a Today per pool, no total)
//   runway    the runway line back
//   level     a top-up never raises the full height
//   midnight  Today is the trailing 24 h, not the calendar day
//   timer     no minute timer
//   sync      a sync round adopts no ledger
//   syncpaint a sync round adopts the ledger but does not repaint the rail
//
// --www <dir> serves another build's www (the red run on 90eaed81).
// ONLY=rail,needle,level,clock,sync runs a subset.
//
//   node dev/verify_evrail.mjs
//   node dev/verify_evrail.mjs --break lit
//   DAIMOND_BROWSER=webkit node dev/verify_evrail.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs, scratch, BROWSER, APP, armFilter, verdict } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' -- ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail !== undefined && detail !== '' ? ' -- ' + detail : ''));
};
const note = (t) => console.log('        . ' + t);
const arg = (flag, dflt) => { const i = process.argv.indexOf(flag); return i > 0 ? String(process.argv[i + 1] || dflt) : dflt; };
const want = armFilter('ONLY');

// ── The breaks: [file, from, to], each anchor present exactly once ─────
const BREAKS = {
	lit: ['js/agentgrid.js',
		"s += '<path class=\"band b' + (i + 1) + '\" d=\"' + arcPath(cx, cy, r, b[0], b[1])",
		"if (an > b[0] + 0.5) s += '<path class=\"band b' + (i + 1) + '\" d=\"' + arcPath(cx, cy, r, b[0], Math.min(an, b[1]))"],
	needle: ['js/agentgrid.js', 'angle: idle ? 180 : needleAngle(rate, p.scale),', 'angle: 180,'],
	week: ['js/daimond.js', '			row.appendChild(who); row.appendChild(gau); row.appendChild(day);\n',
		"			row.appendChild(who); row.appendChild(gau); row.appendChild(day); ['Week', 'Month'].forEach(function (w) { var c = document.createElement('span'); c.className = 'spend-label'; c.textContent = w; row.appendChild(c); });\n"],
	total: ['js/daimond.js', '		if (ev) row.appendChild(ev);\n',
		"		if (ev) row.appendChild(ev); var tt = document.createElement('span'); tt.className = 'spend-cell spend-today'; tt.innerHTML = '<span class=\"spend-label\">Today</span><span class=\"spend-amt\">0.00</span>'; row.appendChild(tt);\n"],
	runway: ['js/daimond.js', '		if (ev) row.appendChild(ev);\n',
		"		if (ev) row.appendChild(ev); var rw = document.createElement('div'); rw.className = 'spend-runway'; rw.textContent = 'runs out in ~20 h'; row.appendChild(rw);\n"],
	level: ['js/money.js', 'if (!has || amount > prev.full || (last !== null && amount > last)) {', 'if (!has) {'],
	midnight: ['js/ledger.js', 'day:     sum(since(entries, d0.getTime())),', 'day:     sum(since(entries, now - 864e5)),'],
	timer: ['js/daimond.js', 'spendMinuteTimer = setInterval(function () { updateSpend(true); }, 60e3);', 'spendMinuteTimer = 0;'],
	sync: ['js/daimond.js', 'if (!DaimondLedger.adopt(remote.ledger)) return;', 'return;'],
	syncpaint: ['js/daimond.js', "			try { updateSpend(); } catch (e) { /* nothing is drawn yet */ }\n", ''],
};
const BREAK = arg('--break', process.env.EV_BREAK || '');	// EV_BREAK: the same through dk arms
if (BREAK && !BREAKS[BREAK]) { console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(' ')}`); process.exit(2); }
if (BREAK && BROWSER !== 'chromium') { console.error('--break serves an edited file through page.route; run it under Chromium.'); process.exit(2); }
const OTHER = arg('--www', '');
if (OTHER && !fs.existsSync(path.join(OTHER, 'index.html'))) { console.error(`--www ${OTHER}: no index.html`); process.exit(2); }

const PATCHED = new Map();
if (BREAK) {
	const [f, from, to] = BREAKS[BREAK];
	const src = fs.readFileSync(path.join(OTHER || WWW, f), 'utf8');
	const n = src.split(from).length - 1;
	if (n !== 1) { console.error(`break anchor for '${BREAK}' appears ${n} times in ${f} (expected 1)`); process.exit(2); }
	PATCHED.set(f, src.replace(from, to));
}
const MIME = { '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css',
	'.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
async function serveHook(page) {
	for (const [f, body] of PATCHED) {
		await page.route('**/' + f + '*', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body }));
	}
	if (OTHER) {
		await page.route(APP + '/**', (r) => {
			const u = new URL(r.request().url());
			if (u.pathname.startsWith('/api/')) return r.fallback();
			const rel = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname.slice(1));
			const file = path.join(OTHER, rel);
			if (PATCHED.has(rel) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return r.fallback();
			return r.fulfill({ status: 200, body: fs.readFileSync(file),
				contentType: MIME[path.extname(file)] || 'application/octet-stream' });
		});
	}
}
const BLOCK_SW = (PATCHED.size || OTHER) ? { serviceWorkers: 'block' } : {};

// ── In the page ───────────────────────────────────────────────────────
// Three pools: Daimond credits (US$12.50 of a 20 top-up), an OpenRouter key limit
// (US$37.18 of 50) and an Anthropic credit estimate (US$8.40 of 10).
async function pools(page, o = {}) {
	await page.evaluate((o) => {
		const now = Date.now();
		window.__ev = Object.assign(window.__ev || { credits: 1250, or: 37.18, an: 8.4 }, o);
		if (!window.__evGs) window.__evGs = DaimondGateway.state.bind(DaimondGateway);
		DaimondGateway.state = () => Object.assign({}, window.__evGs(), { authed: true, credits: window.__ev.credits, currency: 'USD' });
		DaimondModels.providers = () => [
			{ id: 'openrouter', name: 'OpenRouter', hasKey: true, paid: false, credit: { mode: 'auto', usd: window.__ev.or, binds: 'limit' } },
			{ id: 'anthropic', name: 'Anthropic', hasKey: true, paid: false, credit: { mode: 'manual', usd: window.__ev.an } },
		];
		if (!window.__evMarked) {
			window.__evMarked = true;
			try {
				DaimondModels.noteTopups([
					{ key: 'credits', mark: { full: 20, at: now - 3600e3, last: 20 } },
					{ key: 'openrouter', mark: { full: 50, at: now - 3600e3, last: 50 } },
					{ key: 'anthropic', mark: { full: 10, at: now - 3600e3, last: 10 } },
				]);
			} catch (e) { /* an older build has no marks */ }
		}
	}, o);
}
const repaint = async (page) => {
	await page.evaluate(() => DaimondI18n.setCurrency('USD'));
	await page.waitForTimeout(250);
};
const spendOn = (page, usd, pv = 'openrouter') => page.evaluate(({ usd, pv }) => DaimondLedger.record({
	ts: Date.now(), model: 'mock/fast', promptTokens: 100, completionTokens: 100, costUsd: usd, provider: pv }), { usd, pv });

/// The rail as drawn, read and not repainted.
const read = (page) => page.evaluate(() => {
	const el = document.getElementById('spend-row');
	if (!el) return null;
	const ink = (v) => { const p = document.createElement('span'); p.style.color = 'var(' + v + ')'; el.appendChild(p);
		const c = getComputedStyle(p).color; p.remove(); return c; };
	const rows = [...el.querySelectorAll('.evp')].map((r) => {
		const d = r.querySelector('svg.evd'), b = r.querySelector('svg.evb');
		const band = (k) => { const x = d && d.querySelector('.band.' + k); return x ? getComputedStyle(x).stroke : null; };
		return { key: r.dataset.pool, title: r.title || '', aria: r.getAttribute('aria-label') || '',
			name: (r.querySelector('.evnm') || {}).textContent || '', bal: (r.querySelector('.evbal') || {}).textContent || '',
			level: b ? Number(b.dataset.level) : null, low: b ? b.classList.contains('low') : null,
			angle: d ? Number(d.dataset.angle) : null, rest: d ? d.classList.contains('rest') : null,
			bands: d ? { b1: band('b1'), b2: band('b2'), b3: band('b3'), n: d.querySelectorAll('.band').length } : null,
			mi: (r.querySelector('.evmi') || {}).textContent || null, miLow: !!r.querySelector('.evmi.low') };
	});
	// Labels outside the pools' names and their own Todays: Week, Month or a total Today.
	const labels = [...el.querySelectorAll('.spend-label')].filter((x) => !x.classList.contains('evnm') && !x.classList.contains('evdl')).map((x) => x.textContent.trim());
	const days = [...el.querySelectorAll('.evp')].map((r) => { const v = r.querySelector('.evday .evdv'), l = r.querySelector('.evday .evdl');
		return { label: l ? l.textContent.trim() : null, v: v ? Number(String(v.textContent).replace(/[^0-9.]/g, '')) : null }; });
	// Today is each pool's own: the spend under test is all OpenRouter's, so the sum is the day's.
	const today = days.length && days.every((d) => d.v !== null && !Number.isNaN(d.v)) ? Math.round(days.reduce((a, d) => a + d.v, 0) * 1e6) / 1e6 : null;
	return { warn: ink('--warn'), danger: ink('--danger'), rows, labels, days, today,
		runway: !!el.querySelector('.spend-runway, .spend-cyls'), text: el.textContent };
});
const by = (r, k) => (r && r.rows.find((x) => x.key === k)) || null;
const near = (a, b, e = 0.002) => typeof a === 'number' && Math.abs(a - b) <= e;

const ready = (s) => s.page.waitForFunction(
	() => !!(window.DaimondCore && DaimondCore.collectSync && window.DaimondSync && window.DaimondGateway
		&& window.DaimondIdentity && window.DaimondLedger && window.DaimondModels),
	null, { timeout: 30000 });

let ran = 0;
const tag = BROWSER + (BREAK ? '-' + BREAK : '') + (OTHER ? '-other' : '');
console.log(`\n-- EV rail on ${BROWSER}${BREAK ? '  [--break ' + BREAK + ']' : ''}${OTHER ? '  [--www ' + OTHER + ']' : ''} --`);

// ═══ rail, needle, level, words: one context at 1440×900 ═══════════════
if (want('rail') || want('needle') || want('level')) {
	let s = null;
	try {
		s = await open({ name: 'evrail', viewport: { width: 1440, height: 900 }, route: serveHook, ...BLOCK_SW });
		await ready(s);
		const { page } = s;
		await pools(page); await repaint(page);
		const r = await read(page);
		note('rows ' + JSON.stringify((r && r.rows || []).map((x) => [x.key, x.level, x.angle, x.mi])) + ' labels ' + JSON.stringify(r && r.labels));
		if (want('rail')) {
			ran++;
			const keys = (r && r.rows || []).map((x) => x.key).join(',');
			check('rail: one row per pool, in the pools\' order', keys === 'credits,openrouter,anthropic', keys);
			check('rail: every pool has a battery, a dial and a range',
				!!r && r.rows.length === 3 && r.rows.every((x) => x.level !== null && x.angle !== null && x.mi), r && JSON.stringify(r.rows.map((x) => [x.level, x.angle, x.mi])));
			check('rail: no runway line, no cylinders', !!r && !r.runway);
			check('rail: a Today in every pool row, no total Today, no Week or Month', !!r && r.days.length === 3 && r.days.every((d) => d.label === 'Today')
				&& !r.labels.length && !/\b(Week|Month)\b/.test(r.text), r && JSON.stringify([r.days.map((d) => d.label), r.labels]));
			check('rail: idle pools rest at 180° and say "idle"',
				!!r && r.rows.length === 3 && r.rows.every((x) => x.angle === 180 && x.rest && /idle/.test(x.mi)), r && JSON.stringify(r.rows.map((x) => [x.angle, x.rest, x.mi])));
			const face = (x) => x && x.bands && x.bands.n === 3 && x.bands.b2 === r.warn && x.bands.b3 === r.danger
				&& x.bands.b1 !== r.warn && x.bands.b1 !== r.danger;
			check('rail: an idle dial still shows its thirds: uncoloured, orange, red', !!r && r.rows.length === 3 && r.rows.every(face),
				r && JSON.stringify(r.rows.map((x) => x.bands)) + ' warn ' + r.warn + ' danger ' + r.danger);
		}
		if (want('needle')) {
			ran++;
			const angles = [];
			for (const usd of [0.25, 0.5, 1.0]) {
				await spendOn(page, usd); await repaint(page);
				const x = by(await read(page), 'openrouter');
				angles.push(x ? x.angle : null);
			}
			const after = await read(page), or = by(after, 'openrouter');
			check('needle: rises with the 15-min pace, monotonically',
				angles.every((a) => typeof a === 'number') && angles[0] > 180 && angles[0] < angles[1] && angles[1] < angles[2] && angles[2] <= 360,
				JSON.stringify(angles));
			check('needle: 1 an hour on the default 5 an hour scale stands at 216°', near(angles[0], 216, 0.05), String(angles[0]));
			check('needle: a burst keeps the face in thirds', !!or && or.bands && or.bands.n === 3 && or.bands.b2 === after.warn && or.bands.b3 === after.danger,
				or && JSON.stringify(or.bands));
			check('needle: the other pools stay at rest', ['credits', 'anthropic'].every((k) => { const x = by(after, k); return x && x.angle === 180 && x.rest; }));
			check('words: the title names pool, amount, pace and range',
				!!or && /OpenRouter/.test(or.title) && /37\.18/.test(or.title) && /50/.test(or.title) && /an hour/.test(or.title) && /left/.test(or.title) && or.title === or.aria,
				or && or.title);
			check('rail: Today counts what was spent', !!after && near(after.today, 1.75, 0.006), after && String(after.today));
		}
		if (want('level')) {
			ran++;
			const lv = async (o) => { await pools(page, o); await repaint(page); return by(await read(page), 'openrouter'); };
			const a = await lv({ or: 37.18 }), b = await lv({ or: 80 }), c = await lv({ or: 60 }), d = await lv({ or: 1.2 });
			note('levels ' + JSON.stringify([a, b, c, d].map((x) => x && [x.level, x.low])));
			check('level: 37.18 of the 50 mark reads 0.744', !!a && near(a.level, 37.18 / 50), a && String(a.level));
			check('level: a top-up to 80 is the new top', !!b && near(b.level, 1), b && String(b.level));
			check('level: 60 after the top-up to 80 reads 0.75', !!c && near(c.level, 0.75), c && String(c.level));
			check('level: nearly empty reads amber, and the full one does not', !!d && d.low && near(d.level, 1.2 / 80) && !!c && !c.low,
				JSON.stringify([d && d.low, c && c.low]));
		}
	} catch (e) {
		console.log('VERIFY THREW:', e && (e.stack || e.message || e)); bad.push('threw: ' + (e && e.message)); ran++;
	} finally { try { await s?.close?.(); } catch (e) {} }
}

// ═══ clock: the minute timer and local midnight ═══════════════════════
if (want('clock')) {
	ran++;
	let s = null;
	try {
		s = await open({ name: 'evclock', viewport: { width: 1440, height: 900 }, ...BLOCK_SW,
			route: async (page) => { await page.clock.install(); await serveHook(page); } });
		await ready(s);
		const { page } = s;
		await pools(page);
		const at = await page.evaluate(() => { const d = new Date(); d.setHours(23, 50, 0, 0); return d.getTime(); });
		await page.clock.setSystemTime(at);
		await spendOn(page, 0.5); await repaint(page);
		const r0 = await read(page), o0 = by(r0, 'openrouter');
		note('23:50 today ' + (r0 && r0.today) + ' angle ' + (o0 && o0.angle));
		check('clock: at 23:50 Today holds the spend and the needle is up', !!r0 && near(r0.today, 0.5, 0.006) && !!o0 && o0.angle > 180,
			JSON.stringify([r0 && r0.today, o0 && o0.angle]));
		await page.clock.fastForward('16:00');
		await page.waitForTimeout(800);
		const r1 = await read(page), o1 = by(r1, 'openrouter');
		note('00:06 today ' + (r1 && r1.today) + ' angle ' + (o1 && o1.angle));
		check('clock: past local midnight Today starts again, with no event but the minute', !!r1 && r1.today === 0, String(r1 && r1.today));
		check('clock: a quiet pool\'s needle falls to rest as its window empties', !!o1 && o1.angle === 180 && o1.rest, JSON.stringify(o1 && [o1.angle, o1.rest]));
	} catch (e) {
		console.log('VERIFY THREW:', e && (e.stack || e.message || e)); bad.push('threw: ' + (e && e.message));
	} finally { try { await s?.close?.(); } catch (e) {} }
}

// ═══ sync: spend on B moves A, within one sync round ═════════════════
const cloud = { mailbox: null, chunks: new Map() };
function serveCloud(dev, rawPath, method, bodyText) {
	const p = String(rawPath).split('?')[0];
	const body = bodyText ? JSON.parse(bodyText) : {};
	if (p === '/api/sync') {
		if (method === 'GET') {
			if (!cloud.mailbox) return { status: 200, json: { present: false, version: 0 } };
			return { status: 200, json: { present: true, version: cloud.mailbox.version, blob: cloud.mailbox.blob, device: cloud.mailbox.device } };
		}
		const cur = cloud.mailbox ? cloud.mailbox.version : 0;
		if ((body.base_version | 0) !== cur) return { status: 409, json: { ok: false, version: cur } };
		cloud.mailbox = { version: cur + 1, blob: body.blob, device: body.device || dev };
		return { status: 200, json: { ok: true, version: cur + 1 } };
	}
	if (p === '/api/chunk') {
		if (body.op === 'put') { (body.chunks || []).forEach((c) => cloud.chunks.set(c.addr, c.blob)); return { status: 200, json: { ok: true } }; }
		if (body.op === 'have') return { status: 200, json: { missing: (body.addrs || []).filter((a) => !cloud.chunks.has(a)) } };
		if (body.op === 'get') { const blob = cloud.chunks.get(body.addr); return { status: 200, json: blob ? { present: true, blob } : { present: false } }; }
		if (body.op === 'commit') return { status: 200, json: { ok: true, swept: 0, free_allowance: 0, paid_bytes: 0 } };
		return { status: 200, json: { ok: true } };
	}
	return { status: 200, json: { ok: true } };
}
async function wireCloud(s, dev) {
	await s.page.exposeFunction('__cloudCall', async (p, method, body) => serveCloud(dev, p, method, body));
	await s.page.evaluate(() => {
		window.DaimondGateway.state = function () { return { authed: true, credits: 0, pro: false }; };
		window.DaimondGateway.gwFetch = async function (p, opts) {
			const r = await window.__cloudCall(String(p), (opts && opts.method) || 'GET', String((opts && opts.body) || ''));
			return { status: r.status, json: async () => r.json };
		};
	});
}
const push = async (s) => { await s.page.evaluate(() => window.DaimondSync.push()); await s.page.waitForTimeout(500); };
const pull = async (s) => { await s.page.evaluate(() => window.DaimondSync.pull()); await s.page.waitForTimeout(500); };

if (want('sync')) {
	ran++;
	let A = null, B = null;
	const PA = scratch('pw', 'evrail-a-' + tag), PB = scratch('pw', 'evrail-b-' + tag);
	for (const d of [PA, PB]) fs.rmSync(d, { recursive: true, force: true });
	try {
		A = await open({ name: 'evrail-a', profile: PA, signIn: false, connect: false, defaults: false, route: serveHook, ...BLOCK_SW });
		await ready(A); await signInAs(A, 'evrail'); await ready(A);
		const bundle = await A.page.evaluate(() => window.DaimondIdentity.exportBundle());
		B = await open({ name: 'evrail-b', profile: PB, signIn: false, connect: false, defaults: false, route: serveHook, ...BLOCK_SW });
		await ready(B);
		await B.page.evaluate((b) => window.DaimondIdentity.importBundle(b), bundle);
		await B.page.reload({ waitUntil: 'domcontentloaded' });
		await ready(B); await signInAs(B, 'evrail'); await ready(B);
		await wireCloud(A, 'A'); await wireCloud(B, 'B');
		const ka = await A.page.evaluate(() => window.DaimondIdentity.publicKeyB64url());
		const kb = await B.page.evaluate(() => window.DaimondIdentity.publicKeyB64url());
		check('sync: two contexts hold ONE account', !!ka && ka === kb);
		await pools(A.page); await pools(B.page);
		await push(A); await pull(B); await push(B); await pull(A);
		await repaint(A.page);
		const a0 = await read(A.page), o0 = by(a0, 'openrouter');
		note('A before: today ' + (a0 && a0.today) + ' angle ' + (o0 && o0.angle));
		await spendOn(B.page, 0.6);
		// One sync round: B sends, A takes. A is not repainted by the verifier: the
		// adoption itself must move A's rail.
		await push(B); await pull(A);
		await A.page.waitForTimeout(400);
		const a1 = await read(A.page), o1 = by(a1, 'openrouter');
		note('A after: today ' + (a1 && a1.today) + ' angle ' + (o1 && o1.angle));
		check('sync: B\'s spend moves A\'s Today within one round', !!a0 && !!a1 && near(a1.today - a0.today, 0.6, 0.006),
			JSON.stringify([a0 && a0.today, a1 && a1.today]));
		check('sync: B\'s spend moves A\'s dial within one round', !!o0 && !!o1 && o0.angle === 180 && o1.angle > 180 && !o1.rest,
			JSON.stringify([o0 && o0.angle, o1 && o1.angle]));
	} catch (e) {
		console.log('VERIFY THREW:', e && (e.stack || e.message || e)); bad.push('threw: ' + (e && e.message));
	} finally {
		try { await A?.close?.(); } catch (e) {}
		try { await B?.close?.(); } catch (e) {}
	}
}

console.log(`\n=== ${ok.length} ok, ${bad.length} FAIL on ${BROWSER}${BREAK ? ' (--break ' + BREAK + ': FAILs expected)' : ''} ===`);
verdict({ ran, bad, green: `PASS evrail ${BROWSER}`, filters: [want] });

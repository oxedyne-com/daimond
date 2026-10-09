// gateway: none
// verify_labels.mjs -- one word per destination (D-20261009-21).
//
// Two controls answered to "Settings": the top bar's sliders button, which opens
// theme and layout, and the identity row, which opens the account's drawer --
// and that drawer was headed "Admin". A person told "open Settings" had two doors
// and could not know which. The ruling: the look menu is "Appearance", the row
// and its drawer are "Settings".
//
// The rule is general, so the check is too. It collects every visible control on
// every resting surface (the page, the help/overflow menu, and on a phone the
// drawer), names each one the way a screen reader would, and for every name that
// two or more controls share it presses each of them on a freshly loaded page
// and records which places became visible. One name leading to two places fails.
// The two doors of the ruling are always pressed, and the place each opens must
// be headed with the word that opened it.
//
// Desk 1440x900 and phone 390x844, each in Obsidian and Porcelain.
//
//   eval "$(bash dev/world.sh N --env)"; bash dev/world.sh N --up
//   node dev/verify_labels.mjs [desk|phone]
import { open } from './harness.mjs';

const ONLY  = process.argv[2] || '';
const LOOKS = (process.env.LABELS_LOOKS || 'obsidian,porcelain').split(',');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DOORS = ['#user-row', '#settings-menu-btn'];	// the ruling's two
// No shared name is allowed to lead to two places. "More" was, and the two
// overflows it named are now "Chat options" and "Chats list options".
// Never pressed: a control whose press changes data rather than the view.
const UNSAFE = /delete|remove|sign out|log out|clear|reset|discard|stop|archive|trash|revoke|forget|send/i;

const CONFIGS = [
	{ name: 'desk',  size: { width: 1440, height: 900 }, opts: {} },
	{ name: 'phone', size: { width: 390,  height: 844 }, opts: { touch: true, isMobile: true } },
].filter((c) => !ONLY || c.name === ONLY);

const ok = [], bad = [];
const check = (label, pass, info) => {
	(pass ? ok : bad).push(label);
	console.log(`${pass ? 'PASS' : 'FAIL'} ${label}${info ? ' -- ' + info : ''}`);
};

// ── In the page ─────────────────────────────────────────────────────────
// Defined once as a string and installed per load, so each evaluate below is a
// one-liner against `window.__lbl`.
const PAGE_LIB = () => {
	const CTRL = 'button, a[href], [role=button], [role=menuitem], [role=menuitemradio], [role=tab], [role=link]';
	const PLACES = '[role=dialog], [role=menu], .pop, .modal, .dlg, .admin-view, .imp-view, .panel, .admin-open';
	const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();
	const shown = (e) => {
		if (!e.getClientRects().length) return false;
		if (e.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
		const cs = getComputedStyle(e);
		if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
		const r = e.getBoundingClientRect();
		return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0
			&& r.left < innerWidth && r.top < innerHeight;
	};
	// The accessible name, by the precedence a screen reader uses.
	const name = (e) => {
		const by = e.getAttribute('aria-labelledby');
		if (by) {
			const t = by.split(/\s+/).map((id) => { const x = document.getElementById(id); return x ? x.textContent : ''; }).join(' ');
			if (squash(t)) return squash(t);
		}
		return squash(e.getAttribute('aria-label')) || squash(e.innerText) || squash(e.getAttribute('title'));
	};
	const path = (e) => {
		if (e.id) return '#' + CSS.escape(e.id);
		const up = e.parentElement;
		if (!up) return e.tagName.toLowerCase();
		const same = [...up.children].filter((c) => c.tagName === e.tagName);
		return path(up) + ' > ' + e.tagName.toLowerCase() + ':nth-of-type(' + (same.indexOf(e) + 1) + ')';
	};
	const placeKey = (p) => p.id ? '#' + p.id : p.tagName.toLowerCase() + '.' + [...p.classList].sort().join('.');
	window.__lbl = {
		controls: () => [...document.querySelectorAll(CTRL)].filter(shown)
			.map((e) => ({ sel: path(e), name: name(e) })).filter((c) => c.name),
		places: () => [...document.querySelectorAll(PLACES)].filter((p) => p.classList.contains('admin-open') || shown(p))
			.map((p) => placeKey(p)),
		// The heading of the first new place that has one.
		heading: (keys) => {
			for (const k of keys) {
				const p = k.startsWith('#') ? document.querySelector(k) : null;
				if (!p) continue;
				const h = [...p.querySelectorAll('.admin-title, .ui-head-title, h1, h2, h3')].find(shown);
				if (h) return squash(h.textContent);
			}
			return '';
		},
		press: (sel) => { const e = document.querySelector(sel); if (!e) return false; e.click(); return true; },
	};
};

async function fresh(page, cfg, look) {
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.waitForSelector('#user-row', { state: 'attached', timeout: 30000 });
	await sleep(1200);
	await page.setViewportSize(cfg.size);
	await page.evaluate(() => window.dispatchEvent(new Event('resize')));
	await page.evaluate((t) => { window.DaimondLook && window.DaimondLook.set('daylight'); window.DaimondTheme.set(t); }, look);
	await sleep(500);
	await page.evaluate(PAGE_LIB);
}

// The resting surfaces, and how each is reached from a fresh load.
const SURFACES = {
	page:   async () => {},
	help:   async (page) => { await page.evaluate(() => document.getElementById('help-btn').click()); await sleep(400); },
	drawer: async (page) => { await page.evaluate(() => { const b = document.getElementById('drawer-btn'); if (b && b.getClientRects().length) b.click(); }); await sleep(500); },
};

async function run(cfg, look) {
	const tag = `${cfg.name}-${look}`;
	const s = await open({ name: `labels-${cfg.name}`, connect: false, ...cfg.opts });
	const { page } = s;
	try {
		await fresh(page, cfg, look);
		// 1. Every control on every surface, with the surface that shows it.
		const all = [];
		for (const surf of Object.keys(SURFACES)) {
			if (surf === 'drawer' && cfg.name !== 'phone') continue;
			await fresh(page, cfg, look);
			await SURFACES[surf](page);
			for (const c of await page.evaluate(() => window.__lbl.controls())) all.push({ ...c, surf });
		}
		// The same element seen from two surfaces is one control.
		const bySel = new Map();
		for (const c of all) if (!bySel.has(c.sel)) bySel.set(c.sel, c);
		const groups = new Map();
		for (const c of bySel.values()) {
			const k = c.name.toLowerCase();
			if (!groups.has(k)) groups.set(k, []);
			groups.get(k).push(c);
		}
		console.log(`[${tag}] ${bySel.size} controls, ${[...groups.values()].filter((g) => g.length > 1).length} shared names`);

		// 2. Press what has to be pressed, each on a fresh page.
		const dest = async (c) => {
			await fresh(page, cfg, look);
			await SURFACES[c.surf](page);
			const before = new Set(await page.evaluate(() => window.__lbl.places()));
			if (!await page.evaluate((q) => window.__lbl.press(q), c.sel)) return { keys: [], heading: '', missing: true };
			await sleep(700);
			const keys = (await page.evaluate(() => window.__lbl.places())).filter((k) => !before.has(k)).sort();
			return { keys, heading: await page.evaluate((k) => window.__lbl.heading(k), keys) };
		};
		const pressed = new Map();
		for (const [k, g] of groups) {
			if (g.length < 2 || UNSAFE.test(k)) continue;
			const seen = [];
			for (const c of g) {
				const d = await dest(c);
				pressed.set(c.sel, d);
				if (d.keys.length) seen.push({ c, d });	// a control that opens nothing is not a door
			}
			const places = new Set(seen.map((x) => x.d.keys.join(' ')));
			check(`${tag}: "${g[0].name}" leads to one place`, places.size <= 1,
				places.size > 1 ? seen.map((x) => `${x.c.sel} -> ${x.d.keys.join(' ')}`).join(' | ') : '');
		}
		// 3. The ruling's doors: each is headed with its own word.
		for (const sel of DOORS) {
			const c = bySel.get(sel);
			if (!c) { check(`${tag}: ${sel} is reachable`, false, 'not on any resting surface'); continue; }
			const d = pressed.get(sel) || await dest(c);
			check(`${tag}: ${sel} "${c.name}" opens a place headed "${c.name}"`,
				d.keys.length > 0 && d.heading.toLowerCase() === c.name.toLowerCase(),
				`-> ${d.keys.join(' ') || 'nothing'}, headed "${d.heading}"`);
		}
	} finally {
		await s.close().catch(() => {});
	}
}

for (const cfg of CONFIGS) for (const look of LOOKS) await run(cfg, look);
console.log(`\n${ok.length} ok, ${bad.length} failed${bad.length ? ': ' + bad.join(', ') : ''}`);
process.exit(bad.length ? 1 : 0);

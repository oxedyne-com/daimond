// verify_search_app.mjs — the browser half of the search tool: the setting, the
// key, and the pause control the Web panel never had.
//
// WHAT THIS FILE IS ABOUT. Two things shipped together (dev/SEARCH_CONTRACT.md
// §8 and §9) and they share one property: a decision about money that the user
// can see and reach.
//
//   * WHICH ENGINE, and whose key pays. `credits` is the account's balance and
//     the gateway holds the key; everything else is the user's own key, sealed
//     under the passphrase and sent only in the request it pays for. `serper`
//     is BYOK ONLY — it resells Google, and Oxedyne billing for an arbitrage
//     that can stop without notice is a risk the contract says no to (§3).
//
//   * `root/web` GETS ITS CONTROL. The leaf has existed since the pause tree
//     did, with no control anywhere in the app. A user hit that this morning:
//     they paused "Everything", web access stopped, and the refusal told them
//     to press play on it in a panel with no play button. The only way back was
//     to resume everything — which also resumes the Daimond Optimiser, and that
//     ships paused on purpose. So the last section below is not "does the
//     button work": it is that PLAY ON THIS ONE LEAF MOVES THIS ONE LEAF, with
//     every other leaf held, which is the state that user was actually in.
//
// HOW IT JUDGES. No literal counts and no `boxes[0]`. The pause section
// compares SETS of paused ids before and after, so "and only root/web" is a set
// difference rather than a number; the key section scans every localStorage
// entry for the secret rather than looking in the one it expects; the engine
// section reads the request the app was about to send, whatever engine it names.
//
// PROVED RED. `--unbuilt` rewrites the two files as they are served, undoing
// each half — the Web panel's mount, the BYOK-only rule, and the promise that a
// key is never written unsealed — and every matching check must fail there.
//
//   node dev/verify_search_app.mjs
//   node dev/verify_search_app.mjs --unbuilt      # must fail, loudly
//
// Needs a world: `eval "$(bash dev/world.sh N --up)"`. NO GATEWAY — the search
// endpoint is stubbed in the page, deliberately: this file is about what the
// browser DECIDES to send and what it does with the answer, and a real gateway
// would make it a test of somebody else's lane.

import fs from 'node:fs';
import { open, scratch } from './harness.mjs';

const UNBUILT = process.argv.includes('--unbuilt');

const out = [];
let bad = 0;
const check = (ok, what, detail) => {
	out.push(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail != null ? ' — ' + detail : ''}`);
	if (!ok) bad++;
	return ok;
};
const red = (wentRed, what) => check(wentRed, `[self-test] ${what}`);

/// Two id lists as sets, compared by what is in them and not by their order.
const sameSet = (a, b) => {
	const A = new Set(a || []), B = new Set(b || []);
	return A.size === B.size && [...A].every((x) => B.has(x));
};
/// What is in `a` and not in `b`.
const minus = (a, b) => (a || []).filter((x) => !(b || []).includes(x));

/// The part of the engine note that speaks about the engine now chosen: what
/// is left once the general sentence about vendors is taken off the front.
const engineTail = (note, general) =>
	(/\S/.test(general) && note.indexOf(general) === 0 ? note.slice(general.length) : note);
/// Whether that part calls the chosen engine free on its own account.
const claimsFree = (note, general) => /\bfree\b/i.test(engineTail(note, general));

/// A key that could not plausibly be anything else in a storage dump.
const SECRET = 'searchkey-' + process.pid + '-do-not-store-in-the-clear';

const profile = scratch('pw', 'searchapp-' + process.pid);
const s = await open({ name: 'searchapp' + process.pid, profile });
const closeBrowser = s.close;
s.close = async () => {
	await closeBrowser();
	try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* gone */ }
};
const p = s.page;

// ── The unbuilt page ────────────────────────────────────────────────
//
// Each replacement undoes ONE thing this release added, in the served source, so
// what runs is the app as it was rather than the app with a flag in it.
if (UNBUILT) {
	await p.route('**/js/daimond.js', async (route) => {
		const res = await route.fetch();
		let body = await res.text();
		body = body
			// The Web panel's control, never mounted: the leaf as it stood this morning.
			.replace("var web = document.getElementById('web-pause');",
				'var web = null; /* UNBUILT */')
			// And the settings row, never drawn.
			.replace('if (!SearchRow.mount()) return;', 'return; /* UNBUILT */')
			// The egress arm gone, so a search falls through to the same-origin
			// shortcut below it and is waved out with nobody asked — which is
			// exactly what §7's guarantee was doing before this release.
			.replace("if (req.tool === 'web_search') {", 'if (false) { /* UNBUILT */');
		await route.fulfill({ response: res, body, headers: { ...res.headers(), 'content-type': 'text/javascript; charset=utf-8' } });
	});
	await p.route('**/js/search.js', async (route) => {
		const res = await route.fetch();
		let body = await res.text();
		body = body
			// serper reachable on the balance, which §3 forbids.
			.replace('var BYOK_ONLY = { serper: true };', 'var BYOK_ONLY = {}; /* UNBUILT */')
			// And the key written in the clear beside its sealed copy.
			.replace("store.keys[id] = { key: '', keyEnc: sealed };",
				'store.keys[id] = { key: k, keyEnc: sealed }; /* UNBUILT */');
		await route.fulfill({ response: res, body, headers: { ...res.headers(), 'content-type': 'text/javascript; charset=utf-8' } });
	});
	await p.route('**/js/gateway.js', async (route) => {
		const res = await route.fetch();
		let body = await res.text();
		// The search route unknown to the spend guard, which is how it stood: no
		// arm matched it, so it fell out of the bottom of `spendRefusal` governed
		// by nothing — not the leaf, not a Diamond's node, not the global control.
		body = body.replace("|| p === '/api/web/search'", '|| false /* UNBUILT */');
		await route.fulfill({ response: res, body, headers: { ...res.headers(), 'content-type': 'text/javascript; charset=utf-8' } });
	});
	await p.reload({ waitUntil: 'domcontentloaded' });
	await p.waitForTimeout(1500);
	const gate = await p.$('#id-pass');
	if (gate && await gate.isVisible()) {
		await p.fill('#id-pass', 'testpass1234');
		await p.evaluate(() => document.getElementById('id-primary').click());
		await p.waitForSelector('#identity-modal', { state: 'hidden', timeout: 15000 }).catch(() => {});
	}
	await p.waitForTimeout(2000);
}

await p.waitForTimeout(800);

check(await p.evaluate(() => !!window.DaimondSearch),
	'the browser half of the search tool is loaded');

// ── The stub gateway ────────────────────────────────────────────────
//
// Installed over `window.fetch` AFTER the app has wrapped it, so this is the
// outermost layer and sees the request the app actually composed. Everything
// that is not the search route falls through untouched.
async function installStub() {
	await p.evaluate(() => {
		window.__searchCalls = [];
		window.__searchReply = null;
		const real = window.fetch;
		// The app's OWN fetch, gateway.js's pause guard included, kept aside. The
		// stub below sits OUTSIDE that guard — deliberately, so the sections about
		// what `search.js` decides never reach it — which means the section about
		// the guard itself has to call past the stub to test anything at all.
		window.__realFetch = real;
		window.fetch = function (input, init) {
			let url = '';
			try { url = (typeof input === 'string') ? input : (input && input.url) || ''; } catch (e) { url = ''; }
			if (String(url).indexOf('/api/web/search') !== -1) {
				let body = null;
				try { body = JSON.parse((init && init.body) || '{}'); } catch (e) { body = null; }
				window.__searchCalls.push(body);
				const j = window.__searchReply || {
					ok: true, engine: body && body.engine, query: body && body.query, results: [],
				};
				return Promise.resolve(new Response(JSON.stringify(j),
					{ status: 200, headers: { 'content-type': 'application/json' } }));
			}
			return real.apply(this, arguments);
		};
	});
}
await installStub();

/// Every request the app has tried to send to the search route so far.
const calls = () => p.evaluate(() => window.__searchCalls.slice());

/// Run a search in the page and report what came back, or the refusal.
const trySearch = (q, opts) => p.evaluate(async ({ q, opts }) => {
	try {
		const r = await window.DaimondSearch.search(q, opts || {});
		return { ok: true, value: r };
	} catch (e) {
		return { ok: false, message: (e && e.message) || String(e), node: (e && e.pauseNode) || '' };
	}
}, { q, opts });

// ── 1. A key is sealed, and is nowhere in the clear ─────────────────
{
	await p.evaluate(async (k) => {
		window.DaimondSearch.setEngine('brave');
		await window.DaimondSearch.setKey('brave', k);
	}, SECRET);
	await p.waitForTimeout(300);

	const held = await p.evaluate((k) => {
		// EVERY entry, not the one we expect: accounts.js namespaces `daimond-*`,
		// so looking only where this file thinks the store lives would agree with
		// itself about a store that had moved.
		const dump = [];
		for (let i = 0; i < localStorage.length; i++) {
			const name = localStorage.key(i);
			dump.push([name, localStorage.getItem(name) || '']);
		}
		let rec = null;
		for (const [, v] of dump) {
			try {
				const j = JSON.parse(v);
				if (j && j.v === 1 && j.keys && j.keys.brave) { rec = j.keys.brave; break; }
			} catch (e) { /* not the store */ }
		}
		return {
			leaked:  dump.filter(([, v]) => v.indexOf(k) !== -1).map(([n]) => n),
			rec,
			inMemory: window.DaimondSearch.key('brave'),
			has:      window.DaimondSearch.hasKey('brave'),
		};
	}, SECRET);

	check(held.leaked.length === 0,
		'the key set for an engine is nowhere in storage in the clear',
		held.leaked.length ? `found in ${JSON.stringify(held.leaked)}` : 'scanned every entry');
	check(!!held.rec && !!held.rec.keyEnc,
		'it is in the store SEALED, so a reload still has it', JSON.stringify(held.rec && Object.keys(held.rec || {})));
	check(!!held.rec && !held.rec.key,
		'and the plaintext field of that record was never written',
		JSON.stringify(held.rec && held.rec.key));
	check(held.inMemory === SECRET && held.has,
		'while the app itself can read it, in memory, for the request that pays for it');

	// The lock is the whole of forgetting it: what stays behind is the sealed copy.
	const afterLock = await p.evaluate(() => {
		window.DaimondSearch.lock();
		return { plain: window.DaimondSearch.key('brave'), has: window.DaimondSearch.hasKey('brave'),
			sealed: window.DaimondSearch.isSealed('brave') };
	});
	check(afterLock.plain === '' && afterLock.has && afterLock.sealed,
		'locking forgets the readable copy and keeps the sealed one', JSON.stringify(afterLock));
	await p.evaluate(() => window.DaimondSearch.unseal());
	await p.waitForTimeout(300);
	check(await p.evaluate(() => window.DaimondSearch.key('brave')) === SECRET,
		'and unsealing brings it back, so a lock is not a loss');
}

// ── 2. The picker says what the setting needs ───────────────────────
//
// Driven through the real `<select>` and its change event, not through
// `setEngine`: the property is about what a person sees after choosing, and a
// row painted only by the module would pass with no listener attached at all.
{
	await p.evaluate(() => {
		// The Models view is where the Search section lives. Opened the way the
		// rail opens it, so the section is on screen rather than merely in the DOM.
		const row = document.getElementById('astat-model');
		if (row) row.click();
	});
	await p.waitForTimeout(500);

	/// Choose an engine through the control, and read the row back.
	const choose = (id) => p.evaluate((want) => {
		const sel = document.getElementById('set-search-engine');
		if (!sel) return null;
		sel.value = want;
		sel.dispatchEvent(new Event('change', { bubbles: true }));
		const seen = (el) => !!(el && el.getClientRects().length);
		const keyRow = document.getElementById('search-key-row');
		const warn   = document.getElementById('search-key-warn');
		return {
			chosen:  window.DaimondSearch.engine(),
			offered: [...sel.options].map((o) => o.value),
			keyShown: seen(keyRow),
			warn:    seen(warn) ? (warn.textContent || '').trim() : '',
			note:    (document.getElementById('search-engine-note') || {}).textContent || '',
		};
	}, id);

	const onCredits = await choose('credits');
	check(!!onCredits && onCredits.chosen === 'credits',
		'the pulldown sets the engine', JSON.stringify(onCredits && onCredits.chosen));
	check(!!onCredits && !onCredits.keyShown,
		'choosing Daimond credits HIDES the key field — the gateway holds that key and there '
		+ 'is nothing here to paste', JSON.stringify(onCredits && onCredits.keyShown));
	check(!!onCredits && onCredits.offered.includes('serper'),
		'serper is on offer, because a user may bring their own key for it',
		JSON.stringify(onCredits && onCredits.offered));

	// NEITHER HALF OF THIS RELEASE WAITS FOR THE OTHER. The i18n lane fills eight
	// locales in parallel with this file, and `data-i18n` would put the raw key on
	// screen until it did — a panel headed "search.head". Every string here goes
	// through `tOr`, so the property is that nothing in the section, or on the new
	// control, reads like a lookup key.
	const rawKeys = await p.evaluate(() => {
		const looksLikeAKey = (s) => /^[a-z][a-z0-9]*(\.[a-z0-9_]+)+$/.test((s || '').trim());
		const found = [];
		const sec = document.getElementById('search-section');
		if (sec) {
			for (const el of sec.querySelectorAll('*')) {
				if (el.children.length === 0 && looksLikeAKey(el.textContent)) {
					found.push(el.id || el.tagName.toLowerCase() + ':' + el.textContent.trim());
				}
				for (const a of ['title', 'aria-label', 'placeholder']) {
					if (looksLikeAKey(el.getAttribute(a))) found.push((el.id || el.tagName) + '@' + a);
				}
			}
			for (const o of sec.querySelectorAll('option')) {
				if (looksLikeAKey(o.textContent)) found.push('option:' + o.value);
			}
		}
		for (const b of document.querySelectorAll('.pptw[data-pause-node="root/web"] *')) {
			if (looksLikeAKey(b.getAttribute('aria-label'))) found.push('pptw@' + b.className);
		}
		return found;
	});
	check(rawKeys.length === 0,
		'nothing in the section or on the new control shows a raw i18n key, so this half '
		+ 'and the locales can land in either order', JSON.stringify(rawKeys));

	// An engine with no key: the row says what to do, and a search does NOT go out
	// and come back broken. Exa is untouched by section 1, so it genuinely has none.
	const onExa = await choose('exa');
	check(!!onExa && onExa.keyShown, 'choosing an engine of your own shows the key field');
	check(!!onExa && /\S/.test(onExa.warn),
		'and one with no key shows a line saying to add one', JSON.stringify(onExa && onExa.warn));

	// THE ALLOWANCE LINE. §9 makes this the only place a free tier may be stated,
	// which means it has to be per-engine and true. The rule under test is not
	// "does it say 1,000" — a figure hard-coded in a test is the same staleness
	// one file to the left — but that the line agrees with the REGISTRY, and that
	// an engine with no figure we can cite says nothing about being free.
	{
		// The line is TWO claims stitched together: a general one about vendors
		// ("most give a free allowance"), identical whichever engine is chosen,
		// and a per-engine tail that is the only place a figure may be stated.
		// Only the tail is judged here, and it is found by removing the general
		// sentence THE APP ITSELF PAINTED, read back from the catalogue. A copy
		// of that sentence written out in this file is the same staleness one
		// directory to the left: an editor's comma turns this check red and it
		// then reports a product fault where there is none. It also has to be
		// the general sentence and not merely something before the tail, so the
		// prefix is asserted rather than assumed — a restructure that folds a
		// per-engine claim into the shared opening goes red here instead of
		// slipping past the rule underneath.
		const general = await p.evaluate(() =>
			(window.DaimondI18n && window.DaimondI18n.t('search.engine_note')) || '');
		const seen = [];
		for (const id of await p.evaluate(() => Object.keys(window.DaimondSearch.KNOWN))) {
			seen.push(await p.evaluate((want) => {
				const sel = document.getElementById('set-search-engine');
				sel.value = want;
				sel.dispatchEvent(new Event('change', { bubbles: true }));
				const el = document.getElementById('search-engine-note');
				return {
					id: want,
					free: (window.DaimondSearch.KNOWN[want] || {}).free || 0,
					note: ((el && el.textContent) || '').trim(),
				};
			}, id));
		}
		// A figure appears exactly where the registry has one.
		const wrong = seen.filter((r) => /\d/.test(r.note) !== (r.free > 0));
		check(wrong.length === 0,
			'the allowance line appears for exactly the engines the registry has a figure for',
			JSON.stringify(wrong.map((r) => ({ id: r.id, free: r.free, note: r.note }))));
		// And it is THAT figure, not one written into the sentence.
		const withFigure = seen.filter((r) => r.free > 0);
		const mismatched = withFigure.filter((r) =>
			r.note.replace(/[^\d]/g, '').indexOf(String(r.free)) === -1);
		check(withFigure.length > 0 && mismatched.length === 0,
			'and the number on screen is the registry\'s, so one edit moves it',
			JSON.stringify(mismatched.map((r) => ({ id: r.id, free: r.free, note: r.note }))));
		// The general sentence really is the shared opening every note begins with.
		const strays = seen.filter((r) => !/\S/.test(general) || r.note.indexOf(general) !== 0);
		check(strays.length === 0,
			'the sentence about vendors in general opens every engine note, so what follows '
			+ 'it is that engine\'s own claim',
			JSON.stringify({ general, strays: strays.map((r) => ({ id: r.id, note: r.note })) }));
		// Nothing says "free" about an engine whose allowance nobody wrote down.
		const freeWord = seen.filter((r) => r.free === 0 && r.id !== 'credits'
			&& claimsFree(r.note, general));
		check(freeWord.length === 0,
			'and no engine without a figure is called free on its own account',
			JSON.stringify(freeWord.map((r) => ({ id: r.id, tail: engineTail(r.note, general) }))));
	}
	await choose('exa');

	const before = (await calls()).length;
	const refused = await trySearch('anything at all');
	const after = (await calls()).length;
	check(!refused.ok, 'searching on an engine with no key is refused', JSON.stringify(refused.message));
	check(after === before,
		'and refused HERE — nothing reached the gateway to fail there',
		`${after - before} request(s) went out`);
	check(!refused.ok && refused.message === onExa.warn,
		'the refusal and the line on the row are the SAME sentence, so the fix is where the '
		+ 'complaint is', `${JSON.stringify(refused.message)} vs ${JSON.stringify(onExa.warn)}`);

	// And with a key it goes, naming the engine and carrying the key.
	await p.evaluate(async (k) => { await window.DaimondSearch.setKey('exa', k + '-exa'); }, SECRET);
	await p.waitForTimeout(300);
	const ran = await trySearch('kestrel', { kind: 'web', limit: 3 });
	const sent = (await calls()).slice(-1)[0];
	check(ran.ok, 'with a key, the search runs', JSON.stringify(ran.message || ''));
	check(!!sent && sent.engine === 'exa' && sent.key === SECRET + '-exa',
		'the request names the chosen engine and carries that engine\'s key',
		JSON.stringify(sent && { engine: sent.engine, key: !!sent.key }));
	check(!!sent && sent.query === 'kestrel',
		'and the query is what was asked for, not a URL built around it', JSON.stringify(sent && sent.query));
}

// ── 3. serper may never be bought with credits ──────────────────────
//
// §3: it resells Google, so its business is an arbitrage that can end without
// notice. A user taking that risk with their own key is their choice; Oxedyne
// billing for it is Oxedyne's risk.
{
	const set = (id) => p.evaluate((want) => {
		const sel = document.getElementById('set-search-engine');
		sel.value = want;
		sel.dispatchEvent(new Event('change', { bubbles: true }));
		const warn = document.getElementById('search-key-warn');
		return {
			chosen: window.DaimondSearch.engine(),
			byok:   window.DaimondSearch.byokOnly(want),
			warn:   (warn && warn.getClientRects().length) ? (warn.textContent || '').trim() : '',
		};
	}, id);

	const onSerper = await set('serper');
	check(onSerper.chosen === 'serper' && onSerper.byok,
		'serper is chooseable, and the module knows it is own-key-only');

	const before = (await calls()).length;
	const r = await trySearch('who resells this');
	const after = (await calls()).length;
	check(!r.ok, 'serper with no key is refused', JSON.stringify(r.message));
	check(after === before,
		'AND NOTHING WAS SENT — no request went out that the balance could have paid for',
		`${after - before} request(s) went out`);
	// The two refusals differ in what they OFFER, and that is the whole point:
	// an ordinary engine can be swapped for credits and this one cannot.
	const creditsWord = await p.evaluate(() => window.DaimondSearch.engineName('credits'));
	check(!r.ok && r.message.indexOf(creditsWord) === -1,
		'and the refusal does NOT offer to pay for it with credits, which every other '
		+ 'engine\'s refusal does', JSON.stringify(r.message));
	check(!r.ok && r.message === onSerper.warn,
		'the row says the same thing where the choice was made', JSON.stringify(onSerper.warn));

	// With a key it is an ordinary BYOK engine — the rule is about who PAYS, not
	// about whether the engine may be used at all.
	await p.evaluate(async (k) => { await window.DaimondSearch.setKey('serper', k + '-serper'); }, SECRET);
	await p.waitForTimeout(300);
	await trySearch('with my own key');
	const sent = (await calls()).slice(-1)[0];
	check(!!sent && sent.engine === 'serper' && !!sent.key,
		'with a key of their own it runs, as their own key', JSON.stringify(sent && sent.engine));

	// THE GENERAL PROPERTY, over every request this file has caused: a request
	// naming an own-key engine always carries a key, and one naming `credits`
	// never does. That is what "serper cannot reach the credits tier" means at
	// the wire, and it is checked over the whole log rather than the last row.
	const log = await calls();
	const byok = await p.evaluate(() => Object.keys(window.DaimondSearch.KNOWN)
		.filter((id) => window.DaimondSearch.byokOnly(id)));
	const paidByCredits = log.filter((c) => c && (!c.engine || c.engine === 'credits'));
	const bought = paidByCredits.filter((c) => byok.includes(c.engine));
	check(bought.length === 0,
		'no request in this whole run asked the balance to pay for an own-key-only engine',
		JSON.stringify(bought));
	const keyless = log.filter((c) => c && c.engine && c.engine !== 'credits' && !c.key);
	check(log.length > 0 && keyless.length === 0,
		'and every request naming an engine of the user\'s carried that user\'s key',
		JSON.stringify(keyless));
	check(paidByCredits.every((c) => !c.key),
		'while a credits request carries no key at all — the gateway holds that one',
		JSON.stringify(paidByCredits.filter((c) => c.key)));
}

// ── 4. `root/web` has a control, and it moves that leaf alone ───────
//
// The section this release exists for. Every judgement is a SET comparison, so
// "and only root/web" cannot be satisfied by a count that happens to match.
{
	// The Web panel forward, so the control is on screen and not merely in the
	// document — a control nobody can see is the fault being fixed.
	await p.evaluate(() => { try { DaimondPanels.show('web'); DaimondPanels.reflow(); } catch (e) { /* no panels */ } });
	await p.waitForTimeout(600);

	const placed = await p.evaluate(() => {
		const g = document.querySelector('#panel-web .chead .pptw[data-pause-node="root/web"]');
		if (!g) return null;
		const head = g.closest('.chead');
		const panel = document.getElementById('panel-web');
		const gr = g.getBoundingClientRect(), pr = panel.getBoundingClientRect();
		const verb = (act) => {
			const b = g.querySelector('.pptw-' + act);
			return b ? { tag: b.tagName.toLowerCase(), label: b.getAttribute('aria-label') || '',
				disabled: !!b.disabled } : null;
		};
		return {
			inHeader: !!head,
			visible:  g.getClientRects().length > 0,
			// Inside the panel it belongs to, at this width. The Web panel's header
			// has overflowed before — the closer once sat entirely outside the panel
			// it closes — so a new control in that row is measured, not assumed.
			inside:   gr.left >= pr.left - 1 && gr.right <= pr.right + 1,
			order:    [...g.children].map((e) => e.dataset.act || (e.classList.contains('pptw-lamp') ? 'lamp' : '?')),
			play:     verb('play'),
			pause:    verb('pause'),
			lampKids: (g.querySelector('.pptw-lamp') || { childElementCount: -1 }).childElementCount,
		};
	});

	check(!!placed, 'THE WEB PANEL HAS A PAUSE CONTROL, governing `root/web`');
	if (placed) {
		check(placed.inHeader && placed.visible, 'it is in the panel header, on screen',
			JSON.stringify({ inHeader: placed.inHeader, visible: placed.visible }));
		check(placed.inside, 'and inside the panel it belongs to, not pushed out of its own header');
		check(JSON.stringify(placed.order) === '["play","pause","lamp"]',
			'drawn as the one widget the rest of the app draws — play, pause, then the light',
			JSON.stringify(placed.order));
		check(placed.lampKids === 0, 'with nothing inside the light but its colour');
		check(!!placed.play && placed.play.tag === 'button' && /[\p{L}\p{N}]/u.test(placed.play.label),
			'the play verb is a real button with a name that can be read out',
			JSON.stringify(placed.play));
		check(!!placed.pause && /[\p{L}\p{N}]/u.test(placed.pause.label),
			'and so is pause', JSON.stringify(placed.pause));
	}

	/// Press a verb on the Web control the way a finger does, and report the
	/// paused set either side of it.
	const press = (act) => p.evaluate((a) => {
		const before = DaimondPause.pausedIds().slice().sort();
		const b = document.querySelector('#panel-web .pptw[data-pause-node="root/web"] .pptw-' + a);
		if (!b) return { before, after: before, pressed: false, wasDisabled: null };
		const wasDisabled = !!b.disabled;
		b.click();
		return { before, after: DaimondPause.pausedIds().slice().sort(), pressed: true, wasDisabled };
	}, act);

	// (a) From nothing paused: pause here pauses here, and nothing else.
	await p.evaluate(() => DaimondPause.set('root', true));
	await p.waitForTimeout(200);
	const one = await press('pause');
	check(one.pressed && sameSet(one.before, []),
		'nothing is paused at the start of this check', JSON.stringify(one.before));
	check(sameSet(one.after, ['root/web']),
		'pressing pause on it pauses `root/web`, and pauses nothing else',
		JSON.stringify(one.after));

	const back = await press('play');
	check(sameSet(back.after, []), 'and play puts it back', JSON.stringify(back.after));

	// (b) THE CASE THAT WENT WRONG. Everything paused — which is where the user
	// was — and play on this one leaf must release this one leaf. Nothing else
	// may move: `root/diamonds/<optimiser>/…` is paused ON PURPOSE, and a control
	// that resumed it while letting the web out would be the bug in the other
	// direction.
	await p.evaluate(() => DaimondPause.set('root', false));
	await p.waitForTimeout(200);
	const all = await p.evaluate(() => DaimondPause.pausedIds().slice().sort());
	check(all.length > 1 && all.includes('root/web'),
		'with Everything paused, the tree holds more than the web leaf — so "only" means something',
		JSON.stringify(all));

	const freed = await press('play');
	check(!freed.wasDisabled, 'the play verb is live while the leaf is held');
	check(!freed.after.includes('root/web'),
		'PLAY ON THE WEB CONTROL RESUMES `root/web` FROM A FULLY PAUSED TREE — which is the '
		+ 'thing that had no button this morning');
	check(sameSet(minus(all, ['root/web']), freed.after),
		'AND TOUCHES NO OTHER LEAF — everything else the user had paused is still paused',
		`moved: ${JSON.stringify(minus(all, freed.after).filter((x) => x !== 'root/web'))}, `
		+ `gained: ${JSON.stringify(minus(freed.after, all))}`);

	// And the reverse, from the same state: pausing it again restores exactly
	// what was there, so the control is symmetrical rather than merely a release.
	const held = await press('pause');
	check(sameSet(held.after, all),
		'pausing it again leaves the tree exactly as it was', JSON.stringify(minus(held.after, all)));

	// (c) THE REFUSAL NAMES A CONTROL THAT EXISTS. This is the whole complaint,
	// stated as a property rather than as a string: whatever the sentence says,
	// the node it blames must have a live play verb somewhere a person can reach.
	//
	// Checked this way ON PURPOSE. The English of `pause.refused.web` lives in
	// `www/i18n/*.js`, which is another lane's file, so a check that matched its
	// wording would be measuring that lane's timing. What must hold either side
	// of it is that the node named has a control.
	const refusal = await trySearch('while it is held');
	check(!refusal.ok && !!refusal.node,
		'a search while the leaf is held is refused, and the refusal names the node',
		JSON.stringify(refusal));
	const reachable = await p.evaluate((node) => {
		const b = document.querySelector(`.pptw[data-pause-node="${node}"] .pptw-play`);
		if (!b) return { found: false };
		return { found: true, disabled: !!b.disabled, visible: b.getClientRects().length > 0 };
	}, refusal.node || 'root/web');
	check(reachable.found && reachable.visible && !reachable.disabled,
		'and there is a live play verb on screen for exactly that node — the refusal points at '
		+ 'something', JSON.stringify(reachable));

	await p.evaluate(() => DaimondPause.set('root', true));
	await p.waitForTimeout(200);
}

// ── 5. The query is shown before it leaves ──────────────────────────
//
// §7 says a search goes out through `egress_check_detail` WITH THE QUERY as the
// detail, "exactly as `web_type` shows the text it is about to send". It was not
// happening. The wasm names `/api/web/search` — it has to, because it cannot
// know which engine the setting will reach — and that URL is same-origin, so the
// gate's shortcut for Daimond's own pages waved every search straight through
// and the user was asked nothing at all.
//
// The gate is called BY NAME here, the same way the wasm calls it, so what is
// under test is the door rather than the tool that knocks on it.
{
	const Q = 'peregrine stoop speed, measured rather than claimed';

	/// Put a search to the gate and leave the verdict outstanding.
	const ask = (q) => p.evaluate((query) => {
		window.__settled = 'PENDING';
		window.__daimondEgressAllowed(JSON.stringify({
			tool: 'web_search', url: '/api/web/search', detail: query,
		})).then((v) => { window.__settled = v; });
	}, q);
	const dialogNow = () => p.evaluate(() => {
		const d = document.querySelector('.modal.dlg .dlg-card');
		return {
			shown:   !!d,
			settled: window.__settled,
			title:   d ? ((d.querySelector('h2') || {}).textContent || '') : '',
			body:    d ? ((d.querySelector('.dlg-msg') || {}).textContent || '') : '',
			ok:      d ? ((d.querySelector('.dlg-ok') || {}).textContent || '') : '',
			hasNo:   !!(d && d.querySelector('.dlg-cancel')),
		};
	});

	await ask(Q);
	await p.waitForTimeout(400);
	const d1 = await dialogNow();
	check(d1.shown, 'A SEARCH ASKS BEFORE IT GOES — the gate is not waved through as same-origin');
	check(d1.settled === 'PENDING',
		'and it is still waiting on the answer rather than already allowed',
		JSON.stringify(d1.settled));
	check(d1.body.indexOf(Q) !== -1,
		'THE DIALOG SHOWS THE QUERY — the thing that actually leaves the device',
		JSON.stringify(d1.body.slice(0, 120)));
	check((d1.body + d1.title).indexOf('/api/web/search') === -1
		&& !/%[0-9A-Fa-f]{2}/.test(d1.body + d1.title),
		'and NOT the gateway path the wasm had to name, nor a percent-encoded URL — which is '
		+ 'what made this morning\'s prompt unreadable');
	const engNow = await p.evaluate(() =>
		window.DaimondSearch.engineName(window.DaimondSearch.engine()));
	check(d1.body.indexOf(engNow) !== -1,
		'it names the engine the SETTING will reach, not one the model picked',
		`${JSON.stringify(engNow)} in ${JSON.stringify(d1.body.slice(-160))}`);
	check(d1.hasNo && /\S/.test(d1.ok),
		'and it offers both answers, each with words on it', JSON.stringify(d1.ok));

	// PRESSED IF IT IS THERE. The dialog is the thing under test, so it is absent
	// exactly when this section is failing -- and a bare `.click()` on the missing
	// card threw, which took the whole run down at the point it had most to say.
	// `--unbuilt` could not finish for that reason and reported nothing.
	await p.evaluate(() => { const b = document.querySelector('.modal.dlg .dlg-cancel'); if (b) b.click(); });
	await p.waitForTimeout(300);
	check(await p.evaluate(() => window.__settled) === 'deny',
		'declining refuses the search');

	// NEVER REMEMBERED. `web_type` is not remembered because the text is the
	// payload; a query is the same kind of thing, and a yes to one search is not
	// a yes to the next. Allowed once, then asked again.
	await ask(Q);
	await p.waitForTimeout(400);
	check((await dialogNow()).shown, 'a second search asks again rather than riding the first yes');
	await p.evaluate(() => { const b = document.querySelector('.modal.dlg .dlg-ok'); if (b) b.click(); });
	await p.waitForTimeout(300);
	check(await p.evaluate(() => window.__settled) === 'allow', 'and allowing lets it through');

	await ask('a third, quite different question');
	await p.waitForTimeout(400);
	const d3 = await dialogNow();
	check(d3.shown, 'and the one after THAT asks too — consent is per search, not per host');
	check(d3.body.indexOf('a third, quite different question') !== -1,
		'showing the new query and not the one already answered for');
	await p.evaluate(() => { const b = document.querySelector('.modal.dlg .dlg-cancel'); if (b) b.click(); });
	await p.waitForTimeout(300);

	// An empty query is nothing to authorise and nothing to show, so it is refused
	// without a dialog rather than putting an empty box in front of somebody.
	await ask('   ');
	await p.waitForTimeout(400);
	const d4 = await dialogNow();
	check(!d4.shown && d4.settled === 'deny',
		'an empty query is refused outright, with no empty dialog to answer',
		JSON.stringify(d4.settled));
}

// ── 6. The spend guard knows the search route ───────────────────────
//
// `search.js` checks the pause itself, which is the right instinct and is what
// section 4 exercised. This is the OTHER hold: `gateway.js` wraps `window.fetch`
// so a caller that does not ask is refused anyway. `/api/web/search` matched no
// arm of `spendRefusal` at all, so it fell out of the bottom governed by
// nothing — not the Web leaf, not a Diamond's node, and not the global control.
// Two independent holds is correct: `search.js` is the only caller today, and a
// second one arriving later would otherwise be ungoverned with nothing red.
{
	/// Past the stub, through the app's own guarded fetch.
	const call = () => p.evaluate(async () => {
		try {
			const r = await window.__realFetch('/api/web/search', {
				method:  'POST',
				headers: { 'content-type': 'application/json' },
				body:    JSON.stringify({ query: 'while it is held' }),
			});
			let j = null;
			try { j = await r.json(); } catch (e) { j = null; }
			return { status: r.status, j };
		} catch (e) {
			// No gateway in this world, so an unrefused call fails at the network.
			// That is not a 423, which is the whole distinction being drawn.
			return { status: 0, j: null, err: String(e && e.message || e) };
		}
	});

	await p.evaluate(() => { DaimondPause.set('root', true); DaimondPause.set('root/web', false); });
	await p.waitForTimeout(200);
	const onLeaf = await call();
	check(onLeaf.status === 423 && !!onLeaf.j && onLeaf.j.paused === true,
		'a search is refused by the spend guard while `root/web` is held',
		JSON.stringify(onLeaf));
	check(!!onLeaf.j && onLeaf.j.node === 'root/web',
		'and the refusal names the leaf, so a caller can point at its control',
		JSON.stringify(onLeaf.j && onLeaf.j.node));

	// THE CASE THE USER WAS ACTUALLY IN. They paused Everything to stop outbound
	// requests. A search that ignored the root would have gone on spending.
	await p.evaluate(() => { DaimondPause.set('root', true); DaimondPause.set('root', false); });
	await p.waitForTimeout(200);
	const onRoot = await call();
	check(onRoot.status === 423 && !!onRoot.j && onRoot.j.paused === true,
		'AND REFUSED WITH EVERYTHING PAUSED — which is what the user did this morning',
		JSON.stringify(onRoot));

	await p.evaluate(() => DaimondPause.set('root', true));
	await p.waitForTimeout(200);
	const free = await call();
	check(free.status !== 423,
		'and with nothing held the guard lets go — it holds a search, it does not block one',
		JSON.stringify({ status: free.status, err: free.err }));
}

// ── Self-tests: each property shown going red ───────────────────────
out.push('');
out.push('--- self-test: breaking each property in the live page');

// (a) A control that kept its markup and lost its listener still LOOKS operable.
{
	const r = await p.evaluate(() => {
		DaimondPause.set('root', false);
		const g = document.querySelector('#panel-web .pptw[data-pause-node="root/web"]');
		if (!g) return null;
		const twin = g.cloneNode(true);
		g.parentNode.replaceChild(twin, g);
		const before = DaimondPause.pausedIds().slice().sort();
		twin.querySelector('.pptw-play').click();
		const after = DaimondPause.pausedIds().slice().sort();
		twin.parentNode.replaceChild(g, twin);
		return { before, after };
	});
	red(!!r && sameSet(r.before, r.after),
		'a web control that lost its listener releases nothing, and the set comparison sees it');
	await p.evaluate(() => window.dispatchEvent(new CustomEvent('daimond:pause')));
}

// (b) A control wired to the ROOT instead of its leaf — which is exactly what
// "just resume everything" was, drawn as a button. The set difference is what
// catches it; a check that only asked "is the web running again" would pass.
{
	const r = await p.evaluate(() => {
		DaimondPause.set('root', false);
		const all = DaimondPause.pausedIds().slice().sort();
		DaimondPause.set('root', true);				// a play verb wired to the root
		return { all, after: DaimondPause.pausedIds().slice().sort() };
	});
	red(!!r && r.all.length > 1 && r.after.length === 0,
		'a play verb wired to the root resumes everything, and "touches no other leaf" fails');
	await p.evaluate(() => DaimondPause.set('root', true));
}

// (c) The key written in the clear. Planted directly in storage, so the scan is
// shown finding a secret it would otherwise be asserting the absence of.
{
	const r = await p.evaluate((k) => {
		let name = null;
		for (let i = 0; i < localStorage.length; i++) {
			const n = localStorage.key(i);
			try {
				const j = JSON.parse(localStorage.getItem(n) || 'null');
				if (j && j.v === 1 && j.keys) { name = n; break; }
			} catch (e) { /* not the store */ }
		}
		if (!name) return null;
		const kept = localStorage.getItem(name);
		const j = JSON.parse(kept);
		j.keys.brave = { key: k, keyEnc: j.keys.brave ? j.keys.brave.keyEnc : '' };
		localStorage.setItem(name, JSON.stringify(j));
		let seen = 0;
		for (let i = 0; i < localStorage.length; i++) {
			if ((localStorage.getItem(localStorage.key(i)) || '').indexOf(k) !== -1) seen++;
		}
		localStorage.setItem(name, kept);			// put it back
		return { seen };
	}, SECRET);
	red(!!r && r.seen > 0, 'a key written in the clear IS found by the storage scan');
}

// (d) serper on the balance. The general property is re-run over a log with one
// forged row in it, so the check is shown catching the shape it exists for.
{
	const forged = (await calls()).concat([{ engine: 'serper', query: 'x' }]);
	const byok = await p.evaluate(() => Object.keys(window.DaimondSearch.KNOWN)
		.filter((id) => window.DaimondSearch.byokOnly(id)));
	const keyless = forged.filter((c) => c && c.engine && c.engine !== 'credits' && !c.key);
	red(byok.includes('serper') && keyless.length > 0,
		'a serper request with no key of its own is caught by the whole-log rule');
}

// (e) The egress gate answering without asking — the state it was in. Shown by
// putting a same-origin request through the door WITHOUT the `web_search` tool
// name, which is the arm that was missing: it takes the shortcut and allows.
{
	const v = await p.evaluate(() => window.__daimondEgressAllowed(JSON.stringify({
		url: '/api/web/search?q=a+question+nobody+saw',
	})));
	red(v === 'allow',
		'a search wearing no tool name is still waved through as same-origin — which is '
		+ 'precisely why the arm has to be keyed on the tool and sit above that shortcut');
}

// (f) The spend guard with the route removed. The path is edited to one it does
// not know, so the guard is shown answering nothing for a route it has not been
// told about — the shape of the gap this release closed.
{
	const r = await p.evaluate(async () => {
		DaimondPause.set('root', false);				// everything held
		try {
			const res = await window.__realFetch('/api/web/searchXX', {
				method: 'POST', headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ query: 'x' }),
			});
			return { status: res.status };
		} catch (e) { return { status: 0 }; }
	});
	red(r.status !== 423,
		'an unknown web route is refused by nothing even with Everything paused, so the '
		+ 'guard really is matching on the path and not on a prefix');
	await p.evaluate(() => DaimondPause.set('root', true));
}

// (g) A free tier claimed for an engine nobody wrote a figure for — the shape
// §9 forbids, and the one this rule exists to catch. The sentence is planted on
// the live note for an engine whose registry entry has no figure, then the same
// `claimsFree` the check above runs is run over it. The general sentence stays
// where it is, so this also shows that the rule is reading the per-engine tail
// and not merely finding the word "free" somewhere in the paragraph.
{
	const r = await p.evaluate(() => {
		const sel = document.getElementById('set-search-engine');
		const el = document.getElementById('search-engine-note');
		if (!sel || !el) return null;
		const bare = Object.keys(window.DaimondSearch.KNOWN).find((id) =>
			id !== window.DaimondSearch.CREDITS && !(window.DaimondSearch.KNOWN[id] || {}).free);
		if (!bare) return null;
		sel.value = bare;
		sel.dispatchEvent(new Event('change', { bubbles: true }));
		const general = (window.DaimondI18n && window.DaimondI18n.t('search.engine_note')) || '';
		const honest = (el.textContent || '').trim();
		el.appendChild(document.createTextNode(' It is free to use.'));
		const forged = (el.textContent || '').trim();
		sel.dispatchEvent(new Event('change', { bubbles: true }));	// painted back
		return { id: bare, general, honest, forged };
	});
	red(!!r && !claimsFree(r.honest, r.general) && claimsFree(r.forged, r.general),
		'an engine with no figure that is told it is free IS caught, while the general '
		+ 'sentence about vendors in the same paragraph is not mistaken for one');
}

// (h) THE PAUSE VERB, AND WHAT KEEPS IT ALIVE. §4 above presses pause on the Web
// control and watches `root/web` go into the paused set. That only works because
// the leaf is marked `stoppable` in `pauseTree`, and nothing but a comment said
// so until this ran: on 2026-08-28 the light started counting ARMED leaves, and
// `root/web` arms nothing — a page is fetched because a turn asked for one — so
// its control read `idle`, which greys the pause verb. The leaf could be released
// from its own control and never held from it, for a day, with the light saying
// nothing was wrong because the light was not what broke.
//
// The mark is taken off HERE, in the live page, by hiding it from the one reader
// — `paintPause` asks `DaimondPause._core.findNode` — and the verb must die with
// it. Then it is put back, so this proves the mark and not the patch.
{
	const r = await p.evaluate(async () => {
		try { DaimondPanels.show('web'); DaimondPanels.reflow(); } catch (e) { /* no panels */ }
		const core = DaimondPause._core, real = core.findNode;
		const verb = () => {
			const b = document.querySelector('#panel-web .pptw[data-pause-node="root/web"] .pptw-pause');
			return b ? { there: true, disabled: !!b.disabled, press: () => b.click() } : { there: false };
		};
		// A repaint without a change of state: set() announces only when the set
		// really moves, so the leaf is held and released to bring the paint round.
		const repaint = () => { DaimondPause.set('root/web', false); DaimondPause.set('root/web', true); };
		DaimondPause.set('root', true);
		const live = verb().disabled;
		core.findNode = function (tree, id) {
			const n = real(tree, id);
			if (!n || id !== 'root/web') return n;
			const copy = {}; for (const k in n) if (k !== 'stoppable') copy[k] = n[k];
			return copy;
		};
		repaint();
		const dead = verb();
		if (dead.press) dead.press();		// absent under --unbuilt, where nothing is mounted
		const after = DaimondPause.pausedIds().slice();
		core.findNode = real;
		repaint();
		const back = verb().disabled;
		return { there: dead.there, live, dead: dead.disabled, after, back };
	});
	red(!!r && r.there && r.live === false && r.dead === true && r.after.length === 0 && r.back === false,
		'a `root/web` that is no longer marked stoppable loses its pause verb, and pressing '
		+ 'it holds nothing — which is what §4 above is standing on');
}

await s.close();

console.log(out.join('\n'));
const total = out.filter((l) => /^(PASS|FAIL)/.test(l)).length;
if (UNBUILT) {
	console.log(`\nUNBUILT RUN: ${bad} of ${total} checks failed. `
		+ (bad > 0 ? 'Good — the checks see what is missing.'
			: 'BAD — a check that cannot fail is not evidence.'));
	process.exit(bad > 0 ? 0 : 1);
}
console.log(bad === 0 ? `\nALL ${total} CHECKS PASSED` : `\n${bad} of ${total} FAILED`);
process.exit(bad === 0 ? 0 : 1);

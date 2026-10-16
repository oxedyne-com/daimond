// gateway: live
// verify_handoff_effort.mjs — a handed-off turn runs at the Effort it was sent with (D-20261014-08).
//
// The composer row's Effort step sets the chat's level, and the turn carries it: a phone
// that hands its turn to the nominated desktop sends the level in the errand, and the
// desktop runs the turn at that level, not at its own copy of the chat's.
//
// THE PROPERTIES:
//
//   (1) A (a phone) steps Effort down once on mock/thinker, from Medium (its default) to Low.
//   (2) A's send is handed to B (a dispatched placeholder on A).
//   (3) The model saw that prompt exactly once, with `reasoning.effort` "low".
//   (4) Two steps up, to High, is what the next handed-off turn carries.
//   (5) On a Diamond's face the step is the Diamond's own Effort, and a turn sent there and
//       handed to B carries it: B runs it at that level, and A's record of it says so
//       (check_final F1). Needs OPFS (a Diamond's workspace): skipped where the engine lacks it.
//   (6) The record syncs on its own stamps, not the Diamond's (check_f1 B1). B changes the
//       Diamond's crystal and its model while A is offline; A, not yet holding either,
//       steps the Diamond's Effort up. Once both have synced, both hold B's crystal, B's
//       model and A's level. Fails where the press touches the Diamond: A's copy wins and B's
//       crystal and model go back.
//
// (4) is the arm that bites: with the runner's forward of the errand's `effort` removed,
// (3) still passes on the chat's synced level, but B runs (4) at the stale "low"
// (checked 15 Oct 2026).
//
// Needs the dev stack: app (DAIMOND_PORT), mock (DAIMOND_MOCK_PORT), gateway
// (DAIMOND_GW_PORT). Pro-gated via pro.mjs.
//   node dev/verify_handoff_effort.mjs

import {
	checker,
	pair,
	storedMsgs,
	placeholders,
	send,
	freshChat,
	settle,
	switchOn,
	untilScreen,
} from './handoffpair.mjs';
import { connectMock, mockLog } from './harness.mjs';
import { guardRan } from './verdict.mjs';

const MODEL     = 'mock/thinker';	// the mock's model with reasoning levels
const SEEN_MS   = 60000;			// the bound on a handed-off turn reaching the model
const { ok, bad, check } = checker();

/// The `reasoning` of every model request that carries `text`.
const reasoningFor = (text) => mockLog().filter((r) => JSON.stringify(r).includes(text))
	.map((r) => r.reasoning || null);

/// Point a device at the thinking model, and fetch its levels as the app does.
async function thinker(s) {
	await connectMock(s, { model: MODEL });
	await s.page.evaluate(async () => {
		const j = JSON.parse(localStorage.getItem('daimond-models-v2') || '{}');
		await window.DaimondModels.fetchModels((j.def || {}).provider);
	});
}

const step = async (page, sel) => {
	await page.click(sel);
	await page.waitForTimeout(150);
};

/// Send `prompt` from A, and wait for the model to see it; answers A's placeholder for it.
async function handOff(a, prompt) {
	await send(a.page, prompt);
	let ph = null;
	for (let i = 0; i < 120 && !ph; i++) {
		ph = placeholders(await storedMsgs(a)).find((m) => String(m.itext || '').includes(prompt)) || null;
		if (!ph) await a.page.waitForTimeout(250);
	}
	for (const t0 = Date.now(); !reasoningFor(prompt).length && Date.now() - t0 < SEEN_MS; ) {
		await a.page.waitForTimeout(250);
	}
	return ph;
}

let a, b;
try {
	({ a, b } = await pair(check, 'efflead', 'effmate'));
	for (const s of [a, b]) await thinker(s);
	await freshChat(a);
	await a.page.setViewportSize({ width: 420, height: 860 });
	await a.page.waitForTimeout(300);
	const tag = Math.random().toString(36).slice(2, 8);

	// ── (1) Effort stepped on the phone ───────────────────────
	console.log('\n(1) A steps Effort down on ' + MODEL);
	const v0 = await a.page.evaluate(() => document.getElementById('effort-val').textContent);
	await step(a.page, '#effort-dn');
	const v1 = await a.page.evaluate(() => document.getElementById('effort-val').textContent);
	check('(1) the step reads Medium (the default), then Low', v0 === 'Medium' && v1 === 'Low', v0 + ' -> ' + v1);

	// ── (2)/(3) The handed-off turn carries it ─────────────────
	console.log('\n(2) A hands the turn to B');
	// As a person would: send once the switch offers the runner. A runner that has just
	// joined is not offered until its first listening beat reaches the phone, and a turn
	// sent before then runs here.
	const onRunner = await untilScreen(a, async () => (await switchOn(a.page)) === 'runner', 30000);
	check('(2) the switch offers B before the first send', onRunner, 'switch reads ' + (await switchOn(a.page) || 'nothing'));
	const p1 = 'effort low handed ' + tag;
	const ph1 = await handOff(a, p1);
	check('(2) A handed the turn off', !!ph1, ph1 ? String(ph1.iturn) : 'no dispatched placeholder');
	const r1 = reasoningFor(p1);
	check('(3) the model saw it once, at reasoning.effort "low"',
		r1.length === 1 && r1[0] && r1[0].effort === 'low', JSON.stringify(r1));
	await settle(a.page);

	// ── (4) The next level travels too ─────────────────────────
	console.log('\n(4) A steps to High and hands another turn');
	await step(a.page, '#effort-up');
	await step(a.page, '#effort-up');
	const v2 = await a.page.evaluate(() => document.getElementById('effort-val').textContent);
	const p2 = 'effort high handed ' + tag;
	const ph2 = await handOff(a, p2);
	const r2 = reasoningFor(p2);
	check('(4) handed off at High, the model saw reasoning.effort "high"',
		v2 === 'High' && !!ph2 && r2.length === 1 && r2[0] && r2[0].effort === 'high',
		v2 + ' ' + (ph2 ? 'handed' : 'not handed') + ' ' + JSON.stringify(r2));
	await settle(a.page);

	// ── (5) A Diamond's face hands off at the Diamond's Effort ──
	const hasOpfs = await a.page.evaluate(() => { try { return !!(navigator.storage && navigator.storage.getDirectory); } catch (e) { return false; } });
	if (hasOpfs) {
		console.log('\n(5) A steps the Diamond\'s Effort on its face and hands a turn off');
		const idB = await b.page.evaluate(() => window.DaimondIdentity.deviceId());
		await a.page.setViewportSize({ width: 1280, height: 900 });
		await a.page.waitForTimeout(300);
		await a.page.evaluate(() => document.getElementById('new-diamond-btn').click());
		await a.page.waitForSelector('.dlg-card', { timeout: 8000 }).catch(() => {});
		await a.page.evaluate(() => {
			const card = [...document.querySelectorAll('.dlg-card')].filter((c) => c.getClientRects().length).pop();
			const inp = card.querySelector('input.dlg-input');
			inp.value = 'EffortFace';
			inp.dispatchEvent(new Event('input', { bubbles: true }));
			card.querySelector('.dlg-ok').click();
		});
		let dia = '';
		for (let i = 0; i < 30 && !dia; i++) {
			dia = await a.page.evaluate(() => { const c = window.DaimondDiamond.current(); return c ? c.id : ''; });
			if (!dia) await a.page.waitForTimeout(300);
		}
		check('(5) a Diamond is current on A', !!dia, dia);
		await a.page.$('#dview-chat').then((el) => el && el.click({ force: true })).catch(() => {});
		await a.page.waitForTimeout(400);
		// B holds the Diamond before the turn is handed to it, as a runner of a Diamond does.
		await a.page.evaluate(() => window.DaimondSync.push && window.DaimondSync.push()).catch(() => {});
		const bHas = await untilScreen(a, async () => {
			await b.page.evaluate(() => window.DaimondSync.pull && window.DaimondSync.pull(true)).catch(() => {});
			return b.page.evaluate((d) => { try { return !!window.DaimondDiamond.conversation(d); } catch (e) { return false; } }, dia);
		}, 30000);
		check('(5) the Diamond reached B', bHas);
		await a.page.setViewportSize({ width: 420, height: 860 });
		await a.page.waitForTimeout(300);
		const d0 = await a.page.evaluate(() => document.getElementById('effort-val').textContent);
		await step(a.page, '#effort-dn');
		const d1 = await a.page.evaluate(() => document.getElementById('effort-val').textContent);
		check('(5) the Diamond\'s step reads Medium, then Low', d0 === 'Medium' && d1 === 'Low', d0 + ' -> ' + d1);
		const onR = await untilScreen(a, async () => (await switchOn(a.page)) === 'runner', 30000);
		check('(5) the switch offers B on the Diamond\'s face', onR, 'switch reads ' + (await switchOn(a.page) || 'nothing'));
		const p3 = 'effort low diamond ' + tag;
		await send(a.page, p3);
		for (const t0 = Date.now(); !reasoningFor(p3).length && Date.now() - t0 < SEEN_MS; ) {
			await a.page.waitForTimeout(250);
		}
		const r3 = reasoningFor(p3);
		const said = async (s) => s.page.evaluate(([d, p]) => {
			const c = window.DaimondDiamond.conversation(d);
			const ms = (c && c.messages) || [];
			const u = ms.find((m) => m && m.role === 'user' && String(m.content || '').includes(p)) || null;
			const id = u ? String(u.iturn || u.mid || '') : '';
			const ans = ms.find((m) => m && m.role === 'assistant' && id && String(m.iturn || '') === id && m.why !== 'dispatched') || null;
			return { effort: u ? (u.effort === undefined ? null : u.effort) : 'no record', ranOn: ans ? String(ans.ranOn || '') : '' };
		}, [dia, p3]).catch((e) => ({ err: String(e) }));
		let rec = await said(a);
		for (const t0 = Date.now(); !rec.ranOn && Date.now() - t0 < 30000; ) {
			await a.page.waitForTimeout(500);
			rec = await said(a);
		}
		check('(5) A\'s record of the Diamond turn says "low"', rec.effort === 'low', JSON.stringify(rec));
		check('(5) B ran it, and the model saw it once at reasoning.effort "low"',
			rec.ranOn === idB && r3.length === 1 && r3[0] && r3[0].effort === 'low',
			'ranOn=' + (rec.ranOn === idB ? 'B' : (rec.ranOn || '?').slice(0, 8)) + ' ' + JSON.stringify(r3));
		if (!(r3.length === 1 && r3[0] && r3[0].effort === 'low')) {
			console.log('  .. mock saw ' + JSON.stringify(mockLog().filter((r) => JSON.stringify(r).includes(p3)).map((r) => ({ model: r.model, reasoning: r.reasoning, keys: Object.keys(r) }))));
			console.log('  .. B holds ' + JSON.stringify(await b.page.evaluate((d) => {
				const all = JSON.parse(localStorage.getItem('daimond-diamond-models') || '{}');
				const def = window.DaimondModels.getDefault();
				let f = null; try { f = window.DaimondModels.effortsFor(def.provider, def.model); } catch (e) { f = String(e); }
				return { rec: all[d] || null, def, f };
			}, dia)));
		}

		// ── (6) A press does not outrank B's crystal or model change ──
		console.log('\n(6) B changes the crystal and the model; A, offline, steps the Effort up');
		await settle(a.page);
		const round = async () => {
			for (const s of [a, b]) await s.page.evaluate(() => window.DaimondSync.push && window.DaimondSync.push()).catch(() => {});
			for (const s of [a, b]) await s.page.evaluate(() => window.DaimondSync.pull && window.DaimondSync.pull(true)).catch(() => {});
		};
		const recOf = (s) => s.page.evaluate((d) => {
			const r = (JSON.parse(localStorage.getItem('daimond-diamond-models') || '{}'))[d] || {};
			return { model: r.model || '', effort: r.effort || '' };
		}, dia);
		const crystalOf = (s) => s.page.evaluate(async (d) => {
			if (!window.__hm) {
				const m = await import('/pkg/oxedyne_daimond.js');
				window.__hm = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
			}
			try { return await window.__hm.read_crystal_data(d); } catch (e) { return 'unread: ' + e; }
		}, dia);
		// Both hold one copy, and the record, before the race.
		const even = await untilScreen(a, async () => {
			await round();
			const [ca, cb, ra, rb] = [await crystalOf(a), await crystalOf(b), await recOf(a), await recOf(b)];
			return ca === cb && JSON.stringify(ra) === JSON.stringify(rb);
		}, 30000);
		check('(6) A and B agree before the race', even, JSON.stringify([await recOf(a), await recOf(b)]));
		const other = await b.page.evaluate(() => {
			const cur = window.DaimondModels.getDefault();
			return ['mock/eyes'].find((m) => m !== cur.model && window.DaimondModels.resolve(cur.provider, m)) || '';
		});
		await a.page.context().setOffline(true);
		const mark = 'argonaut wrote this ' + tag;
		const want = await b.page.evaluate(async ([d, mk, mo]) => {
			const cur = JSON.parse(await window.__hm.read_crystal_data(d) || '{}');
			const next = JSON.stringify(Object.assign({}, cur, { note6: mk }), null, 2);
			await window.__hm.write_crystal_data(d, next);
			const def = window.DaimondModels.getDefault();
			await window.DaimondDiamond.changeModel(d, { provider: def.provider, model: mo });
			return window.__hm.read_crystal_data(d);
		}, [dia, mark, other]);
		await b.page.evaluate(() => window.DaimondSync.push && window.DaimondSync.push()).catch(() => {});
		await a.page.waitForTimeout(1200);
		const e0 = await a.page.evaluate(() => document.getElementById('effort-val').textContent);
		await step(a.page, '#effort-up');
		await step(a.page, '#effort-up');
		const e1 = await a.page.evaluate(() => document.getElementById('effort-val').textContent);
		check('(6) A steps Low to High offline', e0 === 'Low' && e1 === 'High', e0 + ' -> ' + e1);
		await a.page.waitForTimeout(1200);
		await a.page.context().setOffline(false);
		let got = null;
		const settled = await untilScreen(a, async () => {
			await round();
			got = { a: await crystalOf(a), b: await crystalOf(b), ra: await recOf(a), rb: await recOf(b) };
			return got.a === want && got.b === want && got.ra.model === other && got.rb.model === other
				&& got.ra.effort === 'high' && got.rb.effort === 'high';
		}, 45000, 1500);
		check('(6) B keeps its own crystal at the head', got && got.b === want, got && String(got.b).slice(0, 120));
		check('(6) A takes B\'s crystal', got && got.a === want, got && String(got.a).slice(0, 120));
		check('(6) both hold B\'s model "' + other + '" and A\'s level "high"', settled,
			got && JSON.stringify({ a: got.ra, b: got.rb }));
	} else console.log('\n(5) SKIPPED: no OPFS here, so no Diamond (run it under chromium)');
} catch (e) {
	check('the run completed', false, String(e && e.stack || e).slice(0, 400));
} finally {
	try { await a?.close(); } catch (e) { /* gone */ }
	try { await b?.close(); } catch (e) { /* gone */ }
}

guardRan(ok.length + bad.length);
console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);

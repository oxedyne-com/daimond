// verify_effort.mjs — a chat's Effort, drawn from its model's own levels (U-D #9,
// D-20261006-04/-05).
//
// The provider's `/models` reply names the reasoning levels a model takes
// (`reasoning.supported_efforts`). Since D-20261014-08 a chat's Effort is the composer
// row's step (− level +), beside the seat switch, and no longer a row in the chat's
// cog. It is drawn only when the model lists levels, the level chosen reaches the
// provider as `reasoning.effort` on the next turn and is kept on that turn's prompt,
// and a model change to one without that level clears it with a quiet note. The mock
// lists levels for mock/thinker and none for mock/fast, and logs the `reasoning` each
// request carried.
//
//   1. On mock/thinker the composer's step reads Medium, the model's own default, in muted
//      ink and naming it so; it steps over low, medium, high, and the chat cog has no Effort row.
//   2. Unset, the turn carries no `reasoning`.
//   3. Stepped to low, the next turn carries "low"; stepped to high, the turn after
//      carries "high": turn by turn, each prompt's record keeping its own.
//   3b. A press while a turn runs is the NEXT turn's (F3): that turn's every request keeps
//      its level, and the one after carries the new one.
//   4. A change to mock/fast clears it, says so, hides the step, and the turn sends nothing.
//   5. On a Diamond's face the step is the Diamond's own Effort (F2): its cog has no Effort
//      row, the step sets the Diamond's record, and the daimon's turn carries the level.
//   6. Effort on a Diamond that follows the default pins no model: the record holds the
//      level and the model it was set for, a default change is followed, a level the new
//      default offers (low, on mock/eyes) is kept and one it lacks (medium) is dropped.
//
//   eval "$(bash dev/world.sh 89 --env)"; node dev/verify_effort.mjs
import { open, scratch, connectMock, chat, steerDiamond, storedChats, mockLog, clearMockLog, checker } from './harness.mjs';
import { guardRan } from './verdict.mjs';

const { ok, bad, check: named } = checker();
const check = (pass, name, detail) => named(name, pass, detail);

async function openCog(page, listSel) {
	const hit = await page.evaluate((sel) => {
		document.querySelectorAll('.tile-dlg-card').forEach((c) => {
			const x = c.closest('dialog') || c.parentNode; if (x && x.close) x.close();
		});
		const box = document.querySelector(sel + ' .session-box');
		if (!box) return 'no tile';
		const cog = box.querySelector('.tile-cog');
		if (!cog) return 'no cog';
		cog.click();
		return 'ok';
	}, listSel);
	if (hit !== 'ok') throw new Error(hit);
	await page.waitForSelector('.tile-dlg-card', { timeout: 8000 });
	await page.waitForTimeout(300);
}
const closeCog = (page) => page.keyboard.press('Escape').then(() => page.waitForTimeout(300));

/// The Effort row in the open dialog: whether it is drawn, and its options.
const effortRow = (page) => page.evaluate(() => {
	const r = document.querySelector('.tile-dlg-card .tile-dlg-effort');
	if (!r) return { drawn: false, shown: false, opts: [] };
	const sel = r.querySelector('select');
	return { drawn: true, shown: !r.hidden && r.offsetParent !== null,
		opts: sel ? [...sel.options].map((o) => o.value) : [], value: sel ? sel.value : null,
		first: sel && sel.options[0] ? sel.options[0].textContent : '' };
});

/// The composer's Effort step: whether it is shown, its level's words and title, and its ends.
const effortStep = (page) => page.evaluate(() => {
	const b = document.getElementById('effort-step');
	const v = document.getElementById('effort-val');
	if (!b || !v) return { drawn: false, shown: false };
	return { drawn: true, shown: !b.hidden && b.offsetParent !== null, text: v.textContent, title: v.title,
		dflt: v.classList.contains('is-default'), dn: !document.getElementById('effort-dn').disabled, up: !document.getElementById('effort-up').disabled };
});
const stepEffort = async (page, dir, n) => {
	for (let i = 0; i < n; i++) {
		await page.click(dir < 0 ? '#effort-dn' : '#effort-up');
		await page.waitForTimeout(120);
	}
};
/// The Effort each of the open chat's prompts was sent with, in order.
const promptEfforts = (page) => page.evaluate(async () => {
	const store = window.DaimondCore.chatStore();
	const out = [];
	for (const rec of (store.stored() || [])) {
		let msgs = [];
		try { const got = await store.loadMessages(rec.id); msgs = (got && got.messages) || rec.messages || []; }
		catch (e) { msgs = rec.messages || []; }
		msgs.filter((m) => m && m.role === 'user').forEach((m) => out.push([m.content, m.effort]));
	}
	return out;
});

const reasoningOf = (model) => mockLog().filter((e) => e.model === model).map((e) => e.reasoning || null);

const s = await open({ name: 'effort', connect: false, profile: scratch('pw', 'effort-' + process.pid) });
const { page } = s;
try {
	await connectMock(s, { model: 'mock/thinker' });
	// The list the Effort is drawn from, asked for as the app asks for it.
	await page.evaluate(async () => {
		const j = JSON.parse(localStorage.getItem('daimond-models-v2') || '{}');
		await window.DaimondModels.fetchModels((j.def || {}).provider);
	});

	clearMockLog();
	await chat(s, 'hello');
	const r0 = reasoningOf('mock/thinker');
	check(r0.length > 0 && r0.every((x) => x === null), '2. unset, a turn on mock/thinker carries no reasoning',
		JSON.stringify(r0));

	const st = await effortStep(page);
	check(st.shown && st.text === 'Medium' && st.dflt && /medium/i.test(st.title) && st.dn && st.up,
		'1. the composer shows Effort for mock/thinker: Medium, its own default, muted and named so', JSON.stringify(st));
	await stepEffort(page, 1, 1);
	const top = await effortStep(page);
	check(top.text === 'High' && !top.dflt && top.dn && !top.up, '1. a step up reaches High, the top', JSON.stringify(top));
	await stepEffort(page, -1, 1);
	const back = await effortStep(page);
	check(back.text === 'Medium' && back.dflt, '1. a step down lands on the default again, not a pinned Medium',
		JSON.stringify(back));
	await openCog(page, '#session-list');
	const row = await effortRow(page);
	check(!row.drawn, '1. the chat cog has no Effort row: one door, the composer', JSON.stringify(row));
	await closeCog(page);

	await stepEffort(page, -1, 1);
	const low = await effortStep(page);
	clearMockLog();
	await chat(s, 'again');
	const r1 = reasoningOf('mock/thinker');
	check(low.text === 'Low' && !low.dn && r1.length > 0 && r1.every((x) => x && x.effort === 'low'),
		'3. stepped to low, the next turn carries reasoning.effort "low"', JSON.stringify(low) + ' ' + JSON.stringify(r1));
	await page.waitForTimeout(800);
	const kept = (await storedChats(s)).map((c) => c.effort || '');
	check(kept.includes('low'), '3. the chat record keeps the Effort', JSON.stringify(kept));

	await stepEffort(page, 1, 2);
	clearMockLog();
	await chat(s, 'harder');
	const r1h = reasoningOf('mock/thinker');
	check(r1h.length > 0 && r1h.every((x) => x && x.effort === 'high'),
		'3. stepped to high, the turn after carries "high": turn by turn', JSON.stringify(r1h));

	// 3b. A press mid-turn: a paced turn of several rounds at High, stepped down while it runs.
	clearMockLog();
	const MID = '@rounds 5/400 file_list {"path":"."}';
	await page.fill('#chat-input', MID);
	await page.click('#chat-send', { force: true });
	const t0 = Date.now();
	while (reasoningOf('mock/thinker').length < 2 && Date.now() - t0 < 15000) await page.waitForTimeout(100);
	await stepEffort(page, -1, 1);
	const pressedAt = reasoningOf('mock/thinker').length;
	const t1 = Date.now();
	while (Date.now() - t1 < 30000) {
		const busy = await page.evaluate(() => { const b = document.getElementById('chat-send');
			return !!b && (/stop/i.test((b.getAttribute('title') || '') + (b.className || '')) || b.disabled); });
		if (!busy && reasoningOf('mock/thinker').length >= 6) break;
		await page.waitForTimeout(200);
	}
	await page.waitForTimeout(600);
	const rMid = reasoningOf('mock/thinker');
	check(pressedAt >= 2 && pressedAt < rMid.length && rMid.every((x) => x && x.effort === 'high'),
		'3b. a press mid-turn leaves that turn at its level, every round of it', pressedAt + ' ' + JSON.stringify(rMid));
	clearMockLog();
	await chat(s, 'after');
	const rAfter = reasoningOf('mock/thinker');
	check(rAfter.length > 0 && rAfter.every((x) => x === null),
		'3b. and the next turn runs at the level pressed (the default, sending none)', JSON.stringify(rAfter));
	await page.waitForTimeout(800);
	const pe = await promptEfforts(page);
	const of = (w) => (pe.find((x) => x[0] === w) || [])[1];
	check(of('hello') === '' && of('again') === 'low' && of('harder') === 'high' && of(MID) === 'high' && of('after') === '',
		'3. each prompt keeps the Effort it ran with', JSON.stringify(pe));
	await stepEffort(page, -1, 1);		// low again, for the model change to clear

	await openCog(page, '#session-list');
	const moved = await page.evaluate(async () => {
		const sel = document.querySelector('.tile-dlg-card .tile-dlg-chat-model select');
		if (!sel) return 'no chat model select';
		const o = [...sel.options].find((x) => x.value === 'mock/fast');
		if (!o) return 'no mock/fast option';
		sel.value = 'mock/fast';
		sel.dispatchEvent(new Event('change', { bubbles: true }));
		const btn = sel.closest('.tile-dlg-chat-model').querySelector('.tile-dlg-apply');
		if (!btn || btn.hidden) return 'no Change button';
		btn.click();
		return 'ok';
	});
	await page.waitForTimeout(800);
	const toastTxt = await page.evaluate(() => [...document.querySelectorAll('.daimond-toast')].map((t) => t.textContent).join(' | '));
	const after = await effortStep(page);
	check(moved === 'ok' && !after.shown, '4. after a change to mock/fast the composer\'s Effort step is gone',
		moved + ' ' + JSON.stringify(after));
	check(/default/i.test(toastTxt) && !/\berr\b/.test(toastTxt), '4. the change says the Effort went back to the default',
		toastTxt.slice(0, 240));
	await closeCog(page);

	clearMockLog();
	await chat(s, 'third');
	const r2 = reasoningOf('mock/fast');
	check(r2.length > 0 && r2.every((x) => x === null), '4. a turn on mock/fast sends no reasoning',
		JSON.stringify(r2));
	await page.waitForTimeout(800);
	const kept2 = (await storedChats(s)).map((c) => c.effort || '');
	check(!kept2.includes('low') && !kept2.includes('high'), '4. the record\'s Effort is cleared', JSON.stringify(kept2));

	// The daimon: a Diamond on the default model (mock/thinker), whose Effort is the step on its face.
	await page.evaluate(() => { const b = document.getElementById('admin-close'); if (b) b.click(); });
	const hasDiamond = await page.evaluate(() => !!document.querySelector('#diamond-list .session-box'));
	if (hasDiamond) {
		const KEY = 'daimond-diamond-models';
		const did = await page.evaluate(() => {
			const b = document.querySelector('#diamond-list .session-box');
			return b ? b.dataset.id || '' : '';
		});
		const rec = () => page.evaluate(([k, id]) => (JSON.parse(localStorage.getItem(k) || '{}') || {})[id] || null, [KEY, did]);
		const setDefault = (model) => page.evaluate(async (m) => {
			const j = JSON.parse(localStorage.getItem('daimond-models-v2') || '{}');
			const p = (j.def || {}).provider;
			await window.DaimondModels.fetchModels(p);
			window.DaimondModels.setDefault(p, m);
		}, model).then(() => page.waitForTimeout(400));
		await page.evaluate(([k, id]) => {
			const all = JSON.parse(localStorage.getItem(k) || '{}') || {};
			delete all[id];
			localStorage.setItem(k, JSON.stringify(all));
		}, [KEY, did]);
		await setDefault('mock/thinker');

		await openCog(page, '#diamond-list');
		const d = await effortRow(page);
		check(!d.drawn, '5. the Diamond\'s settings have no Effort row: one door, the composer', JSON.stringify(d));
		await closeCog(page);

		// Onto the Diamond's face, its chat side, where the composer is.
		await page.evaluate(() => { const b = document.querySelector('#diamond-list .session-box'); if (b) b.click(); });
		await page.waitForTimeout(900);
		const face = await page.$('#dview-chat');
		if (face) { await face.click({ force: true }); await page.waitForTimeout(500); }
		const d0 = await effortStep(page);
		check(d0.shown && d0.text === 'Medium' && d0.dflt, '5. on the Diamond\'s face the step shows its Effort: Medium, the default',
			JSON.stringify(d0));

		await stepEffort(page, -1, 1);
		const r6 = await rec();
		check(!!did && !!r6 && !r6.model, '6. Effort on a default-model Diamond pins no model', JSON.stringify(r6));
		check(!!r6 && r6.effort === 'low' && r6.effortModel === 'mock/thinker',
			'5/6. the step sets the Diamond\'s record, with the model it was set for', JSON.stringify(r6));

		clearMockLog();
		await steerDiamond(s, 'diamond turn');
		const t2 = Date.now();
		while (reasoningOf('mock/thinker').length < 1 && Date.now() - t2 < 20000) await page.waitForTimeout(200);
		await page.waitForTimeout(1500);
		const rd = reasoningOf('mock/thinker');
		check(rd.length > 0 && rd.every((x) => x && x.effort === 'low'),
			'5. the daimon\'s turn carries the Diamond\'s Effort, "low"', JSON.stringify(rd));

		await setDefault('mock/eyes');
		const e1 = await effortStep(page);
		check(e1.shown && e1.text === 'Low' && !e1.dflt && e1.up && !e1.dn,
			'6. a default change is followed, and a level the new default offers is kept', JSON.stringify(e1));
		await setDefault('mock/thinker');
		// Medium is mock/thinker's own default, so the step never pins it; a record left pinned
		// to it (by the old settings row, say) is what a default without it must drop.
		await page.evaluate(([k, id]) => {
			const all = JSON.parse(localStorage.getItem(k) || '{}') || {};
			all[id] = Object.assign({}, all[id] || {}, { effort: 'medium', effortProvider: (all[id] || {}).effortProvider || '',
				effortModel: 'mock/thinker' });
			localStorage.setItem(k, JSON.stringify(all));
		}, [KEY, did]);
		await setDefault('mock/eyes');
		const e2 = await effortStep(page);
		const r7 = await rec();
		check(e2.text === 'High' && e2.dflt && !(r7 && r7.effort), '6. a level the new default lacks is dropped, quietly',
			JSON.stringify(e2) + ' ' + JSON.stringify(r7));
		check(!(r7 && r7.model), '6. and the Diamond still pins no model', JSON.stringify(r7));
		await setDefault('mock/thinker');
	} else check(false, '5. a Diamond to judge', 'none on the rail');
} catch (e) {
	check(false, 'the run completed', String(e && e.stack || e).slice(0, 400));
} finally {
	await s.close();
}

guardRan(ok.length + bad.length);
console.log('\n' + (bad.length ? ('FAILED ' + bad.length) : 'ok: verify_effort'));
process.exit(bad.length ? 1 : 0);

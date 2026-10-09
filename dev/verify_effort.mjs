// verify_effort.mjs — a chat's Effort, drawn from its model's own levels (U-D #9,
// D-20261006-04/-05).
//
// The provider's `/models` reply names the reasoning levels a model takes
// (`reasoning.supported_efforts`). The chat's cog shows an Effort row beside its
// model only when the model lists levels, the level chosen reaches the provider as
// `reasoning.effort` on the next turn, and a model change to one without that level
// clears it with a quiet note. The mock lists levels for mock/thinker and none for
// mock/fast, and logs the `reasoning` each request carried.
//
//   1. On mock/thinker the cog has an Effort row: Model default, then low, medium, high.
//   2. Unset, the turn carries no `reasoning`.
//   3. Set to low, the next turn carries `reasoning.effort` "low", and the record keeps it.
//   4. A change to mock/fast clears it, says so, hides the row, and the turn sends nothing.
//   5. The daimon's dialog has the same row beside the daimon's model.
//   6. Effort on a Diamond that follows the default pins no model: the record holds the
//      level and the model it was set for, a default change is followed, a level the new
//      default offers (low, on mock/eyes) is kept and one it lacks (medium) is dropped.
//
//   eval "$(bash dev/world.sh 89 --env)"; node dev/verify_effort.mjs
import { open, scratch, connectMock, chat, storedChats, mockLog, clearMockLog, checker } from './harness.mjs';

const { bad, check: named } = checker();
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

	await openCog(page, '#session-list');
	const row = await effortRow(page);
	check(row.drawn && row.shown && row.opts.join(',') === ',low,medium,high',
		'1. the chat cog shows Effort for mock/thinker: default, low, medium, high', JSON.stringify(row));
	check(/medium/i.test(row.first), '1. the default names the model\'s own level', row.first);

	await page.evaluate(() => {
		const sel = document.querySelector('.tile-dlg-card .tile-dlg-effort select');
		if (!sel) return;
		sel.value = 'low';
		sel.dispatchEvent(new Event('change', { bubbles: true }));
	});
	await page.waitForTimeout(400);
	await closeCog(page);

	clearMockLog();
	await chat(s, 'again');
	const r1 = reasoningOf('mock/thinker');
	check(r1.length > 0 && r1.every((x) => x && x.effort === 'low'),
		'3. set to low, the next turn carries reasoning.effort "low"', JSON.stringify(r1));
	await page.waitForTimeout(800);
	const kept = (await storedChats(s)).map((c) => c.effort || '');
	check(kept.includes('low'), '3. the chat record keeps the Effort', JSON.stringify(kept));

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
	const after = await effortRow(page);
	check(moved === 'ok' && !after.shown, '4. after a change to mock/fast the Effort row is gone',
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
	check(!kept2.includes('low'), '4. the record\'s Effort is cleared', JSON.stringify(kept2));

	// The daimon: a Diamond on the default model (mock/thinker) shows the same row.
	await page.evaluate(() => { const b = document.getElementById('admin-close'); if (b) b.click(); });
	const hasDiamond = await page.evaluate(() => !!document.querySelector('#diamond-list .session-box'));
	if (hasDiamond) {
		await openCog(page, '#diamond-list');
		const d = await effortRow(page);
		check(d.drawn && d.opts.join(',') === ',low,medium,high', '5. the daimon dialog has the Effort row too',
			JSON.stringify(d));
		await closeCog(page);

		// 6. The same Diamond made to follow the default, as one made before Diamonds had models does.
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
		}, model);
		const setEffort = async (level) => {
			await openCog(page, '#diamond-list');
			await page.evaluate((v) => {
				const sel = document.querySelector('.tile-dlg-card .tile-dlg-effort select');
				if (!sel) return;
				sel.value = v;
				sel.dispatchEvent(new Event('change', { bubbles: true }));
			}, level);
			await page.waitForTimeout(400);
			await closeCog(page);
		};
		const rowNow = async () => { await openCog(page, '#diamond-list'); const r = await effortRow(page); await closeCog(page); return r; };
		await page.evaluate(([k, id]) => {
			const all = JSON.parse(localStorage.getItem(k) || '{}') || {};
			delete all[id];
			localStorage.setItem(k, JSON.stringify(all));
		}, [KEY, did]);
		await setDefault('mock/thinker');
		await setEffort('low');
		const r6 = await rec();
		check(!!did && !!r6 && !r6.model, '6. Effort on a default-model Diamond pins no model', JSON.stringify(r6));
		check(!!r6 && r6.effort === 'low' && r6.effortModel === 'mock/thinker',
			'6. the record holds the level with the model it was set for', JSON.stringify(r6));
		await setDefault('mock/eyes');
		const e1 = await rowNow();
		check(e1.opts.join(',') === ',low,high', '6. a default change is followed (the row offers mock/eyes\'s levels)',
			JSON.stringify(e1));
		check(e1.value === 'low', '6. a level the new default offers is kept', JSON.stringify(e1));
		await setDefault('mock/thinker');
		await setEffort('medium');
		await setDefault('mock/eyes');
		const e2 = await rowNow();
		const r7 = await rec();
		check(e2.value === '' && !(r7 && r7.effort), '6. a level the new default lacks is dropped, quietly',
			JSON.stringify(e2) + ' ' + JSON.stringify(r7));
		check(!(r7 && r7.model), '6. and the Diamond still pins no model', JSON.stringify(r7));
	} else check(false, '5. a Diamond to judge', 'none on the rail');
} catch (e) {
	check(false, 'the run completed', String(e && e.stack || e).slice(0, 400));
} finally {
	await s.close();
}

console.log('\n' + (bad.length ? ('FAILED ' + bad.length) : 'ok: verify_effort'));
process.exit(bad.length ? 1 : 0);

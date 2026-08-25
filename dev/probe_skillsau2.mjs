// probe_skillsau2.mjs — the daimon's half, and the chip once the rules are gone.
import { open, mockLog, clearMockLog, contentText, connectMock, steerDiamond } from './harness.mjs';

const s = await open({ name: 'skillsau2', defaults: true });
const { page } = s;
await page.waitForTimeout(2500);
await connectMock(s);
const out = {};

await page.evaluate(() => DaimondPanels.show('ai'));
await page.waitForTimeout(1200);
out.boxes = await page.$$eval('.diamond-box', els => els.length);
await page.$$eval('.diamond-box', els => els[0] && els[0].click());
await page.waitForTimeout(1500);

clearMockLog();
try { await steerDiamond(s, 'Say in one line what skills you have.'); }
catch (e) { out.steerErr = String(e).slice(0, 90); }
await page.waitForTimeout(9000);

const sysOf = (r) => contentText((r.messages || []).find(m => m.role === 'system')?.content || '');
const log = mockLog();
const daimonSys = (() => {
	for (let i = log.length - 1; i >= 0; i--) {
		const t = sysOf(log[i]);
		if (/daimon of this Diamond/i.test(t)) return t;
	}
	return '';
})();
out.daimon = {
	requests:   log.length,
	found:      !!daimonSys,
	skillsNote: /## Skills/.test(daimonSys),
	named:      /handover, pickup, status/.test(daimonSys),
	seedOnWire: /How to answer me/.test(daimonSys),
	ownFolder:  /This Diamond's own folder is/.test(daimonSys),
	chars:      daimonSys.length,
};

// ── The chip once the rules are gone ─────────────────────────────
out.afterDelete = await page.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	try { await m.store_write('DAIMOND.md', ''); } catch (e) { return 'write failed: ' + e; }
	return 'wrote empty';
});
// Through a RELOAD, which is the page's own boot path and the door a root switch
// uses -- and which also proves the seed is once: the flag is set, so an empty
// DAIMOND.md must stay empty rather than being written again.
await page.reload();
await page.waitForTimeout(3000);
await page.evaluate(() => DaimondPanels.show('work'));
await page.waitForTimeout(1200);
out.reseeded = await page.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	try { return String(await m.store_read('DAIMOND.md') || '').length; } catch (e) { return 'gone'; }
});
out.chipAfter = await page.evaluate(() => {
	const el = document.getElementById('instructions-chip');
	return el ? { display: el.style.display, text: el.textContent, title: el.title,
		empty: el.getAttribute('data-empty') } : null;
});

// ── One tap writes it back ───────────────────────────────────────
await page.click('#instructions-chip', { force: true });
await page.waitForTimeout(2500);
out.afterTap = await page.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	let bytes = 0;
	try { bytes = String(await m.store_read('DAIMOND.md') || '').length; } catch (e) { bytes = 'gone'; }
	const el = document.getElementById('instructions-chip');
	return { bytes, empty: el && el.getAttribute('data-empty'), title: el && el.title,
		editorHas: /How to answer me/.test(document.body.innerText) };
});

console.log(JSON.stringify(out, null, 1));
await s.browser.close();

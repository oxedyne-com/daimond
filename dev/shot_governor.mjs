// shot_governor.mjs — a visual capture of the spend gate in the real app.
//
// Drives a Diamond conductor into a large fan-out (60 spawn_agent calls in one
// steer) and captures the predictive gate modal it raises BEFORE any worker
// runs — the "fifty agents in a blink" case, stopped at the door. Then a small
// fan-out to show it clears silently.
//
// Needs dev/serve.mjs :8777 and dev/mockllm.mjs :9099.
import { open, shot } from './harness.mjs';

const s = await open({ name: 'governor-shot', signIn: true, connect: true });
const { page } = s;

// A fresh Diamond through the real UI.
await page.click('#new-diamond-btn');
await page.waitForSelector('.dlg-input', { timeout: 8000 });
await page.fill('.dlg-input', 'Audit the codebase');
await page.click('.dlg-ok');
await page.waitForSelector('#steer-input', { timeout: 10000 });
await page.waitForTimeout(400);

// A conductor turn that dispatches 60 agents at once.
const specs = [];
for (let i = 0; i < 60; i++) specs.push(`spawn_agent {"name":"a${i}","task":"inspect module ${i}"}`);
const steer = '@tools ' + specs.join(' ;; ');
await page.fill('#steer-input', steer);
await page.click('#steer-send');

// The gate should raise the app's confirm modal before dispatch.
const gate = await page.waitForSelector('.dlg-card, .dialog, [class*="dlg"]', { timeout: 15000 }).catch(() => null);
await page.waitForTimeout(400);
const modalText = await page.evaluate(() => {
	const el = document.querySelector('.dlg-card, .dialog, [class*="dlg"]');
	return el ? el.innerText.replace(/\s+/g, ' ').trim() : '(no modal found)';
});
console.log('GATE MODAL:', modalText);
await shot(s, 'governor-gate-60');

// Decline it: nothing should be dispatched.
const cancel = await page.$('.dlg-cancel, .dlg-no, button[data-role="cancel"]');
if (cancel) await cancel.click();
else await page.keyboard.press('Escape');
await page.waitForTimeout(500);
await shot(s, 'governor-after-decline');

await s.close();
console.log('done — screenshots written');

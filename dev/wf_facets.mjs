// Workflow 2 — the Facets brief -> steer -> fold loop with a REAL model.
import fs from 'node:fs';
import { open, connectReal, spend, errors } from './harness.mjs';

const s = await open({ name: 'wf-facets', connect: false });
const model = await connectReal(s, 'value');
const t0 = Date.now();

// Create a Facet.
await s.page.click('#new-facet-btn', { force: true });
await s.page.waitForSelector('.dlg-input', { timeout: 10000 });
await s.page.fill('.dlg-input', 'Ship a CSV parser');
await s.page.click('.dlg-ok', { force: true });
await s.page.waitForTimeout(1200);

// Steer: ask the brief agent to record the goal and open threads into brief.md.
async function steer(text, wait = 60000) {
  await s.page.fill('#steer-input', text);
  await s.page.keyboard.press('Enter');
  const t = Date.now();
  while (Date.now() - t < wait) {
    const busy = await s.page.evaluate(() => (document.getElementById('steer-send')||{}).disabled);
    if (!busy) break;
    await s.page.waitForTimeout(400);
  }
  await s.page.waitForTimeout(400);
}
await steer('Set the brief for this Facet: goal is a small Rust CSV parser. Record the goal, and list three open threads: parse a line, handle quoted fields, and write tests. Edit brief.md to contain this.');
const briefV1 = await s.page.evaluate(() => (document.querySelector('.chat-msg-content')||document.getElementById('brief-body')||{}).innerText || '');

// Fold a delta in (a finished piece of work) and accept it.
await s.page.fill('#fold-delta', 'Decision: use a hand-written state machine, not a regex. The quoted-field thread is now the priority.');
await s.page.click('#fold-propose', { force: true });
await s.page.waitForTimeout(1500);
// wait for the propose (reducer) turn
for (let i=0;i<40;i++){ if (await s.page.$('.diff-accept')) break; await s.page.waitForTimeout(500); }
const accept = await s.page.$('.diff-accept');
let folded = false;
if (accept && !(await accept.isDisabled())) { await accept.click({ force: true }); await s.page.waitForTimeout(2500); folded = true; }
const briefV2 = await s.page.evaluate(() => (document.querySelector('.chat-msg-content')||{}).innerText || '');

const result = {
  workflow: 'facets', model, elapsedS: ((Date.now()-t0)/1000).toFixed(1),
  briefWritten: /csv|parser|thread/i.test(briefV1),
  briefV1_len: briefV1.length,
  foldAccepted: folded,
  briefChangedAfterFold: briefV2.length > 0 && briefV2 !== briefV1,
  briefMentionsDecision: /state machine|regex|quoted/i.test(briefV2),
  spendUsd: +(await spend(s)).toFixed(4),
  consoleErrors: errors(s),
};
fs.writeFileSync('dev/results/facets.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
console.log('--- brief after fold (first 400) ---\n' + briefV2.slice(0, 400));
await s.close();

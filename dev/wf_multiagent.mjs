// Workflow 3 — real conductor dispatches parallel workers on partitioned files.
import fs from 'node:fs';
import { open, connectReal, spend, errors } from './harness.mjs';

const s = await open({ name: 'wf-multi', connect: false });
const model = await connectReal(s, 'value');
const t0 = Date.now();

await s.page.click('#new-diamond-btn', { force: true });
await s.page.waitForSelector('.dlg-input', { timeout: 10000 });
await s.page.fill('.dlg-input', 'Three files');
await s.page.click('.dlg-ok', { force: true });
await s.page.waitForTimeout(1200);

// Natural-language instruction — the REAL model must decide to call spawn_agent
// three times (no @tools directive; that is mock-only).
await s.page.fill('#steer-input',
  'Dispatch three separate worker agents to run in parallel. Worker one: use file_write to create alpha.txt containing exactly the word ALPHA. Worker two: create beta.txt containing exactly BETA. Worker three: create gamma.txt containing exactly GAMMA. Give each worker only its own single-file task.');
await s.page.keyboard.press('Enter');

// Wait for the conductor turn to finish dispatching.
await s.page.waitForTimeout(2000);
for (let i=0;i<30;i++){ const busy = await s.page.evaluate(()=>(document.getElementById('steer-send')||{}).disabled); if(!busy)break; await s.page.waitForTimeout(500); }

// Open the Agents panel and wait for workers to finish.
await s.page.evaluate(() => window.DaimondPanels && DaimondPanels.show('agents'));
await s.page.waitForTimeout(1000);
let tiles = 0;
for (let i=0;i<40;i++){
  const st = await s.page.evaluate(() => {
    const cards=[...document.querySelectorAll('#panel-agents .acard')];
    return { n: cards.length, running: cards.filter(c=>/running|queued/.test((c.querySelector('.pill')||{}).textContent||'')).length };
  });
  tiles = st.n;
  if (st.n >= 1 && st.running === 0) break;
  await s.page.waitForTimeout(1000);
}

// Check the files landed in OPFS.
const files = await s.page.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  const got = {};
  for (const nm of ['alpha.txt','beta.txt','gamma.txt']) {
    try { const fh = await root.getFileHandle(nm); got[nm] = (await (await fh.getFile()).text()).trim(); }
    catch { got[nm] = null; }
  }
  return got;
});

const result = {
  workflow: 'multi-agent', model, elapsedS: ((Date.now()-t0)/1000).toFixed(1),
  workerTiles: tiles,
  files,
  filesCreated: Object.values(files).filter(Boolean).length,
  spendUsd: +(await spend(s)).toFixed(4),
  consoleErrors: errors(s),
};
fs.writeFileSync('dev/results/multiagent.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await s.close();

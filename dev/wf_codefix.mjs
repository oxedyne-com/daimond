// Workflow 1 — real code task with ground-truth verification.
// Seed the rustcalc project into the OPFS workspace, ask a real model to find and
// fix the median bug and document the API, then export the edited file back to
// disk and run `cargo test` to prove the fix is real — not just plausible text.
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { open, chat, errors } from './harness.mjs';

const cfg = JSON.parse(fs.readFileSync('dev/.secrets/testcfg.json', 'utf8'));
const MODEL = cfg.models.value;   // gpt-oss-120b (value)
const SEED = fs.readFileSync('/home/jason/usr/scratch/daimond-test/rustcalc/src/lib.rs', 'utf8');

function connectReal(page) {
  return page.evaluate(async (c) => {
    document.getElementById('settings-btn')?.click();
    await new Promise(r => setTimeout(r, 250));
    const prov = document.getElementById('cfg-provider'); prov.value='custom'; prov.dispatchEvent(new Event('change',{bubbles:true}));
    await new Promise(r=>setTimeout(r,200));
    const url=document.getElementById('cfg-base-url'); url.value=c.baseUrl; url.dispatchEvent(new Event('input',{bubbles:true})); url.dispatchEvent(new Event('change',{bubbles:true}));
    const key=document.getElementById('cfg-api-key'); key.value=c.apiKey; key.dispatchEvent(new Event('input',{bubbles:true})); key.dispatchEvent(new Event('change',{bubbles:true}));
    await new Promise(r=>setTimeout(r,1500));
    const cus=document.getElementById('cfg-model-custom'); if(cus){cus.style.display='';cus.value=c.model;cus.dispatchEvent(new Event('input',{bubbles:true}));}
    document.getElementById('byok-save')?.click();
  }, c => c, cfg);
}
const spendOf = (page) => page.evaluate(() => { try { return JSON.parse(localStorage.getItem('daimond-ledger')||'[]').reduce((a,e)=>a+(e.u||0),0); } catch { return 0; } });

const s = await open({ name: 'wf-codefix', connect: false });
await s.page.evaluate(async (c)=>{ // inline connectReal (evaluate can't take a fn ref easily)
  document.getElementById('settings-btn')?.click(); await new Promise(r=>setTimeout(r,250));
  const prov=document.getElementById('cfg-provider'); prov.value='custom'; prov.dispatchEvent(new Event('change',{bubbles:true})); await new Promise(r=>setTimeout(r,200));
  const url=document.getElementById('cfg-base-url'); url.value=c.baseUrl; url.dispatchEvent(new Event('input',{bubbles:true})); url.dispatchEvent(new Event('change',{bubbles:true}));
  const key=document.getElementById('cfg-api-key'); key.value=c.apiKey; key.dispatchEvent(new Event('input',{bubbles:true})); key.dispatchEvent(new Event('change',{bubbles:true}));
  await new Promise(r=>setTimeout(r,1500));
  const cus=document.getElementById('cfg-model-custom'); if(cus){cus.style.display='';cus.value=c.model;cus.dispatchEvent(new Event('input',{bubbles:true}));}
  document.getElementById('byok-save')?.click();
}, { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: MODEL });
await s.page.waitForTimeout(1500);

// Seed the file into OPFS so the agent's file tools can read/edit it.
await s.page.evaluate(async (src) => {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('rustcalc', { create: true });
  const sub = await dir.getDirectoryHandle('src', { create: true });
  const fh = await sub.getFileHandle('lib.rs', { create: true });
  const w = await fh.createWritable(); await w.write(src); await w.close();
}, SEED);

console.log('model:', MODEL);
const t0 = Date.now();
const task = 'The file rustcalc/src/lib.rs has a bug in the `median` function: for an '
  + 'even-length slice it returns a single middle element instead of the average of '
  + 'the two middle elements, so the test `median_even` fails. Read the file, fix the '
  + 'median function so median_even passes, and add a short /// doc comment to each of '
  + 'the three public functions (mean, median, stddev). Use the file tools. When done, say DONE.';
const out = await chat(s, task, { timeout: 180000 });
console.log('elapsed:', ((Date.now()-t0)/1000).toFixed(1)+'s');
console.log('--- transcript tail ---\n' + out.slice(-500));

// Pull the edited file back out of OPFS and verify with cargo test.
const edited = await s.page.evaluate(async () => {
  try { const root=await navigator.storage.getDirectory(); const d=await root.getDirectoryHandle('rustcalc'); const sub=await d.getDirectoryHandle('src'); const fh=await sub.getFileHandle('lib.rs'); return await (await fh.getFile()).text(); }
  catch(e){ return '(missing: '+e+')'; }
});
const verifyDir = '/home/jason/usr/scratch/daimond-test/rustcalc-verify';
fs.rmSync(verifyDir, { recursive: true, force: true });
fs.mkdirSync(verifyDir+'/src', { recursive: true });
fs.copyFileSync('/home/jason/usr/scratch/daimond-test/rustcalc/Cargo.toml', verifyDir+'/Cargo.toml');
fs.writeFileSync(verifyDir+'/src/lib.rs', edited);
let testOut = '', pass = false;
try { testOut = execSync('cargo test 2>&1', { cwd: verifyDir, encoding: 'utf8' }); pass = /test result: ok/.test(testOut) && !/FAILED/.test(testOut); }
catch (e) { testOut = (e.stdout||'') + (e.stderr||''); pass = false; }
const docs = (edited.match(/^\/\/\/ /gm) || []).length;

const spend = await spendOf(s.page);
const result = {
  workflow: 'codefix', model: MODEL, elapsedS: ((Date.now()-t0)/1000).toFixed(1),
  cargoTest: /test result: ([^\n]+)/.exec(testOut)?.[1] || 'no result line',
  testsPass: pass, docCommentsAdded: docs, spendUsd: +spend.toFixed(4),
  consoleErrors: errors(s),
};
fs.writeFileSync('dev/results/codefix.json', JSON.stringify(result, null, 2));
console.log('\n=== RESULT ===\n' + JSON.stringify(result, null, 2));
await s.close();

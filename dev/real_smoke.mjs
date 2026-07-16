// One real turn against Fireworks gpt-oss-120b, driven through the real Settings
// form (the reliable path), headless. Proves the loop works with a real model.
import fs from 'node:fs';
import { open, chat, errors } from './harness.mjs';
const cfg = JSON.parse(fs.readFileSync('dev/.secrets/testcfg.json', 'utf8'));
const MODEL = cfg.models.value;

const s = await open({ name: 'realsmoke', connect: false });   // signed in, not yet connected

// Drive the Settings form with REAL values (mirrors connectMock, real key).
await s.page.evaluate(async (c) => {
  document.getElementById('settings-btn')?.click();
  await new Promise(r => setTimeout(r, 250));
  const prov = document.getElementById('cfg-provider');
  prov.value = 'custom'; prov.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 200));
  const url = document.getElementById('cfg-base-url');
  url.value = c.baseUrl; url.dispatchEvent(new Event('input', { bubbles: true })); url.dispatchEvent(new Event('change', { bubbles: true }));
  const key = document.getElementById('cfg-api-key');
  key.value = c.apiKey; key.dispatchEvent(new Event('input', { bubbles: true })); key.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 1500));   // real /models fetch
  const cus = document.getElementById('cfg-model-custom');
  if (cus) { cus.style.display=''; cus.value = c.model; cus.dispatchEvent(new Event('input', { bubbles: true })); }
  const sel = document.getElementById('cfg-model');
  if (sel && [...sel.options].some(o=>o.value===c.model)) { sel.value=c.model; sel.dispatchEvent(new Event('change',{bubbles:true})); }
  document.getElementById('byok-save')?.click();
}, { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: MODEL });
await s.page.waitForTimeout(1500);

const ready = await s.page.evaluate(() => { try { const j=JSON.parse(localStorage.getItem('daimond-byok')||'{}'); return {model:j.model, hasKey:!!j.apiKey}; } catch { return null; } });
console.log('connected:', JSON.stringify(ready));

const t0 = Date.now();
const out = await chat(s, 'Use the file_write tool to create hello.txt with exactly this content: Daimond works. Then say you are done.', { timeout: 90000 });
console.log('elapsed:', ((Date.now()-t0)/1000).toFixed(1)+'s');
console.log('--- transcript tail ---\n' + out.slice(-400));

const wrote = await s.page.evaluate(async () => {
  try { const root = await navigator.storage.getDirectory(); const fh = await root.getFileHandle('hello.txt'); return await (await fh.getFile()).text(); }
  catch (e) { return '(no file: '+e+')'; }
});
const spend = await s.page.evaluate(() => { try { return JSON.parse(localStorage.getItem('daimond-ledger')||'[]').reduce((a,e)=>a+(e.u||0),0); } catch { return 0; } });
console.log('hello.txt on disk:', JSON.stringify(wrote));
console.log('spend this run: $' + spend.toFixed(4));
console.log('REAL MODEL DROVE A TOOL CALL:', /Daimond works/.test(wrote));
console.log('errors:', errors(s));
await s.close();

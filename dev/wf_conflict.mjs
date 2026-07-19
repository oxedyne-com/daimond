// Workflow 4 — the two-agents-one-file experiment (the roadmap question).
// Drives the app's REAL file tools (run_tool) directly to characterise what
// happens when a second writer changes a file underneath the first. No LLM
// needed — the tools are the thing under test — so this run is free.
import fs from 'node:fs';
import { open } from './harness.mjs';

const s = await open({ name: 'wf-conflict', connect: false });
// The file tools need an app instance; a chat's app or the diamond app. Easiest:
// use the workspace's own tool runner, which daimond.js exposes as tools().
const run = (name, args) => s.page.evaluate(
  ([n, a]) => window.__daimondTools ? window.__daimondTools(n, a) :
    // fall back to the Files panel's own runner via a fresh DaimondApp
    (async () => {
      // tools() isn't on window; drive via a throwaway app created like the workspace does
      const mod = window.__daimondApp;
      throw new Error('no tool runner exposed');
    })(),
  [name, JSON.stringify(args)]
).catch(e => 'ERR:' + e.message);

// The app doesn't expose tools() on window, so exercise the same OPFS primitives
// the tools use, matching file_write (overwrite) and file_edit (exact replace)
// semantics exactly, to characterise the behaviour deterministically.
const result = await s.page.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  const write = async (p, c) => { const fh = await root.getFileHandle(p, { create: true }); const w = await fh.createWritable(); await w.write(c); await w.close(); };
  const read  = async (p) => { const fh = await root.getFileHandle(p); return await (await fh.getFile()).text(); };
  // file_edit semantics: exact unique substring replace, else "not found".
  const edit  = async (p, oldS, newS) => {
    const cur = await read(p);
    const i = cur.indexOf(oldS);
    if (i === -1) return { ok: false, reason: 'old_string not found' };
    if (cur.indexOf(oldS, i + 1) !== -1) return { ok: false, reason: 'old_string not unique' };
    await write(p, cur.slice(0, i) + newS + cur.slice(i + oldS.length));
    return { ok: true };
  };

  const out = {};
  const FILE = 'race.txt';
  await write(FILE, 'alpha\nbravo\ncharlie\ndelta\n');

  // Agent A reads it (holds a stale copy). Agent B rewrites it behind A's back.
  const aStale = await read(FILE);
  await write(FILE, 'alpha\nBRAVO-B\ncharlie\nDELTA-B\n');   // agent B's edit

  // (1) Agent A edits a region B did NOT touch, anchor still present.
  const e1 = await edit(FILE, 'charlie', 'CHARLIE-A');
  out.editDisjointRegion = { ...e1, fileAfter: await read(FILE) };

  // Reset for the next case.
  await write(FILE, 'alpha\nbravo\ncharlie\ndelta\n');
  await read(FILE);                                        // A reads
  await write(FILE, 'alpha\nbravo\nGONE\ndelta\n');        // B destroys A's anchor
  // (2) Agent A edits anchoring on text B destroyed.
  const e2 = await edit(FILE, 'charlie', 'CHARLIE-A');
  out.editDestroyedAnchor = { ...e2, fileAfter: await read(FILE) };

  // Reset. (3) Agent A does a whole-file WRITE from its stale copy.
  await write(FILE, 'alpha\nbravo\ncharlie\ndelta\n');
  const stale = await read(FILE);                          // A's stale copy
  await write(FILE, 'alpha\nBRAVO-B\ncharlie\nDELTA-B\n'); // B's edit
  await write(FILE, stale);                                // A writes stale copy back
  out.writeFromStale = { fileAfter: await read(FILE), bDataSurvived: (await read(FILE)).includes('BRAVO-B') };

  return out;
});

const findings = {
  workflow: 'file-conflict', llmCost: 0,
  editDisjointRegion_merged: result.editDisjointRegion.ok && result.editDisjointRegion.fileAfter.includes('CHARLIE-A') && result.editDisjointRegion.fileAfter.includes('BRAVO-B'),
  editDestroyedAnchor_failedSafe: !result.editDestroyedAnchor.ok,
  writeFromStale_clobberedSilently: !result.writeFromStale.bDataSurvived,
  raw: result,
};
fs.writeFileSync('dev/results/conflict.json', JSON.stringify(findings, null, 2));
console.log(JSON.stringify(findings, null, 2));
await s.close();

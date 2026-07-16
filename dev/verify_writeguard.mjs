// The stale-write guard: an agent that read a file, then finds it changed on
// disk (another agent), must have its whole-file write REFUSED, not clobber.
import { open, chat, errors } from './harness.mjs';
const s = await open({ name: 'writeguard' });

// Seed g.txt = v1, then have the agent READ it (records its hash in read_seen).
await s.page.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle('g.txt', { create: true });
  const w = await fh.createWritable(); await w.write('ORIGINAL-v1'); await w.close();
});
await chat(s, '@tool file_read {"path":"g.txt"}');

// Another agent changes g.txt underneath (simulated via OPFS directly).
await s.page.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle('g.txt', { create: true });
  const w = await fh.createWritable(); await w.write('AGENT-B-WROTE-THIS'); await w.close();
});

// The first agent now writes a stale whole-file over it.
const out = await chat(s, '@tool file_write {"path":"g.txt","content":"STALE-CLOBBER"}');
const after = await s.page.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle('g.txt'); return await (await fh.getFile()).text();
});
console.log('--- write-turn transcript tail ---\n' + out.slice(-300));
console.log('file after stale write:', JSON.stringify(after));
console.log('GUARD REFUSED THE STALE WRITE:', /changed on disk/.test(out));
console.log('AGENT B WORK PRESERVED:', after === 'AGENT-B-WROTE-THIS');
console.log('errors:', errors(s));
await s.close();

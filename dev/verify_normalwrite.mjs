import { open, chat, errors } from './harness.mjs';
const s = await open({ name: 'normalwrite' });
await chat(s, '@tool file_write {"path":"n.txt","content":"first"}');   // new file: ok
await chat(s, '@tool file_read {"path":"n.txt"}');                       // read (records)
const out = await chat(s, '@tool file_write {"path":"n.txt","content":"second"}');  // own update, no external change: ok
const after = await s.page.evaluate(async()=>{const r=await navigator.storage.getDirectory();const f=await r.getFileHandle('n.txt');return await (await f.getFile()).text();});
console.log('normal write chain result:', JSON.stringify(after), '| refused?', /changed on disk/.test(out));
console.log('NORMAL WRITES UNAFFECTED:', after==='second' && !/changed on disk/.test(out));
console.log('errors:', errors(s));
await s.close();

/* ============================================================
   Test -- the chat log is read at boot and when a chat opens (P2.3a2),
   not only on a wake tap and the hand-off watch.

     BOOT   readLogsAtBoot reads the chat on screen, every chat with a
            turn the log holds open here, and every chat holding a
            hand-off placeholder, each once its transcript is resident,
            and no other chat
     OPEN   selectChat reads the opened chat's log, resident or once its
            transcript lands; install runs the boot read on each unlock

     node www/js/logboot.test.mjs
   ============================================================ */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { failures++; console.log('  FAIL ' + name + (detail ? ': ' + detail : '')); }
}
const { liftSource } = await import('../../dev/syncprobe.mjs');

// ── BOOT ──
const read = [], loaded = [];
const chats = ['cur', 'open', 'ph', 'idle', 'empty'].map((id) => ({ id, messages: [], _loaded: id !== 'ph' }));
let lifted = null;
try {
	lifted = new Function('chats', 'current', 'ChatStore', 'loadChatMessages', 'readChatLog', 'logPlaces', [
		liftSource(['readLogsAtBoot'], ['chats', 'current', 'ChatStore', 'loadChatMessages', 'readChatLog', 'logPlaces']).src,
		'return readLogsAtBoot;',
	].join('\n'))(
		chats, chats[0],
		{ stored: () => [{ id: 'ph', iturns: ['T1'] }, { id: 'idle', iturns: [] }] },
		async (c) => { loaded.push(c.id); c._loaded = true; },
		async (c) => { read.push(c.id + (c._loaded ? '' : '!')); },
		() => ({ open: { seq: 4, views: { T2: {} } }, empty: { seq: 9, views: {} } }),
	);
} catch (e) { lifted = null; }
check('BOOT readLogsAtBoot exists', typeof lifted === 'function');
if (lifted) {
	await lifted();
	check('BOOT reads current, open-turn and placeholder chats only', read.join() === 'cur,open,ph', read.join());
	check('BOOT loads a transcript before reading', loaded.join() === 'ph', loaded.join());
}

// ── OPEN ──
const chatsSrc = readFileSync(join(HERE, 'page', 'chats.js'), 'utf8');
const sel = chatsSrc.slice(chatsSrc.indexOf('export function selectChat('), chatsSrc.indexOf('function pendingStartBlock('));
const calls = sel.split('readChatLog(').length - 1;
check('OPEN selectChat reads the log, resident or once loaded', calls >= 2 && /loadChatMessages\(chat\)\.then\(function \(\) \{[\s\S]*readChatLog\(/.test(sel), String(calls));
const hoSrc = readFileSync(join(HERE, 'page', 'handoff.js'), 'utf8');
check('OPEN install reads the logs on unlock', /addEventListener\('daimond:unlock', function \(\) \{ readLogsAtBoot\(/.test(hoSrc));

if (failures) { console.log(failures + ' failed'); process.exit(1); }
console.log('logboot: all passed');

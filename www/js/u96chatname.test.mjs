/* ============================================================
   Test -- a daimon's chat takes its diamond's name, never a copy (UNBLOCK-96, lead ruling U96c).

   02 Nov 2026 his phone rebuilt Fred Hoogland's lost meta.json as "The Hoogland Family
   Stories"; the daimon's chat copied that guess by value (`daimonChat`, `rec.name = f.name`)
   and the stale copy travelled with the chat. A daimon's chat now holds no name: every reader
   takes the diamond's (`chatName`), as C3 did for its model, and a record from before has its
   copy shed when it is read or written.
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const TILE = readFileSync(join(HERE, 'page', 'tilestyle.js'), 'utf8');
const STORE = readFileSync(join(HERE, 'page', 'chatstore.js'), 'utf8');

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + JSON.stringify(detail) + ')' : '')); failures++; }
}

/// `function name(...) { ... }` by counting braces; '' when absent.
function lift(src, name) {
	const m = new RegExp('(?:^|\\n)\\s*(?:export )?function ' + name + '\\(').exec(src);
	if (!m) return '';
	const start = src.indexOf('function ' + name + '(', m.index);
	let depth = 0, i = src.indexOf('{', start);
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(start, i);
}

const pg = { diamonds: [{ id: 'd', name: 'Fred Hoogland' }] };
const tOr = (k, d) => d;
const stub = (name) => 'function ' + name + '() { return ""; }';
const tile = new Function('pg', 'tOr', [
	lift(TILE, 'chatName') || stub('chatName'),
	lift(TILE, 'chatOpening'),
	lift(TILE, 'chatDisplayName'),
	lift(TILE, 'chatIconName'),
	'return { chatName: chatName, chatDisplayName: chatDisplayName, chatIconName: chatIconName };',
].join('\n'))(pg, tOr);

// The record a device stored before this fix: the guess, copied by value.
const stale = { id: 'cmth5oiix', name: 'The Hoogland Family Stories', diamondId: 'd',
	messages: [{ role: 'user', content: 'hi' }], status: 'active' };

check('the chat is named by its diamond', tile.chatName(stale) === 'Fred Hoogland', tile.chatName(stale));
check('its title is the diamond\'s name', tile.chatDisplayName(stale) === 'Fred Hoogland', tile.chatDisplayName(stale));
check('its icon is the diamond\'s name', tile.chatIconName(stale) === 'Fred Hoogland', tile.chatIconName(stale));
pg.diamonds[0].name = 'Fred';
check('a rename of the diamond is the chat\'s at once', tile.chatDisplayName(stale) === 'Fred', tile.chatDisplayName(stale));
const loose = { id: 'c2', name: 'Solar aircraft', messages: [] };
check('a loose chat keeps its own name', tile.chatDisplayName(loose) === 'Solar aircraft', tile.chatDisplayName(loose));

// The store sheds the copy on every write and read.
const store = new Function('diag', [
	lift(STORE, 'chatOwnName') || 'function chatOwnName(c) { return (c && c.name) || ""; }',
	lift(STORE, 'chatOwnsModel'),
	'var _chatModelShedSaid = true;',
	'function withRecent(c, out) { return out; }',
	lift(STORE, 'slimChat'),
	'return { slimChat: slimChat };',
].join('\n'))(function () {});
const slim = store.slimChat(stale);
check('the stored record holds no name for a daimon\'s chat', slim.name === '', slim.name);
check('a loose chat\'s stored name is kept', store.slimChat(loose).name === 'Solar aircraft');
check('the hydrated record holds no name', /name: chatOwnName\(c\), app: null/.test(STORE));
check('the summary holds no name', /name: chatOwnName\(c\), model: own/.test(STORE));

// The daimon's chat is made without a copy, and nothing copies one into it.
const DIA = readFileSync(join(HERE, 'page', 'diamonds.js'), 'utf8');
const dc = lift(DIA, 'daimonChat');
check('daimonChat copies no name', dc && !/rec\.name = f\.name/.test(dc) && !/name: f\.name/.test(dc), dc.slice(0, 80));

if (failures) { console.log(failures + ' FAILED'); process.exit(1); }
console.log('all passed');

/* ============================================================
   Test -- a crystal changed on another device repaints the page on screen
   (U-A #1, D-20261006-07).

   THE BUG. `onDiamondsChangedElsewhere` adopted the arriving Diamond record and never
   drew the crystal again, so the page on screen kept the old memory until the owner
   clicked away and back. He saw a stale Life log on his second device every day.

   THE FIX. When the Diamond on screen is drawn on its page face and the stored data or
   page bytes differ from what was drawn, the crystal is drawn again. An edit form (or
   History, or Tags) holds the body instead of the page, so nothing is wiped under it,
   and its own way out reads the store. An open memory panel defers the repaint to the
   moment it is closed.
   `node www/js/crystalsync.test.mjs`
   ============================================================ */

import { makeWindow, sliceDaimond } from '../../dev/syncprobe.mjs';

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

// The store: one Diamond's data and page, as another device's import leaves them.
const store = { data: '{"title":"First"}', page: '<p>page</p>' };
const diamonds = [{ id: 'd1', name: 'Life log', crystal_version: 1, updated: 1 }];
// The memory panel, a <details>: `open` and its toggle listeners.
const mem = { open: false, listeners: [],
	addEventListener(t, f) { if (t === 'toggle') this.listeners.push(f); },
	removeEventListener(t, f) { this.listeners = this.listeners.filter((x) => x !== f); },
	toggle(open) { this.open = open; for (const f of this.listeners.slice()) f({}); } };
const body = { children: ['page'], querySelector: (sel) => (/crystal-memory/.test(sel) ? mem : null) };
// What the crystal face last drew. The real renderCrystal records it; this stub does the same.
const shown = { id: '', sig: null, stale: false };
let renders = 0;
const sig = () => store.data + '\u0001' + store.page;
function renderCrystal() { renders++; shown.id = 'd1'; shown.sig = sig(); shown.stale = false; body.children = ['page']; }

const win = makeWindow();
const stubs = {
	t: (k) => k,
	currentDiamond: diamonds[0],
	centreMode: 'focus',
	diamonds,
	loadDiamonds: async () => {},
	sessionNameEl: { textContent: '' },
	setDiamondWhen() {}, signalDiamondChanged() {}, showCentre() {}, renderEmptyState() {},
	crystalBody: body,
	crystalShown: shown,
	renderCrystal,
	diamondApp: () => ({ read_crystal_data: async () => store.data, read_crystal_page: async () => store.page }),
};
const fns = sliceDaimond(win, ['onDiamondsChangedElsewhere'], stubs).fns;
// A newer copy of the Diamond arrives: a fresh record, as loadDiamonds would leave it.
async function arrive(patch) {
	Object.assign(store, patch || {});
	diamonds[0] = Object.assign({}, diamonds[0], { updated: diamonds[0].updated + 1 });
	await fns.onDiamondsChangedElsewhere();
	await new Promise((r) => setTimeout(r, 0));
}

renderCrystal(); renders = 0;

// (1) The crystal changed elsewhere: the page on screen is drawn again.
await arrive({ data: '{"title":"Second"}' });
check('a changed crystal from another device repaints the page on screen', renders === 1, 'renders=' + renders);

// (2) Only the record moved (a rename): the page is left alone, so a capp keeps its state.
renders = 0;
await arrive();
check('a record that moved without its crystal does not repaint', renders === 0, 'renders=' + renders);

// (3) The page itself changed elsewhere (a daimon rewrote it): repainted too.
renders = 0;
await arrive({ page: '<p>page two</p>' });
check('a changed page from another device repaints', renders === 1, 'renders=' + renders);

// (4) The memory panel is open: nothing is wiped under it, and closing it repaints.
renders = 0;
mem.open = true;
await arrive({ data: '{"title":"Third"}' });
check('with the memory panel open the page is not repainted', renders === 0, 'renders=' + renders);
mem.toggle(false);
await new Promise((r) => setTimeout(r, 0));
check('and closing the panel repaints it', renders === 1, 'renders=' + renders);
mem.toggle(true); mem.toggle(false);
await new Promise((r) => setTimeout(r, 0));
check('once, not on every later toggle', renders === 1, 'renders=' + renders);

// (5) An edit form holds the body: it is not wiped, and its own Cancel reads the store.
renders = 0;
shown.id = ''; shown.sig = null; body.children = ['form'];
await arrive({ data: '{"title":"Fourth"}' });
check('with an edit form open nothing repaints', renders === 0, 'renders=' + renders);
check('and the form is still there', body.children[0] === 'form', JSON.stringify(body.children));

// (6) Another face (chat) is up: nothing is drawn into a hidden body.
renderCrystal(); renders = 0;
stubs.centreMode = 'chat';
const chatFns = sliceDaimond(win, ['onDiamondsChangedElsewhere'], stubs).fns;
store.data = '{"title":"Fifth"}';
diamonds[0] = Object.assign({}, diamonds[0], { updated: diamonds[0].updated + 1 });
await chatFns.onDiamondsChangedElsewhere();
check('on the chat face nothing repaints', renders === 0, 'renders=' + renders);

if (failures) { console.log(failures + ' failed'); process.exit(1); }
console.log('crystalsync: all passed');

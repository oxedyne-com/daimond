/* lensscreen.test.mjs -- LENS-SCREEN: the lens's `screen` beat names the phone page he is on.

   The screen seam in boot.js took `#settings-menu` not being hidden to mean Settings. Since
   Stack A2 that menu sits unhidden inside the phone's Settings page, built once and then only
   hidden with its page, so every phone beat after a first visit to Settings said "settings",
   at home and in a chat alike. On a phone the stack's top page is the truth.

   This runs the seam's own view lines (from `var view = 'chat';` to the end of their try)
   against a stub DOM, at head or, with MM_SRC_REV, at another revision:
   node www/js/lensscreen.test.mjs
   MM_SRC_REV=ebafe6996 node www/js/lensscreen.test.mjs   (the live record: red) */
import { source } from './testlift.mjs';

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { failures++; console.log('  FAIL ' + name + (detail ? ': ' + detail : '')); }
}

const src = source('daimond.js');
const from = src.indexOf("var view = 'chat';");
const end = from < 0 ? -1 : src.indexOf('/* the DOM is not up yet */ }', from);
check('the screen seam\'s view lines are found', from >= 0 && end > from);
const body = src.slice(from, end + '/* the DOM is not up yet */ }'.length) + '\nreturn view;';
// The page's one-file view names the centre's face `centreMode`, the module `pg.centreMode`.
const seam = new Function('document', 'window', 'pg', 'centreMode', body);

/// The view the seam reports on a page where `top` is the phone stack's page (null: not a
/// phone), `menu` says whether `#settings-menu` is unhidden, and `mode` is the centre's face.
function view({ top, menu, mode, admin }) {
	const els = {
		admin:           { classList: { contains: (c) => !!admin && c === 'admin-open' } },
		'settings-menu': { hidden: !menu },
	};
	const document = { getElementById: (id) => els[id] || null };
	const phone = top != null;
	const window = {
		DaimondShell: { isPhone: () => phone },
		DaimondStack: { started: () => phone, top: () => (phone ? top : null) },
	};
	return seam(document, window, { centreMode: mode || 'chat' }, mode || 'chat');
}

// A phone that has opened Settings once: its menu is built and stays unhidden in its page.
check('phone at home names home', view({ top: 'home', menu: true }) === 'home', view({ top: 'home', menu: true }));
check('phone in a chat names chat', view({ top: 'turn', menu: true }) === 'chat', view({ top: 'turn', menu: true }));
check('phone in a Diamond names diamond', view({ top: 'turn', menu: true, mode: 'focus' }) === 'diamond');
check('phone in a daimon names daimon', view({ top: 'turn', menu: true, mode: 'daimon' }) === 'daimon');
check('phone in Settings names settings', view({ top: 'settings', menu: true }) === 'settings');
check('phone in a Settings group or view names settings',
	view({ top: 'settings-group', menu: true }) === 'settings' && view({ top: 'settings-view', menu: true }) === 'settings');
check('admin is still admin on a phone', view({ top: 'home', menu: true, admin: true }) === 'admin');
// The desktop reads the menu as before.
check('desktop with the menu open names settings', view({ top: null, menu: true }) === 'settings');
check('desktop with the menu shut names the centre', view({ top: null, menu: false }) === 'chat'
	&& view({ top: null, menu: false, mode: 'focus' }) === 'diamond');

console.log(`\n${checks - failures}/${checks} ok`);
process.exit(failures ? 1 : 0);

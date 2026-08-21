// A DRAFT BELONGS TO THE DIAMOND, NOT TO THE FACE IT WAS TYPED ON.
//
// Reported by the owner, 2026-08-21, using the app: he began typing a reply to a
// daimon on the chat face, switched to the crystal face, and the text was gone.
//
// `moveComposerTo` guards the SAVE on the conversation actually changing --
// "re-entering the conversation already on screen must not read the box back into
// itself" -- and then clobbers the box unconditionally on the next line:
//
//     if (current && current !== next) current._draft = chatInput.value;
//     chatInput.value = (next && next._draft) || '';
//
// A Diamond's two faces share ONE conversation record, so a face switch has
// `current === next`: the save is skipped and the overwrite is not. The box is
// replaced by a stale `_draft`, empty for anyone who had not switched away before.
// The comment above the guard describes the intended behaviour correctly; the code
// implements half of it.
//
// The last two checks exist so the fix cannot be "never touch the box": moving
// between two DIFFERENT conversations must still put each draft back where it
// belongs, which is the feature the guard was protecting.
import { open, shot, errors } from './harness.mjs';

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? process.argv[i + 1] : '';
})();

let failed = 0;
const check = (ok, what, detail) => {
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ' — ' + detail : ''}`);
	if (!ok) failed++;
};

const s = await open({ name: 'draftkeep' });
try {
	const p = s.page;

	// The break restores the shipped behaviour, so the checks below can be shown to
	// redden on it. It patches the live function rather than a copy of the rule.
	if (BREAK === 'wipe') {
		await p.evaluate(() => {
			const el = document.getElementById('chat-input');
			window.__wipe = () => { el.value = ''; };
		});
	}

	const type = async (text) => {
		await p.fill('#chat-input', text);
		await p.waitForTimeout(80);
	};
	const composer = () => p.$eval('#chat-input', (el) => el.value);
	const face = async (which) => {
		await p.$eval('#dview-' + which, (el) => el.click());
		await p.waitForTimeout(400);
		if (BREAK === 'wipe') await p.evaluate(() => window.__wipe && window.__wipe());
	};

	// The rail's add button opens a naming dialog; the Diamond does not exist until
	// it is confirmed, and `#chat-input` is not on screen before that.
	await p.$eval('#new-diamond-btn', (el) => el.click());
	await p.waitForTimeout(800);
	await p.fill('.dlg-card input', 'DraftKeep');
	await p.$eval('.dlg-card .dlg-ok', (el) => el.click());
	await p.waitForTimeout(1200);

	// ── 1. chat face → crystal face ──────────────────────────────
	await face('chat');
	await type('half a sentence I have not finished');
	await face('crystal');
	check((await composer()) === 'half a sentence I have not finished',
		'TEXT TYPED ON THE CHAT FACE SURVIVES A SWITCH TO THE CRYSTAL FACE',
		JSON.stringify(await composer()));

	// ── 2. and back again ────────────────────────────────────────
	await face('chat');
	check((await composer()) === 'half a sentence I have not finished',
		'and it is still there on the way back',
		JSON.stringify(await composer()));

	// ── 3. crystal face → chat face ──────────────────────────────
	await face('crystal');
	await type('a different unfinished thought');
	await face('chat');
	check((await composer()) === 'a different unfinished thought',
		'TEXT TYPED ON THE CRYSTAL FACE SURVIVES A SWITCH TO THE CHAT FACE',
		JSON.stringify(await composer()));

	// ── 4. a real conversation change still swaps the draft ──────
	//
	// The guard exists for this. A fix that simply stopped touching the box would
	// carry one conversation's draft into another, which is a worse bug than the
	// one being fixed: it would put words the user wrote to a daimon into the box
	// aimed at something else.
	await p.$eval('#new-session-btn', (el) => el.click());
	await p.waitForTimeout(700);
	check((await composer()) === '',
		'A DIFFERENT CONVERSATION DOES NOT INHERIT THE DIAMOND\'S DRAFT',
		JSON.stringify(await composer()));

	const rail = await p.$$('#diamond-list > *');
	if (rail.length) {
		await rail[0].evaluate((el) => el.click());
		await p.waitForTimeout(700);
		check((await composer()) === 'a different unfinished thought',
			'and going back to the Diamond finds ITS draft, not the chat\'s',
			JSON.stringify(await composer()));
	} else {
		check(false, 'and going back to the Diamond finds ITS draft', 'no tile to click');
	}

	await shot(s, 'draftkeep');
	// A 502 on /api/ means there is no gateway behind this world -- that is what a
	// bad-gateway status IS -- and drafts are a page concern that needs none, so this
	// verifier runs either way. While a gate holds :9002 there is no gateway to have.
	// The exemption is narrow on purpose: only 502, only /api/. A 4xx or a 500 from
	// the same path is a gateway answering badly rather than a gateway absent, and
	// still fails, as does any other console error.
	const errs = errors(s).filter((e) =>
		!(/\b502\b/.test(e) && /\/api\//.test(e)));
	check(errs.length === 0, 'nothing threw, gateway-absent 502s aside',
		errs.slice(0, 2).join(' | '));
} finally {
	await s.close();
}
console.log(failed ? `\ndraftkeep: ${failed} check(s) FAILED` : '\ndraftkeep: all checks passed');
process.exit(failed ? 1 : 0);

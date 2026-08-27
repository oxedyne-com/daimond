/* i18n/en.js — every English string the interface says, in one table.
 *
 * This is the BASELINE. A translator copies it to `i18n/<locale>.js`, changes
 * the code in the `register` call and the values, and leaves the keys alone.
 * A key missing from a translation falls back to the English here rather than
 * to a blank, so a half-finished file is usable on the day it starts.
 *
 * Conventions:
 *   - `{name}` is a placeholder, filled at the call site. Keep every one that
 *     appears, in whatever order the target language wants them.
 *   - A key ending `.one` / `.other` is a plural pair, chosen by count. A
 *     language with more forms adds them and overrides the chooser.
 *   - Keys ending `_help` are tooltips, `_ph` are placeholders inside a field.
 *   - British spelling throughout the English.
 *   - Product nouns are NOT translated: Daimond, Diamond, Daimond Pro, Hands.
 *     A "Diamond" is a named object in this app, not the gemstone.
 *
 * DECLARATIONS THE CHECKER READS. `dev/i18ncheck.mjs` reads every `t`, `tOr`,
 * `tf` and `tr` call site in the app and asks whether the key it names is in
 * this table. Two shapes of call site name no key it can read, and each is
 * DECLARED here rather than skipped there -- a checker with a skip list of its
 * own is the next thing to go blind:
 *
 *   // i18n-family: <prefix> = one two three
 *       A key built by concatenation, `tOr('<prefix>' + v, …)`. Closed: the
 *       variants listed are exactly the keys this table holds under that
 *       prefix, checked both ways, so a variant added to one and not the other
 *       fails. A prefix may be declared over several lines and the variants add
 *       up; a family of twenty-two reads as groups, not as one long line.
 *
 *   // i18n-family: <prefix> = open -- <why it cannot be closed>
 *       The same, where the value comes from outside this app and no list can
 *       be right. Reported by name on every run with its member count, never
 *       silently.
 *
 *   // i18n-family: <prefix> = one-way one two -- <why the prefix is a namespace>
 *       The same, where the prefix is a NAMESPACE and not a set: other keys
 *       live under it that are not variants at all. Only the forward sweep runs
 *       -- every variant named must be in this table -- and the reverse sweep,
 *       which would demand those other keys be declared variants too, is given
 *       up. That is a weakening, so it is reported by name on every run beside
 *       the open families, and it is decided per family: `permmode.` needs it
 *       and the other eleven do not.
 *
 *   // i18n-indirect: <file> <expression> = key key
 *       A call site whose key is held in a variable. The keys it can name are
 *       written out here; every one must be in this table.
 *
 *   // i18n-indirect: <file> <expression> = open -- <why no list can be right>
 *       The same, where the expression forms names on purpose that this table
 *       does not hold -- a probe using `t`'s own loudness as its test -- or
 *       where the key arrives from the markup. Reported on every run.
 *
 * An undeclared call site of either shape FAILS the check. That is the point:
 * the declaration is a decision on the record, and a missing one is a question
 * nobody answered. Two shapes need no declaration because the key is in plain
 * sight: a conditional of literals, `t(read ? 'attach.read' : 'attach.note')`,
 * which is read for both keys, and a `t(k)` inside a `tOr`/`tf`/`tr` definition
 * naming that helper's own key parameter, which is the `tOr(…)` call above it
 * and is read there.
 */
(function () {
	'use strict';
	if (!window.DaimondI18n) return;

	window.DaimondI18n.register('en', {

	// ── Where `t` itself resolves a key ────────────────────────
	// Five calls in js/i18n.js are the lookup layer doing its own work rather
	// than call sites naming a key: the plural helper appending a form, the
	// applier reading a key out of the markup, and `pick` recovering the key or
	// keys behind a string a widget was handed. Every one of them is handed a
	// name from somewhere else, so no list here could be right.
	// i18n-indirect: i18n.js key + (n === 1 ? '.one' : '.other') = open -- `tn` appends the plural form to the key its own caller named
	// i18n-indirect: i18n.js n.getAttribute('data-i18n-label') = open -- the key is in the markup, where check 4 of dev/i18ncheck.mjs reads it
	// i18n-indirect: i18n.js spec = open -- a `data-i18n` mark, which is one key or several joined by `|`
	// i18n-indirect: i18n.js ks[0] = open -- one of the keys behind such a mark
	// i18n-indirect: i18n.js ks[i] = open -- the rest of them

	// ── Shared words ───────────────────────────────────────────
	'common.close':        'Close',
	// The spoken name of a closer, so a reader hears which of the app's
	// crosses this is rather than a fourth button called Close.
	'common.close_named':  'Close {name}',
	'admin.close_drawer':  'Close the Admin panel',
	'rail.close_rail':     'Close the Diamonds panel',
	'sheet.close':         'Close the sheet',
	'pal.close':           'Close the Go to box',
	'common.dismiss': 'Dismiss',
	'agents.read': 'Read',
	'common.close_panel':  'Close panel',
	'common.refresh':      'Refresh',
	'common.copy':         'Copy',
	'common.cancel':       'Cancel',
	'common.save':         'Save',

	// Copying an identifier. `copy.aria` wraps each `what_` so a reader hears
	// "Copy the build id" rather than five buttons all called Copy.
	'copy.aria':               'Copy {what}',
	'copy.failed':             'Could not copy',
	'copy.nothing':            'Nothing to copy',
	'copy.what_build':         'the build id',
	'copy.what_build_n':       'build {id}',
	'copy.what_fingerprint':   'your account fingerprint',
	'copy.what_device':        'the id of {name}',
	'copy.what_model':         'model id {id}',
	'copy.what_default_model': 'the default model id',
	'copy.what_handle':        'your public handle',

	// ── The top bar ────────────────────────────────────────────
	'topbar.menu':        'Menu',
	'topbar.open_menu':   'Open menu',
	'topbar.brand':       'Daimond, the daimond.app home page',
	'topbar.made_by': 'Made by Oxedyne',
	'topbar.made_with_ai': 'Code made mostly with AI',
	'topbar.up_to_date':  'Daimond is up to date',
	'topbar.about':       'About Daimond',
	'topbar.guide':       'Open the user guide',
	'topbar.guide_short': 'User guide',
	'topbar.appearance':  'Appearance and layout',

	// ── About ──────────────────────────────────────────────────
	// `about.what` is the guide's opening paragraph, near enough word for word:
	// it is already the house voice and already says it, and a second wording
	// would be a second thing to keep true.
	//
	// It said "nothing to install" until the app became installable -- a service
	// worker, a manifest and a guide section on adding it to a home screen -- at
	// which point the About box was denying a feature that had shipped. The
	// guide's own word is "nothing to DOWNLOAD", which is what stayed true: an
	// installed Daimond is the same page and the same stored work, with an icon
	// and a window of its own, and nothing is fetched to a disk.
	'about.title':     'About Daimond',
	'about.splash_alt': 'A figure flying through the night towards a diamond, above the curve of a planet.',
	'about.what':      'Daimond is an AI agent workspace that runs in your browser. There is no server account and nothing to download. Your chats, keys and files stay on this device.',
	// The link out to the delivery check. Painted rather than bound to a
	// `data-i18n` mark -- see the note at daimond.js's `about.verify` call.
	'about.verify':    'Check this build against the published source',

	// ── Panel names ────────────────────────────────────────────
	// Short: they ride in a chip row and a phone tab bar.
	'panel.rail':    'Diamonds',
	'panel.ai':      'AI',
	'panel.web':     'Web',
	'panel.doc':     'Doc',
	'panel.preview': 'Preview',
	// "Email message" and not "Message": the Social panel holds messages of its
	// own, and two things called Message is the collision decision 17 removes.
	'panel.msg':     'Email message',
	'panel.tools':   'Tools',
	'panel.compose': 'Compose',
	'panel.graph':   'Graph',
	'panel.agents':  'Agents',
	'panel.pending': 'Pending',
	'skills.menu':   'Skills you can call',
	'skills.none':   'No skills yet. Put a markdown file in {dir} and its name becomes a command.',
	'skills.draft_badge':   '· draft',
	'skills.draft_title':   'Install /{name}?',
	'skills.draft_ask':     'Daimond drafted this skill. Installing it writes exactly the text below to {into}, where typing /{name} will run it.',
	'skills.draft_install': 'Install',
	'skills.draft_bad':     'This draft cannot be installed',
	'panel.mail':    'Email',
	'panel.work':    'Workspace',
	'panel.spend':   'Spending',
	'panel.term':    'Terminal',

	// ── The chip row ───────────────────────────────────────────
	// {name} is a panel's name, from `panel.*` above.
	'chip.dock_full':    'The dock is full. Choose a larger tiling in Appearance, or close a panel.',
	'chip.show':         'Show {name}',
	'chip.close':        'Close {name}',
	'chip.open':         'Open {name}',
	'chip.open_instead': 'Open {name} in place of the panel beside the chat',
	'chip.more.one':     '{n} more panel',
	'chip.more.other':   '{n} more panels',

	// ── The panel gallery and the command palette ──────────────
	'gallery.title':    'Panels',
	'pal.title':        'Go to',
	'pal.placeholder':  'Go to a panel, or a setting…',
	'pal.results':      'Results',
	'pal.nothing':      'Nothing matches.',
	'pal.kind_panel':   'Panel',
	'pal.kind_theme':   'Theme',
	'pal.kind_size':    'Text size',
	'pal.kind_dock':    'Dock',
	'pal.kind_lang':    'Language',
	'pal.kind_ccy':     'Currency',
	'pal.kind_permmode': 'Permissions',
	'pal.hint_open':    'open',
	'pal.hint_full':    'dock full',
	'pal.hint_current': 'current',

	// ── The rail ───────────────────────────────────────────────
	'rail.diamonds':             'Diamonds',
	'rail.diamonds_help':        'A repeatable method, distilled from a conversation.',
	'rail.new_diamond':          'New Diamond',
	'rail.unnamed_diamond': 'Unnamed Diamond',
	'rail.chats':                'Chats',
	'rail.chats_help':           'Raw conversation. A Diamond is cut from it.',
	'rail.new_chat':             'New chat',
	'rail.chats_menu':           'More',
	'rail.delete_all_chats':     'Delete all chats',
	'layout.handle':             'Drag to resize, double-click to reset',

	// ── Admin ──────────────────────────────────────────────────
	'admin.identity':        'Your Daimond identity',
	'admin.settings':        'Settings',
	'admin.local_identity':  'Local identity',
	'admin.account_help':    'Your account. Click for logout, passphrase and backup.',
	'admin.locked':          'Locked',
	'admin.locked_help':     'Locked. Enter your passphrase to unlock.',
	'admin.no_account':      'No account',
	'admin.no_account_help': 'Your API key is stored unencrypted. Click to create an account and encrypt it.',
	'admin.no_crypto_help':  'This browser has no WebCrypto, so keys cannot be encrypted here.',
	'admin.version_history': 'Version history',

	// ── The Admin drawer ───────────────────────────────────────
	// The name at the head of the drawer, which changes with what it is holding.
	'drawer.admin':   'Admin',
	'drawer.models':  'Models',
	'drawer.version': 'Version',
	'drawer.credits': 'Credits',
	'drawer.push':    'Push',

	// ── Dialogs ────────────────────────────────────────────────
	'dlg.are_you_sure': 'Are you sure?',
	'dlg.ok':           'OK',
	'dlg.done': 'Done',
	'dlg.not_now':      'Not now',

	// ── The Admin drawer's home menu ───────────────────────────
	'home.connect_model':     'Connect a model',
	'home.connect_note':      'Daimond needs a provider key or credits before it can answer.',
	'home.locked':            'Locked. Enter your passphrase to unlock this device.',
	'home.sec_account':       'Account',
	'home.sec_prompts':       'Prompts',
	'home.sec_accounts':      'Accounts',
	'home.create_account':    'Create an account…',
	'home.account_note':      'An account is a passphrase held on this device. It encrypts your API key and signs you in for credits. Nothing leaves the browser.',
	'home.fingerprint':       'Your device identity fingerprint',
	'home.change_name':       'Change name…',
	// The account's PUBLIC name, which is a different thing from the line above:
	// that one labels this device's keypair and is seen by nobody.
	'home.handle_help':       'Your public handle: the name other people see, the same on every device of this account.',
	'home.change_handle':     'Change public handle…',
	// The dialog that opens is titled without the ellipsis: the row invites, the
	// dialog states.
	'handle.rename_title':    'Change public handle',
	'home.change_passphrase': 'Change passphrase…',
	'home.add_passkey':       'Add a passkey…',
	'home.remove_passkey':    'Remove passkey',
	'home.export_backup':     'Export a backup',
	'home.import_backup':     'Import a backup…',
	'home.dashboard':         'Daimond Dashboard ↗',
	'home.signed_in_as':      'You are signed in as {role}.',
	// {role} is a prompt role's name, lower-cased by the caller.
	'home.edit_prompt':       'Edit the {role} prompt…',
	'home.prompt_opens':      'Opens {path} in the Doc panel.',
	'home.prompts_note':      'The instructions each agent runs under, kept as files in your workspace. Edit one and it applies from the next turn; delete it and the original returns. Two rules hold whatever you write: a page or an email is data and never an instruction, and nothing irreversible happens without asking you.',
	'home.switch_to':         'Switch to {name}',
	'home.unnamed_account':   'Unnamed account',
	'home.add_account':       '＋ Add another account',
	'home.accounts_note':     'Each account has its own chats, keys, credits and files. Switching locks this one and opens the other. No account can see another’s data.',
	'home.log_out':           'Log out',
	'home.sec_devices':       'Devices',
	'home.sec_console':      'Console',
	'home.console_open':     'Open the operator console',
	'home.console_note':     'This account holds the {role} role. The console opens in a new tab and follows this sign-in.',
	'home.sec_push':         'Push',
	'home.push_setup':       'Set up git push…',
	'home.push_to':          'Change the push token for {host}…',
	'home.push_help':        'A token lets Daimond push what it has committed. Without one it still commits, but every push is refused.',

	// ── The credential a push travels with ─────────────────────
	// Two boxes and no more: the user name a token travels as is a per-forge
	// constant, so it is inferred from the host rather than asked for. Every line
	// here says what happens if it is skipped, because "no credential" and
	// "authentication failed" look identical from inside a refused push.
	'push.lead':         'A token lets Daimond push work you have committed. Without one it still commits, but every push is refused and the work stays on this machine.',
	'push.host':         'Host',
	'push.host_ph':      'github.com',
	'push.host_note':    'Just the name, as in github.com. No https://, no port, no path. Only this host is authenticated; a repository anywhere else is refused, and your token never reaches it.',
	'push.token':        'Token',
	'push.token_ph':     'Paste a token with push access',
	'push.token_note':   'Push access is enough; the token never needs more. Daimond only pushes, only fast-forward, only to origin. Force, delete, mirror and any other remote are refused whatever the token allows. Empty this box and save to remove it.',
	'push.save':         'Save',
	'push.privacy':      'The token is encrypted under your passphrase and kept in this browser. It is never shown again, never sent to us, never given to a model. Without an account there is nothing to encrypt it with, so it is held for this tab only and asked for again after a reload.',
	'push.set':          'Set. A push reaches {host}.',
	'push.none':         'Not set. Every push is refused until a token is saved here.',
	'push.saved':        'Saved. Encrypted under your passphrase and used each time you unlock.',
	'push.cleared':      'Removed. Pushes are refused again until a token is saved here.',
	'push.session_only': 'Held for this tab only. With no account there is nothing to encrypt it with, so a reload asks for it again. Create an account to keep it.',
	'push.err_host':     'Enter the host the push goes to, as in github.com, or empty the token box to remove the credential.',
	'push.err_not_held': 'That was not accepted, so no push credential is held. Check the host and the token.',
	'push.not_resealed': 'Your passphrase changed, but the push token could not be re-encrypted under it. Pushing works until you reload. Set the token again to keep it.',
	// What the token is CALLED, for a list of what did not survive a passphrase
	// change. Never shown on its own; the sentence above is what a person reads.
	'push.the_token':    'your push token',

	// ── The devices that sync this account ─────────────────────
	// The list is what it says it is: devices that have SYNCED. A linked device
	// holds the same keys as this one, so there is nothing to revoke and the
	// wording must not imply there is.
	'devices.on_platform': '{brand} on {platform}',
	'devices.unknown':     'This device',
	'devices.this_device': 'this device',
	'devices.only_this':   'Only this device syncs this account.',
	// Naming a device. The name is the user's own words, so it never leaves the
	// browser except inside the encrypted parcel; the wording says so, because a
	// list of the user's devices is exactly where that question is asked.
	'devices.rename_title': 'Name this device',
	'devices.rename_body':  'A name to tell this device from the others. Empty the box to go back to “{derived}”. The name is stored with your own encrypted data and travels only to your other devices.',
	'devices.rename_aria':  'Rename {name}',
	'devices.note':        'Devices that have synced this account. One that holds the account but has never synced is not listed. Nothing here signs a device out. A linked device holds the same keys as this one, so it has to be dealt with there.',
	'devices.remove_aria': 'Remove {name}',
	'devices.remove_body': '“{name}” comes off this list. That does not sign the device out. It holds the same keys as this one, so it reappears the next time it syncs.',
	'devices.remove':      'Remove',
	'devices.remove_title':'Remove this device',

	// ── The status rows under the rail ─────────────────────────
	'astat.offline':             'Offline',
	'astat.service_unreachable': 'Account service unreachable',
	'astat.no_account':          'No credits account',
	'money.daimond_credits': 'Daimond credits',
	'money.own_key':         'Your {provider} key',
	'money.own_keys':        'Your own keys',
	'money.left_at_rate':    '~{mins} min at this rate',
	'money.spent_so_far':    '{amt} spent',
	'money.spent_help':      'Your provider reports no balance, so this is what has gone through this key since Daimond started counting.',
	'money.estimate_help':   'Your own figure, less what has been spent since. Update it in Models when you top up.',
	'astat.locked':          'Locked',
	'astat.credits':             'Credits',
	'astat.credits_help':        'Buy credits, or connect your own provider key',
	'astat.pro_owned':           'Owned',
	'astat.pro_owned_help':      'You have Daimond Pro. Sync, cloud storage and Email are on.',
	'astat.pro_ended':           'Licence ended',
	'astat.pro_ended_help':      'Your Pro licence has ended. Sync, cloud storage and Email are off; everything on this device is untouched.',
	'astat.pro_upgrade':         'Upgrade to Pro',
	'astat.pro_upgrade_help':    'Buy five years of Pro to turn on sync, cloud storage and Email.',
	'astat.tools':               'Tools · {have}',
	'astat.tools_of':            'Tools · {have} of {all}',
	'astat.tools_help':          'What Daimond can do, and what the rest would cost.',
	'astat.workspace_browser':   'Workspace · Browser',
	'astat.workspace_native':    'Workspace · Machine',
	'astat.evictable':           'evictable',
	'astat.store_of':            '{used} of {quota} this browser allows.',
	'astat.store_persistent':    'Marked persistent, so the browser will not evict it.',
	'astat.store_evictable':     'Not persistent: the browser may evict this workspace under storage pressure. Click to ask for permanent storage.',
	'astat.not_connected':       'not connected',
	'astat.native_help':         'Let the agents work on a real folder on this machine.',
	'astat.n_files':             '{n} files',
	'astat.counting':            'Counting. Click to stop.',
	'astat.part':                '(part)',
	'astat.counted':             '{n} files under {folder}.',
	'astat.counted_partial':     '{n} files under {folder}, counted until you stopped it.',
	'astat.count_again':         'Click to count again.',
	'astat.count_offer':         'Click to count it. The browser will not say how big a real folder is, and counting reads every file, so a large tree takes a while. You can stop at any point.',

	// ── Pro, in its own words ──────────────────────────────────
	// Pro is a FIVE-YEAR licence, not a perpetual one: it gates sync, cloud
	// storage and Email, which are services Oxedyne has to keep running, and a
	// licence with no end to a service is a promise to run it for ever. Terms §7
	// says so, and nothing here may say otherwise -- what the app claims at the
	// point of sale is the claim the Terms have to support. "No subscription.
	// Nothing renews." stays: it is true, and it is the point.
	'pro.owned_plain':     'You have Daimond Pro. Cross-device sync, cloud storage and Email are on. No subscription, and nothing renews.',
	'pro.offer_plain':     'One payment, and Pro runs for five years. It turns on cross-device sync, cloud storage, and Email, so your own mail is read and sent in the workspace. No subscription, and nothing renews: at the end of five years you decide whether to buy again. Inference, bandwidth and other metered use are still paid from credits.',
	'pro.term_note':       'Pro runs for five years from purchase.',
	'pro.ends_on':         'Your Pro licence ends on {date}.',
	'pro.ended_on':        'Your Pro licence ended on {date}. Sync, cloud storage and Email are off; everything on this device is untouched, and you can still pull down anything already stored.',
	'pro.buy_again':       'Buy another five years',
	'pro.buy_again_priced': 'Buy another five years for {price}',
	'pro.checkout_failed': 'Could not start checkout',

	// ── The egress gate ────────────────────────────────────────
	// The last thing between a steered agent and a request that carries the
	// user's own information out. {host} is a hostname; keep it where a reader
	// will look for it.
	'egress.type_title':  'Type into {host}?',
	'egress.type_body':   'This turn has read content from outside your workspace. Daimond now wants to type into the page at {host}, which may send it on.\n\nWhat it wants to enter:\n\n{text}\n\nIf you did not expect this, decline.',
	'egress.type_ok':     'Type it',
	'egress.nothing':     '(nothing)',
	'egress.act_title':   'Act on {host}?',
	'egress.act_body':    'This turn has read content from outside your workspace. Daimond now wants to act on the page at {host}.\n\nWhoever wrote the page wrote its links, and following one can carry information away.\n\nAllow this only if you expected it.',
	'egress.act_ok':      'Allow acting on {host}',
	'egress.heavy_title': 'Send this to {host}?',
	'egress.heavy_body':  'This turn has read content from outside your workspace. Daimond now wants to reach {host} with an unusually long address.\n\nAn address can carry information out. This one carries:\n\n{text}\n\nIf you did not expect this, decline. Nothing is lost but the one request.',
	'egress.heavy_ok':    'Send it anyway',
	'egress.reach_title': 'Reach {host}?',
	'egress.reach_body':  'This turn has read a web page or a message from outside your workspace, and something in it may be steering Daimond.\n\nIt now wants to reach {host}, which it has not visited before. Anything it knows could ride in that address.\n\nAllow this only if you expected it.',
	'egress.reach_ok':    'Allow {host}',
	// A search, where the thing leaving is the QUERY rather than an address.
	// {query} is the user's own search text, already truncated, and it stands
	// alone in its own paragraph -- never wrapped in quotation marks, because
	// the query may contain quotes of its own and a mismatched pair reads as
	// corruption. {engine} is a display name and is sometimes a proper noun
	// (Brave Search, Serper) and sometimes a translated phrase (Daimond
	// credits). Every \n\n is load-bearing: five paragraphs, four breaks, and
	// a consent dialog run together into a wall is a dialog nobody reads. The
	// clause about the setting answers the question a real user asked -- why
	// that engine -- and the last sentence tells a frightened reader that
	// declining is cheap. Neither may be compressed away.
	'egress.search_title': 'Search the web?',
	'egress.search_body':  'This turn has read content from outside your workspace. Daimond now wants to search the web.\n\nWhat it wants to search for:\n\n{query}\n\nSearching with {engine}, which is your setting. The query is what leaves this device.\n\nIf you did not expect this, decline. Nothing is lost but the one search.',
	'egress.search_ok':    'Run this search',

	// ── A chat tile in the rail ────────────────────────────────
	'chat.tool_refused':   'refused',
	'chat.tool_failed':    'failed',
	'chat.copy_message':   'Copy message',
	'chat.include_turn':   'Include this turn when folding',
	'chat.connect_to_chat': 'Connect a provider, or unlock, to chat on this model.',
	'tile.cost_estimated': 'Estimated. This model is not in the price table.',
	'tile.cost_so_far':    'Cost so far for this chat.',
	'tile.click_to_open':  'Click to open, double-click to rename',
	'tile.settings': 'Settings for this tile',
	'tile.settings_named': 'Settings for "{name}"',
	'tile.close_named': 'Close "{name}"',
	// The name field in a chat's cog dialog. A chat needs no name, so the hint
	// says what happens when it is left empty rather than asking for one.
	'tile.dlg_name': 'Name',
	'tile.dlg_name_hint': 'Unnamed: the rail shows the time',
	'tile.dlg_running': 'Running',
	'tile.dlg_detail': 'Detail',
	'tile.detail_simple': 'Simple',
	'tile.detail_simple_help': 'The name, whether it is running, and what is waiting.',
	'tile.detail_max': 'Max',
	'tile.detail_max_help': 'Models, context, cost, version and when it last moved.',
	'tile.spend_help': 'What this Diamond has cost, over {turns} turns.',
	'tile.detail_default': 'Default ({what})',
	'tile.detail_default_help': 'Follow the view set in Appearance, and any change to it.',
	'tile.detail_note': 'Tiles follow the view unless you set one differently here.',

	// ── The models a Diamond runs on, and the context its chats hold ──
	'tile.dlg_models': 'Models',
	'tile.model_daimon': 'Daimon',
	'tile.model_daimon_help': 'The model this Diamond thinks with. The conversation carries over; use Fresh daimon to end it.',
	'tile.daimon_reset':      'Fresh daimon',
	'tile.daimon_reset_help': 'End this daimon’s conversation without folding it into the crystal',
	'tile.daimon_reset_title': 'Start a fresh daimon?',
	'tile.daimon_reset_body': 'This daimon’s conversation ({n} messages) is discarded, and the next instruction starts a new one. Nothing goes into the crystal — fold it first if any of it is worth keeping. The crystal, the files and the links are untouched.',
	'tile.daimon_reset_ok':   'Discard the conversation',
	'tile.daimon_reset_done': 'A fresh daimon. The crystal is untouched.',
	'tile.daimon_reset_busy_title': 'The daimon is still working',
	'tile.daimon_reset_busy': 'This daimon is in the middle of a turn. Its answer would land in the conversation you are about to discard, and so would the conversation the model is holding — so nothing is discarded yet. Stop the turn first: while it runs, the composer’s button is Stop.',
	'tile.model_workers': 'Workers',
	'tile.model_vision': 'Workers, images',
	'tile.model_vision_help': 'The model a worker runs on when its task names an image, and the model a worker is moved to when the one it is on turns out not to take pictures. Daimond cannot tell in advance which models see, so the choice is yours; it acts on the first refusal.',
	'tile.model_same_as_text': 'Same as the daimon',
	'tile.model_none': 'none',
	'tile.diamond_model_help': 'This Diamond thinks with {model}.',
	'tile.model_note': 'A worker keeps the model it started on. A new model applies to the next one dispatched.',
	'tile.model_changed': 'Daimon moved from {from} to {to}. The conversation continues.',
	'tile.model_change_note': 'Daimon moved from {from} to {to}.',
	'tile.model_change_unlogged': 'The model changed, but the history entry could not be written.',
	'tile.dlg_context': 'Context',
	'tile.context_line': '{used} of {all} used. Folds at {at}%.',
	'tile.context_unknown': 'This model publishes no context window, so there is nothing to measure against until a request is refused.',
	'tile.context_used_folds': 'Context window used: {used} / {all}. Folds at {at}%.',
	'tile.fold_context': 'Fold now',
	'tile.fold_context_help': 'Summarise the earlier part of this conversation now, before it fills up',
	'tile.fold_context_title': 'Fold this conversation?',
	'tile.fold_context_body': 'A model summarises the earlier part, which costs a call, and the summary becomes what this chat remembers. The messages on screen stay where they are.',
	'tile.fold_context_ok': 'Fold',
	'tile.fold_nothing': 'Nothing to fold. This conversation is already as short as it goes.',
	'tile.fold_mid_turn': 'Wait for this turn to finish before folding.',
	'tile.fold_unavailable': 'Nothing has been said in this chat yet.',
	'tile.fold_failed': 'The fold did not finish',

	'tile.dlg_delete': 'Delete',
	'tile.start':          'Start',
	'tile.start_help':     'Confirm the model and start this chat',
	'tile.workers':        'Workers',
	'tile.worker_model_help': 'The model workers run on. Left alone, they run on the chat’s own model.',
	'tile.folded':         'Folded',
	'tile.fold_all':       'Fold all',
	'tile.folded_help':    'Already folded into "{name}". Fold again to add what is new since.',
	'tile.fold_all_help':  'Fold this whole chat into a Diamond',
	'tile.dlg_colour':  'Colour',
	'tile.colour_bg':   'Background',
	'tile.colour_fg':   'Text',
	'tile.colour_clear':'Use the theme’s colours',
	'tile.colour_faint':'These two contrast at {ratio}:1, below the usual {min}:1 floor for text this size. Left as chosen.',

	// ── The spend governor ─────────────────────────────────────
	'gov.past_budget': 'Well past your run budget',
	'gov.faster':      'Spending faster than usual',
	'gov.per_min':     '{rate}/min',
	'gov.run_spent':   'This run has spent {spent} of a {budget} pace budget. A large fan-out asks before it runs.',
	'gov.fanout_body.one':   'This Diamond is about to run {n} agent, at about {total} ({each} each).',
	'gov.fanout_body.other': 'This Diamond is about to run {n} agents, at about {total} ({each} each).',
	'gov.burst_spent': 'This burst has spent {spent} already.',
	'gov.would_pass':  'That would pass your {budget} pace budget for one run.',
	'gov.run_n.one':   'Run {n} agent',
	'gov.run_n.other': 'Run {n} agents',
	'spend.includes_estimate': 'Estimated. At least one model here is not in the price table.',

	// ── Models and provider keys ───────────────────────────────
	'models.lead':                  'A key for each provider you use. New chats and Diamonds start on the default model; any model can be picked for a single chat.',
	'models.add':                   '+ Add provider',
	'models.provider':              'Provider',
	'models.choose_provider':       'Choose a provider…',
	'models.custom_provider':       'Custom (advanced)…',
	'models.base_url':              'Base URL',
	'models.api_key':               'API key',
	'models.api_key_ph':            'Paste your API key',
	'models.default_model':         'Default model',
	'models.choose_provider_first': 'Choose a provider first…',
	'models.model_id_ph':           'Model id (type manually)',
	'models.default_note':          'New agents use this unless you choose another for them.',
	'models.save_start':            'Save & start',
	'models.privacy':               '<strong>Everything stays on this device.</strong> Your keys, chats and files live only in this browser, and nothing is sent to us.',

	// The Models panel: a row per provider, expandable to the models it runs.
	// A vendor's name (Groq, Fireworks AI) is a proper noun and is NOT here;
	// these two are names Daimond made up for itself.
	'models.credits_row':          'Daimond credits',
	'models.custom_provider_name': 'Custom provider',
	// A stand-in where the gateway did not name the company behind a minted key.
	// It goes into {provider} slots built for a BRAND NAME ("via {provider}",
	// "Remove {provider}"), so it must read as a name, not as a noun phrase with
	// an article -- "via the provider" forces an article a Romance language
	// then has to fight.
	'models.the_provider':         'your provider',
	'models.empty':                'No provider yet. Add one to give Daimond a model to think with.',
	'models.balance_left':         '{amount} left',
	'models.via':                  'via {provider}',
	'models.count.one':            '{n} model',
	'models.count.other':          '{n} models',
	'models.row_paid_help':        'These models spend your Daimond balance. Your browser calls {provider} directly with a key minted for you; nothing passes through Daimond.',
	'models.row_own_help':         'These models are billed to your own {provider} account. They do not touch your Daimond balance.',
	// What a row says about its key. The symbol in front is added by the code.
	'models.sealed':               'sealed',
	'models.key_set':              'key set',
	'models.no_key':               'no key',
	'models.connecting':           'connecting…',
	'models.no_credits':           'no credits',
	'models.offline':              'account service unreachable',
	'models.could_not_connect':    'could not connect',
	'models.unlock_to_use':        'unlock to use',
	'models.sealed_unlock':        'sealed, unlock to use',
	'models.top_up_to_use':        'top up to use',
	'models.top_up':               'Top up your credits →',
	'models.ask_provider':         'Ask this provider what it can run',
	'models.ask_provider_again':   'Ask this provider again',
	'models.list_asked':           'Listed {when}.',
	'models.list_never':           'Never asked.',
	'models.add_key_first':        'Add a key first',
	'models.asking':               'Asking…',
	// One model in the list.
	'models.econ_credits':         'credits',
	'models.econ_own':             'your key',
	'models.favourites': 'Favourites',
	'models.is_default':           'default',
	'models.model_is_default':     'New chats and Diamonds start on this model.',
	'models.model_make_default':   'Make this the model new chats and Diamonds start on.',
	'models.model_paid':           'Spends your Daimond balance, via {provider}.',
	'models.model_own':            'Billed to your own {provider} account.',
	'models.model_twin':           'Another provider serves a model of this name. This is the {provider} one.',
	'models.remove':               'Remove {provider}',
	'models.starts_on':            'New chats start on: {model}',
	'models.no_default':           'No default model yet. Star one above.',
	'models.none_yet':             'No provider yet',
	'models.err_refused':          'The account service refused (HTTP {status}).',
	'models.err_bad_key':          'The account service sent a key Daimond cannot use.',
	'models.err_no_key':           'That provider has no key yet.',
	'models.err_key_refused':      'The provider refused the key (HTTP {status}).',
	// What is left on a provider key, and how that is known. The manual line is
	// deliberately not called a balance: it is the user's own figure less an
	// estimate, and saying so is the whole point of showing it.
	'models.credit_auto':          '{amount} left on this key, as the provider said at {when}.',
	'models.credit_manual':        '{amount} left. Your {base} from {when}, less about {spent} spent since.',
	'models.credit_unknown':       'Nothing known about what is left on this key.',
	'models.credit_check':         'Ask what is left',
	'models.credit_recheck':       'Ask again',
	'models.credit_probe_failed':  '{provider} would not say what is left. Tell Daimond instead.',
	'models.credit_base_ph':       'e.g. 12.50',
	'models.credit_base_label':    'What is on this key now, in US dollars',
	'models.credit_base_set':      'I have this much, as of now',
	'models.credit_base_update':   'Update my figure',
	'models.credit_base_bad':      'That is not an amount. Enter a number of US dollars.',
	// A probed figure that this device has since watched money leave. It stops
	// claiming to be what the provider said, because it no longer is.
	'models.credit_auto_spent':    '{amount} left. The provider said {base} at {when}, less about {spent} spent here since.',
	// How old the reading is. Without it a figure that has quietly stopped
	// updating looks exactly like one that is current.
	'models.age_now':              'Checked just now.',
	'models.age_mins.one':         'Checked {n} minute ago.',
	'models.age_mins.other':       'Checked {n} minutes ago.',
	'models.age_hours.one':        'Checked {n} hour ago.',
	'models.age_hours.other':      'Checked {n} hours ago.',
	'models.age_days.one':         'Checked {n} day ago.',
	'models.age_days.other':       'Checked {n} days ago.',
	'models.age_failed':           'The last check did not answer, so this figure has not moved since.',

	// ── Search ─────────────────────────────────────────────────
	// The engine is the USER's setting, not the model's choice, so every string
	// here belongs to the settings row rather than to a tool result. Engine
	// names (Brave, Exa, Tavily, Serper) are proper nouns and are not here, for
	// the same reason a provider's name is not: see the note above
	// `models.credits_row`.
	'search.head':            'Search',
	'search.engine':          'Search engine',
	// An allowance, not a free key: the key costs nothing and the queries past
	// the allowance are billed by the vendor, to the user. Deliberately no
	// figure and no engine named -- a number here goes stale silently when a
	// vendor changes its tier, and nobody re-reads eight locales to catch it.
	// The per-engine line under the field (`.search-engine-note`) is the one
	// that can be accurate.
	'search.engine_note':     'Which service Daimond searches with. Most give a free allowance each month if you bring your own key.',
	'search.credits':         'Daimond credits',
	'search.key':             'API key',
	'search.key_note':        'Kept on this device, sealed with your passphrase, and sent only with the search it pays for.',
	// {engine} is an engine's name, e.g. Brave. It is never translated.
	'search.no_key':          'Add a key for {engine}, or switch to Daimond credits.',
	// What is being searched: the open web, the news, or scholarly work. Three
	// peers in one pulldown, so none of them takes an article, and the third
	// is "Academic" rather than "Research" -- French would otherwise have one
	// word, Recherche, doing three jobs in one panel: the heading, the engine
	// and the corpus.
	// Reached through a lookup table in daimond.js rather than by name, so the
	// three keys are written out here for the checker: it can read a literal and
	// it can read a prefix, and it must never guess at a variable.
	// i18n-indirect: daimond.js kind[k] = search.kind_web search.kind_news search.kind_academic
	'search.kind_web':        'Web',
	'search.kind_news':       'News',
	'search.kind_academic':   'Academic',
	// Named, not "that engine": two of the three places this is reached from
	// -- the gateway's refusal and the operator console -- have no pulldown
	// above them for a "that" to point at.
	'search.refused_serper':  '{engine} can only be used with your own key.',
	// The per-engine allowance under the key field -- the line that CAN be
	// accurate, where `search.engine_note` deliberately is not. {n} arrives
	// already grouped by toLocaleString(), so no separator of our own goes in;
	// the reader gets 1,000 or 1 000 or 1.000 as their locale wants it. "Last
	// time we looked" is not padding: it is a third party's pricing, it will
	// go stale, and the hedge is what keeps this a report rather than a
	// promise. Keep it in every language.
	'search.free_month':      '{engine}: about {n} searches a month free, last time we looked.',

	// ── Credits, packs and Pro ─────────────────────────────────
	// Anything the user is CHARGED says US dollars out loud. See `billing.*`.
	'credits.lead':      'Buy credits and Daimond runs the model for you, with no provider key to manage. No subscription. You keep what you buy, and nothing is charged again unless you turn on auto-reload.',
	'credits.balance':   'Balance: {amount}',
	'credits.balance_unavailable': 'Balance unavailable.',
	'credits.see_spend': 'See where your spending goes →',
	'credits.offline':   'The Daimond account service is unreachable, so credits are unavailable. Your own provider key still works.',
	'credits.need_account': 'Credits let you use Daimond without a provider key. They need an account: a passphrase kept on this device.',
	'credits.need_passcode': 'Credits need an account, and this gateway is not opening new ones while the beta is closed. Redeem a passcode above to open one.',
	'credits.create_account': 'Create an account',
	'credits.added':     'Credits added',
	'credits.now':       'Your balance is now {amount}.',
	'pro.owned':         '<b>You have Daimond Pro.</b> Cross-device sync, cloud storage and Email are on. No subscription, and nothing renews.',
	'pro.offer':         '<p><b>Daimond Pro, for five years.</b> One payment. Pro turns on cross-device sync, cloud storage, and Email, so your own mail is read and sent in the workspace.</p>',
	'pro.fine':          'No subscription, and nothing renews. Metered use (inference, bandwidth, storage beyond the free tier) is paid from credits, whether or not you have Pro.',
	'pro.buy':           'Buy five years of Pro',
	'pro.buy_priced':    'Buy five years of Pro for {price}',
	'billing.usd_note':  'You are billed in US dollars; the converted figure is approximate.',
	'billing.rates_as_of': 'Rates as of {date}, approximate.',

	// ── The closed beta and its passcode ───────────────────────
	// The gateway refuses to open a new account while the beta is shut, and a
	// passcode is the one way past it. Nothing here may contradict what the
	// gateway itself says (gateway/src/handlers/account.rs, `beta_closed`): that
	// only the ACCOUNT is closed, that Daimond is free and works with no account
	// at all on a provider key of the user's own, and that a passcode opens one.
	// And nothing here may soften WHICH refusal a code met — "never issued",
	// "already used" and "run out of time" send a person to three different
	// places, which is the whole reason the gateway tells them apart.
	//
	// NOR MAY IT PROMISE WHAT A FREE ACCOUNT DOES NOT GIVE. Since 2026-08-17 a
	// beta code grants the FREE tier unless the operator asks for Pro, and Pro
	// bundles exactly two things — `ProBundled::ALL` in
	// `gateway/src/handlers/common.rs` names sync and Email, and cloud upload
	// rides the sync unlock. So a free account keeps the app, its credits, the
	// inference bought with them and the telemetry it consented to, and has no
	// sync, no cloud storage and no Daimond Email. The four-item list these
	// strings used to carry ("credits, sync between devices, mail, and inference
	// bought for you") promised two things a free code does not deliver, to
	// every applicant who reached the door.
	'beta.title':              'Closed beta',
	'beta.title_unavailable':  'No account was made',
	'beta.title_plain':        'Beta passcode',
	'beta.lead_beta_only':     'Daimond is not opening new accounts on this server yet. Only the account is closed, not the app: Daimond is free, runs in your browser, and works with no account at all on a provider key of your own. An account adds credits and inference bought for you, so you need no key of your own. Sync between devices and Daimond Email come with Pro, which is bought separately.',
	'beta.lead_unavailable':   'This server could not say whether it is open to new accounts, so it made none. Nothing is wrong with your device, and Daimond works on your own provider key meanwhile. Try again in a moment.',
	'beta.lead_no_reason':     'This device has no Daimond account yet.',
	'beta.have_code':          'If Oxedyne sent you a beta passcode, put it in here. It works once, on this device.',
	'beta.no_code':            'No passcode? Places in each wave of the test are given out by application.',
	'beta.apply':              'Apply to test Daimond',
	'beta.code':               'Passcode',
	'beta.code_ph':            'abcd-efgh-ijkl',
	'beta.redeem':             'Redeem',
	'beta.redeeming':          'Redeeming…',
	'beta.try_again':          'Try again',
	'beta.enter_code':         'Enter a passcode',
	'beta.still_closed':       'Still no account. The server gave the same answer.',
	'beta.err_enter_code':     'Type the passcode you were sent.',
	'beta.err_locked':         'Unlock Daimond first: a passcode is redeemed onto this device’s key.',
	'beta.err_no_identity':    'This device has no identity to redeem a passcode onto. Create one first.',
	'beta.err_unknown':        'That passcode is not one we issued. Check it character by character — twelve characters, in three groups.',
	'beta.err_spent':          'That passcode has already been used. Each one works once, on one device.',
	'beta.err_expired':        'That passcode has expired. Ask Oxedyne for another.',
	'beta.err_throttled':      'Too many passcode attempts from this connection. Wait a while and try again.',
	'beta.err_generic':        'That passcode was not accepted.',
	'beta.err_unreachable':  'The Daimond account service could not be reached, so the passcode was not used. Try again shortly.',
	'beta.done_title':         'You are in',
	'beta.done_pro':           'This device has a Daimond account, and Pro is on it: sync between devices, cloud storage and Email.',
	'beta.done_plain':         'This device has a Daimond account. Everything in the app works, and credits buy inference for you, so you need no provider key of your own. Sync between devices, cloud storage and Email are what Pro adds — buy it whenever you want them.',
	'beta.done_handle':        'Other people see this account as {handle}.',
	'beta.done_not_signed_in': 'The passcode was spent and the account exists, but this device could not finish signing in just now. It will try again on its own.',

	// ── The one thing a tester is asked to agree to ────────────
	// Shown after the passcode is spent and the account exists, so declining
	// cannot cost anybody anything, and again in the Credits drawer for as long
	// as the account does -- which is what makes "you can turn it off" true.
	//
	// NOTHING HERE MAY OVERSTATE OR UNDERSTATE WHAT IS SENT. The whole of it is
	// `www/js/telemetry.js`: twenty events, each one integer, and no text field
	// anywhere in the payload. `tel_never` is the sentence that matters most and
	// it is a claim about the code, not a promise about our care -- so it must
	// not be softened into "we do not collect personal data" in any language.
	// `tel_who` says it is not anonymous, because it is not: the numbers arrive
	// on the account the passcode made, and the passcode carries the note we
	// wrote about who it was for.
	'beta.tel_title':    'Send usage counts?',
	'beta.tel_title_on': 'Usage counts',
	'beta.tel_lead':     'The test is far more useful to us if Daimond can report how it is being used. It sends numbers only: which of twenty things happened, how many milliseconds into the session, and one count each — how long a turn took, which panel was opened, how many errors were thrown.',
	'beta.tel_never':    'It never sends words. Not a message, not a file name, not a Diamond’s name, not a path, not an error message. There is no box for them, and our server refuses a report that carries any.',
	'beta.tel_who':      'It goes to Oxedyne on the account your passcode made, so we can see which numbers are yours and come back and ask you about them.',
	'beta.tel_free':     'Saying no costs you nothing. Your account, your credits and everything else stay exactly as they are, and nothing in the app behaves differently.',
	'beta.tel_more':     'What is sent, in full',
	'beta.tel_yes':      'Send usage counts',
	'beta.tel_no':       'Do not send',
	'beta.tel_on':       'Daimond is sending usage counts for this account: numbers only, never words.',
	'beta.tel_stop':     'Stop sending usage counts',

	// ── The front door ─────────────────────────────────────────
	// The strip above the passphrase form, for a browser that has never held an
	// account. Three routes, named as the reader would name them: two of them
	// are forms to fill in and the third is a code they already hold. The names
	// are short because they sit side by side on a 366px card — a name that
	// wraps to three lines is a route that reads as an obstacle.
	'door.head':       'New to Daimond?',
	'door.lead':       'It is in closed testing, so accounts are given out by passcode.',
	'door.test':       'Apply to test',
	'door.waitlist':   'Join the waitlist',
	'door.code':       'I have a passcode',
	// Said when the code button is pressed before there is a key to redeem onto.
	// It names the order and promises the next step, because the alternative —
	// a code box that refuses the moment it is used — is the thing this app
	// keeps being caught doing.
	'door.code_later': 'Make your passphrase first: a passcode is redeemed onto this device’s own key. The code box opens by itself as soon as it can.',

	// ── Auto-reload ────────────────────────────────────────────
	// Every amount here is charged to a card, so the copy stays plain.
	'autoreload.title':            'Auto-reload',
	'autoreload.lead':             'Daimond can buy credits when they run low, so a long job does not stop halfway. It charges the card below without asking, up to a limit you set here.',
	'autoreload.card_word':        'card',
	'autoreload.card_has':         '{brand} ending {last4}',
	'autoreload.replace':          'Replace…',
	'autoreload.replace_help':     'Save a different card. Stripe collects it; Daimond never sees it.',
	'autoreload.no_card':          'No card saved.',
	'autoreload.save_card':        'Save a card',
	'autoreload.save_card_help':   'Opens Stripe’s own page. Nothing is charged, and no card detail reaches Daimond.',
	'autoreload.switch_on':        'Buy credits automatically',
	'autoreload.switch_no_card':   'Buy credits automatically (save a card first)',
	'autoreload.when_below':       'When the balance falls below',
	'autoreload.when_below_hint':  'A reload fires the moment a turn takes the balance under this.',
	'autoreload.buy_amount':       'Buy this much',
	'autoreload.buy_amount_hint':  'One top-up. The gateway will not sell more than {max} at a time.',
	'autoreload.monthly_cap':      'Never spend more, per month, than',
	'autoreload.monthly_cap_hint': 'The most auto-reload may spend in a calendar month. Raise it here if you need more.',
	'autoreload.spent':            'Spent this month: {spent}',
	'autoreload.spent_of':         'Spent this month: {spent} of {cap}',
	'autoreload.last_error':       'The last automatic top-up failed: {reason}',
	'autoreload.saving':           'Saving…',
	'autoreload.on_note':          'On. Daimond tops itself up, within your monthly limit.',
	'autoreload.off_note':         'Off. Nothing will be charged.',

	// ── The chat ───────────────────────────────────────────────
	'chat.no_chat':        'No chat',
	'chat.model_for_chat': 'Model for this chat',
	'chat.select_all':     'Select all',
	'chat.deselect_all':   'Deselect all',
	'chat.fold_selected':  'Fold selected',
	'chat.fold_now': 'Fold',
	'chat.fold_now_help': 'Fold this conversation now, keeping a summary of what came before.',
	'say.more':             'the detail',
	'say.less':             'hide the detail',
	'rail.dupes_trashed':   'Removed {n} duplicate copies of the built-in Diamonds — an old sync made them. They are in the Trash if you want one back.',
	'rail.dupes_kept':      'There are {n} more duplicate built-in Diamonds, but you have worked in them, so nothing was removed. Delete the ones you do not want.',
	// A question the model put, answered with one tap. `Chose: ` and `Other: ` are
	// NOT here: they are the wire markers the answer travels under, read by the model
	// and not by a person, so they are the same in every language on purpose.
	'ask.of': 'Decision {n} of {of}',
	'ask.recommended': 'Recommended',
	'ask.why': 'Why: {why}',
	'ask.silent': 'If you say nothing: {what}',
	'ask.other': 'Something else…',
	'ask.other_ph': 'Answer in your own words',
	'ask.send': 'Send this answer',
	'ask.answered': 'You answered: {what}',
	'say.more_help':      'About {n} tokens, kept on this device. Closed, they are not sent to the model; open the fold and they are.',
	'say.less_help':      'About {n} tokens. While this is open the model sees them too, on every turn until you close it.',
	'wire.role_help':     'Your role prompt. Edit it in prompts/ — this is the part of the system message you own.',
	'wire.safety_help':   'Appended after your edits, every turn. You cannot remove it by editing your role prompt.',
	'wire.tools_help':    'Written from the tools this conversation actually holds, so it cannot promise one that is not there.',
	'wire.machine_help':  'Written from the same fence that enforces it, so the description and the rule cannot disagree.',
	'wire.schemas_help':  'The full JSON schema of every tool, sent on every single request. Usually the largest thing in the payload.',
	'wire.diamond_help':  'Composed for this turn alone: the Diamond\'s own folder, what the paperclip has attached, and its crystal as it stands now.',
	'wire.standing_help': 'Your DAIMOND.md, appended to the system message of every turn in every conversation.',
	'chat.copy_all_aria':   'Copy the conversation',
	'wire.chip':          'Wire',
	'wire.chip_help':     'Show what is actually sent to the model on every turn — the system message, whose each part is, and the tool schemas.',
	'wire.head':          'Sent on every turn, before anything you have said — about {n} tokens',
	'wire.role':          'Role prompt',
	'wire.role_why':      'yours',
	'wire.safety':        'Safety clause',
	'wire.safety_why':    'immovable',
	'wire.tools':         'Tool names',
	'wire.tools_why':     'from the registry',
	'wire.machine':       'This computer',
	'wire.machine_why':   'from the fence',
	'wire.diamond':       'This Diamond',
	'wire.diamond_why':   'this turn only',
	'wire.standing':      'Standing instructions',
	'wire.standing_why':  'yours',
	'wire.schemas':       'Tool schemas ({n})',
	'wire.schemas_why':   'every turn',
	'chat.copy_all':        'Copy',
	'chat.copy_all_help':   'Copy the whole conversation to the clipboard, as plain text.',
	'chat.copy_all_said':   'The conversation was copied to the clipboard.',
	'chat.copy_all_empty':  'There is nothing in this conversation to copy yet.',
	'chat.copy_all_failed': 'Daimond could not reach the clipboard. Select the text and copy it yourself.',
	'chat.steps':          'Steps',
	'chat.concise': 'Concise',
	'chat.concise_help': 'Ask for short answers in this chat. Every message carries the /concise skill, a file in your workspace you can edit.',
	'chat.concise_failed_title': 'Concise is not available',
	'chat.concise_failed': 'Daimond could not write .daimond/skills/concise.md, so the chip would refuse every turn instead of shortening it. Open a workspace folder, or check the Files panel, and try again.',
	'chat.steps_help':     'Show or hide the tool steps in the thread',
	'chat.collapse_help':  'Collapse every answer, leaving what you asked, and pick turns to fold',
	'chat.input_ph':       'Type a message…',
	'chat.send':           'Send',
	// The turn indicator: what the three dots at the foot of the thread say while
	// a turn runs. It is up from the moment the turn starts until it ends, so
	// these have to carry a long silence — a run of tool calls with the steps
	// hidden changes nothing else on screen for minutes at a time. {tool} is a
	// tool's own name, which the thread shows untranslated; {n} counts the
	// tool-call rounds, and is there so something on the line MOVES.
	// Nothing here says anything about how long any of it has taken.
	'chat.busy':           'Thinking…',
	'chat.busy_tool':      'Running {tool}, step {n}…',
	'chat.busy_next':      'Step {n} done, thinking…',
	'chat.busy_writing':   'Writing the answer…',
	'chat.answered': 'Daimond answered, {n} words',
	'chat.answer_failed': 'Daimond could not answer',
	'chat.collapse': 'Collapse every answer',
	'chat.jump': 'Jump back to your last message',
	'chat.end': 'Jump to the end of the chat',
	'chat.jump_help':      'Jump back to your last message. Press again to walk back through the ones before it.',
	'chat.end_help':       'Jump to the end of the chat.',
	'chat.new':            '+ New chat',
	// Messages typed while an answer is still arriving. They are held, shown, and
	// sent one turn each once the answer is finished.
	// Short on purpose: a phone's composer is ~120px wide, and a longer line wraps
	// to two clipped rows. What happens to a queued message is said in full by the
	// line above the bubbles (chat.queue_help), at the moment it matters.
	'chat.queue_ph':       'Type the next message…',
	'chat.queue_help':     'Waiting. Sent when this answer finishes',
	'chat.queued_pending': 'Not sent yet. Click to edit it.',
	'chat.queue_cancel':   'Do not send this',
	'chat.queue_returned': 'That turn did not finish, so what you queued is back in the box, unsent.',
	// Speaking into a turn that is already running. A turn is a round of requests,
	// and the message list is rebuilt between them, so a message typed mid-turn can
	// go to the model AT THAT SEAM rather than after the whole turn is over. Two
	// states, and the difference between them is what these say: waiting (typed, not
	// yet delivered) and delivered (in the conversation, and the model has it).
	// The heading is honest about the limit -- an answer that writes prose straight
	// through has no seam in it, so a correction can still end up waiting until it
	// finishes -- because a promise of "shortly" that a quiet turn cannot keep is
	// worse than no promise.
	'chat.send_into':         'Send into this answer',
	'chat.interject_help':    'Waiting. Goes in at the model’s next step, or when this answer finishes',
	'chat.interject_pending': 'Not delivered yet. Click to edit it.',
	'chat.interjected':       'You cut in here',
	'chat.interjected_help':  'Said into the turn at this point. The model had it from here on.',
	'chat.thinking':       'Thinking',
	'chat.compacted':         'Conversation folded',
	'chat.compacted_help':    'Daimond replaced the earlier part with a summary so the conversation fits the model’s context window.',
	// The same thing said on the chat's TILE, for a queue left on a conversation
	// the user has walked away from: the bubbles are only drawn in the chat on
	// screen, and money about to be spent should not depend on remembering.
	'chat.queue_badge.one':        '{n} waiting',
	'chat.queue_badge.other':      '{n} waiting',
	'chat.queue_badge_help.one':   'One message is waiting on this chat. Open it and it is sent as its own turn.',
	'chat.queue_badge_help.other': '{n} messages are waiting on this chat. Open it and they are sent, one turn each.',

	// ── How the turn ended, and a template of a Diamond ────────
	//
	// FURNITURE, in the register of a timestamp. `dev/CONTRACT_CLAIMS.md` §3 binds
	// every word here: no word may claim a fault, because the line closes EVERY
	// turn that held tools and an app appending a warning to each of them teaches
	// its reader to skip the one that mattered. "Answered · no tools used" is a
	// statement of what happened, not an accusation — the reader decides whether
	// the model promised otherwise.
	// i18n-family: end.how_ = answered stopped capped silent failed
	'end.how_answered': 'Answered',
	'end.how_stopped':  'Stopped',
	'end.how_capped':   'Step limit reached',
	'end.how_silent':   'Ended without saying anything',
	'end.how_failed':   'Ended on an error',
	'end.no_calls':     'no tools used',
	'end.calls.one':    '{n} tool call',
	'end.calls.other':  '{n} tool calls',
	'end.refused.one':  '{n} refused',
	'end.refused.other': '{n} refused',
	'end.broke.one':    '{n} failed',
	'end.broke.other':  '{n} failed',
	'end.missing':      'not written: {paths}',
	'end.help':         'How this turn ended. Tools available: {offered}. Requests sent: {rounds}. Tool calls made: {calls}.',

	// A template is a Diamond's SHAPE without its contents. Two facts run through
	// every string below because neither is guessable and both change what a
	// person does: opening one mints a NEW Diamond and can never write over an
	// existing one, and triggered actions are deliberately not carried, because a
	// trigger fires with nobody pressing anything.
	'tmpl.section':               'Template',
	'tmpl.dlg_help':              'A template carries this Diamond’s shape — the page it draws through, its automation, and whatever a capp keeps beside itself — and none of what it has recorded. Triggered actions are left out on purpose: a trigger fires with nobody pressing anything, and one carried across would start work on somebody else’s machine because they opened a file. Whoever opens it gets a NEW Diamond; nothing of theirs is written over.',
	'tmpl.with_conversation':      'Include what it has recorded',
	'tmpl.with_conversation_help': 'Carries everything instead: the memory, the kept conversation and a capp’s own entries. Still a template, so it still opens as a new Diamond.',
	'tmpl.save':                  'Save as a template…',
	'tmpl.saving':                'Making the template…',
	'tmpl.saved':                 'Saved as {file}. Anybody you give it to opens it as a Diamond of their own, from the Share view of the Social panel.',
	'tmpl.panel_head':            'Open a template',
	'tmpl.panel_help':            'A template is a Diamond’s shape without its contents: the page it draws through and its automation, and none of what it has recorded. It opens as a NEW Diamond and can never write over one you already have. Triggered actions are never carried, because a trigger fires with nobody pressing anything.',
	'tmpl.panel_open':            'Open a template file…',
	'tmpl.opened':                'Opened as a new Diamond, “{name}”. {n} file(s) arrived.',
	'tmpl.unnamed':               'this template',
	// The consent question. It says what it is (a page — a program), what cannot
	// be told about it (a template carries no signature and no name, unlike a
	// share), which files, and what declining does — which here is nothing at all,
	// because the engine's door has no half-landing behind it.
	'tmpl.code_title':            'This template contains code',
	'tmpl.code_body':             '“{name}” includes a page: a program written by somebody else, which Daimond will run when you open it. A template carries no signature and nobody’s name, so nothing here can tell you where it came from — only the person who gave you the file can.\n\nWhat would be added: {files}\n\nIt opens as a NEW Diamond and can never write over one you already have. Declining writes nothing at all.',
	'tmpl.code_ok':               'Accept the page and open it',
	'tmpl.declined':              'The page was not accepted, so nothing has been opened.',
	'tmpl.err_empty':             'That file is empty, so there is nothing to open.',
	'tmpl.err_not_template':      'That file is not a Daimond template.',
	'tmpl.err_file_huge':         'That file is {size}, which is larger than any template can be, so it was not opened.',
	'tmpl.err_no_file':           'No file was chosen, so nothing was opened.',
	'tmpl.err_nothing':           'There is nothing to save: that Diamond made an empty template.',
	'tmpl.err_no_door':           'This build can read a template but has nowhere to open one.',

	// ── The Web panel ──────────────────────────────────────────
	'web.who_drives': 'Who is driving',
	'web.back':       'Back',
	'web.reload':     'Reload',
	'web.pop_out':    'Open in a real tab',
	// The name of the pause control in the panel header, so `pause.act_pause`
	// reads "Pause Web access". It governs `root/web`, which reaches further
	// than this panel — a page fetched for a chat is stopped by it too — so it
	// is not called "This panel".
	'web.pause':      'Web access',
	'web.blind_title': "You're driving. I'm not watching.",
	'web.blind_note':  'Daimond has stopped reading this page. No text, no picture, no keystrokes. Sign in, then click <b>Resume Daimond</b> in the browser tab to hand the wheel back. That button is in the tab, so this page can never take the wheel from you.',
	'web.resumed':     'I’ve resumed, check',
	// {where} is what the extension said Daimond stopped at, e.g. a sign-in page.
	'web.blind_title_at': 'You’re driving. I stopped at {where}.',
	// The header: what is on screen, and who has the wheel.
	'web.guide':             'Guide',
	'web.guide_title':       'Daimond’s user guide',
	'web.panel_for':         'The Web panel',
	'web.who_you':           'You',
	'web.who_daimond':       'Daimond',
	'web.who_ready':         'Ready',
	'web.who_view_only':     'View only',
	'web.who_you_help':      'You are driving. Daimond is not watching this page.',
	'web.who_daimond_help':  'Daimond is driving. You can take the wheel at any time.',
	'web.who_ready_help':    'Daimond Hands is installed.',
	'web.who_view_only_help': 'This page can be shown, but not operated. Install Daimond Hands to drive it.',
	// Opening a site through the extension. {host} is a hostname, already escaped;
	// these are placed as markup, so keep the tags and add none.
	'web.opening':         '<b>Opening {host}…</b><br>A <b>Daimond Hands</b> window opens in front. Approve the site there, then confirm once in Chrome. Both happen only the first time for a site.',
	'web.not_approved':    '<b>{host} was not approved.</b><br>',
	'web.approval_closed': 'The approval window was closed, or you said no. To allow it, ask for the site again and click <b>Allow, then confirm in Chrome</b>. The window opens in front of this one, and the <b>Daimond Hands</b> icon holds the question until you answer it.',
	// An answer that arrived after Daimond had stopped waiting: the site was
	// approved late, or refused late. The first sits above the driving note.
	'web.approved_late':   '<b>{host} was approved.</b> Your answer arrived after Daimond gave up waiting, so the panel said otherwise for a moment. The page is open now.',
	'web.answer_late':     'Your answer came after Daimond had stopped waiting. ',
	'web.driving_tab':     '<b>Daimond is driving {host}</b> in a browser tab. Watch it there, or pull a live picture into this panel.',
	'web.show_live':       'Show live view here',
	'web.real_tab':       'The page opens as a real browser tab, which is what carries your own sign-ins, so this panel only shows a picture of it.',
	'web.mirror_wait':    'Waiting for the first picture of that tab. If Chrome has put a permission window in front, it wants your answer.',
	'web.mirror_silent':  'Nothing has come back from Daimond Hands for a while, so there is no live picture. The tab itself is still open, and is still the page.',
	'web.mirror_refused': 'This tab cannot be photographed, so there is no live picture. Watch the tab itself, or ask for the picture again.',
	// A site that refuses to be framed, which is most of them.
	'web.blocked':         '<b>{host}</b> will not display inside another page. Most sites block this as protection against clickjacking; it is not a fault.',
	'web.blocked_hands':   'Daimond Hands can drive it in a real tab.',
	'web.blocked_install': 'Install Daimond Hands to drive it live.',
	'web.open_new_tab':    'Open in a new tab',
	'web.read_as_text':    'Read it as text',
	'web.reading':         'Reading…',
	'web.read_failed':     'That page could not be read: {reason}',
	'web.readonly_badge':  'Read-only copy, not the live site. Do not sign in here.',

	// ── Compose ────────────────────────────────────────────────
	'compose.from':       'From',
	'compose.to':         'To',
	'compose.cc':         'Cc',
	'compose.subject':    'Subject',
	'compose.optional':   'Optional',
	'compose.body_ph':    'Write your message.',
	'compose.send':       'Send',
	'compose.save_draft': 'Save draft',
	'compose.attach':     'Attach…',
	'compose.discard':    'Discard',

	// ── Agents ─────────────────────────────────────────────────
	'agents.control_all':    'Control all agents',
	'agents.pause_all':      'Pause all agents',
	'agents.resume_all':     'Resume all paused agents',
	'agents.stop_all':       'Stop all agents',
	'agents.clear_finished': 'Clear finished agents',
	'agent.model_vision':    'This task names an image, so it runs on the Diamond’s image model, {model}.',
	'agent.model_vision_fallback': 'This task names an image, but no image model is set for this Diamond, so it runs on the text model, {model}.',
	'agent.model_rerouted':   '{from} cannot be shown pictures, so this worker moved to {to}.',
	'agent.model_blind':      '{model} cannot be shown pictures, so the picture was left out.',
	'agent.model_blind_none': '{model} cannot be shown pictures and this Diamond has no image model set.',
	// ── Pending ────────────────────────────────────────────────
	'pending.empty':        'Nothing waiting on you.',
	'pending.sort':         'Sort',
	'pending.by_priority':  'By priority',
	'pending.by_newest':    'Newest first',
	'pending.by_oldest':    'Oldest first',
	'pending.priority':     'Priority',
	// i18n-family: pending.prio_ = high normal low
	'pending.prio_high':    'High',
	'pending.prio_normal':  'Normal',
	'pending.prio_low':     'Low',
	'pending.no_detail':    'No further detail was given.',
	'pending.execute':      'Do it',
	'pending.execute_named': 'Do it: {what}',
	'pending.discuss':      'Discuss it first',
	'pending.discuss_named': 'Discuss first: {what}',
	'pending.cancel':       'Drop it',
	'pending.cancel_named': 'Drop it: {what}',
	'pending.noted':        'Noted, and taken off the list.',
	'pending.opened':       'Opened for sending. It stays here until it is sent.',
	'pending.diamond_gone': 'The Diamond that raised this is gone, so there is nobody to discuss it with.',
	'pending.discuss_prompt': 'We need to discuss this further before I approve it: “{headline}”',

	// A dispatched agent's request for permission, raised here because there was
	// nobody at the screen to put it to. The agent is holding its work open until
	// one of the three answers arrives.
	'pending.consent.click_head': 'An agent wants to click something on {host}',
	'pending.consent.type_head':  'An agent wants to send text to {host}',
	'pending.consent.reach_head': 'An agent wants to reach {host}',
	'pending.consent.why':        'It asked while this page was not in front of you, so the question is waiting here instead of on a dialog nobody would have seen.',
	'pending.consent.agent':      'The agent is {name}. Its task: {task}',
	'pending.consent.waiting':    'The agent is still waiting for this answer.',
	'pending.consent.expired':    'The agent that asked has gone — this was raised before the app last reloaded. Saying yes now could not let the act happen.',
	'pending.consent.allowed':    'Allowed. The agent has been told to go ahead.',
	'pending.consent.gone':       'Nothing is waiting on this any more, so there was nothing to allow.',
	'pending.consent.nochat':     'Declined. There is no conversation to take it to: two agents were running, so Daimond cannot tell which one asked.',

	// The agent tile's own controls, its state word and the tally above the
	// list. All of these were hardcoded English in a shipped panel until
	// 2026-08-12, and `dev/i18ncheck.mjs` could not see them: it compares key
	// sets, so a string with no key at all is invisible to it by construction.
	'agents.act_pause':        'Pause',
	'agents.act_pause_help':   'Hang up this agent, keeping its work so far; resume it later.',
	'agents.act_stop':         'Stop',
	'agents.act_stop_help':    'Stop this agent for good. It keeps whatever it managed to do.',
	'agents.act_resume':       'Resume',
	'agents.act_resume_help':  'Continue this agent from where it left off.',
	'agents.act_discard_help': 'Discard this paused agent.',
	'agents.tally_running':    '{n} running',
	'agents.tally_paused':     '{n} paused',
	'agents.tally_queued':     '{n} queued',
	'agents.live':             '{n} live',
	'agents.dropped.one':      '1 older run is not kept.',
	'agents.dropped.other':    '{n} older runs are not kept.',
	// The state word on an agent's pill, keyed by the engine's own status token.
	// Built by concatenation at daimond.js's `tOr('agents.status_' + run.status,
	// run.status)`, so a status with no key here reaches the screen as the raw
	// internal word -- which is what it used to do for all seven.
	// i18n-family: agents.status_ = queued running paused done error stopped interrupted
	'agents.status_queued':      'queued',
	'agents.status_running':     'running',
	'agents.status_paused':      'paused',
	'agents.status_done':        'done',
	'agents.status_error':       'failed',
	'agents.status_stopped':     'stopped',
	'agents.status_interrupted': 'cut off',

	'agents.search':         'Search agents',
	'agents.search_help':    'Search agents by name, task, Diamond or tag',

	// ── Email ──────────────────────────────────────────────────
	'mail.write':       'Write a message',
	'mail.add_mailbox': 'Add a mailbox',
	'mail.sync_now':    'Sync now',

	// The pitch, shown while Email is not unlocked on this account. The first
	// two carry markup and are placed as markup; keep the tags and add none.
	'mail.pitch.head':    '<b>Daimond can read your mail.</b> Your inbox lands in the workspace as ordinary files, so every agent can read, search and work from it.',
	'mail.pitch.fine':    'Email is part of Pro — one payment, and five years of it — alongside cross-device sync and cloud storage. Covers {cap} mailboxes. Sending and fetching are metered against credits, like inference. No subscription, and nothing renews.',
	'mail.pitch.privacy': 'Daimond’s gateway makes the connection and forgets your password. No mail is ever stored on our side.',
	'mail.pitch.unknown': 'The account service is not reachable, so Daimond cannot tell whether Email is unlocked here.',
	'mail.pro_pitch':     'Email is part of Pro. Buy five years of Pro to turn it on, along with sync and cloud storage.',

	// The mailbox list.
	'mail.remove_mailbox': 'Remove this mailbox',
	'mail.remove_mailbox_named': 'Remove the mailbox {address}',
	'mail.no_mailbox':     'No mailbox yet. Press <b>+</b> to add one.',
	'mail.remove.title':   'Remove {address}?',
	'mail.remove.body':    'The mail already synced stays in the workspace. The mailbox frees a seat on your unlock.',
	'mail.remove.ok':      'Remove',
	'mail.ago.never':      'never',
	'mail.ago.just_now':   'just now',
	'mail.ago.mins':       '{n}m ago',
	'mail.ago.hours':      '{n}h ago',
	'mail.ago.days':       '{n}d ago',

	// Folders. A server may name its folders in its own language, so the name
	// shown is the ROLE's name wherever the server declares one (RFC 6154) and
	// the server's own spelling everywhere else.
	'mail.folders':         'Folders',
	'mail.folders_loading': 'Looking for folders…',
	'mail.refreshed_held': '{done} folders refreshed in {boxes} mailboxes; {held} held by a pause.',
	'mail.refreshed': '{done} folders refreshed in {boxes} mailboxes.',
	'mail.count.never': 'Not fetched yet, so there is no count.',
	'mail.count.asat': '{n} messages, as at {when}.',
	'mail.count.more': '{n} more were waiting on the server then.',
	'mail.settings': 'Mailbox settings',
	'mail.settings_named': 'Settings for {address}',
	'mail.all_mailboxes': 'All mailboxes',
	'mail.refresh_all': 'Refresh all {folders} folders in {boxes} mailboxes',
	// How often one folder refreshes, keyed by the interval in SECONDS. Built by
	// concatenation in mail.js, which falls through to `mail.every.secs` for an
	// interval no key names -- so the family and the fallback key are declared
	// together.
	// i18n-family: mail.every. = 0 300 900 1800 3600 14400 43200 86400 secs
	'mail.every.0': 'Manual only',
	'mail.every.300': 'Every 5 minutes',
	'mail.every.900': 'Every 15 minutes',
	'mail.every.1800': 'Every 30 minutes',
	'mail.every.3600': 'Every hour',
	'mail.every.14400': 'Every 4 hours',
	'mail.every.43200': 'Every 12 hours',
	'mail.every.86400': 'Once a day',
	'mail.every.secs': 'Every {n} seconds',
	'mail.every_for': 'How often {folder} refreshes itself',
	'mail.cfg.head': 'How often each folder goes and looks, and which of them may. Every refresh costs credits, so nothing polls until you say so.',
	'mail.cfg.self': 'Holds every folder below.',
	'mail.cfg.title': 'Settings for {address}',
	'mail.folders_err':     'The folder list could not be fetched: {reason}',
	// The role comes from the mail server, but the name is only built where the
	// role is one of ours: `mail.js:1754` fences it on `ROLE_ORDER`, and a role
	// outside that list keeps the server's own spelling instead. So the set is
	// this app's after all, and closed.
	// i18n-family: mail.folder. = inbox sent drafts trash junk archive flagged all
	'mail.folder.inbox':    'Inbox',
	'mail.folder.sent':     'Sent',
	'mail.folder.drafts':   'Drafts',
	'mail.folder.trash':    'Bin',
	'mail.folder.junk':     'Spam',
	'mail.folder.archive':  'Archive',
	'mail.folder.all':      'All mail',
	'mail.folder.flagged':  'Starred',

	// The message list.
	'mail.drafts_head':    'Drafts · {n}',
	'mail.no_subject':     '(no subject)',
	'mail.no_recipient':   '(no recipient)',
	'mail.unknown_sender': '(unknown)',
	'mail.nothing_yet':    'Nothing here yet. Press <b>⟳</b> to sync.',

	// Syncing. {address} is a mailbox, {folder} the folder inside it.
	'mail.note.syncing':          'Syncing {folder} in {address}…',
	'mail.note.fetching_older':   'Fetching older mail from {folder} in {address}…',
	'mail.note.rebuilt':          'The mailbox was rebuilt on the server; resyncing from the start…',
	'mail.note.up_to_date':       'Up to date.',
	'mail.note.no_older':         'No older mail left to fetch.',
	'mail.note.new.one':          '{n} new message',
	'mail.note.new.other':        '{n} new messages',
	'mail.note.older.one':        '{n} older message',
	'mail.note.older.other':      '{n} older messages',
	'mail.note.still_older.one':  '{n} older still on the server',
	'mail.note.still_older.other': '{n} older still on the server',

	// The foot of the list: what the cap held back.
	'mail.more.note.one':   '{n} older message still on the server. Daimond fetches the newest {batch} at a time, so a whole mailbox is never pulled down at once.',
	'mail.more.note.other': '{n} older messages still on the server. Daimond fetches the newest {batch} at a time, so a whole mailbox is never pulled down at once.',
	'mail.more.next':       'Fetch next {n}',
	'mail.more.stop':       'Stop',
	'mail.more.all':        'Fetch all',

	// Walking a whole mailbox down. {count} is `mail.all.count`, already worded.
	'mail.all.title':        'Fetch all {n} remaining messages?',
	'mail.all.body':         'They arrive in batches of {batch} and are written into the workspace, so a large mailbox takes a while and uses disk. Syncing is metered against your credits by the megabyte. Stop part-way and what has arrived stays.',
	'mail.all.ok':           'Fetch all',
	'mail.all.progress':     'Fetched {got} of {total}…',
	'mail.all.count.one':    '{n} message',
	'mail.all.count.other':  '{n} messages',
	'mail.all.done':         'Done. {count} fetched.',
	'mail.all.done_left':    'Done. {count} fetched, {left} still on the server.',
	'mail.all.stopped':      'Stopped. {count} fetched.',
	'mail.all.stopped_left': 'Stopped. {count} fetched, {left} still on the server.',

	// Quoting and forwarding. The separator is what the reader sees; the header
	// names under it (From:, Date:, Subject:, To:) are the message's own and
	// stay spelled as headers are. "Re:" and "Fwd:" are likewise left alone —
	// they are what a receiving client threads on.
	// Two sentences, not one with a fallback phrase dropped into the date slot:
	// a quote whose date cannot be read gets a sentence with no date in it.
	'mail.quote.head':         'On {date}, {who} wrote:',
	'mail.quote.head_undated': '{who} wrote:',
	'mail.quote.they':         'they',
	'mail.fwd.sep':       '---------- Forwarded message ----------',

	// Adding a mailbox.
	'mail.add.title':         'Add a mailbox',
	'mail.add.lead':          'Daimond’s gateway connects to your mail server, hands the messages back, and forgets your password. The password is encrypted on this device under your passphrase.',
	'mail.add.ok':            'Add and sync',
	'mail.add.address':       'Email address',
	'mail.add.password':      'App password',
	'mail.add.password_ph':   'The app password from your provider',
	'mail.add.imap':          'IMAP server',
	'mail.add.smtp':          'SMTP server',
	'mail.add.port':          'Port',
	'mail.add.guess':         'Daimond will need this provider’s server names (often imap.{domain} for reading, smtp.{domain} for sending).',
	'mail.add.err_address':   'That is not an email address.',
	'mail.add.err_password':  'The app password is required.',
	'mail.add.err_imap':      'Daimond needs the IMAP server name.',
	'mail.add.err_port':      'IMAP runs on port 993 (TLS) or 143.',
	'mail.add.err_smtp':      'Daimond needs the SMTP server name to send from this mailbox.',
	'mail.add.err_smtp_port': 'Mail is submitted on port 587 or 465.',

	// Provider guidance, shown under the address as soon as the domain is
	// recognised. These carry markup. "App Password" is the provider's own name
	// for the thing, so keep whatever the provider calls it in that language.
	// i18n-indirect: daimond.js p.note = mail.preset.gmail mail.preset.gmail_short mail.preset.outlook mail.preset.yahoo mail.preset.icloud mail.preset.fastmail
	// i18n-indirect: daimond.js unreachable[dom] = mail.unreachable.proton mail.unreachable.tuta
	'mail.preset.gmail':       'Gmail needs an <b>App Password</b> (Google Account → Security → 2-Step Verification → App passwords), not your Google password.',
	'mail.preset.gmail_short': 'Gmail needs an <b>App Password</b>, not your Google password.',
	'mail.preset.outlook':     'Outlook needs an <b>app password</b> if two-step verification is on.',
	'mail.preset.yahoo':       'Yahoo requires an <b>app password</b> generated in Account Security.',
	'mail.preset.icloud':      'iCloud requires an <b>app-specific password</b>.',
	'mail.preset.fastmail':    'Fastmail requires an app password with IMAP access.',
	'mail.unreachable.proton': 'Proton mail is only reachable through the Proton Bridge running on your own machine, which Daimond’s gateway cannot connect to.',
	'mail.unreachable.tuta':   'Tuta offers no IMAP, so no mail client can read it, Daimond included.',

	// What can go wrong.
	'mail.err.unlock_first':        'Unlock Daimond first. The mail password is encrypted under your passphrase.',
	'mail.err.draft_needs_mailbox': 'A draft needs a mailbox to be from.',
	'mail.err.draft_unreadable':   'That draft could not be read.',
	'mail.err.msg_unreadable':     'That message could not be read.',
	'mail.err.send_from_added':    'Send from a mailbox you have added and synced.',
	'mail.err.no_recipients':      'A message with no recipients cannot be sent.',
	'mail.err.add_mailbox_first':  'Add a mailbox before writing a message.',
	'mail.err.service_unavailable': 'The account service is unavailable.',
	'mail.err.service_unreachable': 'Could not reach the Daimond account service. Try again shortly.',
	'mail.err.cap.one':            'This unlock covers {n} mailbox. Remove one to add another.',
	'mail.err.cap.other':          'This unlock covers {n} mailboxes. Remove one to add another.',

	'mail.err.protocol_pending':   'Daimond cannot fetch mail yet: the private tunnel is finished and the mail protocol is not wired to it. Nothing was sent, and your password never left this device.',

	// ── The tunnel ─────────────────────────────────────────────
	// TLS terminates in the browser, so these are the only words anybody gets about
	// a connection the gateway cannot see into. Each names the repair, because a
	// refusal a reader cannot act on is a refusal they will simply retry.
	'mail.tunnel.close.auth':        'Daimond signed this device out, so the mail connection was refused. Unlock Daimond and fetch again.',
	'mail.tunnel.close.pro':         'Email is part of Pro, and this account has not unlocked it. Buy Pro under Credits and mail opens.',
	'mail.tunnel.close.host':        'Daimond will only reach a mail server this account has bound, and {host} is not one of them. Add the mailbox again — Daimond binds its servers as it does so — then fetch.',
	'mail.tunnel.close.port':        'Mail connects on ports 993, 143, 465 and 587, and {port} is none of them. Correct the port in the mailbox’s settings.',
	'mail.tunnel.close.credits':     'Your credits ran out part way through. Top up under Credits and fetch again; whatever already came down is on this device.',
	'mail.tunnel.close.concurrent':  'This account already holds four mail connections. Let another mailbox finish, or close another Daimond tab, then fetch again.',
	'mail.tunnel.close.unresolved':  '{host} does not resolve to an address Daimond may dial. Check the server name in the mailbox’s settings — a typo reads exactly like this — or whether this network’s DNS can see it.',
	'mail.tunnel.close.toobig':      'The mail connection sent more at once than the gateway carries, so it was closed. Fetch again.',
	'mail.tunnel.close.done':        'The mail server ended the connection before the fetch had finished. Fetch again; whatever came down is on this device.',
	'mail.tunnel.close.unreachable': '{host} could not be reached. Check the server name in the mailbox’s settings, or try again shortly.',
	'mail.tunnel.close.no_socket':   'The mail connection could not be opened at all. Check that you are online, then fetch again.',
	'mail.tunnel.close.idle':        'The mail server stopped answering, so the connection was closed. Fetch again to carry on.',
	'mail.tunnel.close.expired':     'That was taking too long, so the mail connection was closed. Fetch again and it carries on from where it stopped.',
	'mail.tunnel.close.other':       'The mail connection closed unexpectedly (code {code}). Fetch again.',
	'mail.tunnel.err.no_server':     'That mailbox has no server or port set. Open its settings and fill them in.',
	'mail.tunnel.err.no_client':     'Daimond could not start an encrypted mail connection — {reason}',
	'mail.tunnel.err.slow':          '{host} did not finish an encrypted handshake within {secs} seconds. Try again shortly.',
	'mail.tunnel.err.no_reply':      '{host} did not answer the {what} step within {secs} seconds. Fetch again.',
	'mail.tunnel.err.cert':          'Daimond could not verify {host}’s certificate ({fault}), so it sent nothing. Your password stays on this device until the server can prove who it is.',
	'mail.tunnel.err.cert_name':     '{host} offered a certificate issued for a different server ({fault}), so Daimond sent nothing. Check the server name in the mailbox’s settings.',
	'mail.tunnel.err.cert_expired':  '{host} offered an expired certificate ({fault}), so Daimond sent nothing. If this machine’s clock is wrong, correct it and fetch again.',
	'mail.tunnel.err.cert_issuer':   '{host} offered a certificate from an issuer Daimond does not trust ({fault}), so it sent nothing. A self-signed certificate looks like this, and so does an intercepted connection.',
	'mail.tunnel.err.starttls':      'The encrypted channel to {host} could not be started — {reason}',
	'mail.tunnel.err.starttls_early': '{host} sent something before the encrypted channel was up, so Daimond dropped the connection rather than trust it. Nothing was sent.',

	// ── Workspace files ────────────────────────────────────────
	'work.new_file':   'New file',
	'work.new_folder': 'New folder',
	'work.upload':     'Upload files',
	'work.parent':     'Parent folder',
	'work.filter_ph':  'Filter…',
	'work.breadcrumb': 'Folder path',

	// ── The phone shell ────────────────────────────────────────
	'mnav.chat':     'Chat',
	'mnav.mail':     'Email',
	'mnav.files':    'Files',
	'mnav.agents':   'Agents',
	'sheet.panel':   'Panel',
	'sheet.ask':     'Ask',
	'sheet.ask_ph':  'Ask about this…',
	// {thing} is a panel's name, lower-cased by the caller. A language where
	// that reads badly should rewrite the sentence around it.
	'sheet.ask_about': 'Ask about this {thing}…',

	// ── Identity: creating and unlocking ───────────────────────
	'identity.your_name':          'Your name',
	'identity.passphrase':         'Passphrase',
	'identity.confirm_passphrase': 'Confirm passphrase',
	'identity.show_passphrase':    'Show passphrase',
	'identity.hide_passphrase':    'Hide passphrase',
	'identity.generate_another':   'Generate another',
	'identity.wrote_it_down':      'I have written this down somewhere safe',
	'identity.choose_own':         'Choose my own passphrase instead',
	'identity.skip':               'Skip for now',
	'identity.create_account':     'Create account',
	'identity.unlock':             'Unlock',
	'identity.forget':             'Forget this identity…',
	'identity.use_generated':      'Use a generated passphrase instead',
	'identity.title_create':       'Create your account',
	'identity.title_unlock':       'Unlock Daimond',
	'identity.title_welcome':      'Welcome back, {name}',
	'identity.title_linked':       'Linked. Now unlock it',
	'identity.lead_create':        'Choose a name. Daimond generates the passphrase itself, below. If you already use Daimond on another device, do not make a second account: choose “Have a pairing code?” to link this one. (Opening a real folder for agents to edit needs Chrome, Edge or Brave.)',
	'identity.lead_unlock':        'Enter your passphrase to unlock this device and decrypt your saved key.',
	'identity.lead_linked':        'This device is linked to your account. Enter the SAME passphrase you use on your other device, not a new one, to bring your chats and files here.',
	'identity.lead_linked_named':  'This device is linked to your account “{name}”. Enter the SAME passphrase you use on your other device, not a new one, to bring your chats and files here.',
	// {bits} is a number read off the shipped wordlist, not a constant.
	'identity.gen_note':           'Eight words picked at random by this device, about {bits} bits, far past anything that can be guessed. It is the key to everything you store here, and nobody can reset it for you. Write it on paper. A password manager may also offer to keep it, which is safe at this strength.',

	// ── Passkeys ───────────────────────────────────────────────
	// Every one of these is a dead end explained: a passkey that will not open
	// leaves the passphrase as the only way in, so each says which it is.
	'passkey.err_need_passphrase':     'A passphrase is required to enrol a passkey.',
	'passkey.err_no_identity':         'There is no identity to protect with a passkey.',
	'passkey.err_bad_passphrase':      'That passphrase did not match.',
	'passkey.err_cannot_create':       'This browser or device cannot create a passkey.',
	'passkey.err_create_failed':       'Passkey creation was cancelled or failed.',
	'passkey.err_none_created':        'No passkey was created.',
	'passkey.err_no_prf':              'This authenticator does not support the PRF extension, so it cannot unlock Daimond.',
	'passkey.err_not_sealed':          'The passkey could not be sealed. Nothing was saved.',
	'passkey.err_not_saved':           'The passkey could not be saved on this device.',
	'passkey.err_not_enrolled':        'No passkey is enrolled on this device.',
	'passkey.err_unreadable':          'The passkey could not be read.',
	'passkey.err_unreadable_use_pass': 'The passkey could not be read. Use your passphrase.',
	'passkey.err_wrong_identity':      'The passkey did not match this identity. Use your passphrase.',
	'passkey.err_out_of_date':         'This passkey is out of date. Unlock with your passphrase, then re-add it.',
	'passkey.err_cannot_use':          'This browser or device cannot use a passkey.',
	'passkey.err_no_identity_support': 'Identity support is unavailable.',
	'passkey.err_no_offer':            'No Daimond passkey was offered, or it carried no PRF secret.',
	'passkey.err_no_account_carried':  'That passkey is not set up to carry an account. On the device that has your account, open Settings and add the passkey again.',
	'passkey.err_did_not_open':        'That passkey did not open the account.',
	'passkey.err_stored_unreadable':   'The stored account could not be read.',
	'passkey.err_stored_locked':       'The stored account did not open. Use your passphrase.',
	'passkey.err_not_resealed':        'The passkey could not be re-sealed.',

	// ── Cross-device sync ──────────────────────────────────────
	'sync.syncing':    'Syncing…',
	'sync.synced':     'Synced',
	'sync.off':        'Sync off',
	'sync.off_reason': 'Cross-device sync is part of Pro, which this account does not hold.',
	// The chip is the only place this is said, so it also has to be the way to
	// the offer: it is clickable in this state, and opens Pro in Credits.
	'sync.off_click':  'Click to see Pro in Credits.',
	'sync.off_pitch':  'Sync is off because this account is not on Pro. Pro adds cross-device sync, cloud storage and Email.',
	// A refused parcel. Say what is too large, and what usually makes it so:
	// "too large" on its own leaves nothing to do about it.
	'sync.too_big':        'Sync paused',
	'sync.too_big_reason': 'This device’s parcel is too large to send, so its work has stopped travelling. Usually one very large Diamond or workspace file is the cause; shrink or remove it and sync resumes on its own.',
	// A Diamond the parcel had no room for. Named, because the only thing the user can
	// do about it is find that Diamond, and said aloud rather than logged, because
	// nothing else on screen would look any different.
	'sync.diamonds_left.one':   '{n} Diamond did not fit in this device’s sync parcel and will not reach your other devices until it is smaller: {names}',
	'sync.diamonds_left.other': '{n} Diamonds did not fit in this device’s sync parcel and will not reach your other devices until they are smaller: {names}',
	// A session that has ended and could not be taken again. Same label as the
	// two below for the same reason: what the user needs to know is that this
	// device's work is not travelling, and the difference is in the hover.
	'sync.signed_out':        'Sync paused',
	'sync.signed_out_reason': 'This device is signed out of the Daimond account service and could not sign in again, so its work is not reaching your other devices. It resumes as soon as the service is reachable. If it does not, lock Daimond and unlock it.',
	// A reconcile that did not finish. Both of these mean the same thing to the
	// user — this device's work is still only here — so they share a label and
	// differ in the reason.
	'sync.paused':         'Sync paused',
	'sync.busy_reason':    'Another device is saving to this account at the same time, so this device’s work has not been sent yet. It goes on the next change.',
	'sync.merge_reason':   'Some of what arrived from the other device could not be merged here, so this device has not sent over the top of it. Reloading the page usually clears it.',
	'sync.last_synced':    'Last synced {when}.',
	'sync.last_never':     'Nothing has synced from this device yet.',
	'sync.when_just_now':  'just now',
	'sync.when_mins':      '{n}m ago',
	'sync.when_hours':     '{n}h ago',
	'sync.when_days':      '{n}d ago',

	// ── The account's public handle ─────────────────────────────
	// The public name, minted by the gateway and the same on every device of
	// the account. Three refusals and a shrug, because "no" on its own leaves
	// the user guessing which no it was.
	'handle.taken':    'Someone else already has that handle. Try another.',
	'handle.invalid':  'A handle is 3 to 24 characters: lower-case letters, numbers, and hyphens between them.',
	'handle.reserved': 'That handle is kept by Daimond and cannot be taken.',
	'handle.failed':   'The handle could not be changed just now. Try again shortly.',

	// ── Cloud storage cleanup ──────────────────────────────────
	// A deletion the gateway would not carry out on one request. Say the two
	// numbers, and say plainly that nothing of theirs has gone.
	'chunks.sweep_held':          'Cleanup paused',
	'chunks.sweep_held_reason':   'Cloud storage holds {n} of its {m} stored pieces that no file on this account still refers to. They have NOT been deleted, because no single request may remove more than half of what is stored. Nothing of yours is missing, and the space is freed by the next sync that can account for it all.',
	// The chip is a control, so these five carry what pressing it does. They were
	// written as `t('key', 'English')` -- and `t`'s second argument is VARS, not a
	// fallback, so a key that is not here is PAINTED ON THE SCREEN as itself, in
	// every language including this one.
	'chunks.upload_refused':       'Uploads paused',
	'chunks.upload_refused_title': 'Cloud storage refused an upload',
	'chunks.sweep_confirm_ask':    'Delete them now? Nothing you can still see is touched, and the space is freed.',
	'chunks.sweep_confirm_ok':     'Delete them',
	'chunks.sweep_confirm_title':  'Free the unreferenced pieces?',

	// ── Pairing a second device ────────────────────────────────
	// The quotation marks around a button's name are curly on purpose; keep
	// whatever quotation marks the target language uses.
	'pair.link_another':  'Link another device',
	'pair.link_this':     'Link this device',
	'pair.have_code':     'Have a pairing code?',
	'pair.making_code':   'Making a one-time code…',
	'pair.scan_lead':     'On your other phone, point its camera at this to open Daimond and link it:',
	'pair.no_camera':     'Without a camera, open Daimond there, choose “Have a pairing code?”, and enter:',
	'pair.type_lead':     'On your other device, open Daimond, choose “Have a pairing code?”, and enter:',
	'pair.code_expiry':   'This code works once and expires in about {mins} minutes. You will unlock the other device with your usual passphrase.',
	'pair.code_ph':       'pairing code',
	'pair.code_check':    'This is the code from your other device. It should match the one shown there.',
	'pair.scanned_lead':  'Scanned from your other device. Tap “Link this device” below to bring your account here.',
	'pair.manual_lead':   'On the device you already use, choose “Link another device” and type the code it shows here.',
	'pair.linked':        'This device is linked',
	'pair.linked_note':   'It now holds your account. Tap Unlock, then enter the SAME passphrase you use on your other device, not a new one.',
	'pair.linked_named':  'It now holds your account “{name}”. Tap Unlock, then enter the SAME passphrase you use on your other device, not a new one.',
	// Naming the device while linking it: the one moment the user is holding the
	// device in question. Optional — an unnamed device still syncs.
	'pair.name_this':     'Name this device (optional)',
	'pair.name_ph':       'e.g. Kitchen laptop',
	'pair.named_note':    'This device will appear as “{name}” in your device list. You can change it later there.',
	'pair.err_no_identity':      'There is no identity on this device to link.',
	'pair.err_unreadable_local': 'Could not read this device’s identity.',
	'pair.err_sign_in_first':    'Sign in on this device before linking another.',
	'pair.err_enter_code':       'Enter the pairing code from your other device.',
	'pair.err_bad_code':         'That code is invalid or has expired. Make a new one on your other device.',
	'pair.err_bundle_unreadable': 'The linked identity was unreadable.',
	'pair.err_bundle_import':    'The linked identity could not be imported.',
	'pair.err_create':           'Could not create a pairing code.',
	'pair.err_link':             'Could not link this device.',
	// The one-time presentation handover. Say that it happened and that it is
	// this device's own from now on, or a German interface on a new phone reads
	// as a fault rather than as the other device's setting.
	'pair.look_carried': 'Your theme, language and panel layout came across too. Each device keeps its own from now on, so changing one leaves the other alone.',

	// ── The appearance menu ────────────────────────────────────
	// `menu.view_note` is prose about the choice rather than a view, and it is
	// still declared: a variant is a key this table holds under the prefix, not
	// a promise that something in the app is called that.
	// i18n-family: menu.view_ = simple max simple_help max_help note
	'menu.view':            'View',
	'menu.view_simple':     'Simple',
	'menu.view_max':        'Max',
	'menu.view_simple_help': 'Each thing shows its name and whether it is running. Everything else is one press away.',
	'menu.view_max_help':   'Models, cost and context beside each thing, so you can compare them without opening anything.',
	'menu.view_note':       'Sets the shape of every tile too. Use a tile’s cog to set that tile differently.',
	'menu.theme':         'Theme',
	// The bands and the palettes, both from `DaimondTheme` in daimond.js, which
	// this app owns. `_help` is optional and only Amber has one: `workspace.js`
	// forms the name and asks `t` for it, and the key coming back unchanged is
	// how it learns there is no note.
	// i18n-family: menu.tone_ = light mid dark
	// i18n-family: menu.theme_ = light mist linen lollypop sage dusk dark amber midnight forest plum
	// i18n-family: menu.theme_ = amber_help
	// i18n-indirect: workspace.js help = open -- the probe above: `menu.theme_<name>_help` is formed for all eleven palettes and ten of them are absent on purpose
	'menu.tone_light':    'Light',
	'menu.tone_mid':      'Intermediate',
	'menu.tone_dark':     'Dark',
	'menu.theme_light':     'Paper',
	'menu.theme_mist':      'Mist',
	'menu.theme_linen':     'Linen',
	'menu.theme_lollypop':  'Lollypop',
	'menu.theme_sage':      'Sage',
	'menu.theme_dusk':      'Dusk',
	'menu.theme_dark':      'Ember',
	'menu.theme_amber':     'Amber',
	'menu.theme_amber_help': 'Warm and blue-poor, for reading at night.',
	'menu.theme_midnight':  'Midnight',
	'menu.theme_forest':    'Forest',
	'menu.theme_plum':      'Plum',
	'menu.text_size':     'Text size',
	'menu.smaller':       'Smaller text',
	'menu.larger':        'Larger text',
	'menu.dock_tiling':   'Dock tiling',
	'menu.dock_auto':     'Auto',
	'menu.dock_auto_help': 'A second column once the window is wide enough for it',
	'menu.dock_grid_help.one':   '{cols} column, up to {cells} panels',
	'menu.dock_grid_help.other': '{cols} columns, up to {cells} panels',
	'menu.language':      'Language',
	'menu.language_help': 'What Daimond says. A language with no table yet stays in English.',
	'menu.language_pending': 'not translated yet',
	'menu.currency':      'Currency',
	'menu.currency_help': 'What figures are shown in. Billing is always in US dollars.',
	'menu.this_diamond':  'This Diamond',
	'menu.arrangement_update': 'Update the saved arrangement',
	'menu.arrangement_keep':   'Keep this arrangement with {name}',
	'menu.arrangement_keep_this': 'Keep this arrangement with this Diamond',
	'menu.arrangement_forget': 'Forget it',
	'menu.arrangement_note':   'Opening this Diamond again restores the panels it was worked in. Nothing is remembered until you ask.',

	// ── Text-size steps ────────────────────────────────────────
	// i18n-indirect: workspace.js STEP_KEYS[i] = size.small size.normal size.large size.larger
	'size.small':  'Small',
	'size.normal': 'Normal',
	'size.large':  'Large',
	'size.larger': 'Larger',

	// ── Dock grids ─────────────────────────────────────────────
	// i18n-indirect: workspace.js GRID_KEYS[k] || 'dock.automatic' = dock.one_column dock.2x2 dock.2x3 dock.3x2 dock.automatic
	'dock.one_column': 'One column',
	'dock.2x2':        '2 by 2',
	'dock.2x3':        '2 by 3',
	'dock.3x2':        '3 by 2',
	'dock.automatic':  'Automatic',

	// ── The panel gallery rows ─────────────────────────────────
	'gallery.search_ph':        'Search panels',
	'gallery.no_match':         'No panel by that name.',
	// i18n-family: gallery.zone_ = rail stage dock
	'gallery.zone_rail':        'The rail',
	'gallery.zone_stage':       'Beside the chat',
	'gallery.zone_dock':        'The dock',
	'gallery.note':             'Pinned panels sit in the top bar. Press <kbd>Ctrl</kbd> <kbd>K</kbd> to reach any panel from the keyboard.',
	'gallery.state_unrevealed': 'not in use yet',
	'gallery.state_full':       'dock full',
	'gallery.state_open':       'open',
	'gallery.state_no_room':    'no room in the bar',
	'gallery.pin':              'Keep {name} in the top bar',
	'gallery.unpin':            'Remove {name} from the top bar',

	// ── Spending ───────────────────────────────────────────────
	'spend.intro':           'Two pots, kept apart. Inference runs on your own provider key; credits pay the gateway for the few things that leave the browser.',
	'spend.inference':       'Inference',
	'spend.inference_hint':  'billed to your own provider key',
	'spend.credits':         'Credits',
	'spend.credits_hint':    'gateway services: web, mail, sync',
	'spend.no_usage':        'No usage recorded.',
	'spend.no_account':      'No gateway account yet. Credits pay for the few things that leave the browser: fetching a web page, sending or syncing mail, cross-device sync. Add a passphrase and credits to begin.',
	'spend.this_week':       'this week',
	'spend.this_month':      'this month',
	'spend.session':         'this session',
	'spend.balance':         'balance',
	'spend.tok':             'tok',
	// The three cells of the rail's spend row. Short: they sit under a figure.
	// `day` is local midnight to now -- a calendar day, not a rolling 24h, so a
	// late-evening figure does not still carry yesterday morning's spend.
	// i18n-family: spend.period_ = day week month
	'spend.period_day':      'Today',
	'spend.period_week':     'Week',
	'spend.period_month':    'Month',
	'spend.no_turns':        'No turns in this window yet.',
	'spend.nothing_yet':     'Nothing yet.',
	'spend.nothing_spent':   'Nothing spent here yet.',
	'spend.no_movements':    'No credit movements yet.',
	'spend.where_credits_went': 'Where credits went',
	'spend.unknown_model':   '(unknown)',
	'spend.meter_help':      'See where your spending goes',
	'spend.rates_note':      'Figures are converted at approximate rates ({date}); you are billed in US dollars.',
	// Table headings. Keep them short: they sit above numbers in a narrow panel.
	'spend.col_model':   'Model',
	'spend.col_turns':   'Turns',
	'spend.col_tokens':  'Tokens',
	'spend.col_cost':    'Cost',
	'spend.col_key':          'Key',
	'spend.col_left':         'Left',
	'spend.col_period_spend': 'Spent',
	'spend.provider_keys':    'Provider keys',
	'spend.left_auto':        'What the provider says is left on this key.',
	'spend.left_manual':      'Your own figure, counted down by what Daimond estimates you have spent since.',
	'spend.left_unknown':     'This provider does not say what is left, and you have not told Daimond.',
	// Where the headline figure came from. A total the providers billed is not an
	// estimate, and marking it "≈" said the opposite of the truth.
	'spend.all_reported':          'Every turn in this window came with a cost from the provider, so this is what was charged.',
	'spend.part_reported':         '{amount} of this was reported by the providers; the rest is priced from Daimond\'s rate table.',
	'spend.none_reported':         'Priced from Daimond’s rate table. No provider reported a cost for these turns.',
	'spend.none_reported_unknown': 'Priced from Daimond’s rate table, which is missing one of these models, so the figure is a rough guide.',
	// Why a total the user remembers as larger has fallen: the old rate table ran
	// high, and the estimates it made were corrected once, here, on this device.
	'spend.repriced': 'Estimates made before the rate table was corrected have been repriced on this device; under the old table this period read {amount}.',
	'spend.col_when':    'When',
	'spend.col_what':    'What',
	'spend.col_amount':  'Amount',
	'spend.col_balance': 'Balance',
	// Credit categories, as the gateway tags them. The first seven are metered
	// spends and are `SPEND_CATEGORIES` in gateway/src/schema.rs; the rest are
	// credit-side movements, named by their kind alone.
	//
	// `cat_infer` is model spend on the key Daimond mints and reconciles against
	// credits, which is a different pot from the Inference section above it —
	// that one is billed to the user's own provider key and never touches
	// credits. Hence "on credits" rather than "Inference" alone: the two sit on
	// one screen and the qualifier is the whole difference between them. It also
	// leads with the word that matters, because the dock is narrow enough to
	// truncate a label to its first two words.
	//
	// The category comes from the gateway, and the name is only built where the
	// category is one this build knows: `spend.js:103` fences it on `CATS`, and
	// anything else falls to `cat_unlisted` below. So the set is closed, and
	// `dev/verify_spendcats.mjs` is what keeps `CATS` itself in step with the
	// Rust. `fallback` and `unlisted` are named outright rather than built, and
	// are declared here because a variant is a key under the prefix.
	// i18n-family: spend.cat_ = web search mail sync storage infer other
	// i18n-family: spend.cat_ = topup refund grant adjust fallback unlisted
	'spend.cat_web':     'Web pages',
	'spend.cat_search':  'Web searches',
	'spend.cat_mail':    'Mail',
	'spend.cat_sync':    'Cross-device sync',
	'spend.cat_storage': 'Stored files',
	'spend.cat_infer':   'Inference on credits',
	'spend.cat_other':   'Other services',
	'spend.cat_topup':   'Credits bought',
	'spend.cat_refund':  'Refunds',
	'spend.cat_grant':   'Gifts & grants',
	'spend.cat_adjust':  'Adjustments',
	'spend.cat_fallback': 'Other',   // a category the gateway did not name
	// A category the gateway DID name and this build cannot. Money left the
	// balance with nothing to say for it, and that is what the row says: showing
	// the gateway's own token instead is how three weeks of untranslated
	// "infer" reached eight languages unnoticed.
	'spend.cat_unlisted': 'Not accounted for',

	// ── Tools ──────────────────────────────────────────────────
	// `tools.head` and `tools.shop_fine` are placed inside markup, so any HTML
	// in them is rendered. Keep the tags that are there and add none.
	// The Tools panel. Six keys that used to be here went with the panel it was
	// rewritten out of -- `tools.head`, `built_in`, `unlocked`, `sec_unlocked`,
	// `sec_shop` and `shop_fine` -- and are gone rather than kept against a
	// caller that no longer exists. These three outlived it and are still read.
	'tools.unlock_price': 'Unlock for {price}',
	'tools.unreachable':  'The account service could not be reached, so what is unlocked here is unknown.',
	'tools.no_service':   'The account service is unavailable.',
		'tools.intro':          'What Daimond can do for you. Most of it is included. A pack adds new ground, and is bought once in dollars rather than out of your credits.',
		'tools.count':          '<b>{have} of {all}</b> available on this account.',
		'tools.sec_included':   'Included',
		'tools.sec_packs':      'Packs',
		'tools.packs_none':     'No packs are on sale yet. When one is, it appears here.',
		'tools.packs_fine':     'A pack is bought once and kept. It is paid for in dollars, through the same checkout as Pro, and never out of your credits — so a pack costs the same whether you run Daimond on its credits or on your own API key.',
		'tools.status_included': 'Included',
		'tools.status_owned':   'Yours',
		'tools.locked_why':     'Not bought on this account: this is the {pack} pack. Daimond refuses it and says so rather than half-doing it.',
		'tools.expand':         'What it does ({n})',
		'tools.collapse':       'Hide what it does',
		'tools.fn_pack':        'in the {pack} pack',
		// The ten capabilities of `CAPS` in tools.js, plus the `other` that
		// `capOf` returns for a function nobody has placed. A pack landing with a
		// new capability lands here or the panel names it `tools.cap.x.name`.
		// i18n-family: tools.cap. = files.name files.blurb cloud.name cloud.blurb
		// i18n-family: tools.cap. = work.name work.blurb show.name show.blurb asking.name asking.blurb
		// i18n-family: tools.cap. = checking.name checking.blurb machine.name machine.blurb reading.name reading.blurb
		// i18n-family: tools.cap. = browsing.name browsing.blurb typeset.name typeset.blurb
		// i18n-family: tools.cap. = dispatch.name dispatch.blurb graph.name graph.blurb
		// i18n-family: tools.cap. = social.name social.blurb
		// i18n-family: tools.cap. = other.name other.blurb
		'tools.cap.files.name':      'Your files',
		'tools.cap.files.blurb':     'Daimond reads, writes and edits the files in your workspace — a spreadsheet’s cells and a document’s words included — finds things across all of them at once, and tidies up after itself.',
		'tools.cap.cloud.name':      'Files kept in the cloud',
		'tools.cap.cloud.blurb':     'A file this device is not holding is brought down from your cloud storage at the moment Daimond needs to read it, rather than everything being kept everywhere.',
		'tools.cap.work.name':       'Keeping the work together',
		'tools.cap.work.blurb':      'Daimond records which files belong to a piece of work, so something you made yourself is listed with it instead of sitting unremarked in a folder.',
		'tools.cap.asking.name':       'Asking you a question',
		'tools.cap.asking.blurb':      'Daimond puts one decision to you at a time, as answers you tap: each option says what it would concretely mean, one of them is named as the recommendation with the reason for it, and you can always answer in your own words instead.',
		'tools.cap.show.name':       'Showing you a file',
		'tools.cap.show.blurb':      'Daimond puts a file on your screen beside the chat — a PDF as its typeset pages, a picture drawn, a table as a table — rather than only describing it to you.',
		'tools.cap.checking.name':   'Checking its own work',
		'tools.cap.checking.blurb':  'Daimond runs one of this project’s own checks and reports what passed, what failed, and which of the check’s own break tests proved nothing.',
		'tools.cap.social.name':     'Talking to other people about Daimond',
		'tools.cap.social.blurb':    'Daimond reads what people have reported or asked for about Daimond itself, and — with your say-so each time, and after showing you exactly what would go out — reports or backs something on your behalf.',
		'tools.cap.machine.name':    'Your computer',
		'tools.cap.machine.blurb':   'With Daimond’s machine hand installed, Daimond builds, tests and runs command-line tools inside the folder you granted it, and nowhere else.',
		'tools.cap.reading.name':    'Reading the web',
		'tools.cap.reading.blurb':   'Daimond searches with the engine you chose and reads what a page actually says, without either of you leaving Daimond.',
		'tools.cap.browsing.name':   'Using a website',
		'tools.cap.browsing.blurb':  'Daimond opens a page beside the chat and works it — clicking, typing, scrolling — while you watch it happen.',
		'tools.cap.typeset.name':    'Typesetting a document',
		'tools.cap.typeset.blurb':   'Daimond turns a Typst source into a finished PDF, properly typeset, here in the browser.',
		'tools.cap.dispatch.name':   'Sending workers out',
		'tools.cap.dispatch.blurb':  'Daimond breaks a large job into bounded tasks and sends a worker to each, several at a time, then folds what they bring back into one answer.',
		'tools.cap.graph.name':      'How your work relates',
		'tools.cap.graph.blurb':     'Daimond reads and records the relations between your Diamonds, files, pages and chats — what supersedes what, what produced what.',
		'tools.cap.other.name':      'Not yet described',
		'tools.cap.other.blurb':     'Daimond has these and this panel has not been told what to call them. Open it to see what they are.',


	// ── The rail's Diamonds and chats ──────────────────────────
	'rail.no_diamonds':      'No Diamonds yet.',
	'rail.no_match':         'No Diamonds match.',
	'rail.no_chats':         'No chats yet.',
	// A chat tile with nothing behind it is two different things: one nobody
	// said anything in, and one whose transcript is on another device. The
	// second is the one a reader mistakes for lost work, so it says which.
	'rail.not_synced':       'not synced yet',
	'rail.not_synced_help':  'This conversation is on another of your devices and has not arrived here yet.',
	// Shown under the search box when nothing is tagged, so that an empty
	// filing system cannot be read as a missing one.
	'rail.tag_hint':         'No tags yet. Tag a Diamond and filter chips appear here.',
	'rail.tag_hint_help':    'Open a Diamond, then Tags on its crystal. Starter tags are offered there: {tags}.',
	'rail.dblclick_rename':  'Double-click to rename',
	'rail.rename_diamond':   'Rename Diamond',
	'rail.rename':           'Rename',
	'rail.rename_failed':    'Rename failed',
	'rail.delete_failed':    'Delete failed',
	'rail.create':           'Create',
	'rail.name':             'Name',
	'rail.model':            'Model',
	'rail.worker_model':     'Model for workers',
	'rail.worker_model_help': 'The daimon dispatches workers several at a time. Left as it is, they run on the Diamond’s own model.',
	'rail.err_name':         'Give the Diamond a name.',
	'rail.err_model':        'Choose a model for this Diamond to think with.',
	'rail.err_no_key':       'That provider has no readable key yet. Unlock, or add one.',
	'rail.err_no_key_worker': 'The workers’ provider has no readable key yet, so they would fall back to the Diamond’s own model. Unlock the key, or choose another provider.',
	'rail.create_failed':    'Could not create Diamond',
	'rail.created_unreadable': 'Diamond created, but not readable',
	'rail.created_unreadable_body': '"{name}" was written but could not be read back, so it is not in the rail. Reload the page. If it is still missing, this device’s storage is refusing to serve what it accepted.',

	// ── When a chat happened, and keeping it ───────────────────
	// A chat carries no name, so the rail says WHEN: a day heading, and the
	// time within that day on each tile. Neither repeats the other.
	'rail.day_today':        'Today',
	'rail.day_yesterday':    'Yesterday',
	'rail.day_earlier':      'Earlier',
	// Under Today only, and lower case: the heading above has already spoken,
	// so the tile finishes the phrase rather than starting a sentence.
	'rail.when_now':         'just now',
	'rail.when_min':         '{n} min ago',
	'rail.when_hr':          '{n} hr ago',
	// What a nameless chat is called inside a sentence — a toast, a label —
	// where the bare time would leave the sentence naming nothing.
	'rail.a_chat':           'a chat',
	'rail.chat_from':        'the chat from {when}',
	'rail.show_preview':     'Show the first message',
	'rail.show_preview_help': 'Show the first thing you said in each chat, under the time. Turn it off and the rail says only when.',
	// The way across, offered on the tile and again in the trash. The body is
	// the one place the difference between a chat and a Diamond is stated.
	'tile.keep':             'Keep',
	'tile.keep_help':        'Make a Diamond of this chat, with the whole conversation as its first artefact.',
	'keep.title':            'Keep as a Diamond',
	'keep.body':             'Name it, and this conversation is kept whole inside it. Chats expire; Diamonds do not.',
	'keep.ok':               'Keep it',
	'keep.gone':             'That chat is no longer here',
	'keep.gone_body':        'It was destroyed on this device or another one. Nothing was made.',
	'keep.made':             '{name} kept, with the conversation inside it.',
	'keep.made_bare':        '{name} made, but the conversation could not be written into it.',

	// ── The PPTW: pause, play, traffic light ───────────────────
	// One control at six placements. The state words are lower case because
	// they are appended to an action in the accessible name — "Pause Alpha —
	// running" — and a capital mid-sentence would read as a second label.
	'pause.everything':      'Everything',
	'pause.everything_help': 'Pause or resume everything that can spend: every Diamond, every chat, the workers, the mailboxes and any page fetched for you.',
	// {name} holds two different kinds of thing and no spacing suits both, so
	// this has a known rough edge in ja, zh-Hans and fr, and it is left alone
	// deliberately. It takes either a user-named Diamond or chat -- usually
	// Latin script -- or a translated node name. The ja template spaces the
	// particle off the name ('{name} を一時停止') because that is right for
	// "Alpha を一時停止" and wrong for "ウェブアクセス を一時停止"; zh-Hans
	// spaces it ('暂停 {name}') for the same reason and with the same cost
	// between two Chinese words; fr's 'Mettre {name} en pause' wants "l'accès"
	// once {name} is a common noun rather than a name. Every existing node
	// already reads this way. Gluing would fix the translated case and break
	// the commoner one, so nothing in this table fixes both -- only a call
	// site that knows which kind of name it is holding could.
	'pause.act_pause':       'Pause {name}',
	'pause.act_play':        'Resume {name}',
	// The three answers `pause.js:138` can give for a node: no leaf paused, every
	// leaf paused, or some of them.
	// i18n-family: pause.state_ = play pause mixed
	'pause.state_play':      'running',
	'pause.state_pause':     'paused',
	'pause.state_mixed':     'partly paused',
	'pause.this':            'this',
	'pause.workers':         'Workers',
	'pause.mail':            'Mail',
	'pause.mail_polling':    'Mailbox polling',
	'pause.unnamed_chat':    'Unnamed chat',
	// The refusals enforcement speaks at the spend boundary. {node} is a
	// HUMAN name -- DaimondPause.label(), not the node id -- because
	// "root/diamonds/a1b2/self" names the node exactly and tells the reader
	// nothing. All four say the same three things: what did NOT happen, that no
	// money moved, and where the control is. The web one once stayed silent
	// about the control, because `root/web` had no widget anywhere in the app;
	// the Web panel header has one now, and dev/verify_search_i18n.mjs asserts
	// all four name it, in every language.
	'pause.web':              'Web',
	'pause.refused_title':    'Paused',
	// `pauseWords` in gateway.js is handed the key by its two callers, which name
	// it outright; the helper itself is not one this check reads.
	// i18n-indirect: gateway.js key = pause.refused.mail pause.refused.web
	'pause.refused.turn':     '{node} is paused. No turn started, nothing spent. Press play on it to resume.',
	'pause.refused.dispatch': '{node} is paused. No agents dispatched, nothing spent. Press play on it to resume.',
	'pause.refused.web':      '{node} is paused. The page was not fetched and nothing was spent. Press play on it to resume.',
	'pause.refused.mail':     '{node} is paused. The mailbox was not contacted and nothing was spent. Press play on it to resume.',

	// ── Tags ───────────────────────────────────────────────────
	'tag.only_agents':   'Show only agents tagged "{tag}"',
	'tag.only_diamonds': 'Show only Diamonds tagged "{tag}"',
	'tag.clear_filter':  'Clear the "{tag}" filter',
	'tag.remove':        'Remove "{tag}"',
	'tag.add':           'Add "{tag}"',
	'tag.starters': 'person, project, topic, org',
	'tag.add_btn':       'Add',
	'tag.add_ph':        'Add a tag',
	'tag.on_diamond':    'On this Diamond',
	'tag.all':           'All your tags',
	'tag.all_used':      'Every tag you have is on this Diamond already.',
	'tag.none_yet':      'No tags yet.',
	'tag.save_failed':   'Could not save the tags',
	// The rail's boolean filter: the tags wanted, the tags refused, and how two
	// or more wanted tags combine. A chip in the rail cycles off, wanted,
	// refused, off; a chip in the summary comes out of the filter altogether.
	'tag.exclude_next':  'Showing Diamonds tagged "{tag}". Click again to hide them.',
	'tag.clear_exclude': 'Stop hiding Diamonds tagged "{tag}"',
	'tag.not_tagged':    'Not tagged "{tag}"',
	// i18n-indirect: daimond.js m[1] = tag.mode_all tag.mode_any
	// i18n-indirect: daimond.js m[2] = tag.mode_all_help tag.mode_any_help
	'tag.mode_all':      'All',
	'tag.mode_any':      'Any',
	'tag.mode_all_help': 'Show only Diamonds carrying every one of these tags',
	'tag.mode_any_help': 'Show Diamonds carrying any one of these tags',
	'tag.mode_aria':     'How the chosen tags combine',
	'tag.clear_all':     'Clear',
	'tag.clear_all_help': 'Take every tag out of the filter',
	// The one row the pool of chips sits behind, under the search box. It is
	// there whenever a tag is, because a filter nobody can see is a filter
	// nobody finds -- and it is only a row, because a vocabulary of thirty tags
	// standing open costs the rail's two lists four rows on every screen.
	// {n} is how many tags are behind it.
	'tag.pool_toggle':    'Filter by tag ({n})',
	'tag.pool_show_help': 'Show every tag you can filter on',
	'tag.pool_hide_help': 'Put the tags away. Anything you are filtering on stays on, and stays in view.',
	// The chips that are doing the filtering, shown on their own while the tags
	// are put away.
	'tag.active_aria':    'Tags the rail is filtering on',
	// Deleting a tag from the pool, which takes it off every Diamond that carries it.
	'tag.delete_help':        'Delete the tag "{tag}" everywhere',
	'tag.delete_title':       'Delete this tag?',
	'tag.delete_body_used.one':   'Delete the tag "{tag}"? It comes off the {n} Diamond carrying it. Nothing else about that Diamond changes.',
	'tag.delete_body_used.other': 'Delete the tag "{tag}"? It comes off all {n} Diamonds carrying it. Nothing else about them changes.',
	'tag.delete_body_unused': 'Delete the tag "{tag}"? No Diamond carries it, so this only takes it off the list.',
	'tag.delete_ok':          'Delete the tag',
	'tag.deleted':            'Tag "{tag}" deleted.',
	'tag.deleted_from.one':   'Tag "{tag}" deleted from {n} Diamond.',
	'tag.deleted_from.other': 'Tag "{tag}" deleted from {n} Diamonds.',
	'tag.editor_note':   'Tags file this Diamond in the rail. They are never sent to a model and never enter the crystal.',

	// ── Starting and interrupting a turn ───────────────────────
	'chat.choose_model':   'Choose a model to start this chat.',
	'chat.no_key_start':   'That provider has no readable key yet. Unlock, or add one, to start this chat.',
	'chat.connect_start':  'Connect a provider to start this chat.',
	'chat.pending_hint':   'Pick a model in this chat\u2019s tile and press \u25b6 Start to begin.',
	'chat.start_selected': 'Start with the selected model',
	'chat.stop':           'Stop',
	'turn.interrupted':       'Interrupted. The browser closed before this finished.',
	'turn.interrupted_early': 'Interrupted before it could answer.',
	'turn.offline':           'The connection dropped before this finished. Nothing was lost — pick it up where it stopped.',
	'turn.offline_early':     'The connection dropped before an answer arrived. Nothing was lost — ask again from here.',
	'turn.continue':          'Continue',
	'turn.continue_help':     'Run this turn again from your message.',
	'astat.no_model':         'No model connected',
	'astat.model_help':       'The models Daimond can run, and the keys behind them',

	// ── Folding a chat into a Diamond ──────────────────────────
	'fold.nothing':          'Nothing to fold',
	'fold.chat_empty':       'This chat is empty. Send a message first, then fold it into a Diamond.',
	'fold.turns_empty':      'The turns you chose have no content to fold in.',
	'fold.agent_empty':      'This agent produced no summary to fold.',
	'fold.into':             'Fold into…',
	'fold.n_turns_into.one':   'Fold {n} turn into…',
	'fold.n_turns_into.other': 'Fold {n} turns into…',
	'fold.no_diamonds':      'No Diamonds yet. Create one:',
	'fold.new_diamond':      '＋ New Diamond…',
	'fold.connect_first':    'Connect a provider to fold into a Diamond.',
	'fold.create_and_fold':  'Create and fold',
	'fold.no_key':           'That Diamond’s provider has no readable key. Unlock, or add one, to fold into it.',
	'fold.nothing_new':      'Nothing new to fold',
	'fold.nothing_new_body': '"{chat}" has not changed since it was folded into "{diamond}".',
	'fold.proposing':        'Proposing fold…',
	'fold.diamond_gone':     'Diamond is gone',
	'fold.diamond_gone_body': 'The Diamond that dispatched this agent no longer exists.',
	'fold.diamond_gone_chat_body': 'The Diamond you chose no longer exists; it may have been deleted in another tab. Nothing was folded.',
	'fold.empty_reply':      'The model returned nothing to fold, so nothing was proposed. Try again.',
	'fold.proposed_toast':   'Fold proposed. Accept or Reject it below.',
	'fold.proposed_elsewhere': 'Fold proposed on "{diamond}". Open it to Accept or Reject.',
	'fold.pending_badge':    'fold waiting',
	'fold.pending_badge_help': 'A proposed fold is waiting on this Diamond. Open it to accept or reject the change.',
	// The fold diff's heading. Four shapes rather than one with glue, because a
	// language that puts the target first cannot reorder a fragment.
	'diff.folding_chat':      'Folding "{chat}". Review the change, then Accept or Reject.',
	'diff.folding_chat_into': 'Folding "{chat}" into "{diamond}". Review the change, then Accept or Reject.',
	'diff.proposed':          'Proposed fold. Review the change, then Accept or Reject.',
	'diff.proposed_into':     'Proposed fold into "{diamond}". Review the change, then Accept or Reject.',
	'diff.no_change':         'No change proposed. The crystal already covers this.',
	'diff.no_change_into':    'No change proposed into "{diamond}". The crystal already covers this.',
	'diff.accept':            'Accept fold',
	'diff.reject':            'Reject',
	'diff.nothing_to_apply':  'Nothing to apply. The proposal matches the current crystal.',
	// What accepting would take OUT. A fold that only adds needs no warning; one
	// that drops a key the crystal already holds is the change worth naming, and
	// {keys} is the list of them, joined by the caller.
	'fold.keys_lost':         'Accepting this removes: {keys}',

	// ── The crystal ────────────────────────────────────────────
	'crystal.page':           'Page',
	'crystal.page_help':      'Ask the daimon to change how this crystal looks, not what it says',
	'crystal.page_note':      'Change this Diamond\'s PAGE (crystal.html), not its memory (crystal.json). Read crystal.html first, then edit it, and leave crystal.json alone. Keep it self-contained: all CSS and JavaScript inline, images only as data: URIs, no fetch, no external files, no eval. Keep its ready, rendered and height messages, and let rendered name every top-level key of the data that has content. A page may also save files into this Diamond with the save message and read them back with asset, so an interactive page can keep what the user does. What I want: ',
	'crystal.history':        'History',
	'crystal.tags':           'Tags',
	'crystal.tags_help':      'File this Diamond in the rail',
	'crystal.marks_unread':   'The attachments could not be read, so this turn works only in the Diamond.',
	'crystal.empty':          'The crystal is empty. Steer it below to begin.',
	'crystal.empty_paren':    '(empty)',
	'crystal.save_failed':    'Could not save the crystal',
	'crystal.back':           'Back to the crystal',
	'crystal.no_history':     'No history yet.',
	'crystal.view':           'View',
	'crystal.restore':        'Restore',
	'crystal.restore_v':      'Restore v{v}',
	'crystal.restore_title':  'Restore a version',
	'crystal.restore_body':   'Restore the crystal to v{v}? The current text is kept in the history, so this can itself be undone.',
	'crystal.restore_failed': 'Could not restore',
	'crystal.at_version':     'Crystal at v{v}',
	'crystal.read_version_failed': 'Could not read that version',
	'crystal.delta':          'Delta',
	'crystal.delta_help':     'The raw input this fold was made from',
	'crystal.delta_at':       'Delta folded at v{v}',
	'crystal.read_delta_failed': 'Could not read the delta',
	'crystal.view_switch':    'Which face of this Diamond',
	'crystal.view_crystal':   'Crystal',
	'crystal.view_chat':      'Chat',
	// Full screen, on the crystal face. The label names the DESTINATION rather
	// than the state, because while the mode is on this control is the way out
	// and the only chrome left on screen.
	'crystal.full':           'Full screen',
	'crystal.full_help':      'Fill the screen with this page',
	'crystal.full_exit':      'Exit full screen',
	'crystal.full_exit_help': 'Put the rail and the top bar back',
	'crystal.chat_empty':     'Nothing said yet. The crystal is what this Diamond knows; this is how it came to know it.',
	'crystal.dispatch_after_error': 'The turn ended badly, so the agents it asked for were not started.',

	// ── A capp, delivered from the guide ───────────────────────
	// One template ships, and `{name}` is its name rather than a word in the
	// English: a second template must not need a second set of these.
	'capp.title':        '{name}',
	'capp.make_body':    'This makes a Diamond called “{name}” and puts the {name} page inside it. What you record stays in that Diamond, on this device.',
	'capp.make_ok':      'Make it',
	// A second one is not a second log, it is a lost one.
	'capp.exists_body':  'You already have a Diamond called “{name}”, and what you have logged is in it. Making a second one would leave those entries behind.',
	'capp.exists_ok':    'Open it',
	'capp.missing_body': 'This build of Daimond does not carry the {name} template, so there is nothing to put in a Diamond. Nothing has been made. Ask your daimon for a page instead, or update Daimond and try again.',
	'capp.page_failed':  'The Diamond was made, but its page could not be written: {why}',
	// Keeping a capp's page up to date. A capp made before capps carried a
	// version cannot be told apart from one the user has edited, so it is ASKED
	// rather than replaced — an offer, not a warning. `{name}` is the capp's own
	// name, `{files}` the list of files left alone, `{why}` a reason already in
	// the reader's language.
	//
	// "lanes" is the Life log page's own word for its columns, and that page is
	// in English whatever the app is set to. It is left in English here for the
	// same reason Diamond is: a translated word for a thing labelled otherwise
	// on the screen sends the reader looking for something that is not there.
	'capp.legacy_body':  'This {name} was made before capps carried a version, so Daimond cannot tell which parts of its page are the ones it was given. Bring its page up to the current one? Your lanes and your entries are left alone.',
	// Says WHAT it updates. The Reset control beside it does something quite
	// different, and a bare "Update" invites the two to be confused.
	'capp.legacy_ok':    'Update the page',
	'capp.update_kept':  'The page has been brought up to date. These files are yours and were left as they are: {files}.',
	'capp.update_failed': 'The page could not be replaced: {why}',
	// A capp's page resets to ITS OWN template, not to a blank or standard page:
	// `crystal.page_reset_confirm` is the one that says "the standard one" and it
	// is a different sentence for a different case. Nothing here may imply the
	// page comes back empty.
	'capp.page_reset_confirm': 'Replace this Diamond’s page with the current {name} page? What you have logged is not touched.',
	'crystal.steering':       'Steering…',
	'crystal.no_key_steer':   'This Diamond’s provider has no readable key. Unlock, or add one, to steer it.',
	'crystal.page_failed':    'This Diamond’s page did not load, so its data is shown instead.',
	'crystal.page_partial':   'This Diamond’s page did not show everything it holds, so its data is shown instead.',
	'crystal.page_reset':     'Reset the page',
	'crystal.page_reset_confirm': 'Replace this Diamond’s page with the standard one? Its data is not touched.',
	'crystal.ask':            'Ask the daimon to change this page',
	'crystal.edit_json':      'Edit as JSON',
	'crystal.json_invalid':   'That is not valid JSON, so nothing was saved.',
	'crystal.field_title':    'Title',
	'crystal.field_summary':  'Summary',
	'crystal.field_sections': 'Sections',
	'crystal.field_facts':    'Facts',
	'crystal.field_open':     'Open threads',
	'crystal.field_links':    'Links',
	'crystal.field_heading':  'Heading',
	'crystal.field_body':     'Body',
	'crystal.add_section':    'Add a section',
	'crystal.remove':         'Remove',
	'crystal.other_fields':   'Other fields',
	'crystal.other_fields_note': 'Kept as they are, and shown here so nothing vanishes.',

	// ── Artefacts ──────────────────────────────────────────────
	'arte.count.one':      '{n} artefact',
	'arte.count.other':    '{n} artefacts',
	'arte.strip_help':     'What this Diamond produced or consulted',
	'arte.refer_help':     'Refer to this in the steer box',
	'arte.drop_help':      'Not an artefact of this Diamond',
	'arte.drop_named': 'Drop "{name}" as an artefact',
	'arte.file_fenced':      'That path is outside what this Diamond may read',
	'arte.file_fenced_body': 'The fence stopped the read. Grant the folder to this Diamond, or move the file inside one it already has.',
	'arte.file_gone':      'That file is not there any more',
	'arte.file_gone_body': '“{path}” is an artefact of this Diamond, but it cannot be read now; it may have been renamed, moved or deleted.',
	'arte.nothing_to_open': 'Nothing to open',
	'arte.no_viewer':      'This artefact is a \u201c{kind}\u201d, which this version has no viewer for.',

	// ── Attach to focus (ATTACH_CONTRACT.md) ────────────
	'attach.to_focus':     'Attach to current focus',
	'attach.note':         'Note',
	'attach.read':         'Read',
	'attach.note_help':    'The path is worth knowing. Costs a few tokens.',
	'attach.read_help':    'The contents are wanted now. A file can run to thousands of tokens.',
	'attach.add':          'Attach',
	'attach.view_stack':   'Stack',
	'attach.view_icons':   'Icons',
	'attach.prefix_note':  'Note {paths}',
	'attach.prefix_read':  'Read {paths} in full.',
	'attach.cleared':      'Attachments cleared',
	'attach.list':         'Attachments',
	'attach.pick_title':   'Attach files and folders',
	'attach.pick_empty':   'Nothing here.',
	'attach.already':      'Already attached',
	'attach.not_here':     'Held by this chat, but it lives {where}, which is not the workspace you have open. This chat cannot reach it from here.',
	// The workspace group in the chat footer. Its heading is not here: it is
	// `astat.workspace_browser` / `astat.workspace_native`, so the footer, the
	// account strip and the guide say the same words about the same idea.
	'attach.ws_mark':      'Workspace',
	'attach.ws_add':       'Mark a folder into the workspace',
	'attach.add_mark':     'Mark a folder in',
	'attach.mark_note':    'Ticking a FOLDER marks it in: this workspace may then read and change what is inside. Ticking a file only puts it in front of the model.',
	'attach.mark_focus':   'Mark this folder into {name}, so its daimon may read and change what is inside',
	'attach.ws_help':      'The folders this chat may read and change. Marking one in is the permission, and nothing will ask you again.',
	'attach.ws_on':        'In this chat’s workspace: it may read and change what is inside. Press to take it out.',
	'attach.ws_off':       'Not in the workspace, so this chat cannot open it. Press to mark it in.',
	'attach.ws_empty':     'No folder is marked in. This chat can reach nothing of yours, only its own working folder. Mark one in with the + above.',
	'attach.group_prompt': 'In front of the model',
	'attach.group_prompt_help': 'Named or quoted in the prompt when you send. This grants no reach.',
	'attach.read_block':   'The contents of {path}:',
	'attach.read_cut':     'That is as much of {path} as fits here.',

	// ── This Diamond's workspace ───────────────────────────────
	'dws.title':           'This Diamond\u2019s workspace',
	'dws.count.one':       '{n} item',
	'dws.count.other':     '{n} items',
	'dws.none_yet':        'Nothing kept here yet',
	'dws.mode_all':        'Everything',
	'dws.mode_diamond':    'This Diamond',
	'dws.empty':           'Nothing is kept with this Diamond yet. What you keep here is what its daimon can open.',
	// An attachment records the workspace it was made in, so one made on the
	// machine can say so when the browser sandbox is what is open.
	'dws.not_here':        'Kept with this Diamond, but it lives {where}, which is not the workspace you have open. Its daimon cannot reach it from here.',
	'dws.in_machine':      'in the folder "{name}" on this machine',
	'dws.in_browser':      'in the browser workspace',
	'dws.a_folder':        'a folder',
	'dws.attach_dir':      'Keep this folder with {name}',
	'dws.detach_dir':      'Stop keeping this folder with {name}',
	'dws.elsewhere':       'Lives in the workspace',
	'dws.readonly':        'Read only',
	'dws.showing':         'Showing',
	'dws.reach':           'Reach',
	'dws.reach_help':      'The folders this Diamond’s daimon may write in. Shown in both trees, because it is true in both.',
	'dws.reach_own':       'its own folder',
	'dws.reach_search':    'A search that names no path looks in these and nowhere else.',
	'dws.reach_none':      'Nothing else is marked in, so {name}’s daimon can write nowhere else of yours — and a search that names no path looks only here.',
	'dws.mark_here':       'Mark “{name}” in',
	'dws.mark_here_help':  'Put the folder you are looking at into {name}’s workspace. Its daimon may then read and change what is inside, and a search that names no path will look there.',
	'dws.kits':            'Toolchains',
	'dws.kits_help':       'Which compilers and package managers a command from this Diamond may reach on your computer. Off unless you say so; no daimon chooses this.',
	'dws.kit_on':          'Grant the {kit} toolchain to {name}',
	'dws.kit_off':         'Take the {kit} toolchain back from {name}',
	'dws.kit_failed':      'That toolchain grant was not saved',
	'dws.kit_none':        'No toolchain. A command can reach this Diamond\u2019s files and nothing else on your computer.',

	// \u2500\u2500 Links between Diamonds \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	'link.count.one':      '{n} linked Diamond',
	'link.count.other':    '{n} linked Diamonds',
	'link.strip_help':     'How this Diamond stands to your other Diamonds',
	'link.none':           'No links to another Diamond yet.',
	'link.this':           'this',
	'link.rel_blank':      'linked',
	'link.out_help':       'This Diamond \u2192 {rel} \u2192 \u201c{name}\u201d',
	'link.in_help':        '\u201c{name}\u201d \u2192 {rel} \u2192 this Diamond',
	'link.open_other':     'Show \u201c{name}\u201d',
	'link.note_help':      'Show the note on this link',
	'link.drop':           'Remove link',
	'link.drop_help':      'Remove this link',
	'link.drop_confirm':   'Remove the \u201c{rel}\u201d link with \u201c{name}\u201d? Both Diamonds stay; only the link goes.',
	'link.drop_failed':    'Could not remove the link',
	'link.gone':           'That Diamond is not there any more',
	'link.gone_body':      '“{ref}” is linked from this Diamond, but no Diamond of that id can be read now; it may have been deleted.',
	'link.gone_name':      '(deleted Diamond)',
	'link.add_btn':        'Link',
	'link.add_title':      'Link this Diamond to another',
	'link.pick_label':     'Diamond',
	'link.pick_ph':        'Find a Diamond by name',
	'link.pick_none':      'No Diamond matches that.',
	'link.pick_empty':     'There is no other Diamond to link to yet.',
	'link.change_pick':    'Change',
	'link.rel_label':      'Relation',
	'link.rel_sug_help':   'Suggestions only; any word will do',
	'link.rel_use':        'Use \u201c{rel}\u201d',
	'link.note_label':     'Note',
	'link.note_ph':        'Why, in a sentence (optional)',
	'link.direction_note': 'The link runs from this Diamond to the one you pick.',
	'link.need_target':    'Choose the Diamond to link to first.',
	'link.save':           'Add link',
	'link.graph_open':     'Graph',

	// ── Agents ─────────────────────────────────────────────────
	'agents.none_yet':            'No agents yet. Ask a Diamond to start one and it appears here.',
	'agents.no_match':            'No agents match. Clear the search or filter.',
	'agents.fold_in':             'Fold in',
	'agents.fold_in_help':        'Fold this agent\u2019s summary into "{name}"',
	'agents.folded':              'folded',
	'agents.already_folded':      'Already folded',
	'agents.already_folded_body': 'This agent\u2019s summary has already been folded into the crystal.',
	'agents.a_diamond':           'Diamond',
	'agents.clear_diamond_filter': 'Clear the Diamond filter',
	'agents.clear_chat_filter':    'Clear the chat filter',
	'instructions.chip_help':     'Your standing instructions, given to every agent. Click to open.',
	'instructions.chip_empty':    'Nothing here yet. This file goes to every agent Daimond runs. Click to write it.',
	'instructions.chip_two':      'Two layers are in force, yours and this project’s. Click to open yours.',

	// ── The System section: Daimond's own store ────────────────
	'sys.head':  'System',
	'sys.note':  'Daimond\u2019s own files. They live in the browser, not in the folder you have open, and they travel between your devices.',
	'sys.empty': 'nothing here yet',
	'sys.up':    'Up one folder',

	// ── What each kind of agent is told ────────────────────────
	// The five roles of `Prompts.roles` in daimond.js, each carrying the key for
	// its own name and note.
	// i18n-indirect: daimond.js r.label = role.chat role.daimon role.worker role.reducer role.compactor
	// i18n-indirect: daimond.js r.blurb = role.chat_help role.daimon_help role.worker_help role.reducer_help role.compactor_help
	'role.chat':            'Chat',
	'role.chat_help':       'The agent you talk to.',
	'role.daimon':         'Diamond daimon',
	'role.daimon_help':    'Keeps a Diamond\u2019s crystal, and dispatches workers.',
	'role.worker':          'Dispatched worker',
	'role.worker_help':     'One task, its own context, reports back.',
	'role.reducer':         'Crystal fold',
	'role.reducer_help':    'Folds one delta into the crystal.',
	// ── Triggered actions ──────────────────────────────────────
	'trig.head':            'When this Diamond acts',
	'trig.none':            'Nothing set. This Diamond answers when you prompt it and at no other time.',
	'trig.activity':        'After {n} minutes of your activity',
	'trig.mail':            'When mail arrives in {folder} ({mailbox})',
	'trig.edit':            'Edit this action',
	'trig.choose':          'Which action',
	'trig.opt_on':          '▶ {what}',
	'trig.opt_off':         '⏸ {what}',
	'trig.nothing_written': 'nothing written',
	'trig.edit_this':       'Edit the {what}',
	'trig.copy_this':       'Copy the {what}',
	'trig.copy':            'Copy its instruction and context',
	'trig.copied':          'Copied.',
	'trig.copy_failed':     'The clipboard refused. Open the action and copy from the box.',
	'trig.remove':          'Remove',
	'trig.remove_body':     'Remove “{what}”? This Diamond will stop acting on it.',
	'trig.add':             'Add an action',
	'trig.add_kind':        'What sets it off',
	// The trigger editor builds its rows from helpers handed a key: `field`,
	// `longText` and the tile dialog's `row`, whose callers name these outright.
	// i18n-indirect: daimond.js pair[1] = trig.kind_activity trig.kind_mail
	// i18n-indirect: daimond.js labelKey = trig.minutes trig.mailbox trig.folder trig.instruction trig.context tile.model_daimon tile.model_workers tile.model_vision
	// i18n-indirect: daimond.js phKey = trig.instruction_ph trig.context_ph
	// i18n-indirect: daimond.js helpKey = tile.model_daimon_help tile.worker_model_help tile.model_vision_help
	'trig.kind_activity':   'Minutes of my activity',
	'trig.kind_mail':       'Mail arriving',
	'trig.note':            'These live in {path}, where you and this Diamond can both read them.',
	'trig.edit_title':      'Edit: {what}',
	'trig.minutes':         'Minutes',
	'trig.minutes_note':    'Minutes you are working, not minutes on the clock. A tab left open overnight counts none of them.',
	'trig.mailbox':         'Mailbox',
	'trig.folder':          'Folder',
	'trig.no_mailbox':      'No mailbox set up yet',
	'trig.instruction':     'Instruction',
	'trig.instruction_ph':  'What to ask this Diamond to do when it fires…',
	'trig.context':         'Context',
	'trig.context_ph':      'Background it needs the first time, and only the first time…',
	'trig.context_note':    'Sent once, in front of the first instruction. Change it and it is sent again.',
	'trig.section':          'Triggered actions',

	'role.compactor':       'Context fold',
	'role.compactor_help':  'Summarises a conversation that has outgrown its window. Its answer becomes what the chat remembers.',

	// ── The Workspace panel ────────────────────────────────────
	// The disclosure at the foot of the Workspace tree. Not "hidden files": the
	// row is the panel saying what it is not showing, so the name describes the
	// contents rather than labelling them, and the count says what opening it costs.
	'files.rest':            'The rest of this folder',
	'files.rest_count.one':  '{n} entry',
	'files.rest_count.other': '{n} entries',
	'files.rest_help':       'Everything else in this folder: the files and folders whose names begin with a dot, and the ones Daimond keeps for its own work \u2014 your rules and skills, your mail, the prompt each kind of agent is given. Nothing here is off limits to you; it is only out of the way. Open it to read or change any of it.',
	'files.back':            'Back',
	'files.edit':            'Edit',
	'files.stop_editing':    'Stop editing',
	'files.line_numbers':    'Line numbers',
	'files.download':        'Download',
	'files.download_help':   'Save to this machine',
	'files.hold_add': 'Keep this file with {name}',
	'files.hold_drop': 'Stop keeping this file with {name}',
	'files.mode_browser': 'Browser',
	'files.browser_switch': 'Switch the agent back to the private in-browser workspace.',
	'files.browser_help': 'The agent works in a private in-browser workspace. This is what syncs.',
	'files.mode_machine': 'Machine',
	'files.machine_here': 'The agent reads and writes this real folder. It does not sync.',
	'files.machine_pick': 'Let the agent work in a real folder on this machine. It will not sync.',
	'files.machine_needs_chromium': 'Real folders need a Chromium-based browser.',
	'files.machine_reconnect': 'Reconnect {name}',
	'files.mode_cloud': 'Cloud',
	'files.cloud_on_machine': 'Cloud storage carries your browser workspace, not a folder on this machine.',
	'files.cloud_help': 'Where your workspace lives, so it can be larger than this device.',
	'files.import_folder': 'Import a folder…',
	'files.import_folder_help': 'Copy a folder from this machine into the workspace, so it syncs',
	'files.save_copy': 'Save a copy…',
	'files.save_copy_help': 'Write the workspace out to a folder on this machine',
	'files.delete':          'Delete',
	'files.rename_move':     'Rename or move',
	'files.rename_hint':     'A name, or a path, to move it somewhere else.',
	'files.err_name':        'Enter a name.',
	'files.rename_failed':   'Could not rename: {reason}',
	'files.no_match':        'Nothing matches "{filter}".',
	'files.new_doc_here':    'New document. Save writes it into {place}.',
	'files.new_file_hint':   'Name it DAIMOND.md to write standing instructions every agent will follow.',
	'files.create_failed':   'Could not create file: {reason}',
	'files.create_folder_failed': 'Could not create the folder: {reason}',
	'files.delete_file_body':   'Delete "{name}"? This cannot be undone.',
	'files.delete_folder_body': 'Delete the folder "{name}" and everything inside it? This cannot be undone.',
	'files.delete_failed':   'Could not delete {name}: {reason}',
	'files.upload_failed':   'Could not upload {name}: {reason}',
	'files.uploaded.one':    'Uploaded {n} file.',
	'files.uploaded.other':  'Uploaded {n} files.',
	'files.saving':          'Saving…',
	'files.saved':           'Saved.',
	'files.save_failed':     'Save failed: {reason}',
	'files.save_cancelled':  'Save cancelled. The file changed on disk.',
	'files.discard':         'Discard',
	'files.discard_title':   'Discard your changes?',
	'files.keep_editing':    'Keep editing',
	'files.unsaved_body':    'Your changes to {path} have not been saved. Close the editor and lose them?',
	'files.editing_stopped': 'Editing stopped. Nothing was written.',
	'files.overwrite':       'Overwrite',
	'files.conflict_title':  'It changed while you were editing',
	'files.conflict_body':   'This file changed on disk since you opened it, most likely an agent. Save anyway and overwrite those changes?',
	'files.changed_while_editing': 'This file changed on disk; an agent edited it. Your edits are kept, and saving asks before overwriting.',
	'files.reloaded':        'Reloaded. The file changed on disk.',
	'files.compile':         'Compile',
	'files.compiling':       'compiling',
	'files.compiling_path':  'Compiling {path} …',
	'files.compiled':        'Compiled → {path} ({size})',
	'files.compile_failed':  'Compile failed: {reason}',
	'files.binary_note':     'A binary file of {size}. It is stored and synced like everything else here, but there is nothing to show. Download it to open it in something that understands it.',
	// Cloud storage, seen from the Workspace panel.
	'files.cloud':           'Cloud',
	'files.cloud_storage':   'Cloud storage',
	'files.cloud_empty':     'Nothing in cloud storage yet. Your workspace is limited to what this browser grants.',
	'files.cloud_locked':    'Unlock to use cloud storage. Without it your workspace is limited to what this browser grants.',
	'files.cloud_some_away': '{n} files in cloud storage; {away} of them not on this device.',
	'files.cloud_all_here':  '{n} files in cloud storage, all of them also on this device.',
	'files.cloud_intro':     'Your workspace lives in cloud storage, and this device holds as much of it as it can. {n} files, {total} in total;',
	'files.cloud_away':      '{n} of them ({bytes}) are not on this device.',
	'files.cloud_here':      'all of them are also on this device.',
	'files.cloud_none':      'Nothing is in cloud storage yet. Without it your workspace is limited to what this browser grants you.',
	'files.cloud_none_quota': 'Nothing is in cloud storage yet. Without it your workspace is limited to what this browser grants you, {quota} here.',
	'files.cloud_cap':       'This browser has granted {quota}, of which {used} is used. Files are freed automatically as it fills, unless you have pinned them.',
	'files.reclaim':         'Free up space',
	'files.reclaim_help':    'Free up space on this device now',
	'files.get_help':        'Bring this file onto this device ({size})',
	'files.pinned_short':    'Pinned to this device',
	'files.pinned_help':     'Pinned: always kept on this device. Click to release.',
	'files.pin_help':        'Pin: never free this one to make room.',
	'files.free_help':       'Keep it in cloud storage; drop the copy here',
	'files.fetch':           'Fetch',
	'files.fetch_body':      'Bring "{path}" onto this device? That downloads {size}.',
	'files.fetching':        'Fetching {path}…',

	// ── Where the agent works: the root, and its scope ──────────
	// Changing the root is a separate act from switching between the browser sandbox and the
	// disk. The Machine chip used to do both, so a user who had gone to the sandbox and back was
	// shown the folder picker every time -- and had no way to state the root's scope, which is the
	// one thing they most need to know before pointing an agent at a directory.
	'files.change_root':      'Change folder…',
	'files.change_root_help': 'Point the agent at a different folder on this machine',
	'files.machine_scope':    'The agent works only inside {name}. Nothing outside that folder is visible to Daimond.',
	'files.machine_return':   'Put the agent back to work in {name}',
	'files.forget_root':      'Forget this folder',
	'files.forget_root_help': 'Stop offering this folder. Daimond keeps no record of it, and asks you to pick one next time.',
	'files.root_forgotten':   'Forgotten. Daimond no longer holds a record of that folder.',

	// Diamond files an earlier build left in a folder, brought back into Daimond's own storage.
	// Said out loud rather than done quietly: files moved, and the copies in the user's project
	// are still there for them to delete when they are satisfied.
	'files.adopted_title.one':   'A Diamond was brought back',
	'files.adopted_title.other': '{n} Diamonds were brought back',
	'files.adopted_body':        'Daimond found its own files in this folder and copied them back into its own storage, where they sync: {names}. The copies were left where they are, under diamonds/; delete them once you are satisfied.',
	'files.adopted_kept':        'These differed from what Daimond already held, so both copies were kept:\n{paths}',
	// And what did not come back. The copy runs under a budget, and a file past it is
	// left where it is — which the user has to be told, or a Diamond arrives missing a
	// part of itself and looks whole.
	'files.adopt_left_title':    'Some files stayed in the folder',
	'files.adopted_skipped':     'These were not copied, being over 8 MiB or unreadable, so a Diamond that needs one is here without it, or not here at all:\n{paths}',

	// ── The file viewer ────────────────────────────────────────
	// A file is shown as what it IS: decoded where the browser can decode it,
	// laid out where it is text-shaped, and dumped as bytes otherwise. The floor
	// is the tier that matters, so its wording says what the file is and why the
	// bytes are what a reader is looking at, rather than apologising.
	//
	// {fmt} is a format's name, from the `fileview.fmt.*` lookup the viewer does
	// per media variant; where a locale has no entry the library's own English
	// label ("PDF document") stands.
	//
	// That lookup is an OPEN extension point with no members, deliberately: the
	// variant comes from `fe2o3_stds::media`, whose set of formats grows in the
	// Rust library and not here, so any list written in this file would be wrong
	// by the next release. A locale that wants to name a PDF in its own language
	// adds `fileview.fmt.<variant>` and it is picked up; adding none costs the
	// library's English and nothing else.
	// i18n-family: fileview.fmt. = open -- the variants are media names from fe2o3_stds::media, which this app does not own
	//
	// {shown}, {total}, {from} and {to} are
	// already formatted numbers -- grouped by the reader's own locale -- so they
	// are never re-formatted here.
	'fileview.read_failed':      'This file could not be read: {reason}',
	'fileview.disagree':         'The name says {named}. The bytes say {found}, and the bytes are what is shown.',
	'fileview.empty':            'This file is empty.',
	'fileview.too_large':        'A {fmt} of {size} is too large to hold in memory here. Its bytes follow; download it to open it elsewhere.',
	'fileview.decode_failed':    'This browser could not decode this {fmt}.',
	'fileview.frame_title':      'The contents of {name}',
	'fileview.json_bad':         'This is not one JSON value, so it is shown as text.',
	'fileview.tree_capped':      'The tree is cut short here; the file is larger than it shows.',
	'fileview.rows_capped':      'Showing the first {shown} rows of {total}.',
	'fileview.capped':           'Showing the first {shown} of {total}.',
	// The honest floor. Two sentences rather than one with a hole in it: with the
	// format unknown, "no viewer here for a Unknown" is what the hole fills with.
	'fileview.hex_note':         'There is no viewer here for a {fmt}, so these are its bytes.',
	'fileview.hex_note_unknown': 'Nothing here recognises this file, so these are its bytes.',
	'fileview.hex_prev':         'Earlier bytes',
	'fileview.hex_next':         'Later bytes',
	'fileview.hex_at':           'Bytes {from} to {to} of {total}',

	// A Word document or a spreadsheet, unpacked into what it SAYS rather than
	// drawn as it prints. Every line here is about the gap between those two,
	// so none of them may be shortened into reassurance: "reading view" is the
	// whole warning, and a file whose macros are not run has to say so before a
	// reader assumes this opened it the way their office suite would.
	//
	// {why} is a reason from the reader library and arrives in English. {n},
	// {shown}, {rows} and {cols} are already formatted numbers. The English
	// writes "(s)" rather than a plural pair because the count is the key's own
	// argument; a language that pluralises properly does so in its own file.
	'fileview.office_too_large': 'A {fmt} of {size} is too large to unpack here. Its bytes follow.',
	'fileview.office_failed':    'This document could not be read: {why}',
	'fileview.office_reading':   'Reading view. This is what the document says, not how it prints.',
	'fileview.office_tracked':   '{n} tracked insertion(s) are shown as accepted; deletions are not shown.',
	'fileview.office_macros':    'This file contains macros. They are not run and not read.',
	'fileview.office_undrawn':   '{total} things are not drawn: {parts}.',
	'fileview.sheet_failed':     'This spreadsheet could not be read: {why}',
	'fileview.sheet_stored':     'Values are as stored in the file. Formulas are not recalculated.',
	'fileview.sheet_capped':     'Showing {shown} of {rows} rows and {cols} columns of this sheet.',
	'fileview.sheet_formulas':   '{n} cell(s) here carry a formula; the value shown is the stored one.',
	'fileview.sheet_missing':    '{n} sheet(s) are named by this workbook and could not be read: {names}.',

	// Saving a copy, and making an edit. Two sentences here are load-bearing and
	// neither is reassurance.
	//
	// `fileview.save_help` says the file itself does not change, because that is
	// the question a person asks before pressing a button on somebody's document
	// and the answer is what makes it safe to press. `fileview.edited` says the
	// same thing from the other side: once an edit has been applied the panel is
	// showing prose nothing else in the app can see, and a reader who closed it
	// believing the file had changed would have lost the edit without being told.
	//
	// {why} is a reason from the editor and arrives in English. {names} are paths
	// out of the user's own Markdown, so they arrive in no language at all -- the
	// phrase around them is composed below rather than handed over finished.
	// {which} is `fileview.edit_nth` in this locale's own words, so the sentence
	// quotes the label the reader can actually see.
	// Two of these are reached through a variable and both are CLOSED lists: the
	// save-as buttons come from one table in viewer.js and the edit row's fields
	// from one helper, so a key added to either without a line here goes red.
	// i18n-indirect: viewer.js key = fileview.edit_find fileview.edit_replace fileview.edit_nth fileview.edit_cell fileview.edit_value
	'fileview.save':             'Save a copy',
	'fileview.save_help':        'Save a copy of this to your own device. The file here is not changed.',
	'fileview.save_failed':      'This could not be saved: {why}',
	'fileview.save_capped':      'Only the start of this file is on screen, so it is not written out as a document: what came back would be a document missing its end.',
	'fileview.save_as':          'Save as a document',
	'fileview.save_as_help':     'Write this text out as a real document and save it to your own device. The file here is not changed.',
	'fileview.save_as_failed':   'This could not be saved as {fmt}: {why}',
	// What a document written from this text will NOT carry. Composed here from a
	// kind, a count and the source names, exactly as `fileview.undrawn_*` is --
	// `office_write_left` used to hand back a finished English sentence, which was
	// the one string in that panel a translation pass could not reach.
	//
	// Two forms per kind: a bare count, and the same count with the sources named.
	// A named form is a different sentence and not the first with a list bolted
	// on, which is why both are keys rather than one plus a separator.
	// i18n-family: fileview.left_ = image notes image_named notes_named
	'fileview.write_left':       'Not everything in this text reaches the document: {parts}.',
	'fileview.left_image':       '{n} image(s)',
	'fileview.left_notes':       '{n} slide(s) of speaker’s notes',
	'fileview.left_image_named': '{n} image(s): {names}',
	'fileview.left_notes_named': '{n} slide(s) of speaker’s notes: {names}',
	'fileview.edit':             'Make an edit',
	'fileview.edit_find':        'Find',
	'fileview.edit_replace':     'Replace with',
	'fileview.edit_nth':         'Which one',
	'fileview.edit_note':        'Leave “{which}” blank to change every one. Everything else in the file is left byte for byte as it was.',
	'fileview.edit_apply':       'Apply',
	'fileview.edit_failed':      'That edit was not made: {why}',
	'fileview.edit_nothing':     'the editor returned no document',
	'fileview.edited':           'Edited here, {n} time(s). The file itself has not changed — save a copy to keep this.',
	'fileview.edit_sheet':       'Sheet',
	'fileview.edit_cell':        'Cell',
	'fileview.edit_value':       'Value',
	'fileview.edit_cell_note':   'A value beginning with “=” is stored as a formula. Nothing is recalculated, here or in the file.',

	// What the reading view did not draw, by kind and by count, joined into
	// `fileview.office_undrawn` above. The number and the kind are BOTH the
	// information: "3 text boxes, 1 chart" tells a reader whether to go and
	// open the file properly, where "some content is not shown" tells them only
	// that this viewer cannot be trusted.
	//
	// CLOSED, and it can be, because the kinds are the nine variants of
	// `Undrawable` in fe2o3_file's docx reader rather than anything this file
	// invents. A tenth added there fails this check, which is the point: the
	// alternative is a raw key painted on the screen in every language.
	// i18n-family: fileview.undrawn_ = image chart diagram textbox object
	// i18n-family: fileview.undrawn_ = equation footnote endnote comment
	'fileview.undrawn_image':    '{n} image(s)',
	'fileview.undrawn_chart':    '{n} chart(s)',
	'fileview.undrawn_diagram':  '{n} diagram(s)',
	'fileview.undrawn_textbox':  '{n} text box(es)',
	'fileview.undrawn_object':   '{n} embedded object(s)',
	'fileview.undrawn_equation': '{n} equation(s)',
	'fileview.undrawn_footnote': '{n} footnote(s)',
	'fileview.undrawn_endnote':  '{n} endnote(s)',
	'fileview.undrawn_comment':  '{n} comment(s)',

	// ── One message, read ──────────────────────────────────────
	'msg.unknown_sender':    '(unknown sender)',
	'msg.reply_to':          'Reply-to',
	'msg.reply':             'Reply',
	'msg.reply_all':         'Reply all',
	'msg.forward':           'Forward',
	'msg.save_help':         'Save into the workspace',
	'msg.saved_to':          'Saved · {path}',
	'msg.save_failed':       'Could not save {name}',
	'msg.pictures_blocked':  'Pictures and other remote content are blocked. Loading them tells the sender you opened this.',
	'msg.load_pictures':     'Load pictures',
	'msg.no_text':           '(This message has no readable text part.)',

	// ── Writing one ────────────────────────────────────────────
	'compose.new_message':       'New message',
	'compose.draft':             'Draft',
	'compose.remove_attachment': 'Remove this attachment',
	'compose.err_no_to':         'Say who it is going to.',
	'compose.send_title':        'Send this message?',
	'compose.send_body':         'It will be posted through {from}, and cannot be recalled.',
	'compose.discard_title':     'Discard this draft?',
	'compose.discard_body':      'The draft is deleted and what is written in it is lost.',

	// ── Identity, at the gate ──────────────────────────────────
	'identity.err_enter_pass':      'Enter a passphrase.',
	'identity.err_choose_name':     'Choose a name.',
	'identity.err_confirm_written': 'Confirm you have written the passphrase down first.',
	'identity.err_too_short_gen':   'That passphrase is too short. Generate another, or choose your own.',
	'identity.err_too_short':       'Use a passphrase of at least 8 characters.',
	'identity.err_mismatch':        'The passphrases do not match.',
	'identity.err_create':          'Could not create the account.',
	'identity.err_wrong_pass':      'That passphrase did not match. Try again.',
	'identity.err_locked':          'Daimond identity is locked.',
	'identity.err_no_webcrypto':    'WebCrypto is unavailable in this browser.',

	// ── Passkeys, in the interface ─────────────────────────────
	'passkey.have_one':          'I have a passkey for Daimond',
	'passkey.use_one':           'Use a passkey',
	'passkey.browser_cannot':    'This browser cannot use your passkey, so the passphrase is the way in here.',
	'passkey.adopt_note':        'If you added a passkey on another device, it brings that account here without a pairing code or a passphrase.',
	'passkey.looking':           'Looking for your passkey…',
	'passkey.waiting':           'Waiting for your passkey…',
	'passkey.err_unusable':      'The passkey could not be used.',
	'passkey.err_did_not_work':  'That passkey did not work. Use your passphrase.',
	'passkey.err_enter_pass':    'Enter your passphrase.',
	'passkey.add_title':         'Add a passkey',
	'passkey.add_body':          'Confirm your passphrase to protect it with a passkey. Your device then asks you to create it: Face ID, Touch ID, Windows Hello or a security key.',
	'passkey.continue':          'Continue',
	'passkey.not_added':         'Passkey not added',
	'passkey.err_create_failed2': 'The passkey could not be created.',
	'passkey.err_create_retry':  'The passkey could not be created. You can try again from Settings.',
	'passkey.added':             'Passkey added',
	'passkey.added_synced':      'You can now unlock Daimond with your passkey. It syncs between your own devices, so it brings this account to a new phone or laptop without a pairing code. Your passphrase still works, and remains the fallback.',
	'passkey.added_local':       'You can now unlock Daimond on this device with your passkey. The account service could not be reached, so for now it works here only; add it again once you are online and it will carry the account to your other devices. Your passphrase still works, and remains the fallback.',
	'passkey.added_offer':       'Next time, Daimond will ask for your passkey instead of your passphrase. You can remove it from Settings at any time.',
	'passkey.remove_title':      'Remove passkey?',
	'passkey.remove_body':       'The passkey comes off this device and stops opening your account anywhere else, so you unlock with your passphrase. The passkey itself stays in your authenticator until you delete it there.',
	'passkey.removed':           'Passkey removed',
	'passkey.removed_body':      'This device will ask for your passphrase from now on.',
	'passkey.offer_title':       'Unlock with your face?',
	'passkey.offer_body':        'Daimond can unlock with Face ID, Touch ID or your device PIN instead of the passphrase. Your passkey syncs between your devices, so it carries this account to them as well. Your passphrase keeps working either way.',

	// ── Forgetting an account ──────────────────────────────────
	'forget.credits_title':  'Save your credits first?',
	'forget.credits_body':   'This account holds {amount}, kept on Daimond’s server and unlocked only by this identity. A backup saves the identity encrypted, so another device can take it over, but only with this account’s passphrase, which the backup does not contain. Lose the passphrase and nothing brings the balance back. Export a backup now?',
	'forget.skip':           'Skip',
	'forget.title':          'Forget this account?',
	'forget.ok':             'Erase everything',
	'forget.body':           'This erases your passphrase, your encrypted API key, and all of your chats, Diamonds and spend history on this device.',
	'forget.tail':           'There is no recovery. Everything is gone.',
	'forget.body_secondary': 'This removes the account “{name}” from this browser: its passphrase, keys, chats, Diamonds, spend and files.',
	'forget.tail_secondary': 'There is no recovery. Other accounts here are untouched.',
	'forget.abandons':       'It also abandons {amount} held on the server. Only this identity unlocks it, and only this account\u2019s passphrase opens a backup of the identity.',

	// ── Changing a name, and a passphrase ──────────────────────
	'rename.title':               'Change name',
	'rename.failed':              'Could not rename',
	'changepass.lead':            'This replaces your current passphrase. There is no recovery, so write the new one down before you continue.',
	'changepass.gen_note':        'Eight words picked at random by this device, about {bits} bits, far past anything that can be guessed. It becomes the key to everything you store here, and nobody can reset it for you. Write it on paper. A password manager may also offer to update it, which is safe at this strength.',
	'changepass.new_ph':          'New passphrase',
	'changepass.again_ph':        'Type it once more',
	'changepass.change_it':       'Change it',
	'changepass.select_above':    'Select it above',
	'changepass.err_same_gen':    'That matches your current passphrase. Generate another.',
	'changepass.err_short':       'Use at least 8 characters.',
	'changepass.err_same':        'That is your current passphrase. Choose a different one.',
	'changepass.failed':          'That did not work',
	'changepass.failed_body':     'Nothing was changed, and your current passphrase still works — carry on using it. This device could not rewrite its stored keys, which is not something you did wrong. Try again in a moment.',
	'changepass.careful':         'Careful',
	'changepass.key_not_resealed': 'The passphrase changed, but your API key could not be re-encrypted. Re-enter it in Settings.',
	'changepass.mail_not_resealed': 'These mailboxes could not be re-encrypted under the new passphrase and need their passwords again: {list}.',
	'changepass.mail_not_unsealed': 'These mailboxes could not be read under the old passphrase, so they still need their passwords set again: {list}.',
	// The message store, which is sealed under the passphrase like everything
	// else and so has to be carried across a change of it. It names no list: a
	// person has one message store, not a set of them.
	'changepass.post_not_resealed': 'Your private messages could not be re-encrypted under the new passphrase.',
	'changepass.post_not_unsealed': 'Your private messages could not be read under your old passphrase, so they have been left as they were.',
	'changepass.models_not_resealed': 'These providers could not be re-encrypted under the new passphrase and need their keys again: {list}.',
	'changepass.models_not_unsealed': 'These providers already had unreadable keys before the change, and still need their keys set again: {list}.',
	'changepass.all_of_them': 'all of them',
	// The name of the API key in a list of what did not survive. The sentence a
	// person reads is `changepass.key_not_resealed` above.
	'changepass.the_api_key': 'your API key',
	'changepass.search_not_resealed': 'These search services could not be re-encrypted under the new passphrase and need their keys again: {list}.',
	'changepass.search_not_unsealed': 'These search services already had unreadable keys before the change, and still need their keys set again: {list}.',
	'changepass.voice_not_resealed': 'Your forge voice could not be re-encrypted under the new passphrase. Set it again from the line the forge printed for you.',
	'changepass.voice_not_unsealed': 'Your forge voice could not be read under the old passphrase, so it still needs setting again from the line the forge printed for you.',
	// A module that seals something failed in a way it had no words of its own
	// for. Generic on purpose and rare by design: every participant in
	// js/rekey.js carries its own sentence, and this is what is left if one does
	// not — a failure named badly still being better than a failure unmentioned.
	'changepass.rekey_generic': '{who}: {list}.',
	'changepass.rekey_failed':  'Some of what is stored here could not be re-encrypted under the new passphrase. Check your keys and mailbox passwords in Settings.',
	'changepass.changed':         'Passphrase changed',
	'changepass.changed_body':    'Your new passphrase is active.',
	'changepass.passkey_stale':   'Your passkey could not be updated, so it will ask for the new passphrase. Re-add it from Settings.',

	// ── Backups ────────────────────────────────────────────────
	'backup.unreadable':      'That backup file could not be read.',
	'backup.not_a_backup':    'That is not a Daimond backup.',
	// A file from a NEWER Daimond. Both numbers are said because the only useful
	// next step is to run the Daimond that wrote it; keep both placeholders.
	'backup.version_title':   'That backup is newer than this Daimond',
	'backup.version_body':    'The file was written in backup format {found}, and this build reads format {known}. Nothing has been restored, and nothing in the file has been changed. Update Daimond and open it again.',
	'backup.identity_title':  'Account identity restored',
	'backup.identity_body':   'The backup carried the identity for “{name}”, so this browser is now that account, with the credits and Pro licence held on the server for it. Unlock with that account’s passphrase; the backup does not contain it, and nothing else opens the account.',
	'backup.identity_kept':   'This browser already holds an account, so the identity for \u201c{name}\u201d in that backup was left alone. Everything else was restored.',
	'backup.identity_failed': 'The identity in that backup could not be restored.',
	'backup.restored':        'Backup restored',
	'backup.n_files.one':     '{n} workspace file',
	'backup.n_files.other':   '{n} workspace files',
	'backup.n_diamonds.one':  '{n} diamond',
	'backup.n_diamonds.other': '{n} diamonds',
	'backup.restored_body':   'Restored {files} and {diamonds}. Daimond will reload to open your restored workspace.',
	// Appended to the line above when a backup held another account's files. There are
	// only two places they could go — a folder named after a stranger inside this
	// workspace, or into that account's private storage — and neither is a restore, so
	// they are left out and the user is told rather than left to notice.
	'backup.n_foreign.one':   '{n} file in that backup belongs to another account at that browser, so it was not restored and stays only in the backup.',
	'backup.n_foreign.other': '{n} files in that backup belong to another account at that browser, so they were not restored and stay only in the backup.',

	// ── The provider form ──────────────────────────────────────
	'models.other':            'Other (type manually)…',
	'models.enter_key_first':  'Enter your API key to load models…',
	'models.key_rejected':     'That API key was rejected. Check it and try again.',
	'models.list_failed':      'Could not load models automatically. Pick "Other" and type a model id.',


	// ── The provider form's refusals ───────────────────────────
	'byok.err_provider': 'Choose a provider first.',
	'byok.err_base_url': 'Enter the provider base URL.',
	'byok.err_bad_url':  'That base URL is not a web address. It should start with https:// and name the provider’s host.',
	'byok.err_key':      'Paste your API key.',
	'byok.err_model':    'Choose a model, or wait a moment for the list to load.',
	'byok.err_rejected': 'The provider rejected that API key. Check it and try again.',

	// ── Confirming something irreversible ──────────────────────
	'confirm.yes_do_it':    'Yes, do it',
	'confirm.irreversible': 'Daimond wants to do something that cannot be undone',
	'fold.nothing_chosen':      'Nothing chosen',
	'fold.nothing_chosen_body': 'Tick the turns you want to fold, then press Fold selected.',

	// ── Coming back from a checkout ────────────────────────────
	'checkout.cancelled':        'Cancelled',
	'checkout.cancelled_body':   'Nothing was charged and your balance is unchanged.',
	'checkout.card_saved':       'Card saved',
	'checkout.card_saved_body':  'Daimond can now top up your credits automatically. Set the limits below, then switch it on. Nothing has been charged.',
	'checkout.card_pending_body': 'Stripe has taken the card. It may take a moment to appear here; reopen Credits shortly. Nothing has been charged.',
	'checkout.pro_unlocked':     'Pro unlocked',
	'checkout.pro_unlocked_body': 'You have Daimond Pro. Cross-device sync, cloud storage and Email are on. Pro runs for five years from purchase. No subscription, and nothing renews.',
	'checkout.received':         'Payment received',
	'checkout.pro_pending_body': 'Your Pro unlock is being confirmed and will appear here shortly. Reopen Credits in a moment.',
	'checkout.credits_pending_body': 'Your credits are still being confirmed. They will appear here shortly.',

	// ── Going out to a checkout ────────────────────────────────
	// The two ways buying can fail before Stripe is ever reached: the account
	// service did not answer, and it answered without the address to go to. Both
	// arrive at the user through `friendlyError`, which shows them verbatim.
	// A card and a credit pack are named apart, because a buyer who pressed
	// "Save a card" should not be told about a checkout they did not start.
	'gateway.acct_unreachable': 'Could not reach the Daimond account service. Try again shortly.',
	'gateway.session_no_url':   'The checkout session came back without a URL.',
	'gateway.card_no_url':      'The card session came back without a URL.',

	// ── A few more from the Workspace and Agents panels ────────
	'files.folder_open_failed': 'Could not open that folder.',
	'files.import':             'Import',
	'files.import_body':        'Copy "{name}" into the workspace? Everything in it then syncs to your other devices and counts towards your storage.',
	'files.this_file':          'this file',
	'files.unsaved_close':      'Your changes to {path} have not been saved. Close it and lose them?',
	'agents.no_diamond':        'no Diamond',
	'agents.no_diamond_help':   'This run has no Diamond',
	'agents.only_from':         'Show only agents from "{name}"',
	'agents.only_from_chat':    'Show only agents from this chat.',
	// A run dispatched from a chat rather than a Diamond. It has no crystal, so
	// say where its report actually is instead of naming a thing that is missing.
	'agents.from_chat':         'a chat',
	'agents.from_chat_help':    'Sent from the chat “{name}”.',
	// The same chip when the chat has no name: the label is then the rail's derived
	// phrase, and quoting a description as if it were a name is what this avoids.
	'agents.from_chat_help_when': 'Sent from a chat you have not named, last used {when}.',
	'agents.no_diamond_fold':   'This agent was sent from a chat, so there is no crystal to fold it into. Its report is in that conversation, and its full text is under Read.',
	'agents.report_one':        'An agent you sent has finished.',
	'agents.report_n':          '{n} agents you sent have finished.',
	'agents.no_task':           'An agent was asked for with no task, so nothing was started.',
	'changepass.title':         'Change passphrase',
	'changepass.enter_current': 'Enter your current passphrase.',
	'changepass.next':          'Next',

	// ── Errors the app rewrites for the user ───────────────────
	'err.unreachable':  'Could not reach that endpoint. Check the base URL in Settings, and your connection.',
	'err.rejected_401': 'Your API key was rejected (401). Open Settings and check it.',
	'err.denied_403':   'The provider denied access (403). Check your key and plan.',
	'err.notfound_404': 'The provider answered 404. If earlier steps in this turn worked, the base URL is fine and the model could not serve this particular request — most often one carrying an image. Otherwise check the base URL in Settings.',
	'err.ratelimit_429': 'The provider is rate-limiting you (429). Wait a moment and retry.',
	'err.server_5xx':   'The provider had a server error. Try again shortly.',
	'err.generic':      'Something went wrong. Try again.',
	'err.reply_cut':    'The reply ran out of room at {max} tokens, so a tool call arrived incomplete and could not run. Raise the reply length in Settings, or ask for a smaller change',

	// ── How long a reply may be ────────────────────────────────
	'settings.max_tokens':         'Longest reply',
	'settings.max_tokens_auto':    'Automatic',
	'settings.tokens':             'tokens',
	'settings.max_tokens_note':    'How long a single reply may be. Too low and a large file arrives cut in half.',
	'settings.max_tokens_ceiling': 'accepts up to',

	// ── How far one turn may go ─────────────────────
	'settings.max_rounds':         'Steps per turn',
	'settings.crystal_limits':   'Size limits',
	'settings.crystal_cap':      'Crystal size limit',
	'settings.crystal_cap_note': 'A crystal is a Diamond’s summary, so it has a ceiling. Past it, a daimon puts the detail in a file in the Diamond’s scope.',
	'settings.crystal_cap_auto': 'Default',
	'settings.crystal_page_cap': 'Page size limit',
	'settings.crystal_page_cap_note': 'The page that renders a Diamond’s data. It travels in every sync, so it shares the budget with the data itself.',
	'settings.max_rounds_auto':    'Default',
	'settings.steps':              'steps',
	'settings.max_rounds_note':    'How many times an agent may use a tool before one turn stops. It says so when it stops, and you can tell it to carry on.',
	'settings.fold_model':         'Fold with',
	'settings.fold_model_own':     'The conversation’s own model',
	'settings.fold_model_group':   'Fold with instead',
	'settings.fold_model_note':    'When a conversation outgrows its window it is summarised, and the summary becomes what the model remembers. This chooses what writes it, for chats on the same provider; every other chat folds with its own model.',

	// ── The permission ladder ──────────────────────────────────
	// What Daimond does WITHOUT ASKING. Nothing here moves the fence, the
	// system-call filter, a Diamond's folders or the journal — say so plainly,
	// because a person choosing bypass is entitled to know exactly what they
	// have and have not switched off.
	'permmode.title':        'Permission mode',
	'permmode.lead':         'What Daimond does without asking',
	// The hover said 'Permission mode: what Daimond does without asking' -- the CATEGORY,
	// which is the one thing a person hovering a button marked Guarded already knows. What
	// it governs was written and hidden a click away in the rung blurbs. So the tooltip is
	// composed in `handmode.js` from the current rung's name and blurb, and this is only
	// what a surface with no rung to hand can say.
	'permmode.chip_help':    'What Daimond does without asking',
	'permmode.chip_aria':    'Permission mode: {mode}. Change it.',
	'permmode.astat':        'Permissions: {mode}',
	'permmode.never':        'No mode moves the fence, a Diamond’s folders, or the journal.',
	'permmode.failed':       'That permission mode could not be set, so nothing changed.',

	// ── This chat's network ────────────────────────────────────
	// The rungs above are one setting for the whole app; this is one chat's own state,
	// which is why it is a section and not a fourth rung. Before it existed there was no
	// way to see whether a chat was cut off, no way to grant it in advance, and -- once
	// answered -- no way to change your mind: the answer was written once and kept.
	//
	// The words are the four `DaimondApp::net_state` returns, and they are read by four
	// literal `t()` calls in a switch rather than a composed key, because `i18ncheck`
	// cannot follow a key it has to build.
	'permmode.net_head':    'The network',
	'permmode.net_open':     'Nothing has been read from outside, so nothing is withheld.',
	'permmode.net_cut':      'Something written by somebody else has been read, so commands run with no network.',
	'permmode.net_allowed':  'Commands may reach the network.',
	'permmode.net_refused':  'Commands run with no network.',
	'permmode.net_bypass':   'Nothing is withheld in Bypass.',
	'permmode.net_each':     'Ask once per chat',
	'permmode.net_always':   'Always allow',
	'permmode.net_never':    'Never',
	'permmode.net_cut_mark': 'no network',

	// The three rungs of the ladder, each with a name and a note, built by
	// `handmode.js:44-45` from `MODES`. Declared ONE-WAY because `permmode.` is a
	// namespace before it is a set: sixteen keys above and below these six live
	// under the same prefix and are not rungs at all. The reverse sweep would
	// demand every one of them be declared a rung, which is a worse falsehood
	// than the one it catches, so it is given up HERE and nowhere else -- the
	// eleven other families keep it. What that costs: a seventh key under
	// `permmode.` that nobody declares is not reported.
	// i18n-family: permmode. = one-way ask ask_blurb guarded guarded_blurb bypass bypass_blurb -- the prefix is a namespace, not a set: thirty-five keys sit under it and six are rungs
	'permmode.ask':          'Ask every time',
	'permmode.ask_blurb':    'Every command and every page fetch is put to you first.',
	'permmode.guarded':      'Guarded',
	'permmode.guarded_blurb': 'Commands run. Once something written by somebody else has been read, Daimond asks before reaching out.',
	'permmode.bypass':       'Bypass',
	'permmode.bypass_blurb': 'Nothing is asked, whatever has been read.',

	'permmode.bypass_title': 'Stop asking?',
	'permmode.bypass_body':  'Commands run on your machine and pages are fetched without asking — including after Daimond has read a page, an email or a build log written by somebody else.\n\nThat last case is what you give up: where something you did not write could talk Daimond into sending your work somewhere.\n\nUntouched: the fence a command runs inside, each Diamond’s own folders, the system-call filter, and the journal you can check afterwards — and text from outside is still marked as somebody else’s words.\n\nYou will not be asked again.',
	'permmode.bypass_ok':    'Use bypass',

	'permmode.run_title':    'Run this command?',
	'permmode.run_body':     'Daimond wants to run a command on your machine.\n\n{cmd}\n\nin {cwd}\n\nThe “ask every time” permission mode puts every command to you first.',
	'permmode.run_ok':       'Run it',

	// The network question a marked chat's first command puts (`hand/REVIEW.md` §1.13,
	// remedy 2). Not the same question as `run_body` above and it must not read like it:
	// that one asks whether a command may RUN, this one asks whether it may REACH OUT,
	// and a no here still runs the command. Both halves of the answer are still said,
	// because a person deciding needs to know what a yes covers and what a no costs.
	//
	// IT SAID "THIS TURN" AND MEANT THIS CHAT. The memory lives on the chat's own engine
	// object, which lasts until the tab is reloaded -- so a user who read the word and
	// expected to be asked again next message was told something untrue by the one
	// sentence in it that was meant to be reassuring. It now says which conversation it
	// covers, and points at the control that can change it afterwards.
	'permmode.net_title':    'Let this chat reach the network?',
	'permmode.net_body':     'Daimond has read something written by somebody else, so commands are running with no network. Whatever it read could choose where this one goes.\n\n{cmd}\n\nin {cwd}\n\nYes, and Daimond stops asking — the permissions button takes it back. No runs the command anyway, with no network — and so does saying nothing.',
	'permmode.net_ok':       'Allow the network',

	// A dispatched worker asking to act on a page. Nobody is reading its
	// transcript, so the app puts the question for it — and every clause here is
	// load-bearing: who is acting, why the app is asking, what a click can do,
	// that it cannot be undone, and that the yes covers this one act only.
	'permmode.act_worker_title': 'An agent wants to act on a page',
	'permmode.act_worker_body':  'An agent working on its own wants to click something on {host}. You are not driving it and it cannot ask you itself, so Daimond is asking. Clicking can spend your money, send a message or submit a form, and none of that can be taken back. Saying yes allows this one click and nothing after it.',
	'permmode.type_worker_body': 'An agent working on its own wants to type this into {host} and send it:\n\n{text}\n\nYou are not driving it and it cannot ask you itself, so Daimond is asking. Text sent to a site cannot be recalled. Saying yes allows this one act and nothing after it.',

	// ── When conversations stop being saved ────────────────────
	// Said outright, and while the user can still act. The failure this replaces
	// was silent: the work went on being answered and stopped being stored, and
	// the user found out on the next reload.
	'store.alarm':          'Your conversations are not being saved.',
	'store.alarm_advice':   'Everything on screen is still here, but a reload would lose it. Download a copy now.',
	'store.alarm_download': 'Download a copy',
	'store.alarm_retry':    'Try again',
	'store.full':           'there is no room left in this browser’s storage for this site',
	// A read that returned nothing where the last good write left {n}. The
	// number is the count, so keep the placeholder.
	'store.empty_read':     'this browser returned none of the {n} conversations it is holding',

	// ── The delivery check ─────────────────────────────────────
	// A page checking itself. The check NAMES are what a reader scans down, so
	// keep them short; the details are the sentence under a failure.
	//
	// The page around them (verify.html) is here too. It used to be English in
	// every language, under a verdict that was translated -- so a reader was told
	// "manifest self-consistent" in their own language beneath a heading that was
	// not. The verdict lines are the sentences a person acts on, so they carry
	// their emphasis: {NOT} in `verdict_no` is deliberate and should stay loud in
	// whatever way the language has.
	'verify.page_title':      'Verify Daimond',
	'verify.page_lede':       'Check that the Daimond this page came from is the published open source. The evidence is a hash you can reproduce yourself.',
	'verify.checking':        'Checking this build…',
	'verify.recheck':         'Check again',
	'verify.hashing':         'hashing served files… {done} / {total}',
	'verify.ids':             'build {build}  ·  bundle {bundle}',
	'verify.verdict_ok':      'This build is the published source, and it was sealed.',
	'verify.verdict_no':      'This build does NOT match the published source.',
	'verify.verdict_partial': 'Could not fully verify. The checks say why.',
	'verify.independent':     'The independent check.',
	'verify.independent_body': 'A page cannot fully vouch for itself. Build the public source and run the verifier; nothing this server controls is in that loop:',
	// Stands in the command below where the page could not read its own origin.
	'verify.this_site':       'this site',
	// {url} is the transparency log's address, held by the page and never by a
	// translation -- keep the placeholder and the anchor around the words.
	'verify.green_means':     'Green means the bytes this site served are the source you just built, and that build is a sealed entry in the public <a href="{url}">transparency log</a>.',
	'verify.check_manifest':  'manifest',
	'verify.check_self':      'manifest self-consistent',
	'verify.check_log':       'public transparency log',
	'verify.check_sealed':    'sealed in the public log',
	'verify.check_files':     'every served file matches the manifest',
	'verify.no_manifest':     'this build was served without a manifest.json, so it cannot be checked',
	'verify.self_mismatch':   'the manifest bundle hash does not match its file list',
	'verify.log_broken':      'the public log is not an intact chain: {reason}',
	'verify.log_unreachable': 'could not reach the public log (offline, or blocked by policy); run verify/check.mjs to be sure',
	'verify.on_record':       '{n} releases on record',
	'verify.never_published': 'this served bundle is NOT in the public history; it was never published',
	'verify.unreadable':      '(unreadable)',
	'verify.files_differ':    '{n} differ: {list}',
	'verify.files_ok':        '{n} files',
	'verify.chain_order':     'entry {n} out of order',
	'verify.chain_break':     'entry {n} does not chain on {prev}',
	'verify.chain_hash':      'entry {n} hash mismatch',
	'verify.caveat':          'A page cannot vouch for itself: a tampered server could tamper with this check too. For an independent verdict, build the public source and run verify/check.mjs, or use the delivery-verify browser extension. This server can touch neither.',

	// ── Versions and the release history ───────────────────────
	'rel.version':          'Version',
	'rel.prerelease':       'Pre-release',
	'rel.unsealed':         'Unsealed',
	'rel.update_ready':     'update ready',
	'rel.not_published':    'not published',
	'rel.planned':          'planned',
	'rel.next':             'next',
	'rel.you_are_here':     'you are here',
	'rel.today':            'today',
	'rel.yesterday':        'yesterday',
	'rel.days_ago.one':     '{n} day ago',
	'rel.days_ago.other':   '{n} days ago',
	'rel.months_ago.one':   '{n} month ago',
	'rel.months_ago.other': '{n} months ago',
	'rel.years_ago.one':    '{n} year ago',
	'rel.years_ago.other':  '{n} years ago',
	'rel.title_named':      '{name}, build {build}, published {date}.',
	'rel.title_prerelease': 'Pre-release, build {build}, published {date}.',
	'rel.title_behind':     'A newer build has been published; reload to take it.',
	'rel.title_click':      'Click for what changed.',
	'rel.title_unlogged':   'This build is not in the published log. Click for the history.',
	'rel.no_date':          'Not released yet, and not promised for a date.',
	'rel.no_history':       'No published history could be read.',
	'rel.none_declared':    'No release has been declared yet. You are running a build ahead of the first one.',
	'rel.sealed_no':        'sealed #{n}',
	'rel.sealed_builds.one':   '{n} sealed build',
	'rel.sealed_builds.other': '{n} sealed builds',
	'rel.foot':             'A release is declared; a build is deployed. Every build here is recorded in a chain that cannot be rewritten without breaking. There is deliberately no way back to an older one.',

	// ── Updates ────────────────────────────────────────────────
	'update.checking':   'Checking for updates…',
	'update.latest':     'You are on the latest version',
	'update.ready':      'Update ready',
	'update.click_now':  'Click to update now.',
	'update.ready_help': 'Update ready. It applies when this finishes, or click to force it.',
	'update.updated':    'Daimond updated',
	'update.stale':      'Daimond is out of date and must reload to keep working. Click to reload.',

	// ── Typst ──────────────────────────────────────────────────
	// {reason} is the compiler's own diagnostic, which stays as it came.
	'typst.load_failed':   'Typst compiler failed to load: {reason}',
	'typst.no_pdf':        'Typst produced no PDF (unknown compile error).',
	'typst.compile_error': 'Typst compile error: {reason}',
	'typst.pack_locked':   'Typesetting is part of a tool pack this account has not bought. The Tools panel names it and its price: bought once, kept for good, and paid for in money rather than out of your credits.',

	// The watched live document. A few words in a bar over the pages, because the
	// thing worth looking at is the document underneath. {heap}, {more} and {budget}
	// are megabytes of wasm heap, and the two long ones are the only place the
	// reader is told why a loop stopped, so they say what to do about it.
	'typst.watch.starting': 'Laying out the pages…',
	'typst.watch.building': 'Rebuilding…',
	'typst.watch.live_preview': 'Live preview',
	'typst.watch.stale':    'Showing the last build that worked',
	'typst.watch.held':     'Rebuilding stopped',
	'typst.watch.dead':     'The compiler has stopped',
	'typst.watch.rebuild':  'Rebuild',
	'typst.watch.nothing':  'The compiler produced nothing and gave no reason.',
	'typst.watch.heap':     'The compiler is holding {heap} MB and another rebuild could need {more} MB more, which is past the {budget} MB it is allowed on this page. Rebuilding on every save has stopped, and the pages below are the last ones that built. The compiler cannot give that memory back — reload the page to start it fresh, or press Rebuild to try once anyway.',
	'typst.watch.spin': 'A watched file keeps reporting that it has changed, and it is too large to read back and check: the pages have been laid out {n} times in a row for it. Rebuilding on every save has stopped, so that it cannot fill the compiler’s memory. Press Rebuild when you want the pages again. The file was {what}.',
	'typst.watch.page': 'Page',
	'typst.watch.zoom_out': 'Smaller',
	'typst.watch.zoom_in': 'Bigger',
	// The two toggles in the bar say one word each, and their hover titles carry
	// the longer form: bar width is the scarce thing, not explanation.
	'typst.watch.fit_width': 'Fit the width',
	'typst.watch.fit_page': 'Fit the whole page',
	'typst.watch.paper_dark': 'Dark',
	'typst.watch.paper_light': 'Light',
	'typst.watch.paper_dark_why': 'Dark paper, for reading at night',
	'typst.watch.paper_light_why': 'Light paper',
	'typst.watch.sections': 'Sections',
	'typst.watch.sections_none': 'This document has no headings to list.',
	'typst.watch.dead_why': 'The compiler ran out of memory on this document and cannot be restarted without reloading the page. The pages below are the last ones that built. Reload, and open the same file again.',

	// ── Toasts ─────────────────────────────────────────────────
	'toast.copied': 'Copied',
	'render.copy_failed': 'Failed',

	// ── The Graph pane ─────────────────────────────────────────
	// One still picture of the Diamonds and the links between them. It is an
	// instrument for checking the structure, so the wording states what is
	// there rather than praising it.
	'graph.no_diamonds':        'No Diamonds yet, so there is nothing to draw.',
	'graph.isolated':           'Not linked',
	'graph.unnamed':            'Untitled',
	'graph.link_mode': 'Link',
	'graph.link_help': 'Click the Diamond a link starts at, then the one it points at. Escape cancels.',
	'graph.organise': 'Organise',
	'graph.organise_help': 'Lay the Diamonds out again to reduce crossings, and keep the new positions.',
	'graph.pick_source': 'Click the source, then the target. Escape cancels.',
	'graph.pick_target': 'From {name}. Click the target, or press Escape.',
	'graph.menu_link': 'Link from here…',
	'graph.menu_open': 'Open this Diamond',
	'graph.menu_reset_node': 'Put this Diamond back',
	'graph.menu_reset_all': 'Put every Diamond back',
	'graph.menu_reset_view': 'Reset the view',
	'graph.menu_edit_link': 'Edit this link…',
	'graph.menu_drop_link': 'Delete this link',
	// The zoom control that takes in the whole picture. One word: it rides in a
	// row of zoom buttons beside the numbers.
	'graph.fit': 'All',
	'graph.fit_help': 'Scale the picture until every Diamond is on screen.',
	'graph.edit_title': 'Link',
	'graph.new_title': 'New link',
	// A link carries several relations, added one at a time. `graph.rel_pool` heads
	// the words already used elsewhere in this graph, offered so the same idea is
	// not written three ways.
	'graph.rels_label': 'Relations',
	'graph.rel_add_ph': 'part-of, blocks… one at a time',
	'graph.rel_add': 'Add this relation',
	'graph.rel_pool': 'Already in use',
	'graph.rel_none': 'No relation yet.',
	'graph.rel_remove': 'Remove {rel}',
	'graph.rel_full': 'A link carries at most {n} characters of relation.',
	'graph.rel_label': 'Relation',
	'graph.rel_ph': 'part-of, blocks, supersedes…',
	'graph.note_label': 'Note',
	'graph.note_ph': 'Whatever the relation does not say.',
	'graph.save': 'Save',
	'graph.create': 'Create',
	'graph.cancel': 'Cancel',
	'graph.drop': 'Delete',
	'graph.self_link': 'A link joins two different Diamonds.',
	'graph.write_failed': 'That could not be written: {err}',
	'graph.edit_help': 'Edit this link',
	'graph.in_cycle':           'This Diamond is on a cycle.',
	'graph.back_edge':          'This link closes a cycle. Cycles are allowed; it is drawn dashed so it can be seen.',
	'graph.edge_tip':           '{from} → {to}',
	'graph.edge_rel':           'Relation: {rel}',
	'graph.failed':             'The graph could not be read: {err}',
	'graph.artefacts.one':      '{n} link to a file, page or chat',
	'graph.artefacts.other':    '{n} links to files, pages or chats',
	'graph.stat_diamonds.one':  '{n} Diamond',
	'graph.stat_diamonds.other': '{n} Diamonds',
	'graph.stat_links.one':     '{n} link between Diamonds',
	'graph.stat_links.other':   '{n} links between Diamonds',
	'graph.stat_cycles.one':    '{n} link closes a cycle',
	'graph.stat_cycles.other':  '{n} links close cycles',
	'graph.stat_dangling.one':  '{n} link points at a Diamond that is gone',
	'graph.stat_dangling.other': '{n} links point at Diamonds that are gone',

	// ── The terminal ───────────────────────────────────────────
	'term.label':            'Terminal',
	'term.menu_copy':          'Copy',
	'term.menu_paste':         'Paste',
	'term.menu_select_all':    'Select all',
	'term.clipboard_denied':   'The browser would not hand over the clipboard. Use Ctrl-V, which always works.',
	'termroot.browse': 'Choose a folder\u2026',
	'termroot.browse_wait': 'Asking this computer\u2026',
	'termroot.browse_use': 'Use this folder',
	'grantroot.head': 'Folder Daimond may work in',
	'grantroot.label': 'What every command is bounded to',
	'grantroot.note': 'This bounds every command a daimon can run. Changing it takes effect when the page is reloaded, and Daimond will ask you to confirm the folder again.',
	'termroot.reset': 'Back to the granted folder',
	'termroot.head':         'Terminal folder',
	'termroot.label':        'Where a terminal may reach',
	'termroot.note':         'A terminal you open is you, not a daimon: it may be given more than the folder a model is fenced to. Only folders this computer offers appear here.',
	'termroot.pinned':       'Set on this computer with install.sh --terminal-workspace, so it is not changed from here.',
	'term.hint':             'Type to send keys straight to the program. With text selected, Ctrl-C copies it; with none, Ctrl-C interrupts the program. Ctrl-V pastes, Ctrl-Shift-A selects everything, and right-click offers the same three. Shift with Page Up or Page Down moves through what has scrolled past.',
	'term.screen_label':     'Terminal screen, as text',
	'term.screen_now':       'The screen now reads:',
	'term.nothing_selected': 'Nothing is selected.',
	'term.copied.one':       '{n} line copied.',
	'term.copied.other':     '{n} lines copied.',
	'term.printed_lines.one':   '{n} line printed.',
	'term.printed_lines.other': '{n} lines printed.',
	'term.paste_warn':       'This paste is {n} lines. The program has not asked to be told when text is pasted, so every line after the first would run the moment it arrived.',
	'term.paste_first':      'Paste the first line',
	'term.paste_all':        'Paste all {n} lines',
	'term.exited':           'The program exited with status {code}.',

	// ── The Terminal panel ─────────────────────────────────────
	// The sentences a refusal is made of live one layer down, in js/handpty.js and
	// in the hand itself, and reach the panel verbatim. What is here is the panel's
	// own furniture, plus the two conditions no lower layer can report: a page
	// missing one of its own scripts, and a build whose wasm cannot say what a
	// terminal would be allowed to touch.
	'term.notices_label':    'Notices about this terminal',
	'term.dismiss_notice':   'Dismiss this notice',
	'term.gaps_count.one':   'Output is missing in {n} place.',
	'term.gaps_count.other': 'Output is missing in {n} places.',
	// The Start button says which of the two things it would do.
	// i18n-indirect: daimond.js k = term.start term.restart
	'term.start':            'Start a terminal',
	'term.restart':          'Restart the terminal',
	'term.stop':             'Stop the program',
	'term.leave_hint':       'Press F6 to move the keyboard out of the terminal.',
	'term.starting':         'Starting a terminal…',
	'term.running':          'The terminal is running.',
	'term.nothing_running':  'There is no program running in this terminal.',
	'term.not_paired':       'No machine hand is paired with this browser, so there is no machine to open a terminal on. Everything else in Daimond works without one.',
	'term.no_composer':      'This build cannot say what a terminal would be allowed to touch, so it will not open one. The Rust side of the app works that out, and this page is older than it. Update Daimond; commands and the file tools are unaffected.',
	'term.unreadable_request': 'Daimond could not read its own answer about what this terminal would be allowed to touch, so nothing was started. Reload the app; if it happens again, the app needs updating.',
	'term.no_relay_script':  'The terminal relay did not load in this page, so no terminal can be opened. Nothing is wrong with your machine. Reload Daimond.',
	'term.no_renderer':      'The terminal itself did not load in this page, so there is nothing to draw one on. Nothing is wrong with your machine. Reload Daimond.',

	// The durable trail, shown on the lock screen only when the app is
	// actually looping -- three boots in ninety seconds. See breadcrumb.js.
	'trail.looping':         'Daimond has restarted {n} times in the last minute. This is what it did; copy it into a bug report.',
	'trail.copy':            'Copy',
	'trail.copied':          'Copied',
	'trail.clear':           'Clear',

	// A safe start: the app opens without the sync engine, so a device that
	// cannot stay open long enough to be used gets to be used. See safe.js.
	'safe.armed':            'Daimond has started without syncing, so it should stay open. Your work is safe on this device, and reaches your other devices again once syncing is turned back on.',
	'safe.offer':            'If Daimond will not stay open, start it without syncing. Your work stays on this device and nothing is deleted.',
	'safe.turn_off':         'Start without syncing',
	'safe.turn_on':          'Turn syncing back on',
	'safe.chip':             'Sync off (safe start)',
	'safe.chip_reason':      'Daimond started without syncing, so this device’s work is not reaching your other devices. Nothing is lost; it is all still here.',
	'safe.chip_click':       'Click to turn syncing back on.',
	'safe.turn_on_title':    'Turn syncing back on?',
	'safe.turn_on_ask':      'Daimond restarts and tries to sync with your other devices again. If it starts closing itself, it goes back to a safe start on its own.',
	'safe.turn_on_ok':       'Restart with syncing',


	// The sync switch and the durable trail, both reachable from the admin
	// panel. See safe.js and breadcrumb.js.
	'home.sec_sync':        'Syncing and diagnostics',
	'settings.sync':        'Syncing',
	'settings.sync_on_note': 'This device is sending its work to your other devices. Stopping is immediate and loses nothing; everything stays here.',
	'settings.sync_off_note': 'This device is not syncing. Its work is safe here and is not reaching your other devices.',
	'settings.trail':       'Diagnostics',
	'settings.trail_copy':  'Copy the app’s own trail',
	'settings.trail_note':  'What Daimond last did: event names and a clock, no keys, no message text, nothing from your files. Safe to paste into a bug report.',
	'settings.trail_empty': 'Nothing recorded yet.',

	// ── The email doorbell ─────────────────────────────────────
	// One email, at most once a day, saying something is waiting. On by default
	// for a beta account, which is why the switch and the notice both exist: a
	// default that sends mail has to be reachable and has to be announced.
	// The switch says what was CHOSEN; `no_address` and `unconfigured` say
	// whether a bell could ring at all, which is a different fact.
	'doorbell.title':        'Email doorbell',
	'doorbell.asking':       'Checking…',
	'doorbell.saving':       'Saving…',
	'doorbell.turn_off':     'Turn the email doorbell off',
	'doorbell.turn_on':      'Turn the email doorbell on',
	'doorbell.on_note':      'When a message arrives and you have no Daimond open, we may send one email to the address on your account saying something is waiting. No sender, no subject, no count, and at most one in any 24 hours. Turning it off also stops any that is already waiting to go.',
	'doorbell.off_note':     'No email will be sent. You will see a message when you next open Daimond, and nowhere else.',
	'doorbell.default_note': 'This is the default for a beta account; you have not changed it.',
	'doorbell.no_address':   'There is no email address on your account, so nothing can be sent whatever this is set to.',
	'doorbell.unconfigured': 'This gateway cannot send email, so nothing will be sent whatever this is set to.',
	'doorbell.err_save':     'That did not save. The setting is unchanged; try again.',
	'doorbell.notice_title': 'One email, at most once a day',
	'doorbell.notice_body':  'When somebody sends you a private message and you have no Daimond open, we may send one email to the address on your account saying that something is waiting. It carries no sender, no subject, no count and no link to any message — and at most one in any 24 hours.\n\nYou can turn it off whenever you like: open Settings from the cog beside your name, and it is the row called “Email doorbell”. Turning it off also stops any that is already waiting to go.',

	// ── Reporting a message ────────────────────────────────────
	// One message, with the sender's signature and the one key that opens it,
	// and nothing else from the conversation. The operator reads the words out
	// of the SIGNED artefact, so a reporter cannot file words that differ from
	// the words that were signed -- which is why the sheet's rule sentence is a
	// promise the design keeps rather than a reassurance.
	//
	// The five reasons are the gateway's closed list (gateway/src/schema.rs:1226)
	// and are FETCHED, not compiled in, so the picker and the endpoint cannot
	// drift. The keys here are the reader's words for them.
	// i18n-family: report.reason_ = harassment threat spam impersonation other
	'post.report':              'Report',
	'report.title':             'Report this message',
	'report.rule':              'These exact words go to the operator, with the sender’s signature and the one key that opens this message. Nothing else from this conversation goes: not the rest of the thread, not their other messages, not your other conversations.',
	'report.signed_by':         'Signed by {fp}',
	'report.why':               'Why are you reporting it?',
	'report.reason_harassment':    'Abuse aimed at me',
	'report.reason_threat':        'A threat of harm',
	'report.reason_spam':          'Unwanted bulk messages',
	'report.reason_impersonation': 'Pretending to be somebody else',
	'report.reason_other':         'Something else',
	'report.send':              'Send this report',
	'report.cancel':            'Cancel',
	'report.sending':           'Sending…',
	'report.sent':              'Reported. The operator can now read this one message.',
	'report.already':           'You have already reported this message. Nothing new was sent.',
	'report.done':              'Close',
	'report.err_no_message':    'That message is not one this device holds.',
	'report.err_no_artefact':   'This build did not keep the signed form of that message, so there is nothing to prove who sent it. A report without it would be an accusation, so nothing was sent.',
	'report.err_no_envelope':   'This build did not keep the sealed form of that message, so the report could not be checked against what the relay carried. Nothing was sent.',
	'report.err_no_bridge':     'This build cannot read the message it is about to send, so it will not send it.',
	'report.err_not_a_post':    'That is not a message; it is a {kind}.',
	'report.err_no_reasons':    'Reporting is not available just now.',
	'report.err_failed':        'That report was not filed. Nothing was sent.',

	// ── Sharing a Diamond ──────────────────────────────────────
	// A Diamond, sealed to one person's key and carried by the message relay.
	// Every refusal here names what was NOT sent, because a share that half
	// happened is worse than one that did not: a copy missing a file is not a
	// smaller copy, and the sentences say so rather than trimming.
	'share.err_no_bridge':      'This build cannot share a Diamond: its share format is not loaded.',
	'share.err_no_seal':        'This build cannot share a Diamond: the seal it would be sent under is not loaded.',
	'share.err_no_store':       'This build can read a share but has nowhere to put one.',
	'share.err_locked':         'Unlock Daimond to share: a share is signed with your own key.',
	'share.err_empty':          'There is nothing in that Diamond to send yet.',
	'share.err_nothing':        'There is nothing to share: name a Diamond or the files to send.',
	'share.err_no_name':        'A share needs a name for what is in it.',
	'share.err_note_long':      'That note is longer than {n} characters and was not sent. A share carries a line about what it is; a letter is a message.',
	'share.err_too_many_files': 'That Diamond holds {n} files, and a share carries at most {max}.',
	'share.err_too_big':        'That Diamond is {mb} MB, and a share carries at most {max} MB. It is refused rather than trimmed: a copy missing a file is not a smaller copy.',
	'share.err_bad_key':        'That person has no usable key, so nothing was sent.',
	'share.err_no_card':        'There is no sealing key for that person yet, so nothing can be sealed to them. Scan their code, or ask them to send you theirs.',
	'share.err_not_addressed':  'That share is addressed to a different key from this one.',
	'share.err_addr_mismatch':  'The share you were told about is not the share that arrived.',
	'share.err_all_code':       'Everything in that share is a page, and the page was not accepted, so nothing has been added.',
	// The one question a share asks. A page is a program somebody else wrote and
	// Daimond will run it, so it is named as code and attributed before it lands.
	'share.code_title':         'This share contains code',
	'share.code_body':          '“{name}” includes a page: a program written by somebody else, which Daimond will run when you open it. It came from {who}. Accept it only if you meant to receive a page from them.\n\nWhat would be added: {files}',
	'share.code_ok':            'Accept the page',
	'share.landed_name':        'A shared Diamond',
	'share.landed_title':       'Shared Diamond added',
	'share.landed_partial':     'These files could not be written into the Diamond: {list}. Everything else in the share is there.',
	// A SHARE THAT LANDED SHORT SAYS SO. `accept` answered `ok: true` beside a
	// count of the files it had left out and nothing anywhere read the count, so a
	// share of five files of which two were pages landed three and reported plain
	// success. `share.err_all_code` covered only the total case — nothing landing
	// at all — which is the one case a person cannot fail to notice.
	'share.left_page':          'it is a page you did not accept',
	'share.landed_ok':          'Added as a Diamond of your own. {n} file(s) arrived.',
	// The Share view of the Social panel. Both halves of the feature: taking one
	// in needs nothing but the file, and sending one needs a Diamond and somebody
	// to send it to. Every refusal names what to do instead, because a person told
	// only that the relay declined has been told nothing they can act on.
	'share.panel_take_head':    'Open a share',
	'share.panel_take_help':    'Take a {ext} somebody gave you. A page inside it is a program they wrote, and it is never written into your workspace without asking you first.',
	'share.panel_take':         'Open a share file…',
	'share.panel_send_head':    'Send a Diamond',
	'share.panel_no_diamond':   'Open a Diamond to share it. A share carries the files of one Diamond, so there has to be one in front of you.',
	'share.panel_no_people':    'Nobody here has a sealing key yet, so there is nobody a share can be sealed to. Show somebody your code, or read theirs.',
	'share.panel_this':         'Sharing “{name}” — a copy they will own, not a view of yours.',
	'share.panel_who':          'Who it goes to',
	'share.panel_send':         'Share',
	'share.panel_sealing':      'Sealing…',
	'share.panel_sent':         'Sent to {who}.',
	'share.panel_refused':      'The relay would not take it: {why} It is saved as a file instead — give them that.',
	// Which carrier, and the file route. The relay refuses a sealed envelope over
	// 64 KiB and a capp page is about that on its own, so the file is not a
	// fallback for an awkward case: it is the only way a capp can travel. The
	// sentences carry the SIZE, because the sender is the only person who can do
	// anything about it and the number says whether taking one file out is enough.
	'share.by_relay':           'This share is {size} and goes straight to them through the relay.',
	'share.by_file':            'This share is {size} and the relay carries at most {max}, so it travels as a file: save it and give them the file. It is sealed to them either way.',
	'share.saved_as':           'Saved as {name}. Give them that file: it is sealed to them and to nobody else.',
	'share.err_not_share':      'That file is not a Daimond share.',
	'share.err_no_file':        'No file was chosen, so nothing was opened.',
	'share.err_file_huge':      'That file is {size}, which is larger than any share can be, so it was not opened.',
	// ── The Trash ──────────────────────────────────────────────
	// Deleting a chat or a Diamond moves it here and asks nothing. The two
	// questions that cannot be taken back are both in this panel.
	'panel.trash': 'Trash',

	// ── The Social panel ───────────────────────────────────────
	// Where a note about Daimond is written, where the proposals made from notes
	// are read and voted on, and where messages and the people they come from
	// will live. Both halves of the note/proposal pair go through the Oregami
	// forge. See js/improve.js and dev/IMPROVE_CONTRACT.md.
	//
	// TRANSLATORS — `panel.social` names a whole panel and rides in a chip row
	// and a phone tab bar, so keep it to one short word.
	'panel.social':        'Social',
	'social.messages':     'Messages',
	'social.people':       'People',
	'social.notes':        'Notes',
	'social.proposals':    'Proposals',
	// What each chip's list says while it is empty, and the two are NOT the same
	// sentence. Messages is not switched on in this build, so it says that -- an
	// empty list there would be claiming "nothing has arrived", which is a
	// different claim and is not true. People IS switched on, so its line is an
	// ordinary empty state and tells you how to end it.
	'social.messages_off': 'Messages are not switched on in this build.',
	'social.people_off':   'Nobody yet. Show your code to somebody in the room, or read theirs.',
	// The fifth chip. Its module was complete and unreachable before it existed.
	'social.share':             'Share',
	'social.share_off':         'Sharing is not available in this build.',
	// ── A private message ──────────────────────────────────────
	//
	// The Social panel's Messages chip. Written from the English at the call
	// sites in js/post.js, VERBATIM: a second wording here would be a second
	// wording on the screen, and nobody would find out which one a reader saw.
	//
	// TRANSLATORS — "private" here is a claim about who can read the words, and
	// it is exact: the message is sealed on this device to the recipient's key,
	// and the relay that carries it holds ciphertext it cannot open. Do not
	// soften it to "confidential" or strengthen it to anything about the
	// recipient's identity, which is a different claim and lives under trust.*.
	// "relay" is the post box in the middle; it is not a server that holds an
	// account, and a word suggesting a mailbox provider would be wrong.

	'post.err_no_bridge':        'This build cannot compose a message: its message format is not loaded.',
	'post.err_no_draft':         'This build cannot compose a message: its message encoder is not loaded.',
	'post.err_no_recipient':     'A sealed message needs at least one recipient key.',
	'post.err_too_many':         'A message can be sealed to at most {n} people at once.',
	'post.err_bad_key':          'One of the recipients has no usable key, so nothing was sent.',
	'post.err_short':            'That message is too short to be one.',
	'post.err_not_sealed':       'That is not a sealed Daimond message.',
	'post.err_no_sealing_key':   'This device has no sealing key, so it cannot open a sealed message. Unlock Daimond once and one will be made.',
	'post.err_not_for_you':      'This message was not sealed to any key this device holds.',
	'post.err_locked':           'Unlock Daimond to send a message: it is signed with your own key.',
	'post.err_empty':            'There is nothing to send.',
	'post.err_long':             'That message is longer than {n} characters of text and was not sent. It is refused rather than cut: half a message is not a shorter message.',
	'post.err_no_card':          'There is no sealing key for that person yet, so nothing can be sealed to them. Scan their code, or ask them to send you theirs.',
	// Sending to a group rather than to one person. `post.err_no_groups` is the
	// build saying it has no group module at all, which is not the same as a
	// group being empty; `post.err_group_none` is a real group the message
	// reached nobody in.
	'post.err_no_groups':        'This build cannot send to a group.',
	'post.err_group_none':       'The message reached nobody in that group, so nothing was sent.',
	// The one line a person may not write, because group.js reads it as a
	// membership list. Refused rather than escaped, and the refusal has to say
	// what to do about it.
	'post.err_reserved_line':    'A message cannot begin with that line: Daimond uses it to carry a group\'s membership list. Put something before it.',
	'post.err_bad_ref':          'That is not a kind of reference a message can carry.',
	'post.err_not_a_post':       'That is not a message; it is a {kind}.',
	'post.err_not_addressed':    'That message is addressed to a different key from this one.',
	'post.err_addr_mismatch':    'The message the relay named is not the message it carried.',
	'post.err_offline':          'Daimond could not reach the relay, so the message has not been sent.',
	'post.err_box_full':         'That mailbox is full, so the message did not arrive. They have to collect what is already in it before another will fit.',
	'post.err_no_account':       'No account holds that key, so the message has not been sent.',
	'post.err_too_big':          'That message is too large for the relay to carry.',
	'post.err_refused':          'The relay would not take that message, so it has not been sent.',
	'post.locked':               'Unlock Daimond to read your messages: they are kept encrypted on this device.',
	'post.tray_head':            'Waiting for your answer',
	'post.none':                 'No messages yet.',
	'post.you':                  'You',
	'post.someone':              'Someone new',
	'post.unreadable':           'A message arrived that this device could not open.',
	'post.accept':               'Accept',
	'post.ignore':               'Ignore',
	'post.block':                'Block',
	'post.expired':              'A message you sent was never collected and the relay has let it go.',
	// The same, for several copies of one group message. {n} is the SENDER'S
	// own count of copies the relay let go, and it is not a read receipt and
	// cannot become one: it is a fact about the relay letting go, never about
	// anybody opening anything. Do not translate it into "{n} people did not
	// read it".
	'post.expired_group':        'A message you sent to a group was never collected by {n} of the people it went to, and the relay has let those copies go.',
	'post.notice':               'The relay left a notice here.',
	'post.nobody':               'There is nobody to write to yet. Exchange codes with somebody in People, and they will be here.',
	'post.to_label':             'Who this goes to',
	'post.audience':             'Private. Only you and the person you are writing to can read this.',
	// WHO CAN READ THIS, when the answer is a group, and it is a different
	// sentence with a different set of people behind it. Both halves of the
	// second clause are load-bearing and neither may be dropped for brevity: a
	// later joiner CANNOT read this, and somebody taken out afterwards KEEPS
	// it. That is what having no shared key means, and it is the opposite of
	// what a reader assumes a group chat does.
	'post.audience_group':       'Sealed once for each of the {n} people in this group. There is no shared key: anybody who joins later cannot read this, and anybody taken out afterwards keeps it.',
	// How many people a group in the picker holds.
	'post.group_count':          '{n} people',
	'post.box_label':            'Write a private message',
	'post.box_ph':               'What you want to say, and to whom.',
	'post.send':                 'Send privately',
	'post.err_no_to':            'Choose who this is going to first.',
	'post.sending':              'Sending…',
	'post.sent':                 'Sent.',
	// SENT TO, never DELIVERED TO. The relay answers a blocked delivery exactly
	// as it answers an accepted one, so {n} is the number this device wrote to
	// and nothing more. A translation saying "delivered to {n} people" would
	// make a claim the transport was built not to be able to make.
	'post.sent_group':           'Sent to {n} people.',
	// Who a group message was NOT sealed to, appended to the line above. Never
	// a log line: the sender believes the message went to the whole group, and
	// their own screen at the moment they press is the only place that can be
	// corrected. TWO SENTENCES, because the two lists are fixable by different
	// people -- `group.refused` is what this device would not seal, and this one
	// is what the relay would not take. `post.group_skipped` used to be the first
	// of them and was retired on 2026-08-17: `group.refused` says it, and the only
	// caller left naming the old key was a second copy of the sentence in
	// `js/share.js`.
	'post.refused_offline':    'the relay could not be reached',
	'post.refused_full':       'their mailbox is full',
	'post.refused_no_account': 'no account holds their key',
	'post.refused_too_big':    'too large for the relay to carry',
	'post.refused_other':      'the relay refused it',
	'post.group_refused':      'The relay would not take it for: {who}.',
	// ── A group, and who is in it ──────────────────────────────
	//
	// A group is a LIST OF PEOPLE a message is sealed to one by one. There is no
	// shared key, no key agreement and nothing kept on the relay, and that one
	// fact decides every sentence in this section: what a new member cannot be
	// shown, what somebody taken out keeps, and why a count is always people
	// WRITTEN TO rather than people who received anything.
	//
	// Written from the English at the call sites in js/group.js, VERBATIM, for
	// the reason the private message block above gives: a second wording here
	// would be a second wording on the screen and nobody would find out which
	// one a reader saw.
	//
	// TRANSLATORS — "group" here is not a group chat. Nothing is shared between
	// members except the roster, so a word carrying "room", "channel" or
	// "shared conversation" would promise the architecture. Prefer your
	// language's plain word for a list of people. "roster" is that list;
	// "relay" is the post box in the middle, the same word post.* uses.

	'group.err_unknown':               'This device does not know that group.',
	'group.err_left':                  'You are no longer in this group, so nothing can be sent to it. The messages already here stay where they are.',
	// NOT `err_left`, AND THE DIFFERENCE IS THE POINT. Closing leaves everybody
	// including the creator out of the group, so the record says "left" -- but
	// telling somebody they are no longer in a group they closed themselves reads
	// as something done to them. This one is about the group; that one is about
	// them.
	'group.err_closed':                'This group has been closed, so nothing more can be sent to it. Every message already here stays where it is.',
	'group.err_close_not_creator':     'Only the person who made a group can close it.',
	'group.err_not_joined':            'Join this group before writing to it.',
	'group.err_nobody':                'There is nobody in this group this device can seal to.',
	'group.err_locked':                'Unlock Daimond to make a group: its roster is signed with your own key.',
	'group.err_no_id':                 'This device could not name a group.',
	'group.err_not_creator':           'Only the person who made a group can change who is in it.',
	'group.err_no_sealing_key':        'This device has no sealing key yet, so it cannot make a group.',
	'group.err_too_many':              'A group can hold at most {n} people.',
	// TWO SENTENCES AND NOT ONE, because a mis-typed key and somebody whose code
	// has not been scanned take different repairs and a roster can hit both at
	// once. `err_no_card`'s {n} counts the SECOND kind only: it counted both, and
	// one typing mistake plus one uncarded person read as "no sealing key for 2 of
	// the people chosen", which sent the reader to scan a code for a typo.
	//
	// TRANSLATORS — `err_bad_keys` is PLURAL and its {who} is a comma-joined list
	// of the spellings the caller gave, one or several. It replaced a singular key
	// with one {k}, which could not describe the two-entry case it was written
	// for. Keep it in the register of post.group_refused, which carries a list the
	// same way. It names SPELLINGS, because a spelling is what can be corrected.
	'group.err_no_card':               'There is no sealing key for {n} of the people chosen, so they cannot be added. Scan their code first.',
	'group.err_bad_keys':              'These are not keys: {who}.',
	'group.err_pick':                  'Choose at least one person.',

	// Why a member was left out of a send, each one a phrase that finishes
	// `group.refused`, so they are lower case and carry no full stop.
	// `skip_changed` says MATCHED, the same word trust.key_* uses, because it
	// is the same act being named -- see the note on that family below.
	'group.skip_blocked':              'you blocked this key',
	'group.refused':                   'Not sealed to: {who}.',
	'group.skip_changed':              'their key changed and you have not matched the new one',
	'group.skip_disagree':             'the group\'s key for them is not the one you hold',

	// THE THREE SENTENCES, and they are the reason this section reads the way it
	// does. Each says what a group CANNOT do, on the screen before the press
	// rather than after it, where it would be an excuse instead of a fact.
	//
	// TRANSLATORS — translate the LIMIT, not the reassurance. `joining` says
	// the earlier messages cannot be shown to a new member BY ANY DEVICE,
	// because they were never sealed to that key: it is not a policy and not
	// a setting, and "you will not see older messages" loses exactly that.
	// `removing` says nothing is taken back, and both halves are needed --
	// what they keep, and what stops. `close_note` says the same about a whole
	// group and adds the one thing no other sentence here has to: it cannot be
	// undone. If a qualification will not sit naturally in your language, keep
	// the sentence long rather than lose it.
	'group.joining_shows_nothing':     'Joining shows you nothing that was sent before you join. Those messages were never sealed to your key, so no device can open them for you.',
	'group.removing_retracts_nothing': 'Taking somebody out takes nothing back. They keep every message already sent to them; they will not receive anything sent from now on.',
	'group.close_note':                'Closing a group closes it for everybody. Nobody can write to it again, you included; every message already sent stays where it is. It cannot be undone.',

	// A group's name is the CREATOR'S claim, so it is drawn beside the first
	// eight characters of the id, which nobody chose.
	'group.unnamed':                   'A group',
	'group.invites_head':              'Group invitations',
	'group.head':                      'Groups',

	// Two empty states rather than one, because "no groups yet" printed over a
	// pending invitation is a screen arguing with the row above it. The second
	// says what a group IS, and "no shared key" is the whole of it.
	'group.none_joined':               'None joined yet. Answer the invitation above, or make one below.',
	'group.none':                      'No groups yet. A group is a list of people a message is sealed to one by one — there is no shared key, and nothing is kept on the relay.',

	'group.invited_by':                '{n} people, invited by the person who made it.',
	'group.join':                      'Join',
	'group.decline':                   'Not now',
	'group.count':                     '{n} people',

	// STOP SENDING TO, never "remove". "Remove" reads as though something is
	// taken back, and nothing is; the sentence above this control says so.
	'group.stop_sending':              'Stop sending to {who}',
	'group.leave':                     'Leave this group',

	// A group this device has left keeps its place on the list, with its
	// messages. That IS the second sentence: leaving and being taken out both
	// retract exactly nothing.
	'group.gone':                      'You are no longer in this group. Nothing has been taken away: every message already here stays, and nothing new will arrive.',

	// CLOSING ONE. The creator's act and the only one in this feature that cannot
	// be undone, so it is the only one behind a confirmation dialogue.
	//
	// TRANSLATORS — the control says CLOSE and never "delete", "disband" or
	// "remove". Nothing is destroyed by it: every member keeps every message they
	// hold, and the group stays on their list saying it is closed. A word carrying
	// "delete" would promise something this design does not do, in the same way
	// `stop_sending` refuses the word "remove". `close_ask` names the group, so
	// {name} is the creator's own label for it and the quotation marks belong to
	// your language.
	'group.close':                     'Close this group',
	'group.close_title':               'Close this group for everybody?',
	'group.close_ask':                 'This closes “{name}” for everybody in it.',
	'group.close_ok':                  'Close it for everybody',
	'group.closed_said':               'Closed, and {n} people have been told.',
	'group.closed':                    'This group has been closed by the person who made it. Nothing has been taken away: every message already here stays, and nobody can write to it again.',

	// Making one. A member with no sealing key is a member nothing can be
	// sealed to, so People is where this sends somebody, in the same words
	// `post.nobody` uses.
	'group.nobody':                    'There is nobody to put in a group yet. Exchange codes with somebody in People, and they will be here.',
	'group.name_ph':                   'What to call this group',
	'group.name_label':                'The group\'s name',
	'group.members_label':             'Who is in this group',
	'group.make':                      'Make this group',

	// The status line while a roster goes out. `group.made` counts people TOLD,
	// which is what this device wrote to, and never people who received it.
	'group.sending_roster':            'Telling everybody…',
	'group.roster_sent':               'Done.',
	'group.making':                    'Making the group…',
	'group.made':                      'Made, and {n} people have been told.',

	// ── People: a key, and whether it is the one you matched ────
	//
	// TRANSLATORS — THE ONE RULE HERE IS NOT A STYLE PREFERENCE, and it is worth
	// the paragraph. Daimond makes TWO different claims about somebody and must
	// never let them read as one:
	//
	//   what a key IS      matched, or new. Matched means the reader compared
	//                      this key themselves, in person or by reading the
	//                      safety number aloud. New means they have not.
	//   who somebody IS    the name they gave. Daimond knows nothing about it
	//                      and says nothing about it.
	//
	// So a `trust.key_*` string may NEVER carry this language's word for
	// "verified" or "trusted". Those words say the second thing while claiming to
	// say the first, and a reader who believes a key was "verified" believes
	// somebody checked WHO the person is. Nobody did. Use the ordinary word your
	// language has for two things being compared and found the same.
	//
	// This is enforced twice -- `dev/verify_trust.mjs` reads all eight files and
	// fails on the forbidden words, and the drawing code refuses a table that
	// hands it one and draws the built-in English instead -- but a translator who
	// knows why will write a better sentence than a guard that only says no.
	//
	// The key state is drawn as a line UNDER the name, never as a badge beside
	// it, so keep these as sentences rather than as labels.

	'trust.key_blocked':           'Blocked key',
	'trust.key_matched_qr':        'Key matched in person, {when}',
	'trust.key_matched_number':    'Key matched by safety number, {when}',
	'trust.key_changed':           'Different key — the one you matched was last seen {when}',
	'trust.key_new':               'New key — you have not matched this one',
	'trust.no_name':               '(no name given)',
	'trust.calls_themselves':      'calls themselves “{name}”',
	'trust.lookalike':             'This name looks like one you have already matched ({fp}). Names are not identities — check the key.',
	'trust.held':                  'Messages from this key are held until you decide.',
	'trust.compare_numbers':       'Compare safety numbers',
	'trust.unblock':               'Unblock',
	'trust.block':                 'Block',
	'trust.show_mine':             'Show my code',
	'trust.show_lead':             'Let them point their camera at this. Reading it in person is the only way either of you can mark the other matched without a phone call.',
	'trust.no_card':               'This device has no card yet. Unlock it and try again.',
	'trust.paste_lead':            'No camera? Send them this instead. A code that arrives this way is a new key and stays one until you compare numbers.',
	'trust.add':                   'Add somebody',
	'trust.add_lead':              'Point this device at their code, or paste what they sent you.',
	'trust.read_paste':            'Read this',
	'trust.bad_card':              'That is not a Daimond code, or it did not verify.',
	'trust.arrived':               'A code arrived',
	'trust.qr_lead':               'You read this off their screen, so there was no channel for anybody to get between you. Mark it matched only if that is what happened.',
	'trust.mark_matched':          'Mark matched now',
	'trust.async_lead':            'This came through something in the middle, so it stays a new key. Read the safety number aloud on a call to change that.',
	'trust.numbers':               'Safety numbers',
	'trust.numbers_lead':          'Read these sixty digits to each other on a call, or in person. Both of you must see the same twelve groups. Reading them in a message proves nothing — whatever could swap the keys could swap the message.',
	'trust.numbers_differ':        'They are different',
	'trust.numbers_match':         'The numbers match',
	'trust.no_number':             'This device cannot compute the number yet.',
	'trust.numbers_differ_note':   'Then somebody is between you. Do not use this key. Meet, or start again from a code you read in person.',
	'social.info':         'What this panel is, in the guide',
	'social.box_label':    'Write a note about Daimond',
	'social.box_ph':       'Where it is, what you expected, and what happened instead.',
	'social.with':         'What goes with it',
	'social.with_off':     'Take the details off this note',
	'social.keep':         'Keep',
	'social.keep_help':    'Store this note on this device. Nothing is sent.',
	'social.send':         'Send',
	'social.send_help':    'Send exactly what is above to Oxedyne. Nothing else goes with it.',
	// A note goes under the writer's VOICE. No handle and no name travels with
	// it, so nothing here may name the writer.
	'social.as_voice':     'Goes to the forge under your voice, where anyone with the repository can read it.',
	'social.as_novoice':   'You have no voice, so a note can only be kept here.',
	// Above Send, and on the screen exactly when Send is. The repository this
	// panel reads is public — the forge draws no other kind — so a note that is
	// sent is readable by ANYBODY, with NO account, under the name of the voice
	// it was written with. All three of those facts must survive translation.
	// `{host}` is the forge's address, filled in by js/improve.js: keep it as it
	// is rather than typing the address out, and do not name the repository,
	// which is a constant in the code and would strand eight files if it moved.
	'social.publish_body': 'Daimond wants to publish this, in your name, where other people can read it. It cannot be taken back.\n\n{what}\n\nIf you did not expect this, decline. Nothing is lost but this one publication.',
	'social.publish_ok': 'Publish it',
	'social.publish_title': 'Publish this?',
	'social.public_note':  'Sending publishes this note at {host}, with your voice name on it. Anyone can read it there without an account. A note you keep stays on this device.',
	'social.title_hint':   'The first line is the title of the proposal. What happened goes underneath it.',
	'social.no_title':     'The first line is the title. Write one, then what happened underneath.',
	'social.nothing':      'Write something first.',
	// Said after a refusal. Nothing is queued and nothing is tried again, so a
	// translation must not promise a retry.
	'social.kept_here':    'Your note is kept here and nothing tried again.',
	'social.copied':       'Copied.',
	'social.state_kept':   'Kept here',
	'social.state_sent':   'Sent {date}',
	'social.state_sent_n': 'Sent {date}, and is proposal {n}',
	'social.drop':         'Delete this note',
	'social.drop_ask':     'Delete this note? It is only on this device, so there is no other copy.',
	'social.drop_ok':      'Delete',
	'social.no_notes':     'No notes yet.',
	// The one line that goes with a note, in the characters it travels as.
	'social.ctx_build':    'Build {id}',
	'social.ctx_touch':    'touch',
	'social.ctx_pointer':  'pointer',
	'social.ctx_palette':  'palette {name}',
	'social.ctx_panels':   'panels open: {list}',

	// The voice: a per-person secret the forge looks the writer up by. It is
	// held here encrypted under the passphrase, and it never goes in an address.
	'social.voice_held':        'A voice is held on this device, encrypted under your passphrase.',
	'social.voice_none':        'No voice is held here, so a note can only be kept.',
	'social.voice_set':         'Set a voice',
	'social.voice_replace':     'Replace the voice',
	'social.voice_help':        'The line the forge printed for you. It is kept encrypted here and never put in an address.',
	'social.voice_ph':          'Paste the line the forge printed for you',
	'social.voice_save':        'Save the voice',
	'social.voice_saved':       'Your voice is held here, encrypted.',
	'social.voice_failed':      'That voice could not be stored.',
	'social.voice_forget':      'Forget it',
	'social.voice_forget_help': 'Remove the copy on this device.',
	'social.voice_forgotten':   'The copy on this device is gone.',
	'social.voice_ask_forget':  'Forget your voice on this device? The forge showed it once and cannot show it again.',

	// ── What js/voice.js says when a voice will not do ──────────
	// The secret itself, and every refusal about it. These were in NO catalogue
	// at all -- not even this one -- from the day voice.js was written until
	// 2026-08-14: every one of them is reached through `tOr(key, english)`, which
	// paints correct English and reports nothing, and both existing checks
	// compare the seven locales AGAINST this file, so a key absent HERE was
	// invisible to both by construction. `dev/i18ncheck.mjs` now reads the call
	// sites as well as the tables, which is what closes that.
	//
	// NONE of these may quote the secret: an error message carrying a credential
	// is a credential in a screenshot.
	'voice.err.empty':      'A voice is needed to write on the forge.',
	'voice.err.shape':      'That does not look like a voice. Copy the whole line the forge printed.',
	'voice.err.short':      'That is shorter than any voice the forge issues. Copy the whole line.',
	'voice.err.long':       'That is longer than a voice can be.',
	'voice.err.locked':     'Unlock Daimond first: your voice is kept encrypted under your passphrase.',
	'voice.err.locked_send': 'Unlock Daimond to write on the forge: your voice is encrypted under your passphrase.',
	'voice.err.unreadable': 'Your voice cannot be read with this passphrase. Set it again from the line the forge printed for you.',
	'voice.err.inurl':      'A voice goes in a header, never in an address.',
	// What the voice is CALLED in a list of what did not survive a passphrase
	// change. Never shown on its own; `changepass.voice_not_resealed` is the
	// sentence a person reads.
	'voice.the_voice':      'your forge voice',

	// Proposals, read from the forge as the panel is looked at. Nothing tells a
	// reader when one is answered, and no string here may suggest otherwise.
	'social.live_note':    'These are read from the forge as you look at them. Nothing tells you when a proposal is answered; look again to find out.',
	'social.loading':      'Reading the proposals…',
	'social.none_shown':   'Nothing could be read just now.',
	'social.none_yet':     'No proposals here yet. Yours would be the first.',
	'social.reading':      'Reading it…',
	'social.more':         'Show older',
	'social.count.one':    '{n} proposal',
	'social.count.other':  '{n} proposals',
	'social.by':           'from {who}',
	'social.said_n.one':   '{n} reply',
	'social.said_n.other': '{n} replies',
	'social.built_on':     'written on build {build}',
	'social.closed_by':    'closed by mark {mark}',
	'social.move_floor':   'A note follows its content across a file boundary only when the change is recognised as a move, and the floor for that is 64 bytes. Cut less than that from one file into another and the history holds a deletion and an insertion, so a note anchored there honestly reports its content deleted. The note is right and the history is right.',
	'social.state_open':   'Open',
	// The forge calls this state `accepted`; the panel has always called it
	// Being done, and the eight locales already hold that phrase.
	'social.state_taken':  'Being done',
	'social.state_done':   'Done',
	'social.state_declined': 'Declined',
	'social.tally':        '{yes} for, {no} against',
	'social.do':           'Do this',
	'social.not':          'Not this',
	'social.vote_novoice': 'Set a voice to vote on this.',
	'social.vote_off':     'Press again to take your vote back off.',
	'social.reply':        'Say it',
	'social.reply_ph':     'Say something about this proposal.',
	'social.reply_help':   'Send exactly what is in this box. Nothing else goes with it.',

	// What the forge refused, said in words. None of them names which allowance
	// ran out: a limit that reports its own state is one somebody can pace
	// against, and a vote and a proposal draw on different budgets.
	//
	// TRANSLATORS — `social.err_absent` is a privacy rule, not a wording
	// preference. The forge answers `absent` for BOTH "no such repository" and
	// "this repository is private", deliberately and permanently, because any
	// token, status or timing that separated them would republish exactly what a
	// private repository is withholding. The sentence must therefore be true in
	// both cases: "there is no such repository" is false when it is private, and
	// "this repository is private" leaks. Say only that it is not available to
	// you. See dev/IMPROVE_CONTRACT.md §7 (and the forge contract §3.1).
	'social.err_absent':    'This repository is not available to you.',
	'social.err_unvoiced':  'The forge was given no voice, so it refused.',
	'social.err_unknown':   'The forge does not recognise your voice. Set it again from the line the forge printed for you.',
	'social.err_unpermitted': 'Your voice may not do that here.',
	'social.err_throttled': 'Too many requests just now. Wait a little, then try again.',
	'social.err_throttled_address': 'Too many requests from this address just now. Wait a little, then try again.',
	'social.err_throttled_failing': 'Too many failing requests just now. Wait a little, then try again.',
	'social.err_malformed': 'The forge could not read what Daimond asked it. That is a fault in Daimond, not in what you wrote.',
	'social.err_no_proposal': 'There is no such proposal here.',
	'social.err_unsupported': 'The forge does not answer that.',
	'social.err_internal':  'Something went wrong at the forge. This is not your fault.',
	'social.err_gateway':   'Daimond could not reach the forge just now.',
	'social.err_session':   'Daimond is not signed in just now, so it could not reach the forge.',
	'social.err_toolong':   'That is longer than the forge accepts. Shorten it, or send it in two.',
	'social.err_offline':   'Nothing could be sent just now.',

	// ── A reference, drawn as a chip ───────────────────────────
	//
	// Four things a message may point at: a proposal, a build, a panel and a
	// guide page. THE READER RESOLVES IT. What travels is a kind, an id and the
	// sender's own description, and that description is drawn only when the
	// resolution fails -- as plain text, said to be the sender's words. A title
	// taken from the sender and drawn as though it were a forge record is a lie
	// waiting to happen and a place to inject markup.
	//
	// i18n-family: ref.kind_ = proposal build panel guide
	'ref.kind_proposal': 'Proposal',
	'ref.kind_build':    'Build',
	'ref.kind_panel':    'Panel',
	'ref.kind_guide':    'Guide',
	'ref.proposal':      'Proposal #{n}',
	'ref.build':         'Build {id}',
	'ref.panel':         'The {name} panel',
	'ref.guide':         'Guide: {page}',
	'ref.open_proposal': 'Open the proposal',
	'ref.open_build':    'Open the release note',
	'ref.open_panel':    'Open it',
	'ref.open_guide':    'Open the page',
	'ref.expand':        'Show what this is',
	'ref.reading':       'Reading it…',
	// Not "not found". A signed-out reader is refused before the forge is asked,
	// so nothing is known about whether the thing exists -- and saying it does
	// not would be the panel inventing an answer it was never given.
	'ref.signin':        'Sign in to open this.',
	// The sender's own words, said to be the sender's own words.
	'ref.said':          'Described as: {text}',
	'ref.unopenable':    'There is no opening this here.',
	'ref.said_n.one':    '{n} comment, public',
	'ref.said_n.other':  '{n} comments, public',
	'ref.build_here':    'This is the build you are on.',
	'ref.build_other':   'You are on build {id}.',
	'ref.build_update':  'Update to it',

	// ── The dock count badge ───────────────────────────────────
	// One number on a dock chip, and the whole of what this app does to say
	// something arrived while you were elsewhere. Never a zero: a badge showing
	// 0 is a mark that has to be read before it can be ignored.
	'dock.unseen.one':   '{n} unread',
	'dock.unseen.other': '{n} unread',

	// ── The sealing key, and the identity that holds it ────────
	// js/identity.js has named this key since the sealing key landed and this
	// table never had it, so every reader in every language got the English by
	// fallback and nothing said so.
	'identity.err_no_sealing_key': 'This device has no sealing key, so it cannot open a sealed message. Unlock the identity once and one will be made.',

	'trash.nothing': 'Nothing has been deleted.',
	'trash.kept_days': 'Kept for {days} days, then destroyed.',
	'trash.holding.one': '{n} thing, {bytes}',
	'trash.holding.other': '{n} things, {bytes}',
	'trash.until': 'Until {date}',
	'trash.deleted_why': 'Deleted. It is only here.',
	// The app did this, not the user. It must not read as a reproach.
	'trash.expired_why': 'Its time ran out. It is only here.',
	'trash.kind_chat': 'chat',
	'trash.kind_diamond': 'diamond',
	'trash.unnamed_chat': 'Unnamed chat',
	// A trashed chat can still be made into a Diamond, which is the useful act
	// on a conversation somebody has just found again.
	'trash.keep': 'Keep',
	'trash.keep_help': 'Make a Diamond of this chat, with the whole conversation as its first artefact.',
	'trash.keep_named': 'Keep {name} as a Diamond',
	'trash.restore': 'Restore',
	'trash.restore_named': 'Restore {name}',
	'trash.restore_all': 'Restore everything',
	'trash.purge': 'Delete permanently',
	'trash.purge_named': 'Delete {name} permanently',
	'trash.purge_ask': 'Delete “{name}” for good? It goes from every device, and there is no way back.',
	'trash.purge_ok': 'Delete permanently',
	'trash.empty': 'Empty trash',
	'trash.empty_ask.one': 'Destroy the {n} thing in the trash for good? It goes from every device, and there is no way back.',
	'trash.empty_ask.other': 'Destroy all {n} things in the trash for good? They go from every device, and there is no way back.',
	'trash.empty_ok': 'Empty trash',
	'trash.moved': 'Moved “{name}” to the trash.',
	'trash.moved_n.one': 'Moved {n} thing to the trash.',
	'trash.moved_n.other': 'Moved {n} things to the trash.',
	// The retention sweep, reported once at boot. Destroyed, and not coming
	// back: the word has to carry that.
	'trash.swept.one': 'One thing had been in the trash for {days} days and has been destroyed.',
	'trash.swept.other': '{n} things had been in the trash for {days} days and have been destroyed.',

	// ── The Terms and the Privacy Policy, in the app ───────────
	// js/legal.js puts both documents in Daimond's own Web panel rather than
	// handing the reader to another website. See www/guide/legal/.
	// i18n-indirect: legal.js d.key = legal.terms legal.privacy
	'legal.terms':      'Terms of Service',
	'legal.privacy':    'Privacy Policy',
	'legal.draft_note': 'In force from 13 August 2026. Points marked [TO CONFIRM] are still being settled.',

	// ── Lapse notices ──────────────────────────────────────────
	// Two clauses of the Terms promise a notice on this screen before something
	// of the user's lapses: §13 and Privacy §9 on stored file data, §7 on the
	// five-year Pro term. Every sentence traces to one in landing/terms.html, and
	// none of them may be more generous than the clause it quotes. See
	// js/lapse.js and dev/verify_legalreach.mjs.
	'lapse.hide':                 'Hide until tomorrow',
	'lapse.read_clause':          'What the Terms say',
	'lapse.storage_head':         'Stored files above the free allowance will be deleted on {date}.',
	'lapse.storage_head_undated': 'Stored files above the free allowance will be deleted when the grace period ends.',
	'lapse.storage_why':          'Your credits will not cover the cloud storage you are holding, so the metering has paused. Nothing is being back-charged, and you can still read everything you have stored.',
	'lapse.storage_size':         'About {size} is held above the free allowance.',
	'lapse.storage_what':         'If the balance is not restored by then, the stored data above the free allowance is deleted. Files on this device are untouched.',
	'lapse.top_up':               'Top up credits',
	'lapse.credits_pitch':        'Topping up stops the stored data above the free allowance being deleted.',
	'lapse.lic_head':             'Your Pro licence ends on {date}.',
	'lapse.lic_head_past':        'Your Pro licence ended on {date}.',
	'lapse.lic_off':              'Cross-device sync, cloud storage and Daimond Email switch off then, because each of those is a service we run on our side.',
	'lapse.lic_off_past':         'Cross-device sync, cloud storage and Daimond Email are off, because each of those is a service we run on our side.',
	'lapse.lic_keep':             'Everything on this device carries on exactly as before: your files, your chats, your Diamonds, your identity and your own provider key. Nothing is deleted, nothing is locked, and nothing you have made becomes unreadable.',
	'lapse.lic_pull':             'Pulling down what you have already stored never stops, and your credits are unaffected.',
	});
})();

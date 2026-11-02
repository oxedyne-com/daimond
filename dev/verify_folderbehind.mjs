// gateway: live
// verify_folderbehind.mjs -- a former folder desktop is never seeded as a committer on upgrade (QA82-ARM).
//
// The 13 Sep guard (`syncFolderBehind` in www/js/page/parcel_collect.js): a device with a machine folder
// behind it may have merged only its shares (argonaut, 09-13: 611 chunks swept, 222 of the phone's files
// lost), so the upgrade seed must not make it a committer. The page opens no folder now (R1,
// D-20261031-11), so the rig seeds the record an older build leaves instead of mounting one. This runs
// verify_commitmerged's arm F alone, so a release's ARMS can name it (`gw:folderbehind`) as a pre-deploy
// gate; the arm itself lives there, with the devices and stand-ins it shares.
// In-process, not a child: dev/predeploy_guard.mjs judges the script this process was started as, which
// is this file, the one ARMS names; a child started as verify_commitmerged would be refused (41).
process.argv = [...process.argv.filter((a) => !a.startsWith('--arms=')), '--arms=F'];
await import('./verify_commitmerged.mjs');

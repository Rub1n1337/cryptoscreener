// Sign-in through the bot (docs/PLAN-ACCOUNTS.md): what functions/auth and the bot's buttons (_shared/tg.ts) must agree on.
// Before, each kept its own copy (docs/PLAN-UNTANGLE-accounts.md, fix 9): changed in one, the right code would no longer be among
// the buttons and nobody could sign in.
// Single code points only (4 bytes each), so the button data "L:<nonce>:<two emoji>" fits in Telegram's 64 bytes.
export const LOGIN_EMOJI = ["🍋", "🚀", "🐳", "🦊", "🍉", "🌵", "🎯", "🔥", "🌙", "🍀", "🐙", "🦄", "🍒", "🎲", "🐝", "🍄"];
export const LOGIN_TTL = 5 * 60e3;   // a sign-in request lives 5 minutes

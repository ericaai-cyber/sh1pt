import { defineSocial, tokenSetup } from '@profullstack/sh1pt-core';

// Telegram Bot API. Bots auth with a bot token from @BotFather; channel /
// group posting requires the bot to be added as admin to the target chat.
// Personal accounts can also use Login Widget (OAuth-style) but that's
// for sign-in only, not posting.
interface Config {
  chatId: string;
}

export default defineSocial<Config>({
  id: 'social-telegram',
  label: 'Telegram',
  requires: { maxBodyChars: 4096, maxHashtags: 0, hashtagsInBody: true },

  async connect(ctx, config) {
    if (!ctx.secret('TELEGRAM_BOT_TOKEN')) throw new Error('TELEGRAM_BOT_TOKEN not in vault');
    return { accountId: config.chatId };
  },

  async post(ctx, post, config) {
    ctx.log(`telegram message · chat=${config.chatId} · ${post.body.length} chars`);
    if (ctx.dryRun) return { id: 'dry-run', url: 'https://t.me/', platform: 'telegram', publishedAt: new Date().toISOString() };
    // TODO: POST https://api.telegram.org/bot{token}/sendMessage with { chat_id, text, parse_mode: 'MarkdownV2' }
    // For media, use sendPhoto / sendVideo / sendMediaGroup.
    return { id: `tg_${Date.now()}`, url: 'https://t.me/', platform: 'telegram', publishedAt: new Date().toISOString() };
  },

  setup: tokenSetup({
    secretKey: 'TELEGRAM_BOT_TOKEN',
    label: 'Telegram (bot)',
    vendorDocUrl: 'https://core.telegram.org/bots#how-do-i-create-a-bot',
    steps: [
      'Open Telegram and start a chat with @BotFather',
      'Send /newbot, pick a display name and a username ending in "bot"',
      'Copy the bot token from the BotFather reply',
      'Add the bot as an admin to the channel/group you want to post to',
    ],
    fields: [
      { key: 'chatId', message: 'Default chat id (e.g. @yourchannel or numeric -100…):', required: true },
    ],
  }),
});

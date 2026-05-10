import { defineSocial, webhookUrlSetup } from '@profullstack/sh1pt-core';

// Discord — channel webhooks are the simplest publish path (one URL per
// channel, no bot identity to manage). For richer automation (slash
// commands, reactions, threads) wire up an OAuth bot separately.
interface Config {
  channelLabel?: string;
}

export default defineSocial<Config>({
  id: 'social-discord',
  label: 'Discord',
  requires: { maxBodyChars: 2000, maxHashtags: 0, hashtagsInBody: true },

  async connect(ctx) {
    if (!ctx.secret('DISCORD_WEBHOOK_URL')) throw new Error('DISCORD_WEBHOOK_URL not in vault');
    return { accountId: 'webhook' };
  },

  async post(ctx, post) {
    ctx.log(`discord message · ${post.body.length} chars · media=${post.media?.length ?? 0}`);
    if (ctx.dryRun) return { id: 'dry-run', url: 'https://discord.com/', platform: 'discord', publishedAt: new Date().toISOString() };
    // TODO: POST {webhook_url} with { content, embeds, username, avatar_url }; multipart for files.
    return { id: `dc_${Date.now()}`, url: 'https://discord.com/', platform: 'discord', publishedAt: new Date().toISOString() };
  },

  setup: webhookUrlSetup({
    secretKey: 'DISCORD_WEBHOOK_URL',
    label: 'Discord (channel webhook)',
    urlPrefix: 'https://discord.com/api/webhooks/',
    vendorDocUrl: 'https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks',
    steps: [
      'Server settings → Integrations → Webhooks → New Webhook',
      'Pick the target channel, name the webhook, copy the URL',
      'Paste it below — anyone with this URL can post to the channel',
    ],
  }),
});

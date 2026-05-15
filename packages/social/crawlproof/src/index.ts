// sh1pt social adapter — Crawlproof bridge.
//
// Unlike the per-platform adapters (sh1pt-social-x, -bluesky, -reddit,
// ...), this one doesn't talk to a single platform directly. It targets
// a single sp_account on crawlproof.com — whichever the user picks in
// the adapter config — and crawlproof's v1 API does the platform call.
//
// Why this exists: lets a user manage social connections in ONE place
// (crawlproof.com), then post via them from sh1pt's CLI, CI, or any
// `defineSocial`-consuming surface.
//
// Setup flow:
//   1. User generates a Bearer token at https://crawlproof.com/social/api-tokens.
//   2. `sh1pt promote social setup --platform crawlproof` prompts for it
//      and stores it as CRAWLPROOF_API_TOKEN in the sh1pt vault.
//   3. Adapter calls listAccounts() to enumerate the user's connected
//      accounts; user picks ONE (or wires multiple adapter instances
//      with different accountIds).
//   4. Subsequent `sh1pt promote social post --adapter crawlproof`
//      sends `{accountId, text}` to crawlproof's POST /api/sp/v1/posts.

import { defineSocial, type SocialPost } from '@profullstack/sh1pt-core';
import {
  createCrawlproofSocialClient,
  type Platform,
  type SocialAccount,
} from '@profullstack/crawlproof-social';

interface Config {
  // crawlproof's sp_account.id — selected at setup time.
  accountId: string;
  // For UI display only; not load-bearing.
  platform?: Platform;
  handle?: string;
  // Override the API base URL (defaults to https://crawlproof.com).
  baseUrl?: string;
  // For reddit accounts: passed straight through to POST /v1/posts.
  // Phase 1 fix: no UI to set this from sh1pt yet, so reddit posting
  // via this adapter needs `subreddit` + `title` to be set in
  // post.overrides['social-crawlproof'].
  subreddit?: string;
  title?: string;
}

const TOKEN_SECRET = 'CRAWLPROOF_API_TOKEN';

function formatPostText(post: SocialPost): string {
  const link = post.link ? `\n${post.link}` : '';
  return `${post.body}${link}`;
}

export default defineSocial<Config>({
  id: 'social-crawlproof',
  label: 'Crawlproof (proxy to connected accounts)',
  // We don't know up-front what platform the chosen account targets,
  // so the limits below are deliberately loose — crawlproof's API
  // enforces real per-platform char/title limits and returns a
  // descriptive error if exceeded.
  requires: { hashtagsInBody: true },

  async connect(ctx, config) {
    const token = ctx.secret(TOKEN_SECRET);
    if (!token) {
      throw new Error(
        `${TOKEN_SECRET} not in vault — generate one at https://crawlproof.com/social/api-tokens then run \`sh1pt secret set ${TOKEN_SECRET}\``,
      );
    }
    if (!config.accountId) {
      throw new Error(
        'social-crawlproof: no accountId in config — re-run setup to pick an account.',
      );
    }
    return { accountId: config.accountId };
  },

  async post(ctx, post, config) {
    const token = ctx.secret(TOKEN_SECRET);
    if (!token) {
      throw new Error(`${TOKEN_SECRET} not in vault — run \`sh1pt secret set ${TOKEN_SECRET}\``);
    }
    if (!config.accountId) {
      throw new Error('social-crawlproof: no accountId configured.');
    }

    const override = post.overrides?.['social-crawlproof'] ?? {};
    const text = formatPostText({ ...post, ...override } as SocialPost);
    const subreddit = (override as Partial<Config>).subreddit ?? config.subreddit;
    const title = (override as Partial<Config>).title ?? config.title ?? post.title;

    ctx.log(
      `crawlproof post · account=${config.accountId} (${config.platform ?? 'unknown'}) · ${text.length} chars`,
    );

    if (ctx.dryRun) {
      return {
        id: 'dry-run',
        url: `https://crawlproof.com/social`,
        platform: `crawlproof:${config.platform ?? 'unknown'}`,
        publishedAt: new Date().toISOString(),
      };
    }

    const client = createCrawlproofSocialClient({
      token,
      baseUrl: config.baseUrl,
    });
    const r = await client.post({
      accountId: config.accountId,
      text,
      subreddit,
      title,
    });
    return {
      id: r.platformPostId,
      url: r.webUrl,
      platform: `crawlproof:${config.platform ?? 'unknown'}`,
      publishedAt: new Date().toISOString(),
    };
  },

  async setup(ctx) {
    const existingToken = ctx.secret(TOKEN_SECRET);
    if (!existingToken) {
      await ctx.open('https://crawlproof.com/social/api-tokens');
      const token = await ctx.prompt<string>({
        type: 'password',
        message:
          'Paste a Crawlproof API token (starts with `crp_`). Generate one at crawlproof.com/social/api-tokens.',
        validate: (v) =>
          (typeof v === 'string' && v.startsWith('crp_') && v.length > 16) ||
          'Token must start with `crp_` and be longer than 16 chars.',
      });
      await ctx.setSecret(TOKEN_SECRET, token);
    }

    const baseUrl =
      (await ctx
        .prompt<string>({
          type: 'text',
          message: 'API base URL (leave default for crawlproof.com):',
          initial: 'https://crawlproof.com',
        })
        .catch(() => 'https://crawlproof.com')) ?? 'https://crawlproof.com';

    // Pull the user's connected accounts so they can pick one.
    let accounts: SocialAccount[];
    try {
      const client = createCrawlproofSocialClient({
        token: ctx.secret(TOKEN_SECRET)!,
        baseUrl,
      });
      accounts = await client.listAccounts();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        config: { accountId: '', baseUrl } as Config,
        manual: [
          `Could not list accounts from ${baseUrl}: ${message}`,
          'Verify your token is valid and not revoked.',
        ],
      };
    }

    const active = accounts.filter((a) => a.status === 'active');
    if (active.length === 0) {
      return {
        ok: false,
        config: { accountId: '', baseUrl } as Config,
        manual: [
          'No active social accounts on crawlproof.com.',
          'Connect at least one at https://crawlproof.com/social/setup, then re-run setup.',
        ],
      };
    }

    const chosen = await ctx.prompt<string>({
      type: 'select',
      message: 'Pick which connected account to post via:',
      choices: active.map((a) => ({
        title: `${a.handle} (${a.platform})`,
        value: a.id,
      })),
    });
    const picked = active.find((a) => a.id === chosen)!;

    return {
      ok: true,
      config: {
        accountId: picked.id,
        platform: picked.platform,
        handle: picked.handle,
        baseUrl,
      },
    };
  },
});

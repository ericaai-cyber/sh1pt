// @profullstack/crawlproof-social
//
// Typed HTTP client for crawlproof.com's social posting API:
//   GET  /api/sp/v1/accounts   — list a user's connected social accounts
//   POST /api/sp/v1/posts      — publish a post via one of those accounts
//
// Auth: Bearer token issued at https://crawlproof.com/social/api-tokens.
//
// Usage:
//   import { createCrawlproofSocialClient } from '@profullstack/crawlproof-social';
//   const client = createCrawlproofSocialClient({ token: process.env.CRAWLPROOF_API_TOKEN! });
//   const accounts = await client.listAccounts();
//   const result = await client.post({ accountId: accounts[0].id, text: 'hello world' });

export type Platform =
  | 'bluesky'
  | 'reddit'
  | 'mastodon'
  | 'linkedin'
  | 'x'
  | 'facebook_page'
  | 'threads'
  | 'discord'
  | 'telegram'
  // Schema-supported, posting-not-yet-implemented:
  | 'pinterest'
  | 'instagram'
  | 'instagram_business'
  | 'tiktok'
  | 'youtube'
  | 'tumblr'
  | 'snapchat';

export type SocialAccount = {
  id: string;
  platform: Platform;
  handle: string;
  status: 'active' | 'token_expired' | 'suspended_by_platform' | 'user_disabled' | 'flagged';
  instance_url: string | null;
  last_post_at: string | null;
  created_at: string;
};

export type PostInput = {
  accountId: string;
  text: string;
  // Reddit-only — required when posting to a reddit account.
  subreddit?: string;
  title?: string;
};

export type PostResult = {
  postId: string; // sp_post.id on crawlproof
  platformPostId: string; // platform-native id
  webUrl: string;
};

export type CrawlproofSocialClient = {
  listAccounts(): Promise<SocialAccount[]>;
  post(input: PostInput): Promise<PostResult>;
};

export type ClientOptions = {
  token: string;
  // Defaults to https://crawlproof.com. Override for self-hosted or
  // staging environments.
  baseUrl?: string;
  // Override the global fetch (e.g. inject undici, an instrumented
  // fetch). Defaults to globalThis.fetch.
  fetch?: typeof fetch;
};

const DEFAULT_BASE_URL = 'https://crawlproof.com';

export class CrawlproofSocialError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = 'CrawlproofSocialError';
    this.status = status;
    this.body = body;
  }
}

export function createCrawlproofSocialClient(
  options: ClientOptions,
): CrawlproofSocialClient {
  if (!options.token) {
    throw new Error('crawlproof-social: token is required');
  }
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('crawlproof-social: no fetch implementation available');
  }
  const headers = {
    authorization: `Bearer ${options.token}`,
    'content-type': 'application/json',
  };

  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers ?? {}) },
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // non-JSON response; fall through with body = null
    }
    if (!res.ok) {
      const message =
        body && typeof body === 'object' && 'error' in body
          ? String((body as { error: unknown }).error)
          : `${res.status} ${res.statusText}`;
      throw new CrawlproofSocialError(res.status, message, body);
    }
    return body as T;
  }

  return {
    async listAccounts(): Promise<SocialAccount[]> {
      const r = await call<{ accounts: SocialAccount[] }>('/api/sp/v1/accounts', {
        method: 'GET',
      });
      return r.accounts;
    },
    async post(input: PostInput): Promise<PostResult> {
      const r = await call<{
        post_id: string;
        platform_post_id: string;
        web_url: string;
      }>('/api/sp/v1/posts', {
        method: 'POST',
        body: JSON.stringify({
          account_id: input.accountId,
          text: input.text,
          subreddit: input.subreddit,
          title: input.title,
        }),
      });
      return {
        postId: r.post_id,
        platformPostId: r.platform_post_id,
        webUrl: r.web_url,
      };
    },
  };
}

import { defineCloud, tokenSetup, type Instance, type Quote, type InstanceSpec } from '@profullstack/sh1pt-core';

// Linode (now Akamai Cloud Computing) — VPS, bare metal, GPU, block
// storage, managed DB, object storage. Clean REST API with OAuth2
// or personal access token auth.
// API docs: https://techdocs.akamai.com/cloud-computing/reference/rest-api
interface Config {
  apiToken?: string;                  // LINODE_API_TOKEN secret (personal access token or OAuth2)
  defaultRegion?: string;            // us-east, us-central, us-west, eu-west, ap-south, ap-northeast, etc.
}

const API = 'https://api.linode.com/v4';

// ── Response shapes ──────────────────────────────────────────────

interface LinodeAccount {
  email: string;
  euuid: string;
  company: string;
  first_name: string;
  last_name: string;
  balance: number;
  balance_uninvoiced: number;
}

interface LinodeType {
  id: string;                          // e.g. 'g6-standard-2', 'g6-nanode-1', 'g7-gpu-1'
  label: string;                       // e.g. 'Linode 4GB'
  price: {
    hourly: number;                    // USD
    monthly: number;                    // USD
  };
  addons: {
    backups?: { price: { hourly: number; monthly: number } };
  };
  vcpus: number;
  memory: number;                      // MB
  disk: number;                         // MB
  transfer: number;                     // GB/month network transfer
    gpus?: number;
  class: string;                       // nanode, standard, highmem, dedicated, gpu
  region_availability: Record<string, string>;  // region -> 'available' | 'unavailable'
}

interface LinodeTypesResponse {
  data: LinodeType[];
  page: number;
  pages: number;
  results: number;
}

interface LinodeInstance {
  id: number;
  label: string;
  status: string;                      // running, offline, provisioning, booting, rebooting, rebuilding, migrating, cloning, deleting, stopped
  type: string;                        // e.g. 'g6-standard-2'
  ipv4: string[];
  ipv6: string;
  region: string;
  image: string;
  created: string;
  updated: string;
  specs: {
    vcpus: number;
    memory_mb: number;
    disk_mb: number;
    gpus: number;
    transfer: number;
  };
  tags: string[];
  watchdog_enabled: boolean;
}

interface LinodeInstancesResponse {
  data: LinodeInstance[];
  page: number;
  pages: number;
  results: number;
}

interface LinodeCreateResponse {
  data: LinodeInstance;
}

interface LinodeVolume {
  id: number;
  label: string;
  status: string;                      // active, creating, resizing, contact_support
  size: number;                         // GB
  region: string;
  linode_id: number | null;
  created: string;
  price_per_gb: number;
  tags: string[];
}

interface LinodeVolumesResponse {
  data: LinodeVolume[];
  page: number;
  pages: number;
  results: number;
}

// ── Adapter ──────────────────────────────────────────────────────

export default defineCloud<Config>({
  id: 'cloud-linode',
  label: 'Linode / Akamai Cloud (VPS, GPU, Bare Metal, Block Storage, Managed DB)',
  supports: ['cpu-vps', 'gpu', 'bare-metal', 'block-storage', 'managed-db'],

  async connect(ctx, config) {
    if (!ctx.secret('LINODE_API_TOKEN')) throw new Error('LINODE_API_TOKEN not in vault — `sh1pt secret set LINODE_API_TOKEN`');
    ctx.log('linode connect · verifying token...');
    const resp = await linodeRequest<{ data: LinodeAccount }>(ctx, 'GET', '/account');
    ctx.log(`linode connected · account=${resp.data.euuid} · email=${resp.data.email} · balance=$${resp.data.balance}`);
    return { accountId: resp.data.euuid };
  },

  async quote(ctx, spec, config) {
    ctx.log(`linode quote · kind=${spec.kind} · region=${spec.region ?? config.defaultRegion ?? 'us-east'}`);
    const region = spec.region ?? config.defaultRegion ?? 'us-east';

    let types: LinodeType[];
    try {
      types = await fetchTypes(ctx);
    } catch (e) {
      ctx.log(`linode quote · could not fetch types (${e instanceof Error ? e.message : String(e)}) — returning stub`, 'warn');
      return { hourly: 0, monthly: 0, currency: 'USD', provider: 'linode', sku: 'unknown', spot: false };
    }

    const match = pickType(types, spec, region);
    if (!match) {
      ctx.log(`linode quote · no matching type for kind=${spec.kind} in ${region}`, 'warn');
      return { hourly: 0, monthly: 0, currency: 'USD', provider: 'linode', sku: 'none', spot: false };
    }

    return {
      hourly: match.price.hourly,
      monthly: match.price.monthly,
      currency: 'USD',
      provider: 'linode',
      sku: match.id,
      spot: false,
    } satisfies Quote;
  },

  async provision(ctx, spec, config) {
    const region = spec.region ?? config.defaultRegion ?? 'us-east';
    const label = `sh1pt-${spec.kind}-${Date.now()}`;

    // Block storage
    if (spec.kind === 'block-storage') {
      ctx.log(`linode provision · volume · region=${region} · size=${spec.storage ?? 10}GB`);
      if (ctx.dryRun) return stubInstance('dry-run', 'provisioning', spec.kind);
      const vol = await linodeRequest<{ data: LinodeVolume }>(ctx, 'POST', '/volumes', {
        label,
        region,
        size: spec.storage ?? 10,
      });
      return {
        id: String(vol.data.id),
        kind: spec.kind,
        status: 'provisioning',
        createdAt: vol.data.created,
        hourlyRate: vol.data.price_per_gb * spec.storage! / 730,
        currency: 'USD',
        region,
      } satisfies Instance;
    }

    // VPS / GPU / Dedicated
    const types = await fetchTypes(ctx);
    const match = pickType(types, spec, region);
    const typeId = match?.id ?? defaultType(spec.kind);

    // Validate price guardrail
    if (match && spec.maxHourlyPrice !== undefined && match.price.hourly > spec.maxHourlyPrice) {
      throw new Error(`linode: cheapest matching type (${match.id}) costs $${match.price.hourly}/hr, exceeds maxHourlyPrice $${spec.maxHourlyPrice}`);
    }

    ctx.log(`linode provision · type=${typeId} · region=${region} · image=${spec.image ?? 'linode/ubuntu24.04'}`);
    if (ctx.dryRun) return stubInstance('dry-run', 'provisioning', spec.kind);

    const body: Record<string, unknown> = {
      label,
      region,
      type: typeId,
      image: spec.image ?? 'linode/ubuntu24.04',
      booted: true,
    };

    if (spec.sshKeyIds?.length) {
      body.authorized_keys = spec.sshKeyIds;
    }

    if (spec.tags?.length) {
      body.tags = spec.tags;
    }

    const result = await linodeRequest<LinodeCreateResponse>(ctx, 'POST', '/linode/instances', body);
    return instanceToInstance(result.data);
  },

  async list(ctx, config) {
    ctx.log('linode list · fetching instances');
    const result = await linodeRequest<LinodeInstancesResponse>(ctx, 'GET', '/linode/instances');
    const instances = result.data.map(instanceToInstance);

    // Also include volumes (block storage)
    try {
      const volResult = await linodeRequest<LinodeVolumesResponse>(ctx, 'GET', '/volumes');
      instances.push(...volResult.data.map(volumeToInstance));
    } catch {
      ctx.log('linode list · volumes fetch failed, returning instances only', 'warn');
    }

    return instances;
  },

  async destroy(ctx, instanceId, config) {
    ctx.log(`linode destroy · ${instanceId}`);
    // Try instance delete first, then volume
    try {
      await linodeRequest<unknown>(ctx, 'DELETE', `/linode/instances/${instanceId}`);
      return;
    } catch {
      // Not a linode instance, try volume
    }
    await linodeRequest<unknown>(ctx, 'DELETE', `/volumes/${instanceId}`);
  },

  async status(ctx, instanceId, config) {
    ctx.log(`linode status · ${instanceId}`);
    // Try instance first
    try {
      const result = await linodeRequest<{ data: LinodeInstance }>(ctx, 'GET', `/linode/instances/${instanceId}`);
      return instanceToInstance(result.data);
    } catch {
      // Not a linode instance, try volume
    }
    const result = await linodeRequest<{ data: LinodeVolume }>(ctx, 'GET', `/volumes/${instanceId}`);
    return volumeToInstance(result.data);
  },

  setup: tokenSetup<Config>({
    secretKey: 'LINODE_API_TOKEN',
    label: 'Linode / Akamai Cloud',
    vendorDocUrl: 'https://techdocs.akamai.com/cloud-computing/docs/get-started-with-the-linode-api',
    steps: [
      'Log in to cloud.linode.com → Profile → API Tokens',
      'Create a Personal Access Token (read/write for Linodes, Volumes, Account)',
      'Copy the token (shown only once)',
      'Run: sh1pt secret set LINODE_API_TOKEN <paste>',
      'Tip: Linode is now Akamai Cloud Computing — same API, same tokens',
    ],
    fields: [
      { key: 'defaultRegion', message: 'Default region (us-east, us-central, us-west, eu-west, ap-south, ap-northeast, ca-central, eu-central):' },
    ],
  }),
});

// ── Helpers ──────────────────────────────────────────────────────

function stubInstance(id: string, status: Instance['status'], kind: InstanceSpec['kind']): Instance {
  return {
    id,
    kind,
    status,
    createdAt: new Date().toISOString(),
    hourlyRate: 0,
    currency: 'USD',
  };
}

function instanceToInstance(i: LinodeInstance): Instance {
  const statusMap: Record<string, Instance['status']> = {
    running: 'running',
    offline: 'stopped',
    stopped: 'stopped',
    provisioning: 'provisioning',
    booting: 'provisioning',
    rebooting: 'provisioning',
    rebuilding: 'provisioning',
    migrating: 'provisioning',
    cloning: 'provisioning',
    deleting: 'destroyed',
  };

  // Determine kind from type ID and GPU specs
  const kind: Instance['kind'] = (i.specs?.gpus && i.specs.gpus > 0)
    ? 'gpu'
    : (i.type?.startsWith('g6-dedicated') ? 'bare-metal' : 'cpu-vps');

  return {
    id: String(i.id),
    kind,
    status: statusMap[i.status] ?? 'provisioning',
    publicIp: i.ipv4?.[0] && i.ipv4[0] !== '0.0.0.0' ? i.ipv4[0] : undefined,
    createdAt: i.created,
    hourlyRate: 0, // Not returned per-instance; fetch from types if needed
    currency: 'USD',
    sku: i.type,
    region: i.region,
    tags: i.tags?.length ? i.tags : undefined,
  };
}

function volumeToInstance(v: LinodeVolume): Instance {
  const statusMap: Record<string, Instance['status']> = {
    active: 'running',
    creating: 'provisioning',
    resizing: 'provisioning',
    contact_support: 'failed',
  };

  return {
    id: String(v.id),
    kind: 'block-storage',
    status: statusMap[v.status] ?? 'provisioning',
    createdAt: v.created,
    hourlyRate: v.price_per_gb * v.size / 730,
    currency: 'USD',
    region: v.region,
  };
}

function defaultType(kind: InstanceSpec['kind']): string {
  switch (kind) {
    case 'gpu': return 'g7-gpu-1';                    // 1x RTX 6000 GPU
    case 'bare-metal': return 'g6-dedicated-2';        // 2 vCPU dedicated
    case 'cpu-vps': return 'g6-standard-2';            // 2 vCPU shared
    case 'managed-db': return 'g6-standard-2';          // Same underlying type for managed DB
    default: return 'g6-nanode-1';                      // Smallest VPS
  }
}

function pickType(types: LinodeType[], spec: InstanceSpec, region: string): LinodeType | null {
  // Filter by region availability
  let candidates = types.filter(t => {
    const avail = t.region_availability?.[region];
    return avail === 'available' && t.price?.hourly > 0;
  });

  // Kind-based filtering
  if (spec.kind === 'gpu') {
    candidates = candidates.filter(t =>
      t.class === 'gpu' || t.id.includes('gpu') || (t.gpus && t.gpus > 0)
    );
  } else if (spec.kind === 'bare-metal') {
    candidates = candidates.filter(t =>
      t.class === 'dedicated' || t.id.includes('dedicated')
    );
  } else if (spec.kind === 'cpu-vps') {
    candidates = candidates.filter(t =>
      t.class !== 'gpu' && !t.id.includes('gpu') && (!t.gpus || t.gpus === 0) && t.class !== 'dedicated'
    );
  }

  // Spec-based filtering
  if (spec.cpu) candidates = candidates.filter(t => t.vcpus >= spec.cpu!);
  if (spec.memory) candidates = candidates.filter(t => t.memory >= spec.memory! * 1024); // spec.memory in GB, type.memory in MB
  if (spec.storage) candidates = candidates.filter(t => t.disk >= spec.storage! * 1024); // spec.storage in GB, type.disk in MB

  // Price guardrail
  if (spec.maxHourlyPrice) {
    candidates = candidates.filter(t => t.price.hourly <= spec.maxHourlyPrice!);
  }

  // Cheapest first
  candidates.sort((a, b) => a.price.monthly - b.price.monthly);
  return candidates[0] ?? null;
}

let typesCache: LinodeType[] | null = null;

async function fetchTypes(
  ctx: { secret(k: string): string | undefined; log(msg: string, level?: 'info' | 'warn' | 'error'): void },
): Promise<LinodeType[]> {
  if (typesCache) return typesCache;
  const result = await linodeRequest<LinodeTypesResponse>(ctx, 'GET', '/linode/types?per_page=200');
  typesCache = result.data;
  return typesCache;
}

async function linodeRequest<T = unknown>(
  ctx: { secret(k: string): string | undefined; log(msg: string, level?: 'info' | 'warn' | 'error'): void },
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const token = ctx.secret('LINODE_API_TOKEN');
  if (!token) throw new Error('LINODE_API_TOKEN not in vault');

  const opts: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };

  if (body !== undefined) {
    opts.body = JSON.stringify(stripUndefined(body));
  }

  const response = await fetch(`${API}${path}`, opts);

  if (method === 'DELETE' && (response.status === 204 || response.status === 200)) {
    return undefined as T;
  }

  const text = await response.text();
  const data = text ? JSON.parse(text) : undefined;

  if (!response.ok) {
    const errMsg = extractErrorMessage(data, response.statusText);
    throw new Error(`Linode ${method} ${path} failed: ${response.status} ${errMsg}`);
  }

  return data as T;
}

function extractErrorMessage(data: unknown, fallback: string): string {
  if (typeof data === 'object' && data && 'errors' in data && Array.isArray((data as { errors: unknown }).errors)) {
    const errors = (data as { errors: Array<{ reason?: string; field?: string }> }).errors;
    return errors.map(e => e.reason ?? e.field ?? 'unknown').join('; ');
  }
  if (typeof data === 'object' && data && 'error' in data && typeof (data as { error?: unknown }).error === 'string') {
    return (data as { error: string }).error;
  }
  if (typeof data === 'object' && data && 'message' in data && typeof (data as { message?: unknown }).message === 'string') {
    return (data as { message: string }).message;
  }
  return fallback;
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, stripUndefined(v)]),
  );
}
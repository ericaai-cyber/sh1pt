import { defineCloud, tokenSetup, type Instance, type Quote, type InstanceSpec } from '@profullstack/sh1pt-core';

// Lambda Labs — GPU cloud for AI/ML workloads. Offers H100, A100, A6000,
// RTX 4090, and other GPU instances billed per hour. Two product lines:
//   - GPU Cloud: shared GPU instances (cheaper, no SLA)
//   - Dedicated Cloud: reserved GPU instances (SLA, higher reliability)
//
// REST API docs: https://cloud.lambdalabs.com/api/v1
// Note: Lambda Labs is distinct from AWS Lambda (serverless functions).
// This adapter provisions GPU VMs, not Lambda functions.
interface Config {
  apiKey?: string;                    // LAMBDA_LABS_API_KEY secret
  defaultRegion?: string;            // us-south-1, us-west-2, us-east-1, eu-central-1, asia-northeast-1
}

const API = 'https://cloud.lambdalabs.com/api/v1';

// ── Response shapes ──────────────────────────────────────────────

interface LambdaInstance {
  id: string;
  name: string;
  status: string;                     // active, building, stopped, terminated
  ip: string;
  gpu_type: string;                    // e.g. 'gpu_1x_h100_pcie', 'gpu_1x_a100_sxm4'
  gpu_count: number;
  vcpu_count: number;
  memory_gb: number;
  region: string;
  created_at: string;
  cost_per_hour: number;
}

interface LambdaInstancesResponse {
  data: LambdaInstance[];
}

interface LambdaInstanceResponse {
  data: LambdaInstance;
}

interface LambdaInstanceType {
  name: string;                        // e.g. 'gpu_1x_h100_pcie'
  description: string;                 // e.g. '1x H100 PCIe'
  gpu_type: string;
  gpu_count: number;
  vcpu_count: number;
  memory_gb: number;
  price_per_hour: number;              // USD
  regions: string[];
}

interface LambdaInstanceTypesResponse {
  data: LambdaInstanceType[];
}

// ── Adapter ──────────────────────────────────────────────────────

export default defineCloud<Config>({
  id: 'cloud-lambda-labs',
  label: 'Lambda Labs (GPU Cloud)',
  supports: ['gpu'],

  async connect(ctx, config) {
    if (!ctx.secret('LAMBDA_LABS_API_KEY')) throw new Error('LAMBDA_LABS_API_KEY not in vault — `sh1pt secret set LAMBDA_LABS_API_KEY`');
    ctx.log('lambda-labs connect · verifying API key...');
    // Fetch instance types as a lightweight connectivity check
    const resp = await lambdaRequest<LambdaInstanceTypesResponse>(ctx, 'GET', '/instance-types');
    ctx.log(`lambda-labs connected · ${resp.data.length} instance types available`);
    return { accountId: 'lambda-labs-account' };
  },

  async quote(ctx, spec, config) {
    ctx.log(`lambda-labs quote · gpu=${spec.gpu?.model} x${spec.gpu?.count ?? 1} · region=${spec.region ?? config.defaultRegion ?? 'us-south-1'}`);
    const region = spec.region ?? config.defaultRegion ?? 'us-south-1';

    let instanceTypes: LambdaInstanceType[];
    try {
      instanceTypes = await fetchInstanceTypes(ctx);
    } catch (e) {
      ctx.log(`lambda-labs quote · could not fetch instance types (${e instanceof Error ? e.message : String(e)}) — returning stub`, 'warn');
      return { hourly: 0, monthly: 0, currency: 'USD', provider: 'lambda-labs', sku: 'unknown', spot: false };
    }

    const match = pickInstanceType(instanceTypes, spec, region);
    if (!match) {
      ctx.log(`lambda-labs quote · no matching instance type for gpu=${spec.gpu?.model} in ${region}`, 'warn');
      return { hourly: 0, monthly: 0, currency: 'USD', provider: 'lambda-labs', sku: 'none', spot: false };
    }

    const monthly = match.price_per_hour * 730;
    return {
      hourly: match.price_per_hour,
      monthly,
      currency: 'USD',
      provider: 'lambda-labs',
      sku: match.name,
      spot: false,
    } satisfies Quote;
  },

  async provision(ctx, spec, config) {
    if (!spec.gpu) throw new Error('cloud-lambda-labs: spec.gpu is required');

    const region = spec.region ?? config.defaultRegion ?? 'us-south-1';
    const name = spec.image ?? `sh1pt-gpu-${Date.now()}`;

    if (spec.maxHourlyPrice !== undefined) {
      ctx.log(`maxHourlyPrice=${spec.maxHourlyPrice} — quote will be validated before launch`);
    }

    ctx.log(`lambda-labs provision · ${spec.gpu.count}×${spec.gpu.model} · region=${region}`);
    if (ctx.dryRun) return stubInstance('dry-run', 'provisioning', spec);

    const instanceTypes = await fetchInstanceTypes(ctx);
    const match = pickInstanceType(instanceTypes, spec, region);
    const instanceTypeName = match?.name ?? defaultInstanceType(spec.gpu.model);

    // Validate price guardrail
    if (match && spec.maxHourlyPrice !== undefined && match.price_per_hour > spec.maxHourlyPrice) {
      throw new Error(`lambda-labs: cheapest matching instance (${match.name}) costs $${match.price_per_hour}/hr, exceeds maxHourlyPrice $${spec.maxHourlyPrice}`);
    }

    const body: Record<string, unknown> = {
      name,
      region,
      instance_type: instanceTypeName,
      ssh_key_ids: spec.sshKeyIds ?? [],
    };

    if (spec.tags?.length) {
      body.description = spec.tags.join(', ');
    }

    const result = await lambdaRequest<LambdaInstanceResponse>(ctx, 'POST', '/instances', body);
    return lambdaInstanceToInstance(result.data);
  },

  async list(ctx, config) {
    ctx.log('lambda-labs list · fetching instances');
    const result = await lambdaRequest<LambdaInstancesResponse>(ctx, 'GET', '/instances');
    return result.data.map(lambdaInstanceToInstance);
  },

  async destroy(ctx, instanceId, config) {
    ctx.log(`lambda-labs destroy · ${instanceId}`);
    await lambdaRequest<unknown>(ctx, 'DELETE', `/instances/${instanceId}`);
  },

  async status(ctx, instanceId, config) {
    ctx.log(`lambda-labs status · ${instanceId}`);
    const result = await lambdaRequest<LambdaInstanceResponse>(ctx, 'GET', `/instances/${instanceId}`);
    return lambdaInstanceToInstance(result.data);
  },

  setup: tokenSetup<Config>({
    secretKey: 'LAMBDA_LABS_API_KEY',
    label: 'Lambda Labs (GPU Cloud)',
    vendorDocUrl: 'https://cloud.lambdalabs.com/api/v1/docs',
    steps: [
      'Go to cloud.lambdalabs.com → Settings → API Keys',
      'Generate a new API key',
      'Copy the API key (shown only once)',
      'Run: sh1pt secret set LAMBDA_LABS_API_KEY <paste>',
      '⚠ GPU instances bill by the hour — always use --max-hourly-price to cap spend',
    ],
    fields: [
      { key: 'defaultRegion', message: 'Default region (us-south-1, us-west-2, us-east-1, eu-central-1, asia-northeast-1):' },
    ],
  }),
});

// ── Helpers ──────────────────────────────────────────────────────

function stubInstance(id: string, status: Instance['status'], spec: InstanceSpec): Instance {
  return {
    id,
    kind: 'gpu',
    status,
    createdAt: new Date().toISOString(),
    hourlyRate: 0,
    currency: 'USD',
  };
}

function lambdaInstanceToInstance(i: LambdaInstance): Instance {
  const statusMap: Record<string, Instance['status']> = {
    active: 'running',
    building: 'provisioning',
    stopped: 'stopped',
    terminated: 'destroyed',
  };

  return {
    id: i.id,
    kind: 'gpu',
    status: statusMap[i.status] ?? 'provisioning',
    publicIp: i.ip || undefined,
    createdAt: i.created_at,
    hourlyRate: i.cost_per_hour ?? 0,
    currency: 'USD',
    sku: i.gpu_type,
    region: i.region,
    tags: i.name ? [i.name] : undefined,
  };
}

function defaultInstanceType(gpuModel?: string): string {
  // Reasonable defaults based on common GPU models
  const model = (gpuModel ?? '').toLowerCase();
  if (model.includes('h100')) return 'gpu_1x_h100_pcie';
  if (model.includes('a100')) return 'gpu_1x_a100_sxm4';
  if (model.includes('a6000')) return 'gpu_1x_a6000';
  if (model.includes('4090') || model.includes('rtx')) return 'gpu_1x_rtx_4090';
  return 'gpu_1x_a100_sxm4'; // sensible default for AI workloads
}

function pickInstanceType(
  instanceTypes: LambdaInstanceType[],
  spec: InstanceSpec,
  region: string,
): LambdaInstanceType | null {
  // Filter by region availability
  let candidates = instanceTypes.filter(it =>
    it.regions.includes(region) &&
    it.price_per_hour > 0
  );

  // GPU model matching
  if (spec.gpu?.model) {
    const modelLower = spec.gpu.model.toLowerCase();
    candidates = candidates.filter(it => {
      const descLower = it.description.toLowerCase();
      const nameLower = it.name.toLowerCase();
      return descLower.includes(modelLower) || nameLower.includes(modelLower);
    });
  }

  // GPU count matching
  if (spec.gpu?.count && spec.gpu.count > 1) {
    candidates = candidates.filter(it => it.gpu_count >= spec.gpu!.count!);
  }

  // Memory filtering
  if (spec.memory) {
    candidates = candidates.filter(it => it.memory_gb >= spec.memory!);
  }

  // Price guardrail
  if (spec.maxHourlyPrice) {
    candidates = candidates.filter(it => it.price_per_hour <= spec.maxHourlyPrice!);
  }

  // Cheapest first
  candidates.sort((a, b) => a.price_per_hour - b.price_per_hour);
  return candidates[0] ?? null;
}

let instanceTypesCache: LambdaInstanceType[] | null = null;

async function fetchInstanceTypes(
  ctx: { secret(k: string): string | undefined; log(msg: string, level?: 'info' | 'warn' | 'error'): void },
): Promise<LambdaInstanceType[]> {
  if (instanceTypesCache) return instanceTypesCache;
  const result = await lambdaRequest<LambdaInstanceTypesResponse>(ctx, 'GET', '/instance-types');
  instanceTypesCache = result.data;
  return instanceTypesCache;
}

async function lambdaRequest<T = unknown>(
  ctx: { secret(k: string): string | undefined; log(msg: string, level?: 'info' | 'warn' | 'error'): void },
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const token = ctx.secret('LAMBDA_LABS_API_KEY');
  if (!token) throw new Error('LAMBDA_LABS_API_KEY not in vault');

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
    throw new Error(`Lambda Labs ${method} ${path} failed: ${response.status} ${errMsg}`);
  }

  return data as T;
}

function extractErrorMessage(data: unknown, fallback: string): string {
  if (typeof data === 'object' && data && 'error' in data) {
    const err = (data as { error: unknown }).error;
    if (typeof err === 'object' && err && 'message' in err && typeof (err as { message?: unknown }).message === 'string') {
      return (err as { message: string }).message;
    }
    if (typeof err === 'string') return err;
  }
  if (typeof data === 'object' && data && 'detail' in data && typeof (data as { detail?: unknown }).detail === 'string') {
    return (data as { detail: string }).detail;
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
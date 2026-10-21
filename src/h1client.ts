import fetch, { type RequestInit } from "node-fetch";
import { type Readable } from "stream";

const H1_BASE = "https://api.hackerone.com/v1";

// ── Simple in-memory cache ────────────────────────────────────────
interface CacheEntry {
  data: any;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000; // 1 minute

function cacheGet(key: string): any | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.data;
}

function cacheSet(key: string, data: any): void {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

function cacheInvalidatePrefix(prefix: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

// ── Auth ──────────────────────────────────────────────────────────
function getAuth(): string {
  const username = process.env.H1_USERNAME;
  const token = process.env.H1_API_TOKEN;
  if (!username || !token) {
    throw new Error(
      "Missing H1_USERNAME or H1_API_TOKEN environment variables"
    );
  }
  return Buffer.from(`${username}:${token}`).toString("base64");
}

// ── HTTP helpers with retry + backoff ─────────────────────────────
async function h1Fetch(
  path: string,
  params?: Record<string, string>,
  options?: { skipCache?: boolean }
): Promise<any> {
  const url = new URL(`${H1_BASE}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v != null && v !== "") url.searchParams.set(k, v);
    }
  }

  const cacheKey = url.toString();
  if (!options?.skipCache) {
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
  }

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await sleep(1000 * Math.pow(2, attempt)); // 2s, 4s
    }
    try {
      const res = await fetch(url.toString(), {
        redirect: "error",
        headers: {
          Authorization: `Basic ${getAuth()}`,
          Accept: "application/json",
        },
      });

      if (res.status === 429) {
        const retryAfter = res.headers.get("retry-after");
        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 5000;
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HackerOne API error ${res.status}: ${body}`);
      }

      const json = await res.json();
      cacheSet(cacheKey, json);
      return json;
    } catch (err: any) {
      lastErr = err;
      if (err.message?.includes("HackerOne API error")) throw err;
    }
  }
  throw lastErr ?? new Error("h1Fetch failed after retries");
}

async function h1Post(
  path: string,
  body: any,
  contentType = "application/json"
): Promise<any> {
  const url = `${H1_BASE}${path}`;

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(1000 * Math.pow(2, attempt));
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${getAuth()}`,
          Accept: "application/json",
          "Content-Type": contentType,
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });

      if (res.status === 429) {
        const retryAfter = res.headers.get("retry-after");
        await sleep(retryAfter ? parseInt(retryAfter, 10) * 1000 : 5000);
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HackerOne API error ${res.status}: ${text}`);
      }

      // Invalidate caches that may be stale after a write
      cacheInvalidatePrefix(`${H1_BASE}/hackers/me/reports`);
      cacheInvalidatePrefix(`${H1_BASE}/hackers/reports`);

      const text = await res.text();
      return text ? JSON.parse(text) : {};
    } catch (err: any) {
      lastErr = err;
      if (err.message?.includes("HackerOne API error")) throw err;
    }
  }
  throw lastErr ?? new Error("h1Post failed after retries");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Auto-pagination helper ────────────────────────────────────────
function isObject(value: any): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function h1FetchAllPages(
  path: string,
  limit?: number
): Promise<any[]> {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
    throw new Error("page_size must be a positive integer");
  }
  const endpoint = new URL(`${H1_BASE}${path}`);
  let url = new URL(endpoint);
  url.searchParams.set("page[size]", String(Math.min(limit ?? 100, 100)));
  url.searchParams.set("page[number]", "1");
  const visited = new Set<string>();
  const all: any[] = [];
  while (true) {
    url.searchParams.sort();
    if (visited.has(url.href)) {
      throw new Error(`Repeated HackerOne pagination link for ${path}`);
    }
    visited.add(url.href);
    const page = await h1Fetch(url.href.slice(H1_BASE.length));
    if (
      !isObject(page) || !Array.isArray(page.data) ||
      page.data.some((item: any) =>
        !isObject(item) || typeof item.id !== "string" ||
        typeof item.type !== "string" || !isObject(item.attributes)
      ) ||
      (page.links !== undefined && !isObject(page.links))
    ) {
      throw new Error(`Malformed HackerOne page for ${path}: expected a data array of resources and optional links object`);
    }
    const next = page.links?.next;
    let nextUrl: URL | undefined;
    if (next !== undefined && next !== null) {
      if (typeof next !== "string" || !next.trim()) {
        throw new Error(`Malformed HackerOne pagination link for ${path}`);
      }
      try {
        nextUrl = new URL(next, url);
      } catch {
        throw new Error(`Malformed HackerOne pagination link for ${path}`);
      }
      if (
        nextUrl.protocol !== "https:" || nextUrl.origin !== endpoint.origin ||
        nextUrl.pathname !== endpoint.pathname || nextUrl.username ||
        nextUrl.password || nextUrl.hash
      ) {
        throw new Error(`HackerOne pagination link leaves the original HTTPS API endpoint for ${path}`);
      }
    }
    all.push(...page.data.slice(0, limit === undefined ? undefined : limit - all.length));
    if (all.length === limit || !nextUrl) break;
    url = nextUrl;
  }
  return all;
}

// ── List / search reports ──────────────────────────────────────────
export interface SearchReportsOpts {
  query?: string;
  program?: string;
  severity?: string;
  state?: string;
  page_size?: number;
  page_number?: number;
  sort?: string;
}

export async function searchReports(opts: SearchReportsOpts = {}) {
  const needsFilter = !!(
    opts.program ||
    opts.severity ||
    opts.state ||
    opts.query
  );
  const requestedSize = opts.page_size ?? 25;

  const fetchSize = needsFilter ? 100 : requestedSize;
  const pageNumber = opts.page_number ?? 1;

  let allReports: any[] = [];

  if (needsFilter) {
    // Build server-side filter params where possible
    const serverParams: Record<string, string> = {
      "page[size]": "100",
      "page[number]": "1",
    };
    if (opts.program) {
      serverParams["filter[program][]"] = opts.program;
    }
    if (opts.severity) {
      serverParams["filter[severity][]"] = opts.severity;
    }
    if (opts.state) {
      serverParams["filter[state][]"] = opts.state;
    }

    // If we have server-side filters (not just keyword), use them
    const hasServerFilters = !!(opts.program || opts.severity || opts.state);

    if (hasServerFilters) {
      // Fetch with server-side filters, paginate until we have enough
      for (let page = 1; page <= 20; page++) {
        serverParams["page[number]"] = String(page);
        const data = await h1Fetch("/hackers/me/reports", serverParams);
        if (!data.data || data.data.length === 0) break;
        allReports.push(...data.data);
        if (data.data.length < 100) break;
        if (!opts.query && allReports.length >= requestedSize) break;
      }
    } else {
      // Keyword-only: fall back to client-side search with backward pagination
      const probeRes = await h1Fetch("/hackers/me/reports", {
        "page[size]": "100",
        "page[number]": "1",
      });
      if (probeRes.data?.length === 100) {
        let lo = 1,
          hi = 50;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          const check = await h1Fetch("/hackers/me/reports", {
            "page[size]": "100",
            "page[number]": String(mid),
          });
          if (check.data?.length > 0) {
            lo = mid;
            if (check.data.length < 100) break;
            hi = Math.max(hi, mid + 5);
          } else {
            hi = mid - 1;
          }
        }
        for (let page = lo; page >= 1; page--) {
          const data =
            page === 1 && probeRes.data
              ? probeRes
              : await h1Fetch("/hackers/me/reports", {
                  "page[size]": "100",
                  "page[number]": String(page),
                });
          if (!data.data || data.data.length === 0) continue;
          allReports.push(...data.data);
          const tempFiltered = allReports.filter((r: any) => {
            const q = opts.query!.toLowerCase();
            const title = r.attributes.title?.toLowerCase() ?? "";
            const vuln =
              r.attributes.vulnerability_information?.toLowerCase() ?? "";
            const weakness =
              r.relationships?.weakness?.data?.attributes?.name?.toLowerCase() ??
              "";
            return (
              title.includes(q) || vuln.includes(q) || weakness.includes(q)
            );
          });
          if (tempFiltered.length >= requestedSize) break;
        }
      } else {
        allReports = probeRes.data ?? [];
      }
    }
  } else {
    const data = await h1Fetch("/hackers/me/reports", {
      "page[size]": String(fetchSize),
      "page[number]": String(pageNumber),
    });
    allReports = data.data ?? [];
  }

  let reports = allReports.map((r: any) => mapReportSummary(r));

  // Client-side filtering (keyword always needs this; program/severity/state as fallback)
  if (opts.program) {
    const prog = opts.program.toLowerCase();
    reports = reports.filter((r) => r.program?.toLowerCase() === prog);
  }
  if (opts.severity) {
    reports = reports.filter((r) => r.severity === opts.severity);
  }
  if (opts.state) {
    reports = reports.filter((r) => r.state === opts.state);
  }
  if (opts.query) {
    const q = opts.query.toLowerCase();
    reports = reports.filter(
      (r) =>
        r.title?.toLowerCase().includes(q) ||
        r._vuln_info?.toLowerCase().includes(q) ||
        r.weakness?.toLowerCase().includes(q)
    );
  }

  if (opts.sort) {
    const desc = opts.sort.startsWith("-");
    const field = opts.sort.replace(/^-/, "").replace("reports.", "");
    reports.sort((a: any, b: any) => {
      const va = a[field] ?? "";
      const vb = b[field] ?? "";
      return desc ? (vb > va ? 1 : -1) : va > vb ? 1 : -1;
    });
  }

  if (needsFilter) {
    reports = reports.slice(0, requestedSize);
  }

  return reports.map(({ _vuln_info, ...rest }) => rest);
}

function mapReportSummary(r: any) {
  const bounty = r.relationships?.bounties?.data?.[0]?.attributes;
  return {
    id: r.id,
    title: r.attributes.title,
    state: r.attributes.state,
    substate: r.attributes.substate,
    severity: r.attributes.severity_rating,
    created_at: r.attributes.created_at,
    disclosed_at: r.attributes.disclosed_at,
    bounty_awarded_at: r.attributes.bounty_awarded_at,
    bounty_amount: bounty?.amount ?? null,
    bounty_bonus: bounty?.bonus_amount ?? null,
    _vuln_info: r.attributes.vulnerability_information,
    weakness: r.relationships?.weakness?.data?.attributes?.name ?? null,
    program: r.relationships?.program?.data?.attributes?.handle ?? null,
  };
}

// ── Get single report (with full CVSS + bounty) ──────────────────
export async function getReport(reportId: string) {
  const data = await h1Fetch(`/hackers/reports/${reportId}`);
  const r = data.data;
  const attrs = r.attributes;
  const sev = r.relationships?.severity?.data?.attributes;
  const bounty = r.relationships?.bounties?.data?.[0]?.attributes;
  const attachments = r.relationships?.attachments?.data ?? [];

  return {
    id: r.id,
    title: attrs.title,
    state: attrs.state,
    created_at: attrs.created_at,
    closed_at: attrs.closed_at,
    triaged_at: attrs.triaged_at,
    bounty_awarded_at: attrs.bounty_awarded_at,
    disclosed_at: attrs.disclosed_at,
    severity: sev?.rating ?? null,
    cvss_score: sev?.score ?? null,
    cvss_vector: sev?.attack_vector
      ? {
          attack_vector: sev.attack_vector,
          attack_complexity: sev.attack_complexity,
          privileges_required: sev.privileges_required,
          user_interaction: sev.user_interaction,
          scope: sev.scope,
          confidentiality: sev.confidentiality,
          integrity: sev.integrity,
          availability: sev.availability,
        }
      : null,
    bounty_amount: bounty?.amount ?? null,
    bounty_bonus: bounty?.bonus_amount ?? null,
    vulnerability_information: attrs.vulnerability_information,
    impact: attrs.impact,
    weakness: r.relationships?.weakness?.data?.attributes?.name ?? null,
    weakness_id:
      r.relationships?.weakness?.data?.attributes?.external_id ?? null,
    program: r.relationships?.program?.data?.attributes?.handle ?? null,
    structured_scope:
      r.relationships?.structured_scope?.data?.attributes?.asset_identifier ??
      null,
    structured_scope_type:
      r.relationships?.structured_scope?.data?.attributes?.asset_type ?? null,
    attachments: attachments.map((a: any) => ({
      id: a.id,
      file_name: a.attributes?.file_name,
      content_type: a.attributes?.content_type,
      file_size: a.attributes?.file_size,
      expiring_url: a.attributes?.expiring_url,
    })),
  };
}

// ── Get report activities (comments, state changes) ────────────────
export async function getReportActivities(
  reportId: string,
  _pageSize = 50
) {
  const data = await h1Fetch(`/hackers/reports/${reportId}`);
  const activities = data.data?.relationships?.activities?.data ?? [];

  return activities.map((a: any) => ({
    id: a.id,
    type: a.type,
    message: a.attributes.message,
    created_at: a.attributes.created_at,
    internal: a.attributes.internal,
    automated_response: a.attributes.automated_response,
    actor_type: a.relationships?.actor?.data?.type ?? null,
    actor:
      a.relationships?.actor?.data?.attributes?.username ??
      a.relationships?.actor?.data?.attributes?.name ??
      null,
  }));
}

// ── List programs (auto-paginated) ────────────────────────────────
export async function listPrograms(pageSize?: number) {
  const allData = await h1FetchAllPages("/hackers/programs", pageSize);

  return allData.map((p: any) => ({
    id: p.id,
    handle: p.attributes.handle,
    name: p.attributes.name,
    offers_bounties: p.attributes.offers_bounties,
    state: p.attributes.state,
    started_accepting_at: p.attributes.started_accepting_at,
    submission_state: p.attributes.submission_state,
  }));
}

// ── Get program details ───────────────────────────────────────────
export async function getProgramDetails(handle: string) {
  const data = await h1Fetch(`/hackers/programs/${handle}`);
  const p = isObject(data) && "data" in data ? data.data : data;
  if (
    !isObject(p) || p.type !== "program" || typeof p.id !== "string" ||
    !isObject(p.attributes) || typeof p.attributes.handle !== "string"
  ) {
    throw new Error(`Malformed HackerOne program response for ${handle}: expected a program resource with id and attributes.handle`);
  }
  const attrs = p.attributes;

  return {
    id: p.id,
    handle: attrs.handle,
    name: attrs.name,
    url: attrs.url,
    offers_bounties: attrs.offers_bounties,
    state: attrs.state,
    submission_state: attrs.submission_state,
    started_accepting_at: attrs.started_accepting_at,
    policy: attrs.policy,
    response_efficiency_percentage: attrs.response_efficiency_percentage ?? null,
    average_time_to_first_program_response:
      attrs.average_time_to_first_program_response ?? null,
    average_time_to_report_resolved: attrs.average_time_to_report_resolved ?? null,
    average_time_to_bounty_awarded: attrs.average_time_to_bounty_awarded ?? null,
    allow_bounty_splitting: attrs.allows_bounty_splitting ?? null,
    bookmarked: attrs.bookmarked,
  };
}

// ── Get public program signal requirements ────────────────────────
export async function getProgramSignalRequirements(handle: string) {
  handle = handle.trim();
  if (!handle) throw new Error("program_handle must not be empty");
  const cacheKey = `program-signal-requirements:${handle}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // shortcut: uses the public website API; switch when the Hacker API exposes this field.
  const source = "https://hackerone.com/graphql";
  const res = await fetch(source, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `query ProgramSignalRequirements($handle: String!) {
        team(handle: $handle) {
          handle
          signal_requirements_setting { target_signal }
        }
      }`,
      variables: { handle },
    }),
  });
  if (!res.ok) {
    throw new Error(`HackerOne GraphQL HTTP error ${res.status}: ${await res.text()}`);
  }
  const data: any = await res.json();
  if (data?.errors && (!Array.isArray(data.errors) || data.errors.length > 0)) {
    throw new Error(`HackerOne GraphQL error: ${JSON.stringify(data.errors)}`);
  }
  const team = data?.data?.team;
  if (team === null) {
    throw new Error(`Program ${handle} was not found or is not publicly accessible; signal requirements are unavailable`);
  }
  const setting = team?.signal_requirements_setting;
  if (
    !isObject(team) || typeof team.handle !== "string" ||
    (setting !== null && (
      !isObject(setting) ||
      (setting.target_signal !== null && (
        typeof setting.target_signal !== "number" || !Number.isFinite(setting.target_signal)
      ))
    ))
  ) {
    throw new Error(`Malformed HackerOne signal requirements response for ${handle}`);
  }
  const target = setting?.target_signal ?? null;
  const result = {
    handle: team.handle,
    signal_requirement: target === -10 ? null : target,
    signal_requirement_enabled: target === null ? null : target !== -10,
    source,
  };
  cacheSet(cacheKey, result);
  return result;
}

type RewardAvailability = "available" | "partial" | "unavailable";
type RewardSeverity = "low" | "medium" | "high" | "critical";

interface RewardAsset {
  id: string;
  asset_identifier: string;
  asset_type: string | null;
  eligible_for_submission: boolean | null;
  eligible_for_bounty: boolean | null;
}

interface RewardGroup {
  id: string;
  name: string | null;
  description: string | null;
  scope_kind: "all_assets" | "asset" | "reward_group" | null;
  use_range: boolean | null;
  rewards: Record<RewardSeverity, {
    label: string | null;
    minimum: number | null;
    maximum: number | null;
  }>;
  assets: RewardAsset[] | null;
  assets_availability: RewardAvailability;
}

export interface ProgramRewards {
  handle: string;
  currency: string | null;
  source: string;
  program_url: string;
  format: "legacy" | "scope_and_rewards" | null;
  description: string | null;
  availability: RewardAvailability;
  issues: { code: string; group_id: string | null; message: string }[];
  groups: RewardGroup[] | null;
}

// ── Get public program rewards ───────────────────────────────────
export async function getProgramRewards(handle: string): Promise<ProgramRewards> {
  handle = handle.trim();
  if (!handle) throw new Error("program_handle must not be empty");
  const cacheKey = `program-rewards:${handle}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // shortcut: uses the public website API; switch when the Hacker API exposes reward groups.
  const result: ProgramRewards = {
    handle, currency: null, source: "https://hackerone.com/graphql",
    program_url: `https://hackerone.com/${encodeURIComponent(handle)}`,
    format: null, description: null, availability: "unavailable", issues: [], groups: null,
  };
  const issue = (code: string, message: string, group_id: string | null = null) => {
    result.issues.push({ code, group_id, message });
  };
  const request = async (query: string, variables: Record<string, unknown> = {}) => {
    const res = await fetch(result.source, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { handle, ...variables } }),
    });
    if (!res.ok) throw new Error(`HackerOne GraphQL HTTP error ${res.status}`);
    const body: any = await res.json();
    if (body?.errors !== undefined && (!Array.isArray(body.errors) || body.errors.length)) {
      if (body.data?.team === null && Array.isArray(body.errors) &&
          body.errors.length && body.errors.every((e: any) => e?.type === "NOT_FOUND")) return null;
      throw new Error("HackerOne GraphQL returned errors");
    }
    const team = body?.data?.team;
    if (team !== null && !isObject(team)) throw new Error("Malformed HackerOne team response");
    return team;
  };
  const scopeFields = `_id asset_identifier asset_type eligible_for_submission eligible_for_bounty`;
  const rewardsQuery = `query ProgramRewards($handle: String!, $after: String) {
    team(handle: $handle) {
      handle currency scope_and_rewards_groups_enabled
      bounty_table {
        _id description low_label medium_label high_label critical_label
        bounty_table_rows(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          edges { node {
            _id name description use_range
            low low_minimum medium medium_minimum high high_minimum critical critical_minimum
            structured_scope { ${scopeFields} }
          } }
        }
      }
    }
  }`;
  const rows = new Map<string, any>();
  const groups: RewardGroup[] = [];
  const nextCursor = (connection: any, seen: Set<string>): string | null => {
    const info = connection?.pageInfo;
    if (!isObject(info) || typeof info.hasNextPage !== "boolean") {
      throw new Error("Missing reward pagination metadata");
    }
    if (!connection.edges.length && seen.size) throw new Error("Prematurely empty reward page");
    if (!info.hasNextPage) return null;
    if (!connection.edges.length || typeof info.endCursor !== "string" ||
        !info.endCursor || seen.has(info.endCursor)) {
      throw new Error("Incomplete or repeated reward pagination cursor");
    }
    seen.add(info.endCursor);
    return info.endCursor;
  };
  const nodes = (connection: any): any[] => {
    if (!isObject(connection) || !Array.isArray(connection.edges) ||
        connection.edges.some((e: any) => !isObject(e?.node))) {
      throw new Error("Malformed reward connection");
    }
    return connection.edges.map((e: any) => e.node);
  };
  const asset = (raw: any): RewardAsset => {
    if (!isObject(raw) || typeof raw._id !== "string" || !raw._id ||
        typeof raw.asset_identifier !== "string" || !raw.asset_identifier) {
      throw new Error("Malformed reward scope asset");
    }
    return {
      id: raw._id, asset_identifier: raw.asset_identifier,
      asset_type: typeof raw.asset_type === "string" ? raw.asset_type : null,
      eligible_for_submission: typeof raw.eligible_for_submission === "boolean" ? raw.eligible_for_submission : null,
      eligible_for_bounty: typeof raw.eligible_for_bounty === "boolean" ? raw.eligible_for_bounty : null,
    };
  };

  try {
    let team = await request(rewardsQuery);
    if (team === null) {
      issue("not_public_or_not_found", "Program was not found or is not publicly accessible");
      return result;
    }
    if (typeof team.handle !== "string" || typeof team.scope_and_rewards_groups_enabled !== "boolean") {
      throw new Error("Malformed program rewards metadata");
    }
    result.handle = team.handle;
    result.format = team.scope_and_rewards_groups_enabled ? "scope_and_rewards" : "legacy";
    const sourceCurrency = team.currency;
    result.currency = typeof team.currency === "string" && team.currency.trim() ? team.currency : null;
    if (result.currency === null) issue("missing_currency", "Reward currency is unknown");
    if (team.bounty_table === null) {
      result.groups = [];
      issue("no_published_table", "No public bounty table is available");
      return result;
    }
    const tableId = team.bounty_table?._id;
    if (typeof tableId !== "string" || !tableId) throw new Error("Malformed bounty table");
    result.description = typeof team.bounty_table.description === "string" ? team.bounty_table.description : null;
    const cursors = new Set<string>();
    while (true) {
      const table = team?.bounty_table;
      if (table?._id !== tableId || team.handle !== result.handle ||
          team.scope_and_rewards_groups_enabled !== (result.format === "scope_and_rewards") ||
          team.currency !== sourceCurrency) {
        throw new Error("Program rewards changed during pagination");
      }
      for (const row of nodes(table.bounty_table_rows)) {
        if (typeof row._id !== "string" || !row._id || rows.has(row._id)) {
          throw new Error("Missing or repeated reward group ID");
        }
        const useRange = typeof row.use_range === "boolean" ? row.use_range : null;
        const rewards = {} as RewardGroup["rewards"];
        let incomplete = useRange === null;
        for (const severity of ["low", "medium", "high", "critical"] as const) {
          const amount = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
          let maximum = amount(row[severity]);
          let minimum = useRange === false ? maximum : amount(row[`${severity}_minimum`]);
          if (minimum !== null && maximum !== null && minimum > maximum) {
            minimum = maximum = null;
          }
          incomplete ||= minimum === null || maximum === null;
          rewards[severity] = {
            label: typeof table[`${severity}_label`] === "string" ? table[`${severity}_label`] : null,
            minimum, maximum,
          };
        }
        if (incomplete) issue("incomplete_rewards", "Some payout amounts, bounds, or the range setting are unknown or invalid", row._id);
        groups.push({
          id: row._id, name: typeof row.name === "string" ? row.name : null,
          description: typeof row.description === "string" ? row.description : null,
          scope_kind: result.format === "scope_and_rewards" ? "reward_group" :
            row.structured_scope === null ? "all_assets" : isObject(row.structured_scope) ? "asset" : null,
          use_range: useRange, rewards, assets: null, assets_availability: "unavailable",
        });
        rows.set(row._id, row);
      }
      const after = nextCursor(table.bounty_table_rows, cursors);
      if (after === null) break;
      team = await request(rewardsQuery, { after });
    }
    if (!groups.length) {
      result.groups = [];
      issue("no_published_rewards", "The public bounty table contains no reward rows");
      return result;
    }
  } catch (err: any) {
    issue("upstream_error", `Could not retrieve every reward group: ${err.message}`);
    if (!groups.length) return result;
  }
  result.groups = groups;

  let allAssets: RewardAsset[] | undefined;
  for (const group of groups) {
    try {
      const assets: RewardAsset[] = [];
      const seenIds = new Set<string>();
      const append = (rawAssets: any[]) => {
        for (const raw of rawAssets) {
          const item = asset(raw);
          if (seenIds.has(item.id)) throw new Error("Repeated scope asset during pagination");
          seenIds.add(item.id);
          assets.push(item);
        }
      };
      if (group.scope_kind === "reward_group") {
        const rowId = Number(group.id);
        if (!/^\d+$/.test(group.id) || !Number.isSafeInteger(rowId) || rowId < 1 || rowId > 2147483647) {
          throw new Error("Invalid reward group ID for scope search");
        }
        let total: number | undefined;
        while (true) {
          const team = await request(`query ProgramRewardAssets($handle: String!, $rowId: Int!, $from: Int!) {
            team(handle: $handle) {
              structured_scopes_search(bounty_table_row_id: $rowId, from: $from, size: 100,
                sort: {field: "id", direction: ASC}) {
                total_count edges { node { ... on StructuredScopeDocument {
                  _id asset_identifier: identifier asset_type eligible_for_submission eligible_for_bounty
                } } }
              }
            }
          }`, { rowId, from: assets.length });
          const page = team?.structured_scopes_search;
          const batch = nodes(page);
          if (!Number.isSafeInteger(page.total_count) || page.total_count < 0 ||
              (total !== undefined && total !== page.total_count)) {
            throw new Error("Missing or inconsistent reward asset total");
          }
          total = page.total_count;
          append(batch);
          if (assets.length === total) break;
          if (!batch.length || assets.length > total!) throw new Error("Incomplete reward asset search");
        }
        group.assets = assets;
      } else if (group.scope_kind === "asset") {
        group.assets = [asset(rows.get(group.id).structured_scope)];
      } else if (group.scope_kind === "all_assets") {
        if (!allAssets) {
          let after: string | null = null;
          const cursors = new Set<string>();
          do {
            const team = await request(`query ProgramRewardDefaultAssets($handle: String!, $after: String) {
              team(handle: $handle) {
                structured_scopes(first: 100, after: $after, archived: false,
                  eligible_for_submission: true, eligible_for_bounty: true) {
                  pageInfo { hasNextPage endCursor }
                  edges { node { ${scopeFields} } }
                }
              }
            }`, { after });
            const page = team?.structured_scopes;
            append(nodes(page));
            after = nextCursor(page, cursors);
          } while (after !== null);
          allAssets = assets;
        }
        group.assets = allAssets;
      } else {
        throw new Error("Legacy reward scope applicability is unknown");
      }
      group.assets_availability = group.assets.some((a) =>
        a.asset_type === null || a.eligible_for_bounty === null || a.eligible_for_submission === null
      ) ? "partial" : "available";
      if (group.assets_availability === "partial") issue("incomplete_asset_fields", "Some asset types or eligibility fields are unknown", group.id);
    } catch (err: any) {
      issue("assets_unavailable", `Could not retrieve every asset: ${err.message}`, group.id);
    }
  }
  result.availability = result.issues.length ? "partial" : "available";
  if (result.availability === "available") cacheSet(cacheKey, result);
  return result;
}

// ── Get program scope (auto-paginated) ────────────────────────────
export async function getProgramScope(handle: string, pageSize?: number) {
  const allData = await h1FetchAllPages(
    `/hackers/programs/${handle}/structured_scopes`, pageSize
  );

  return allData.map((s: any) => ({
    id: s.id,
    asset_type: s.attributes.asset_type,
    asset_identifier: s.attributes.asset_identifier,
    eligible_for_bounty: s.attributes.eligible_for_bounty,
    eligible_for_submission: s.attributes.eligible_for_submission,
    instruction: s.attributes.instruction,
    max_severity: s.attributes.max_severity,
    created_at: s.attributes.created_at,
  }));
}

// ── Get program weaknesses (auto-paginated) ───────────────────────
export async function getProgramWeaknesses(handle: string, pageSize?: number) {
  const allData = await h1FetchAllPages(
    `/hackers/programs/${handle}/weaknesses`, pageSize
  );

  return allData.map((w: any) => ({
    id: w.id,
    name: w.attributes.name,
    description: w.attributes.description,
    external_id: w.attributes.external_id,
  }));
}

// ── Get earnings ──────────────────────────────────────────────────
export async function getEarnings(pageSize = 100) {
  const data = await h1Fetch("/hackers/payments/earnings", {
    "page[size]": String(pageSize),
  });

  return data.data.map((e: any) => ({
    id: e.id,
    amount: e.attributes.amount,
    awarded_by: e.attributes.awarded_by_name,
    created_at: e.attributes.created_at,
    currency:
      e.relationships?.program?.data?.attributes?.currency ?? null,
    program: e.relationships?.program?.data?.attributes?.handle ?? null,
  }));
}

// ── Get hacker profile ────────────────────────────────────────────
export async function getHackerProfile() {
  const reports = await h1FetchAllPages("/hackers/me/reports");
  const u = reports
    .map((report) => report.relationships?.reporter?.data)
    .find((reporter) =>
      isObject(reporter) && reporter.type === "user" &&
      isObject(reporter.attributes) &&
      typeof reporter.attributes.username === "string" &&
      reporter.attributes.username === process.env.H1_USERNAME
    );
  const attrs = u?.attributes;

  return {
    id: u?.id ?? null,
    username: attrs?.username ?? null,
    name: attrs?.name ?? null,
    bio: attrs?.bio ?? null,
    reputation: attrs?.reputation ?? null,
    signal: attrs?.signal ?? null,
    impact: attrs?.impact ?? null,
    rank: attrs?.rank ?? null,
    created_at: attrs?.created_at ?? null,
    hackerone_triager: attrs?.hackerone_triager ?? null,
    source: "/hackers/me/reports reporter relationship",
    unavailable_reason: u ? null : reports.length === 0
      ? "No reports available; profile data and statistics are unavailable."
      : "No reporter username matches H1_USERNAME; an API identifier may differ from the account username.",
  };
}

// ── Get balance ───────────────────────────────────────────────────
export async function getBalance() {
  const data = await h1Fetch("/hackers/payments/balance");
  // The balance endpoint may return differently; handle both formats
  if (data.data) {
    const attrs = data.data.attributes ?? data.data;
    return {
      balance: attrs.balance ?? attrs.amount ?? null,
      currency: attrs.currency ?? null,
      pending: attrs.pending ?? null,
    };
  }
  return data;
}

// ── Get report summary (condensed for Claude context) ──────────────
export async function getReportSummary(reportId: string) {
  const report = await getReport(reportId);
  const activities = await getReportActivities(reportId);

  const comments = activities.filter(
    (a: any) =>
      a.message &&
      !a.automated_response &&
      (a.type === "activity-comment" ||
        a.type === "activity-bug-triaged" ||
        a.type === "activity-bug-resolved" ||
        a.type === "activity-bounty-awarded")
  );

  return {
    ...report,
    conversation: comments.map((c: any) => ({
      from: c.actor ?? c.actor_type,
      type: c.type.replace("activity-", ""),
      message: c.message,
      date: c.created_at,
    })),
  };
}

// ── Submit report ─────────────────────────────────────────────────
export async function submitReport(opts: {
  program_handle: string;
  title: string;
  vulnerability_information: string;
  impact?: string;
  severity_rating?: string;
  weakness_id?: string;
  structured_scope_id?: string;
}) {
  const relationships: any = {
    program: {
      data: {
        type: "program",
        attributes: { handle: opts.program_handle },
      },
    },
  };

  if (opts.weakness_id) {
    relationships.weakness = {
      data: { type: "weakness", id: opts.weakness_id },
    };
  }

  if (opts.structured_scope_id) {
    relationships.structured_scope = {
      data: { type: "structured-scope", id: opts.structured_scope_id },
    };
  }

  const severity: any = {};
  if (opts.severity_rating) {
    severity.rating = opts.severity_rating;
  }

  const body = {
    data: {
      type: "report",
      attributes: {
        team_handle: opts.program_handle,
        title: opts.title,
        vulnerability_information: opts.vulnerability_information,
        impact: opts.impact ?? "",
        severity_rating: opts.severity_rating,
      },
      relationships,
    },
  };

  const result = await h1Post("/hackers/reports", body);
  const r = result.data;
  return {
    id: r.id,
    title: r.attributes?.title,
    state: r.attributes?.state,
    url: `https://hackerone.com/reports/${r.id}`,
  };
}

// ── Add comment to report ─────────────────────────────────────────
export async function addComment(
  reportId: string,
  message: string,
  internal = false
) {
  const body = {
    data: {
      type: "activity-comment",
      attributes: {
        message,
        internal,
      },
    },
  };

  const result = await h1Post(
    `/hackers/reports/${reportId}/activities`,
    body
  );
  return {
    id: result.data?.id,
    type: result.data?.type,
    message: result.data?.attributes?.message,
    created_at: result.data?.attributes?.created_at,
  };
}

// ── Close / withdraw report ───────────────────────────────────────
export async function closeReport(reportId: string, message?: string) {
  const body = {
    data: {
      type: "activity-hacker-requested-mediation",
      attributes: {
        message: message ?? "Withdrawing this report.",
        close_report: true,
      },
    },
  };

  // Attempt the state change via activities
  const result = await h1Post(
    `/hackers/reports/${reportId}/activities`,
    body
  );
  return {
    id: result.data?.id,
    type: result.data?.type,
    message: result.data?.attributes?.message,
    created_at: result.data?.attributes?.created_at,
  };
}

// ── Search disclosed reports ──────────────────────────────────────
export async function searchDisclosedReports(opts: {
  program?: string;
  query?: string;
  page_size?: number;
}) {
  // The hacktivity endpoint for disclosed reports
  const params: Record<string, string> = {
    "page[size]": String(opts.page_size ?? 25),
  };
  if (opts.program) {
    params["filter[team_handle][]"] = opts.program;
  }

  const data = await h1Fetch("/hackers/hacktivity", params, {
    skipCache: true,
  });
  let reports = (data.data ?? []).map((r: any) => ({
    id: r.id,
    title: r.attributes?.title ?? r.attributes?.raw_title,
    severity: r.attributes?.severity_rating,
    disclosed_at: r.attributes?.disclosed_at,
    total_awarded_amount: r.attributes?.total_awarded_amount,
    upvotes: r.attributes?.vote_count ?? r.attributes?.upvotes,
    url: r.attributes?.url ?? `https://hackerone.com/reports/${r.id}`,
    reporter:
      r.relationships?.reporter?.data?.attributes?.username ?? null,
    program:
      r.relationships?.team?.data?.attributes?.handle ??
      r.relationships?.program?.data?.attributes?.handle ??
      null,
    weakness: r.relationships?.weakness?.data?.attributes?.name ?? null,
  }));

  if (opts.query) {
    const q = opts.query.toLowerCase();
    reports = reports.filter(
      (r: any) =>
        r.title?.toLowerCase().includes(q) ||
        r.weakness?.toLowerCase().includes(q)
    );
  }

  return reports;
}

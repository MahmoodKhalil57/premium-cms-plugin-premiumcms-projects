/**
 * Cloudflare REST client + marketplace deploy-service caller, over ctx.http
 * (the sandbox bridge). Every outbound call is pinned to `allowedHosts`.
 *
 * Ported from the pre-reset provider's env.ts, adapted so credentials come
 * from plugin settings (a CfCreds pair / the Settings bag) rather than a
 * Worker ProviderEnv.
 */

import type { PluginContext } from "@premium-cms/emdash/plugin";
import type { CfCreds, Settings } from "./settings.js";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

export interface HttpResult {
	status: number;
	ok: boolean;
	text: string;
	json<T = Record<string, unknown>>(): T;
}

export interface CfResult<T = unknown> {
	success: boolean;
	result: T;
	errors: Array<{ code: number; message: string }>;
}

/** Thin wrapper over ctx.http.fetch that always reads the body as text once. */
export async function http(
	ctx: PluginContext,
	url: string,
	init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResult> {
	if (!ctx.http)
		throw new Error(
			"network access is not available to the plugin (needs the network:request capability)",
		);
	const res = await ctx.http.fetch(url, init as RequestInit);
	const text = await res.text();
	return {
		status: res.status,
		ok: res.status >= 200 && res.status < 300,
		text,
		json<T = Record<string, unknown>>(): T {
			try {
				return JSON.parse(text) as T;
			} catch {
				return {} as T;
			}
		},
	};
}

function parseCf<T>(res: HttpResult): CfResult<T> {
	try {
		return JSON.parse(res.text) as CfResult<T>;
	} catch {
		return {
			success: res.ok,
			result: undefined as T,
			errors: res.ok ? [] : [{ code: res.status, message: res.text.slice(0, 200) }],
		};
	}
}

/**
 * Account-scoped Cloudflare call:
 * `https://api.cloudflare.com/client/v4/accounts/<accountId><path>`.
 */
export async function cfApi<T = unknown>(
	ctx: PluginContext,
	creds: CfCreds,
	method: string,
	path: string,
	body?: unknown,
): Promise<CfResult<T>> {
	if (!creds.apiToken || !creds.accountId)
		throw new Error("Cloudflare credentials not configured — open Plugins → Projects → Settings.");
	const res = await http(ctx, `${CF_API_BASE}/accounts/${creds.accountId}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${creds.apiToken}`,
			...(body !== undefined ? { "Content-Type": "application/json" } : {}),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return parseCf<T>(res);
}

/**
 * Resolve a zone id by name. The zones endpoint is NOT under /accounts, so it
 * takes the bare `${CF_API_BASE}/zones` base URL.
 */
/**
 * Resolve the Cloudflare zone new instances are provisioned under, from the
 * account's zones. Prefers a name (derived from the site URL) when it matches
 * an account zone, else falls back to the account's first zone. Reliable
 * regardless of whether ctx.site.url is populated in the current context.
 */
export async function resolveZone(
	ctx: PluginContext,
	creds: CfCreds,
	preferred?: string,
): Promise<{ name: string; id: string }> {
	if (!creds.apiToken || !creds.accountId)
		throw new Error("Cloudflare credentials not configured.");
	const res = await http(ctx, `${CF_API_BASE}/zones?account.id=${creds.accountId}&per_page=50`, {
		headers: { Authorization: `Bearer ${creds.apiToken}` },
	});
	const data = res.json<CfResult<Array<{ id: string; name: string }>>>();
	const zones = data.success && data.result ? data.result : [];
	if (zones.length === 0) {
		throw new Error(
			"no Cloudflare zones on this account (check the token's Zone:Read permission).",
		);
	}
	const chosen = (preferred && zones.find((z) => z.name === preferred)) || zones[0];
	return { name: chosen.name, id: chosen.id };
}

export async function cfZoneId(ctx: PluginContext, creds: CfCreds, zone: string): Promise<string> {
	if (!creds.apiToken || !zone) throw new Error("Cloudflare credentials / zone not configured.");
	const res = await http(
		ctx,
		`${CF_API_BASE}/zones?name=${encodeURIComponent(zone)}&account.id=${creds.accountId}`,
		{
			headers: { Authorization: `Bearer ${creds.apiToken}` },
		},
	);
	const data = res.json<CfResult<Array<{ id: string }>>>();
	if (!data.success || !data.result?.[0]) throw new Error(`zone ${zone} not found`);
	return data.result[0].id;
}

/**
 * Look up a D1 database's uuid by its exact name (e.g. `${rn}-db`). Returns
 * null when no database with that name exists. Used to resolve a child's
 * database without any stored state — the name is derived from the row id.
 */
export async function findD1IdByName(
	ctx: PluginContext,
	creds: CfCreds,
	name: string,
): Promise<string | null> {
	const list = await cfApi<Array<{ uuid: string; name: string }>>(
		ctx,
		creds,
		"GET",
		"/d1/database?per_page=100",
	);
	return list.result?.find((d) => d.name === name)?.uuid ?? null;
}

/**
 * Look up a KV namespace's id by its exact title (e.g. `${rn}-session`).
 * Returns null when none matches.
 */
export async function findKvIdByName(
	ctx: PluginContext,
	creds: CfCreds,
	title: string,
): Promise<string | null> {
	const list = await cfApi<Array<{ id: string; title: string }>>(
		ctx,
		creds,
		"GET",
		"/storage/kv/namespaces?per_page=100",
	);
	return list.result?.find((n) => n.title === title)?.id ?? null;
}

/**
 * Run one SQL statement against a project's D1 database. The D1 query endpoint
 * executes a single statement per call, so callers split multi-statement work.
 */
export async function d1Query<T = unknown>(
	ctx: PluginContext,
	creds: CfCreds,
	d1Id: string,
	sql: string,
	params: unknown[] = [],
): Promise<CfResult<T>> {
	return cfApi<T>(ctx, creds, "POST", `/d1/database/${d1Id}/query`, { sql, params });
}

/**
 * Trusted marketplace deploy service (uploads the golden bundle, purges R2).
 * POST `${marketplaceUrl}${path}` with the X-Deploy-Key header; throws on
 * non-2xx.
 */
export async function deployService<T = Record<string, unknown>>(
	ctx: PluginContext,
	settings: Settings,
	path: string,
	body?: unknown,
	method = "POST",
): Promise<T> {
	if (!settings.deployKey)
		throw new Error(
			"Deploy key not configured — set it in Plugins → Projects → Settings (matches the marketplace worker's secret).",
		);
	const res = await http(ctx, `${settings.marketplaceUrl}${path}`, {
		method,
		headers: { "Content-Type": "application/json", "X-Deploy-Key": settings.deployKey },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const data = res.json<T & { error?: string }>();
	if (!res.ok)
		throw new Error(`deploy service ${res.status}: ${data.error ?? res.text.slice(0, 200)}`);
	return data;
}

/**
 * Custom-domain (Cloudflare for SaaS) helpers, run on the control plane which
 * holds the Cloudflare credentials. An instance owner points their own domain
 * at the platform: we create a custom hostname on the platform zone, map it to
 * the instance's canonical `p<ulid>.<zone>` origin in the `custom-domains` KV
 * (which the router worker reads), and hand the owner the DNS records to add.
 * On a later "check" we poll the hostname's status until the cert is active.
 */

import type { PluginContext } from "@premium-cms/emdash/plugin";
import { http } from "./cf.js";
import type { CfCreds } from "./settings.js";

const CF = "https://api.cloudflare.com/client/v4";

/** The proxied hostname on the platform zone that custom domains CNAME to. */
export const CNAME_TARGET = "router.premium-cms.com";

/** A DNS record the owner must add at their registrar. */
export interface DnsRecord {
	type: "CNAME" | "TXT";
	name: string;
	value: string;
	note: string;
}

export interface CustomHostname {
	id: string;
	hostname: string;
	status: string;
	ssl?: {
		status?: string;
		validation_records?: Array<{ txt_name?: string; txt_value?: string }>;
	};
	ownership_verification?: { type?: string; name?: string; value?: string };
}

/** Strip protocol / path / port from a URL or host → a bare lowercase hostname. */
export function normalizeDomain(input: string): string {
	return (input || "")
		.trim()
		.toLowerCase()
		.replace(/^[a-z]+:\/\//, "")
		.replace(/[/?#].*$/, "")
		.replace(/:\d+$/, "")
		.replace(/\.$/, "");
}

function envelope<T>(text: string): { success: boolean; result?: T; errors?: unknown } {
	try {
		return JSON.parse(text);
	} catch {
		return { success: false, errors: text.slice(0, 200) };
	}
}

async function zoneGet<T>(
	ctx: PluginContext,
	creds: CfCreds,
	path: string,
): Promise<{ success: boolean; result?: T }> {
	const res = await http(ctx, `${CF}/zones/${path}`, {
		headers: { Authorization: `Bearer ${creds.apiToken}` },
	});
	return envelope<T>(res.text);
}

/** Look up a custom hostname on the zone by its hostname, or null. */
export async function findCustomHostname(
	ctx: PluginContext,
	creds: CfCreds,
	zoneId: string,
	hostname: string,
): Promise<CustomHostname | null> {
	const data = await zoneGet<CustomHostname[]>(
		ctx,
		creds,
		`${zoneId}/custom_hostnames?hostname=${encodeURIComponent(hostname)}`,
	);
	return data.success && data.result && data.result[0] ? data.result[0] : null;
}

/** Create a custom hostname (TXT DCV) on the zone. */
export async function createCustomHostname(
	ctx: PluginContext,
	creds: CfCreds,
	zoneId: string,
	hostname: string,
): Promise<CustomHostname | null> {
	const res = await http(ctx, `${CF}/zones/${zoneId}/custom_hostnames`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${creds.apiToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			hostname,
			ssl: { method: "txt", type: "dv", settings: { min_tls_version: "1.2" } },
		}),
	});
	const data = envelope<CustomHostname>(res.text);
	return data.success && data.result ? data.result : null;
}

/** Delete a custom hostname (revert to the default domain). */
export async function deleteCustomHostname(
	ctx: PluginContext,
	creds: CfCreds,
	zoneId: string,
	id: string,
): Promise<void> {
	await http(ctx, `${CF}/zones/${zoneId}/custom_hostnames/${id}`, {
		method: "DELETE",
		headers: { Authorization: `Bearer ${creds.apiToken}` },
	});
}

/** Point a custom hostname at an instance origin in the router's KV. */
export async function mapDomain(
	ctx: PluginContext,
	creds: CfCreds,
	kvId: string,
	hostname: string,
	origin: string,
): Promise<void> {
	await http(
		ctx,
		`${CF}/accounts/${creds.accountId}/storage/kv/namespaces/${kvId}/values/${encodeURIComponent(hostname)}`,
		{
			method: "PUT",
			headers: { Authorization: `Bearer ${creds.apiToken}`, "Content-Type": "text/plain" },
			body: origin,
		},
	);
}

/** Remove a custom hostname → origin mapping from the router's KV. */
export async function unmapDomain(
	ctx: PluginContext,
	creds: CfCreds,
	kvId: string,
	hostname: string,
): Promise<void> {
	await http(
		ctx,
		`${CF}/accounts/${creds.accountId}/storage/kv/namespaces/${kvId}/values/${encodeURIComponent(hostname)}`,
		{ method: "DELETE", headers: { Authorization: `Bearer ${creds.apiToken}` } },
	);
}

/** The DNS records an owner must add for `hostname`, derived from the custom hostname. */
export function recordsFor(hostname: string, ch: CustomHostname | null): DnsRecord[] {
	const records: DnsRecord[] = [
		{
			type: "CNAME",
			name: hostname,
			value: CNAME_TARGET,
			note: "Routes your domain to your site.",
		},
	];
	const val = ch?.ssl?.validation_records?.[0];
	if (val?.txt_name && val?.txt_value) {
		records.push({
			type: "TXT",
			name: val.txt_name,
			value: val.txt_value,
			note: "Proves you control the domain so we can issue an SSL certificate.",
		});
	}
	const own = ch?.ownership_verification;
	if (own?.type === "txt" && own.name && own.value) {
		records.push({
			type: "TXT",
			name: own.name,
			value: own.value,
			note: "Verifies domain ownership.",
		});
	}
	return records;
}

/** Whether the custom hostname is fully live (routing + cert active). */
export function isActive(ch: CustomHostname | null): boolean {
	return ch?.status === "active" && ch?.ssl?.status === "active";
}

/**
 * Re-point every router entry that targets `from` at `to` — used when an
 * instance's home hostname changes so customer domains keep resolving to it.
 * Returns the hostnames re-pointed.
 */
export async function remapDomains(
	ctx: PluginContext,
	creds: CfCreds,
	kvId: string,
	from: string,
	to: string,
): Promise<string[]> {
	const base = `${CF}/accounts/${creds.accountId}/storage/kv/namespaces/${kvId}`;
	const auth = { Authorization: `Bearer ${creds.apiToken}` };
	const list = await http(ctx, `${base}/keys?limit=1000`, { headers: auth });
	const keys = list.json<{ result?: Array<{ name: string }> }>().result ?? [];
	const moved: string[] = [];
	for (const { name } of keys) {
		const cur = await http(ctx, `${base}/values/${encodeURIComponent(name)}`, { headers: auth });
		if (!cur.ok || cur.text.trim() !== from) continue;
		await mapDomain(ctx, creds, kvId, name, to);
		moved.push(name);
	}
	return moved;
}

/** Router entries (customer hostnames) currently pointing at `origin`. */
export async function hostnamesRoutedTo(
	ctx: PluginContext,
	creds: CfCreds,
	kvId: string,
	origin: string,
): Promise<string[]> {
	const base = `${CF}/accounts/${creds.accountId}/storage/kv/namespaces/${kvId}`;
	const auth = { Authorization: `Bearer ${creds.apiToken}` };
	const list = await http(ctx, `${base}/keys?limit=1000`, { headers: auth });
	const out: string[] = [];
	for (const { name } of list.json<{ result?: Array<{ name: string }> }>().result ?? []) {
		const cur = await http(ctx, `${base}/values/${encodeURIComponent(name)}`, { headers: auth });
		if (cur.ok && cur.text.trim() === origin) out.push(name);
	}
	return out;
}

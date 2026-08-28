/**
 * Platform service token: how a parent authenticates to the instances it
 * provisioned.
 *
 * At bootstrap the parent mints an `admin`-scoped API token straight into the
 * child's `_emdash_api_tokens` (it already has D1 write access to the child)
 * and keeps the raw value in its own kv. Every later privileged call into the
 * child — plugin updates, seed re-apply, the recursive roll — is a normal
 * Bearer-authenticated admin API call, so no shared secret is needed and each
 * hop of the tree uses the token the parent minted.
 */

import type { PluginContext } from "@premium-cms/emdash/plugin";
import { d1Query, http, type HttpResult } from "./cf.js";
import type { CfCreds } from "./settings.js";

const tokenKey = (project: string) => `platform:token:${project}`;

function b64url(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Stored hash = base64url(sha256(utf8(rawToken))) — matches core's hashPrefixedToken. */
async function hashToken(raw: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
	return b64url(new Uint8Array(digest));
}

/**
 * Mint (or re-mint) the platform token for a child. Idempotent per call: an
 * existing row with the same name is replaced, so a lost kv value can always be
 * recovered by minting again.
 */
export async function mintPlatformToken(
	ctx: PluginContext,
	creds: CfCreds,
	d1Id: string,
	project: string,
	ownerEmail: string,
): Promise<string> {
	const user = await d1Query<Array<{ results?: Array<{ id: string }> }>>(
		ctx,
		creds,
		d1Id,
		"SELECT id FROM users WHERE email = ? ORDER BY created_at LIMIT 1",
		[ownerEmail],
	);
	const userId = user.result?.[0]?.results?.[0]?.id;
	if (!userId) throw new Error(`owner ${ownerEmail} not found in child ${project}`);

	const rand = new Uint8Array(32);
	crypto.getRandomValues(rand);
	const raw = `ec_pat_${b64url(rand)}`;
	const hash = await hashToken(raw);
	const id = crypto.randomUUID().replace(/-/g, "").slice(0, 26).toUpperCase();

	await d1Query(ctx, creds, d1Id, "DELETE FROM _emdash_api_tokens WHERE name = ?", [
		"PremiumCMS platform",
	]);
	const ins = await d1Query(
		ctx,
		creds,
		d1Id,
		"INSERT INTO _emdash_api_tokens (id,name,token_hash,prefix,user_id,scopes,created_at) VALUES (?,?,?,?,?,?,datetime('now'))",
		[id, "PremiumCMS platform", hash, raw.slice(0, 11), userId, JSON.stringify(["admin"])],
	);
	if (!ins.success) throw new Error(`platform token insert failed: ${JSON.stringify(ins.errors)}`);
	await ctx.kv.set(tokenKey(project), raw);
	return raw;
}

export async function platformToken(ctx: PluginContext, project: string): Promise<string> {
	const v = await ctx.kv.get(tokenKey(project));
	return typeof v === "string" ? v : "";
}

export async function forgetPlatformToken(ctx: PluginContext, project: string): Promise<void> {
	await ctx.kv.delete(tokenKey(project));
}

/** Authenticated admin API call into a child instance. */
export async function childApi(
	ctx: PluginContext,
	origin: string,
	token: string,
	method: string,
	path: string,
	body?: unknown,
): Promise<HttpResult> {
	return http(ctx, `${origin.replace(/\/$/, "")}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			"X-EmDash-Request": "1",
			"Content-Type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

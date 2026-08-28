/**
 * Marketplace client: themes are projects published as repos; plugins are
 * repos that publish themselves. The control plane talks to the marketplace
 * as the trusted publisher (SEED token) to register/refresh theme listings,
 * and through the deploy key to mint publish tokens for forked plugin repos.
 */

import type { PluginContext } from "@premium-cms/emdash/plugin";
import { http } from "./cf.js";
import type { Settings } from "./settings.js";

export interface MarketplaceTheme {
	id: string;
	name: string;
	description?: string | null;
	previewUrl?: string | null;
	demoUrl?: string | null;
	repositoryUrl?: string | null;
}

const base = (settings: Settings) => `${settings.marketplaceUrl.replace(/\/$/, "")}/api/v1`;

export async function listThemes(
	ctx: PluginContext,
	settings: Settings,
): Promise<MarketplaceTheme[]> {
	const out: MarketplaceTheme[] = [];
	let cursor = "";
	for (let page = 0; page < 10; page++) {
		const r = await http(
			ctx,
			`${base(settings)}/themes?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
		);
		if (!r.ok) throw new Error(`marketplace themes ${r.status}`);
		const d = r.json<{ items?: MarketplaceTheme[]; nextCursor?: string | null }>();
		out.push(...(d.items ?? []));
		if (!d.nextCursor) break;
		cursor = d.nextCursor;
	}
	return out;
}

export async function getTheme(
	ctx: PluginContext,
	settings: Settings,
	id: string,
): Promise<MarketplaceTheme | null> {
	const r = await http(ctx, `${base(settings)}/themes/${encodeURIComponent(id)}`);
	if (r.status === 404) return null;
	if (!r.ok) throw new Error(`marketplace theme ${id}: ${r.status}`);
	return r.json<MarketplaceTheme>();
}

/** Create or update a theme listing as the trusted publisher. */
export async function upsertTheme(
	ctx: PluginContext,
	settings: Settings,
	theme: MarketplaceTheme & { keywords?: string[]; license?: string },
): Promise<void> {
	if (!settings.marketplaceSeedToken) throw new Error("marketplace publisher token not configured");
	const headers = {
		Authorization: `Bearer ${settings.marketplaceSeedToken}`,
		"Content-Type": "application/json",
	};
	const body = {
		name: theme.name,
		description: theme.description ?? undefined,
		previewUrl: theme.previewUrl ?? undefined,
		demoUrl: theme.demoUrl ?? undefined,
		repositoryUrl: theme.repositoryUrl ?? undefined,
		license: theme.license,
		keywords: theme.keywords,
	};
	const existing = await getTheme(ctx, settings, theme.id);
	const r = existing
		? await http(ctx, `${base(settings)}/themes/${encodeURIComponent(theme.id)}`, {
				method: "PUT",
				headers,
				body: JSON.stringify(body),
			})
		: await http(ctx, `${base(settings)}/themes`, {
				method: "POST",
				headers,
				body: JSON.stringify({ id: theme.id, ...body }),
			});
	if (!r.ok) throw new Error(`marketplace theme upsert ${r.status}: ${r.text.slice(0, 160)}`);
}

/** A long-lived marketplace publish token for a GitHub user (author row created on first use). */
export async function authorToken(
	ctx: PluginContext,
	settings: Settings,
	githubLogin: string,
	githubId?: string,
): Promise<string> {
	const r = await http(ctx, `${base(settings)}/author-token`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-Deploy-Key": settings.deployKey },
		body: JSON.stringify({ githubLogin, githubId }),
	});
	if (!r.ok) throw new Error(`marketplace author-token ${r.status}: ${r.text.slice(0, 120)}`);
	const token = r.json<{ token?: string }>().token;
	if (!token) throw new Error("marketplace returned no token");
	return token;
}

/** Register a plugin listing on behalf of its author (their publish token). */
export async function createPluginListing(
	ctx: PluginContext,
	settings: Settings,
	token: string,
	plugin: { id: string; name: string; description?: string; repositoryUrl: string },
): Promise<{ created: boolean; error?: string }> {
	const r = await http(ctx, `${base(settings)}/plugins`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			id: plugin.id,
			name: plugin.name,
			description: plugin.description ?? "",
			repositoryUrl: plugin.repositoryUrl,
			license: "MIT",
			capabilities: [],
			keywords: [],
		}),
	});
	if (r.ok || r.status === 201) return { created: true };
	if (r.status === 409)
		return { created: false, error: `plugin id "${plugin.id}" is already taken` };
	return { created: false, error: `marketplace ${r.status}: ${r.text.slice(0, 160)}` };
}

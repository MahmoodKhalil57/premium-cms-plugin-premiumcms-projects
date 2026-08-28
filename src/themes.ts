/**
 * Themes are projects. A project marked "Is theme / demo" is published as a
 * marketplace theme: its live schema + content are exported as seed.json into
 * its own site repo (which becomes a GitHub template), and the listing points
 * at that repo with the project as the live preview. A new project "copied
 * from" a theme generates its site repo from the theme's repo and applies the
 * theme's seed.json.
 */

import type { PluginContext } from "@premium-cms/emdash/plugin";
import { fetchRepoFile, parseRepoUrl, pushFiles, setTemplateRepo } from "./github.js";
import { getTheme, upsertTheme } from "./marketplace.js";
import { childApi, platformToken } from "./platform.js";
import type { Settings } from "./settings.js";

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Marketplace id for a project: its slug-ish label, else its ULID. */
export function themeIdFor(row: { id: string; data: Record<string, unknown> }): string {
	const label = str(row.data.label)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
	return /^[a-z]/.test(label) ? label : `t-${row.id.toLowerCase()}`;
}

/**
 * Export the project's seed into its repo and (re)register the listing.
 * Returns what happened; throws when the project can't be a theme yet.
 */
export async function publishTheme(
	ctx: PluginContext,
	settings: Settings,
	row: { id: string; data: Record<string, unknown> },
): Promise<string> {
	const project = row.id;
	const url = str(row.data.url);
	if (!url) throw new Error("not provisioned yet");
	const token = await platformToken(ctx, project);
	if (!token) throw new Error("no platform token");
	const gh = str(await ctx.kv.get(`github:token:${project}`));
	const owner = str(await ctx.kv.get(`github:owner:${project}`));
	const repo = str(await ctx.kv.get(`github:repo:${project}`));
	if (!gh || !owner || !repo) throw new Error("frontend not connected (no site repo)");

	const res = await childApi(ctx, url, token, "GET", "/_emdash/api/settings/seed/export");
	if (!res.ok) throw new Error(`seed export ${res.status}`);
	const seed = res.json<{ data?: unknown }>().data;
	if (!seed || typeof seed !== "object") throw new Error("seed export returned nothing");

	const push = await pushFiles(
		ctx,
		gh,
		owner,
		repo,
		[{ path: "seed.json", content: `${JSON.stringify(seed, null, "\t")}\n` }],
		"chore: publish theme seed",
	);
	if (!push.ok) throw new Error(push.error || "could not commit seed.json");
	const tpl = await setTemplateRepo(ctx, gh, owner, repo, true);
	if (!tpl.ok) throw new Error(tpl.error || "could not mark the repo as a template");

	const id = themeIdFor(row);
	await upsertTheme(ctx, settings, {
		id,
		name: str(row.data.label) || id,
		description: str(row.data.description) || undefined,
		previewUrl: url,
		demoUrl: url,
		repositoryUrl: `https://github.com/${owner}/${repo}`,
		license: "MIT",
	});
	return `published as "${id}" (${owner}/${repo})`;
}

/** The theme's repo (`owner/repo`) from the marketplace, or null when unknown. */
export async function themeRepo(
	ctx: PluginContext,
	settings: Settings,
	themeId: string,
): Promise<{ owner: string; repo: string } | null> {
	if (!themeId) return null;
	const theme = await getTheme(ctx, settings, themeId);
	const parsed = theme?.repositoryUrl ? parseRepoUrl(theme.repositoryUrl) : null;
	return parsed;
}

/**
 * Apply a theme's seed.json (from its repo) to a project. Returns a summary,
 * or null when the theme has no seed to apply.
 */
export async function applyThemeSeed(
	ctx: PluginContext,
	settings: Settings,
	project: string,
	projectUrl: string,
	themeId: string,
): Promise<string | null> {
	const repo = await themeRepo(ctx, settings, themeId);
	if (!repo) return null;
	const gh = str(await ctx.kv.get(`github:token:${project}`)) || undefined;
	const text = await fetchRepoFile(ctx, repo.owner, repo.repo, "seed.json", gh);
	if (!text) return null;
	const token = await platformToken(ctx, project);
	if (!token) throw new Error("no platform token");
	const res = await childApi(
		ctx,
		projectUrl,
		token,
		"POST",
		"/_emdash/api/settings/seed/apply",
		JSON.parse(text),
	);
	if (!res.ok) throw new Error(`seed apply ${res.status}: ${res.text.slice(0, 120)}`);
	const d =
		res.json<{ data?: Record<string, { created?: number; updated?: number }> }>().data ?? {};
	const c = Object.values(d).reduce((n, v) => n + (v?.created ?? 0), 0);
	const u = Object.values(d).reduce((n, v) => n + (v?.updated ?? 0), 0);
	return `theme "${themeId}" seed applied (${c} created, ${u} updated)`;
}

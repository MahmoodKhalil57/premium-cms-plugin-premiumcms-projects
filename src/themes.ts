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

const CONTENT_README = `# content/

Git-tier content: entries of collections with \`storage: "git"\`
(\`content/<collection>/<slug>.json\`) and plugin data declared git-backed
(\`content/<pluginId>/<collection>/<id>.json\`, e.g. form definitions).

Saving in the admin commits here; editing a file here is picked up on the
next read. The static build renders these files directly. Frequently edited
or sensitive data stays in the database, and test data lives in \`seed/\`.
`;

/**
 * Export the project's seed into its repo as the \`seed/\` directory (and
 * scaffold \`content/\`). Every connected project gets this — the repo is the
 * whole site — whether or not it is listed as a theme.
 */
export async function publishSeed(
	ctx: PluginContext,
	settings: Settings,
	row: { id: string; data: Record<string, unknown> },
): Promise<{ owner: string; repo: string; gh: string; files: number }> {
	const project = row.id;
	const url = str(row.data.url);
	if (!url) throw new Error("not provisioned yet");
	const token = await platformToken(ctx, project);
	if (!token) throw new Error("no platform token");
	const gh = str(await ctx.kv.get(`github:token:${project}`));
	const owner = str(await ctx.kv.get(`github:owner:${project}`));
	const repo = str(await ctx.kv.get(`github:repo:${project}`));
	if (!gh || !owner || !repo) throw new Error("frontend not connected (no site repo)");

	// The seed as a directory (seed/** with JSON schemas), one file per thing.
	const res = await childApi(ctx, url, token, "GET", "/_emdash/api/settings/seed/export?format=tree");
	if (!res.ok) throw new Error(`seed export ${res.status}`);
	const files = res.json<{ data?: { files?: Record<string, string> } }>().data?.files ?? {};
	const list: Array<{ path: string; content: string | null }> = Object.entries(files).map(
		([path, content]) => ({ path, content }),
	);
	if (list.length === 0) throw new Error("seed export returned nothing");
	// The single-file layout this replaces (a tree can't delete a missing path).
	if (await fetchRepoFile(ctx, owner, repo, "seed.json", gh))
		list.push({ path: "seed.json", content: null });
	if (!(await fetchRepoFile(ctx, owner, repo, "content/README.md", gh)))
		list.push({ path: "content/README.md", content: CONTENT_README });

	const push = await pushFiles(ctx, gh, owner, repo, list, "chore: publish seed");
	if (!push.ok) throw new Error(push.error || "could not commit seed/");
	return { owner, repo, gh, files: list.length };
}

/**
 * Publish the project as a marketplace theme: its seed into its repo, the
 * repo as a template, the listing. Throws when it can't be a theme yet.
 */
export async function publishTheme(
	ctx: PluginContext,
	settings: Settings,
	row: { id: string; data: Record<string, unknown> },
): Promise<string> {
	const { owner, repo, gh } = await publishSeed(ctx, settings, row);
	const tpl = await setTemplateRepo(ctx, gh, owner, repo, true);
	if (!tpl.ok) throw new Error(tpl.error || "could not mark the repo as a template");

	const id = themeIdFor(row);
	const url = str(row.data.url);
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
	const token = await platformToken(ctx, project);
	if (!token) throw new Error("no platform token");
	// The child downloads the theme repo's archive itself and composes the
	// seed from its seed/ directory (or a legacy seed.json).
	const res = await childApi(ctx, projectUrl, token, "POST", "/_emdash/api/settings/seed/apply-repo", {
		owner: repo.owner,
		repo: repo.repo,
	});
	if (!res.ok) throw new Error(`seed apply ${res.status}: ${res.text.slice(0, 120)}`);
	const d = res.json<{ data?: Record<string, unknown> }>().data ?? {};
	if (d.applied === false) return null;
	const counts = Object.values(d).filter(
		(v): v is { created?: number; updated?: number } => !!v && typeof v === "object",
	);
	const c = counts.reduce((n, v) => n + (v.created ?? 0), 0);
	const u = counts.reduce((n, v) => n + (v.updated ?? 0), 0);
	return `theme "${themeId}" seed applied (${c} created, ${u} updated)`;
}

/**
 * Roll: bring every instance this control plane provisioned up to date, then
 * ask each of them to do the same for theirs — so one call at the root walks
 * the whole tree, every hop using its own parent's credentials.
 *
 * Steps (all idempotent, each independently selectable):
 *   bundle   — redeploy the child Worker from its theme's `latest` golden bundle
 *              (same bindings as provisioning, FRONTEND_ORIGIN preserved)
 *   plugins  — apply every available marketplace plugin update in the child
 *   seed     — re-apply the theme seed embedded in the (new) bundle,
 *              update-on-conflict, via the child's reseed route
 *   frontend — sync the theme's frontend template repo into the child's site
 *              repo (template-owned paths only) and rebuild Pages
 *   theme    — export the project's seed into its repo (seed/ + content/);
 *              for projects marked "Is theme / demo" also refresh the
 *              marketplace listing
 *
 * Children that are not control planes answer the cascade with `skipped`.
 */

import type { PluginContext } from "@premium-cms/emdash/plugin";
import { deployService, findD1IdByName, findKvIdByName } from "./cf.js";
import { listProjectRows } from "./content.js";
import { dispatchRebuild, syncTemplate, templateForTheme } from "./github.js";
import { childApi, platformToken } from "./platform.js";
import { isUlid, projectBindings, resourceName } from "./provisioner.js";
import { credsOf, type Settings } from "./settings.js";
import { applyThemeSeed, publishSeed, publishTheme } from "./themes.js";

export const ROLL_STEPS = ["bundle", "plugins", "seed", "frontend", "theme"] as const;
export type RollStep = (typeof ROLL_STEPS)[number];

export interface RollOptions {
	steps: RollStep[];
	cascade: boolean;
	/** Restrict to one child (ULID). */
	project?: string;
}

export interface RollResult {
	project: string;
	label: string;
	url: string;
	ok: boolean;
	steps: Partial<Record<RollStep, string>>;
	children?: RollResult[] | { skipped: string };
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const ROLL_PATH = "/_emdash/api/plugins/premiumcms-projects/roll";

export async function rollChildren(
	ctx: PluginContext,
	settings: Settings,
	opts: RollOptions,
): Promise<RollResult[]> {
	const results: RollResult[] = [];
	for (const row of await listProjectRows(ctx)) {
		const url = str(row.data.url);
		if (!url || !isUlid(row.id)) continue;
		if (opts.project && row.id !== opts.project) continue;
		results.push(await rollOne(ctx, settings, row, url, opts));
	}
	return results;
}

async function rollOne(
	ctx: PluginContext,
	settings: Settings,
	row: { id: string; data: Record<string, unknown> },
	url: string,
	opts: RollOptions,
): Promise<RollResult> {
	const id = row.id;
	const rn = resourceName(id);
	const label = str(row.data.label) || id;
	const theme = str(row.data.theme);
	const out: RollResult = { project: id, label, url, ok: true, steps: {} };
	const token = await platformToken(ctx, id);

	for (const step of opts.steps) {
		try {
			out.steps[step] = await runStep(ctx, settings, step, {
				id,
				rn,
				label,
				theme,
				url,
				token,
				row,
			});
		} catch (err) {
			out.ok = false;
			out.steps[step] = `error: ${err instanceof Error ? err.message : String(err)}`;
			ctx.log.error(`[premiumcms-projects] roll ${step} failed for ${id}`, out.steps[step]);
		}
	}

	if (opts.cascade) {
		if (!token) {
			out.children = { skipped: "no platform token" };
		} else {
			const r = await childApi(ctx, url, token, "POST", ROLL_PATH, {
				steps: opts.steps,
				cascade: true,
			});
			const body = r.json<{ data?: { results?: RollResult[]; skipped?: string } }>();
			if (!r.ok) out.children = { skipped: `roll ${r.status}` };
			else if (body.data?.skipped) out.children = { skipped: body.data.skipped };
			else out.children = body.data?.results ?? [];
		}
	}
	return out;
}

interface Target {
	id: string;
	rn: string;
	label: string;
	theme: string;
	url: string;
	token: string;
	row: { id: string; data: Record<string, unknown> };
}

async function runStep(
	ctx: PluginContext,
	settings: Settings,
	step: RollStep,
	t: Target,
): Promise<string> {
	switch (step) {
		case "bundle":
			return rollBundle(ctx, settings, t);
		case "plugins":
			return rollPlugins(ctx, t);
		case "seed":
			return rollSeed(ctx, settings, t);
		case "frontend":
			return rollFrontend(ctx, settings, t);
		case "theme":
			return rollTheme(ctx, settings, t);
	}
}

async function rollBundle(ctx: PluginContext, settings: Settings, t: Target): Promise<string> {
	const creds = credsOf(settings);
	const d1Id = await findD1IdByName(ctx, creds, `${t.rn}-db`);
	const kvId = await findKvIdByName(ctx, creds, `${t.rn}-session`);
	if (!d1Id || !kvId) throw new Error("child resources not found");
	const bindings = projectBindings(
		t.rn,
		{ d1_id: d1Id, kv_id: kvId, bucket: `${t.rn}-media`, label: t.label },
		settings,
	);
	// Keep the static-frontend proxy target: a deploy replaces the whole
	// binding set, and without FRONTEND_ORIGIN the site falls back to the
	// "not set up yet" placeholder.
	const owner = str(await ctx.kv.get(`github:owner:${t.id}`));
	const repo = str(await ctx.kv.get(`github:repo:${t.id}`));
	if (owner && repo) {
		bindings.push({
			type: "plain_text",
			name: "FRONTEND_ORIGIN",
			text: `https://${owner.toLowerCase()}.github.io/${repo}`,
		});
	}
	const res = await deployService<{ version?: string }>(ctx, settings, "/api/v1/deploy", {
		accountId: settings.cfAccountId,
		apiToken: settings.cfApiToken,
		script: t.rn,
		theme: settings.instanceBundle,
		version: "latest",
		bindings,
		cron: "* * * * *",
	});
	return `deployed ${settings.instanceBundle}@${res.version ?? "latest"}`;
}

async function rollPlugins(ctx: PluginContext, t: Target): Promise<string> {
	if (!t.token) throw new Error("no platform token");
	const list = await childApi(ctx, t.url, t.token, "GET", "/_emdash/api/admin/plugins/updates");
	if (!list.ok) throw new Error(`updates ${list.status}`);
	const items =
		list.json<{ data?: { items?: Array<{ pluginId?: string; latestVersion?: string }> } }>().data
			?.items ?? [];
	let updated = 0;
	const failed: string[] = [];
	for (const it of items) {
		if (!it.pluginId) continue;
		const r = await childApi(
			ctx,
			t.url,
			t.token,
			"POST",
			`/_emdash/api/admin/plugins/${encodeURIComponent(it.pluginId)}/update`,
			{
				version: it.latestVersion,
				confirmCapabilityChanges: true,
				confirmRouteVisibilityChanges: true,
				confirmMcpTools: true,
			},
		);
		if (r.ok) updated++;
		else failed.push(`${it.pluginId} ${r.status}`);
	}
	if (failed.length) throw new Error(`updated ${updated}, failed: ${failed.join(", ")}`);
	return `updated ${updated} of ${items.length}`;
}

async function rollSeed(ctx: PluginContext, settings: Settings, t: Target): Promise<string> {
	if (!t.token) throw new Error("no platform token");
	// A theme is a repo: its seed.json is the source of truth. Projects that
	// are themselves themes are the source, not a copy — skip them.
	if (t.theme && !t.row.data.is_theme) {
		const applied = await applyThemeSeed(ctx, settings, t.id, t.url, t.theme);
		if (applied) return applied;
	}
	const r = await childApi(ctx, t.url, t.token, "POST", "/_emdash/api/settings/reseed", {});
	if (!r.ok) throw new Error(`reseed ${r.status}: ${r.text.slice(0, 120)}`);
	const d = r.json<{ data?: Record<string, { created?: number; updated?: number }> }>().data ?? {};
	const c = Object.values(d).reduce((n, v) => n + (v?.created ?? 0), 0);
	const u = Object.values(d).reduce((n, v) => n + (v?.updated ?? 0), 0);
	return `seed applied (${c} created, ${u} updated)`;
}

async function rollFrontend(ctx: PluginContext, settings: Settings, t: Target): Promise<string> {
	const gh = str(await ctx.kv.get(`github:token:${t.id}`));
	const owner = str(await ctx.kv.get(`github:owner:${t.id}`));
	const repo = str(await ctx.kv.get(`github:repo:${t.id}`));
	if (!gh || !owner || !repo) return "skipped (frontend not connected)";
	const template = templateForTheme(settings.githubFrontendTemplate, t.theme);
	if (!template) throw new Error(`no frontend template for theme "${t.theme}"`);
	const sync = await syncTemplate(ctx, gh, template, owner, repo);
	if (!sync.ok) throw new Error(sync.error || "template sync failed");
	if (sync.changed > 0) await dispatchRebuild(ctx, gh, owner, repo);
	return sync.changed > 0 ? `synced ${sync.changed} file(s), rebuilding` : "up to date";
}

async function rollTheme(ctx: PluginContext, settings: Settings, t: Target): Promise<string> {
	if (t.row.data.is_theme) return publishTheme(ctx, settings, t.row);
	const gh = str(await ctx.kv.get(`github:token:${t.id}`));
	if (!gh) return "skipped (frontend not connected)";
	const r = await publishSeed(ctx, settings, t.row);
	return `seed published (${r.files} files) to ${r.owner}/${r.repo}`;
}

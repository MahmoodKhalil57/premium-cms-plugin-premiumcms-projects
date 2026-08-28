/**
 * Stateless provisioner: "provision and forget". Everything a child needs is
 * named deterministically from the content row's id (a ULID), so nothing is
 * stored on the parent side — the content row (its `url` field) is the only
 * persistent state.
 *
 *   resourceName(id) = "p" + id.toLowerCase()   → the 27-char resource stem
 *   worker script  = rn
 *   D1 database    = `${rn}-db`
 *   KV namespace   = `${rn}-session`
 *   R2 bucket      = `${rn}-media`
 *   hostname       = `${rn}.${zone}`
 *
 * `provisionAll` runs the whole pipeline (create/lookup resources → deploy →
 * attach domain → seed credits → bootstrap owner → write the url back) in ONE
 * invocation, driven by the tick (which has a full subrequest budget). Every
 * step is idempotent (create-or-lookup, overwrite-on-deploy, tolerate
 * "already"), so a failure just leaves `url` empty and the next tick retries.
 *
 * The golden bundle itself is uploaded by the trusted marketplace deploy
 * service; this plugin supplies the per-project bindings and the provider's
 * Cloudflare credentials.
 */

import type { PluginContext } from "@premium-cms/emdash/plugin";
import {
	cfApi,
	cfZoneId,
	d1Query,
	deployService,
	findD1IdByName,
	findKvIdByName,
	resolveZone,
} from "./cf.js";
import { pushCreditsSettings, seedInitialCredits } from "./credits.js";
import { COLLECTION } from "./content.js";
import { mintPlatformToken } from "./platform.js";
import { applyThemeSeed } from "./themes.js";
import { credsOf, siteZone, type Settings } from "./settings.js";

/** ULID: 26 Crockford base32 chars (no I, L, O, U), case-insensitive. */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

/** Deterministic resource stem for a content row id — `p` + lowercased ULID. */
export function resourceName(contentId: string): string {
	return `p${contentId.toLowerCase()}`;
}

/** Guard: the content id must look like a ULID before we name resources from it. */
export function isUlid(id: string): boolean {
	return typeof id === "string" && ULID_RE.test(id);
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * The transient, in-memory provisioning object. Lives only for the duration of
 * one `provisionAll` call — there is no kv registry. The step functions fill in
 * `d1_id` / `kv_id` / `bucket` as they go.
 */
export interface Provision {
	id: string;
	rn: string;
	label: string;
	theme: string;
	zone: string;
	hostname: string;
	d1_id?: string;
	kv_id?: string;
	bucket?: string;
}

/* ------------------------------------------------------------------ */
/* Bindings                                                            */
/* ------------------------------------------------------------------ */

/**
 * The child Worker's binding set — mirrors the known-good apex instance. The
 * names are the contract the golden bundle expects.
 */
export function projectBindings(
	rn: string,
	state: {
		d1_id?: string | null;
		kv_id?: string | null;
		bucket?: string | null;
		label: string;
	},
	settings: Settings,
): unknown[] {
	const bindings: unknown[] = [
		{ type: "d1", name: "DB", id: state.d1_id },
		{ type: "kv_namespace", name: "SESSION", namespace_id: state.kv_id },
		{ type: "r2_bucket", name: "MEDIA", bucket_name: state.bucket },
		{ type: "images", name: "IMAGES" },
		{ type: "worker_loader", name: "LOADER" },
		{ type: "assets", name: "ASSETS" },
		{ type: "send_email", name: "EMAIL" },
		// Self service-binding: the instance's scheduled() handler loops back to
		// its own (public) provisioning tick through this — a Worker's subrequest
		// to its own custom domain does not reliably loop back. Present on every
		// instance so any of them can act as a control plane once configured.
		{ type: "service", name: "SELF", service: rn },
	];
	// Fallback email provider credentials, read by the theme's trusted
	// fallback-email provider from env. Only when a fallback is configured.
	if (settings.emailAccountId && settings.emailApiToken && settings.emailFrom) {
		bindings.push(
			{ type: "secret_text", name: "EMAIL_FALLBACK_ACCOUNT_ID", text: settings.emailAccountId },
			{ type: "secret_text", name: "EMAIL_FALLBACK_API_TOKEN", text: settings.emailApiToken },
			{ type: "secret_text", name: "EMAIL_FALLBACK_FROM", text: settings.emailFrom },
			{ type: "secret_text", name: "EMAIL_FALLBACK_FROM_NAME", text: state.label || "PremiumCMS" },
		);
	}
	return bindings;
}

/* ------------------------------------------------------------------ */
/* Steps (transient — no kv reads/writes)                              */
/* ------------------------------------------------------------------ */

/** CF: create (or look up, when they already exist) the D1 DB, KV namespace and R2 bucket. */
export async function createResources(
	ctx: PluginContext,
	settings: Settings,
	p: Provision,
): Promise<Provision> {
	const creds = credsOf(settings);
	const dbName = `${p.rn}-db`;
	const kvTitle = `${p.rn}-session`;
	const bucketName = `${p.rn}-media`;

	const d1 = await cfApi<{ uuid: string }>(ctx, creds, "POST", "/d1/database", { name: dbName });
	let d1Id: string | null = d1.result?.uuid ?? null;
	if (!d1.success || !d1Id) {
		d1Id = await findD1IdByName(ctx, creds, dbName);
		if (!d1Id) throw new Error(`d1 create failed: ${JSON.stringify(d1.errors)}`);
	}

	const kv = await cfApi<{ id: string }>(ctx, creds, "POST", "/storage/kv/namespaces", {
		title: kvTitle,
	});
	let kvId: string | null = kv.result?.id ?? null;
	if (!kv.success || !kvId) {
		kvId = await findKvIdByName(ctx, creds, kvTitle);
		if (!kvId) throw new Error(`kv create failed: ${JSON.stringify(kv.errors)}`);
	}

	const r2 = await cfApi(ctx, creds, "POST", "/r2/buckets", { name: bucketName });
	if (!r2.success && !JSON.stringify(r2.errors).includes("already exists"))
		throw new Error(`r2 create failed: ${JSON.stringify(r2.errors)}`);

	p.d1_id = d1Id;
	p.kv_id = kvId;
	p.bucket = bucketName;
	return p;
}

/** Deploy service: upload the golden bundle for this project with its bindings. */
export async function deployWorker(
	ctx: PluginContext,
	settings: Settings,
	p: Provision,
): Promise<Provision> {
	if (!p.d1_id || !p.kv_id) throw new Error("resources not created yet");
	await deployService(ctx, settings, "/api/v1/deploy", {
		accountId: settings.cfAccountId,
		apiToken: settings.cfApiToken,
		script: p.rn,
		// Every instance runs the same golden bundle; the theme is a repo + seed.
		theme: settings.instanceBundle,
		version: "latest",
		bindings: projectBindings(p.rn, p, settings),
		cron: "* * * * *",
	});
	return p;
}

/** CF: bind the assigned `<rn>.<zone>` hostname to the project's Worker. */
export async function attachDomain(
	ctx: PluginContext,
	settings: Settings,
	p: Provision,
): Promise<Provision> {
	const creds = credsOf(settings);
	const zoneId = await cfZoneId(
		ctx,
		creds,
		p.zone || (await resolveZone(ctx, creds, siteZone(ctx))).name,
	);
	const res = await cfApi(ctx, creds, "PUT", "/workers/domains", {
		zone_id: zoneId,
		hostname: p.hostname,
		service: p.rn,
		environment: "production",
	});
	if (!res.success && !JSON.stringify(res.errors).includes("already"))
		throw new Error(`domain attach failed: ${JSON.stringify(res.errors)}`);
	return p;
}

/**
 * (a) Poke the child's root once so its first-boot migrations + auto-seed run,
 * then (b) insert the owner user + the setup-complete option straight into the
 * child's D1. Both statements are idempotent, so re-running is safe.
 */
export async function bootstrapOwner(
	ctx: PluginContext,
	settings: Settings,
	p: Provision,
	ownerEmail: string,
): Promise<Provision> {
	if (!p.d1_id) throw new Error("d1 not created yet");
	const creds = credsOf(settings);

	// (a) Trigger first boot. Ignore the result — a cold worker may 5xx once.
	try {
		if (ctx.http) await ctx.http.fetch(`https://${p.hostname}/`, { method: "GET" });
	} catch {
		// non-fatal — the D1 writes below create the rows regardless
	}

	const now = new Date().toISOString();
	const email = (ownerEmail || settings.ownerEmail || "").trim();
	if (!email) throw new Error("no owner email — set ownerEmail in Settings");
	const userId = ulid();

	const insUser = await d1Query(
		ctx,
		creds,
		p.d1_id,
		"INSERT OR IGNORE INTO users (id,email,name,role,role_id,email_verified,disabled,created_at,updated_at) VALUES (?, ?, ?, 50, 'role:admin', 0, 0, ?, ?)",
		[userId, email, p.label, now, now],
	);
	if (!insUser.success) throw new Error(`owner insert failed: ${JSON.stringify(insUser.errors)}`);

	const insOpt = await d1Query(
		ctx,
		creds,
		p.d1_id,
		"INSERT INTO options (name,value) VALUES ('emdash:setup_complete','true') ON CONFLICT(name) DO UPDATE SET value='true'",
	);
	if (!insOpt.success)
		throw new Error(`setup-complete option failed: ${JSON.stringify(insOpt.errors)}`);

	// The parent's service token into this child (plugin updates, reseed, the
	// recursive roll). Minted last so the owner row it binds to exists.
	await mintPlatformToken(ctx, creds, p.d1_id, p.id, email);

	return p;
}

/* ------------------------------------------------------------------ */
/* One-shot provisioning                                               */
/* ------------------------------------------------------------------ */

/**
 * Provision a single project end-to-end in one invocation. Returns the live
 * URL, which the caller has already written back to the row (this function does
 * the write itself, as step 6). Throws on any failure — the caller leaves the
 * row's `url` empty so the next tick retries from scratch (every step is
 * idempotent, so a retry converges).
 */
export async function provisionAll(
	ctx: PluginContext,
	settings: Settings,
	row: { id: string; data: Record<string, unknown> },
): Promise<string> {
	const id = row.id;
	if (!isUlid(id)) throw new Error(`content id "${id}" is not a ULID — cannot name resources`);
	const rn = resourceName(id);
	const zone = (await resolveZone(ctx, credsOf(settings), siteZone(ctx))).name;
	const p: Provision = {
		id,
		rn,
		label: str(row.data.label).trim() || id,
		theme: str(row.data.theme),
		zone,
		hostname: `${rn}.${zone}`,
	};

	// 1. resources → 2. deploy → 3. domain
	await createResources(ctx, settings, p);
	await deployWorker(ctx, settings, p);
	await attachDomain(ctx, settings, p);

	// 4. seed the child's credits: price book / markup / enforcement / project
	//    id / top-up target, then the initial balance.
	if (!p.d1_id) throw new Error("d1 not created");
	await pushCreditsSettings(ctx, settings, p.d1_id, id, `https://${p.hostname}`);
	await seedInitialCredits(ctx, settings, p.d1_id, id, Number(row.data.starting_credits) || 0);

	// 5. bootstrap the owner admin into the child instance.
	const ownerEmail = str(row.data.owner_email) || settings.ownerEmail;
	await bootstrapOwner(ctx, settings, p, ownerEmail);

	// 6. the theme's seed (its repo's seed.json), best-effort: a missing or
	//    unreachable seed leaves a blank site rather than a failed provision.
	const url = `https://${rn}.${zone}`;
	try {
		const applied = await applyThemeSeed(ctx, settings, id, url, p.theme);
		if (applied) ctx.log.info(`[premiumcms-projects] ${id}: ${applied}`);
	} catch (err) {
		ctx.log.warn(`[premiumcms-projects] ${id}: theme seed not applied`, err);
	}

	// 7. write back ONLY the url (also the "already provisioned" marker).
	if (ctx.content?.update) await ctx.content.update(COLLECTION, id, { url });
	return url;
}

/* ------------------------------------------------------------------ */
/* Teardown                                                            */
/* ------------------------------------------------------------------ */

/**
 * Tear a project down by deterministic name, derived from the row id. Idempotent
 * and best-effort: ignores not-found, collects removed/warnings rather than
 * aborting on the first failure. Order: custom domain(s) → worker → R2 bucket
 * (via the deploy service — unbounded object count) → KV namespace → D1 database.
 */
export async function destroyProject(
	ctx: PluginContext,
	settings: Settings,
	id: string,
): Promise<{ removed: string[]; warnings: string[] }> {
	const rn = resourceName(id);
	const creds = credsOf(settings);
	const removed: string[] = [];
	const warnings: string[] = [];

	// Custom domain(s) bound to this worker (service === rn).
	const wd = await cfApi<Array<{ id: string; hostname: string; service: string }>>(
		ctx,
		creds,
		"GET",
		"/workers/domains",
	);
	for (const d of wd.result ?? []) {
		if (d.service !== rn) continue;
		const r = await cfApi(ctx, creds, "DELETE", `/workers/domains/${d.id}`);
		if (r.success) removed.push(`domain ${d.hostname}`);
		else warnings.push(`domain ${d.hostname}: ${JSON.stringify(r.errors)}`);
	}

	// Worker script.
	const ws = await cfApi(ctx, creds, "DELETE", `/workers/scripts/${rn}?force=true`);
	if (ws.success) removed.push("worker");
	else warnings.push(`worker: ${JSON.stringify(ws.errors)}`);

	// R2 bucket (purge + delete via the deploy service — unbounded object count).
	try {
		const r = await deployService<{ purged?: number; deleted?: boolean }>(
			ctx,
			settings,
			"/api/v1/destroy-bucket",
			{ accountId: settings.cfAccountId, apiToken: settings.cfApiToken, bucket: `${rn}-media` },
		);
		removed.push(`R2 bucket${typeof r.purged === "number" ? ` (${r.purged} objects purged)` : ""}`);
	} catch (err) {
		warnings.push(`R2 bucket: ${err instanceof Error ? err.message : String(err)}`);
	}

	// KV namespace (name → id → delete).
	const kvId = await findKvIdByName(ctx, creds, `${rn}-session`);
	if (kvId) {
		const kv = await cfApi(ctx, creds, "DELETE", `/storage/kv/namespaces/${kvId}`);
		if (kv.success) removed.push("KV namespace");
		else warnings.push(`KV: ${JSON.stringify(kv.errors)}`);
	}

	// D1 database (name → id → delete).
	const d1Id = await findD1IdByName(ctx, creds, `${rn}-db`);
	if (d1Id) {
		const d1 = await cfApi(ctx, creds, "DELETE", `/d1/database/${d1Id}`);
		if (d1.success) removed.push("D1 database");
		else warnings.push(`D1: ${JSON.stringify(d1.errors)}`);
	}

	return { removed, warnings };
}

/* ------------------------------------------------------------------ */
/* ULID (Crockford base32, time + randomness) — a unique text id       */
/* ------------------------------------------------------------------ */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulid(): string {
	let time = Date.now();
	const timeChars: string[] = [];
	for (let i = 0; i < 10; i++) {
		timeChars.unshift(CROCKFORD[time % 32]);
		time = Math.floor(time / 32);
	}
	const rand = new Uint8Array(16);
	crypto.getRandomValues(rand);
	let randStr = "";
	for (let i = 0; i < 16; i++) randStr += CROCKFORD[rand[i] % 32];
	return timeChars.join("") + randStr;
}

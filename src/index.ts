/**
 * Projects (provider) — provisions fully isolated EmDash instances on
 * Cloudflare. STATELESS, "provision and forget", child-side metering.
 *
 * A row in the `projects` collection (created by a seed elsewhere) is the only
 * persistent state. Its id is a ULID, and EVERY Cloudflare resource is named
 * deterministically from it (`resourceName(id) = "p" + id`), so nothing needs
 * to be stored on the parent side — no kv registry. The row's `url` field
 * doubles as the "already provisioned" marker: empty ⇒ still to do, set ⇒ done.
 *
 * The per-minute `tick` route (driven by the instance's scheduled handler, so
 * it has a full subrequest budget) provisions ONE pending row per tick end to
 * end — create/lookup D1 + KV + R2, deploy the golden bundle with its bindings,
 * attach `<rn>.<zone>`, seed the child's credits options + initial balance, and
 * bootstrap the owner admin — then writes the live url back. `content:afterSave`
 * only handles operator credit top-ups (it has no subrequest budget to
 * provision); `content:afterDelete` tears every resource down by name.
 * Metering now happens INSIDE each child (a core credits middleware) — there is
 * no parent-side CF-analytics sync.
 *
 * This is a TRUSTED, in-process plugin loaded via a theme's
 * `plugins: [premiumcmsProjects()]` config; its factory `createPlugin` returns
 * a `definePlugin(...)` result. Settings are declared with `admin.settingsSchema`
 * and rendered by the admin's auto-generated form (Plugins → Projects →
 * Settings), writing to the same `settings:` kv prefix `readSettings` reads.
 */

import type {
	PluginAdminConfig,
	PluginContext,
	PluginDescriptor,
	ResolvedPlugin,
} from "@premium-cms/emdash";
import { definePlugin } from "@premium-cms/emdash";

/** The admin settings-schema map type (`Record<string, SettingField>`). */
type SettingsSchema = NonNullable<PluginAdminConfig["settingsSchema"]>;

import { COLLECTION, fieldsOf, listProjectRows } from "./content.js";
import {
	destroyProject,
	isUlid,
	projectBindings,
	provisionAll,
	resourceName,
} from "./provisioner.js";
import { type Settings, credsOf, readSettings, siteZone, validate } from "./settings.js";
import { grantCredits, pushCreditsSettings } from "./credits.js";
import { checkoutSessionIdFromEvent, createCheckout, retrieveCheckoutSession } from "./stripe.js";
import {
	authorizeUrl,
	canPush,
	createFromTemplate,
	dispatchRebuild,
	enablePages,
	exchangeCode,
	parseRepoUrl,
	setSecret,
	templateForTheme,
	whoami,
} from "./github.js";
import { authorToken, createPluginListing, listThemes } from "./marketplace.js";
import { publishTheme, themeRepo } from "./themes.js";
import { ROLL_STEPS, rollChildren, type RollStep } from "./roll.js";
import { applyCanonicalUrl, applyPlatformDomain } from "./platform-domain.js";
import {
	cfZoneId,
	d1Query,
	deployService,
	findD1IdByName,
	findKvIdByName,
	resolveZone,
} from "./cf.js";
import {
	createCustomHostname,
	deleteCustomHostname,
	findCustomHostname,
	isActive,
	mapDomain,
	normalizeDomain,
	recordsFor,
	unmapDomain,
} from "./domains.js";

const STEP_TIMEOUT_MS = 60_000; // one Cloudflare-round-trip budget per step

const str = (v: unknown): string => (typeof v === "string" ? v : "");

// ─── Trust contract ──────────────────────────────────────────────
// `network:request` (not `network:request:unrestricted`) pins ctx.http to
// `allowedHosts`: the Cloudflare API token and the marketplace deploy key are
// the most sensitive values here, so egress is limited to the Cloudflare API,
// the marketplace deploy service, and provisioned child instances under the
// platform zone. `content:read`/`content:write` let the plugin read the
// Projects collection rows and mirror provisioning status back into them.
const CAPABILITIES = ["network:request", "content:read", "content:write"] as const;
const ALLOWED_HOSTS = [
	"api.cloudflare.com",
	"api.stripe.com",
	"api.github.com",
	"github.com",
	"marketplace.premium-cms.com",
	"*.premium-cms.com",
];

/**
 * Declarative settings schema. The admin auto-generates the settings form at
 * `/_emdash/admin/plugins-manager/premiumcms-projects/settings` from this, and
 * persists each field under the `settings:` kv prefix — exactly where
 * `readSettings` (settings.ts) reads them. The field keys MUST match what
 * `readSettings` looks up.
 */
// Only the two Cloudflare credentials are the site owner's to enter. The zone
// is derived from the site's canonical URL (Settings → General), and the deploy
// key / marketplace URL / owner email are set up behind the scenes on a
// platform instance — so they are deliberately not on this form.
const SETTINGS_SCHEMA: SettingsSchema = {
	cfAccountId: {
		type: "string",
		label: "Cloudflare Account ID",
		description: "32 hex characters, from your Cloudflare dashboard.",
	},
	cfApiToken: {
		type: "secret",
		label: "Cloudflare API Token",
		description: "A token with Workers, D1, R2, KV and Workers Routes permissions.",
	},
	emailAccountId: {
		type: "string",
		label: "Fallback email — Cloudflare Account ID",
		description:
			"Optional. A Cloudflare account with Email Sending onboarded, used as the fallback email provider for provisioned instances so magic-link login works out of the box.",
	},
	emailApiToken: {
		type: "secret",
		label: "Fallback email — Cloudflare API Token",
		description: "A token with Email:Send on the account above.",
	},
	emailFrom: {
		type: "email",
		label: "Fallback email — Send from",
		description: "e.g. cms@send.premium-cms.com (its domain must be onboarded for Email Sending).",
	},
	stripeSecretKey: {
		type: "secret",
		label: "Stripe secret key",
		description:
			"Optional. Lets child projects buy hosting credits with a card. Starts sk_live_… or sk_test_…",
	},
	stripeWebhookSecret: {
		type: "secret",
		label: "Stripe webhook signing secret",
		description:
			"The whsec_… secret for a webhook at …/api/plugins/premiumcms-projects/billingWebhook (checkout.session.completed).",
	},
	creditsMarkup: {
		type: "number",
		label: "Cost-plus markup",
		description:
			"Multiplier on the underlying Cloudflare cost billed to each child (e.g. 2 = 100% margin).",
		default: 2,
	},
	creditsEnforce: {
		type: "boolean",
		label: "Meter + enforce credits",
		description: "When on, children are metered and suspended once their credits run out.",
		default: false,
	},
	githubAppId: {
		type: "string",
		label: "GitHub App ID",
		description:
			"For static-frontend hosting: provisions a GitHub repo (Astro frontend + seed) built to GitHub Pages instead of hosting the frontend on Cloudflare.",
	},
	githubClientId: {
		type: "string",
		label: "GitHub App client ID",
		description: "The App's client id (Iv1.… / Iv23…).",
	},
	githubClientSecret: {
		type: "secret",
		label: "GitHub App client secret",
		description: "The App's client secret (OAuth user-authorization flow).",
	},
	githubPrivateKey: {
		type: "secret",
		label: "GitHub App private key (PEM)",
		description:
			"The App's private key — required to mint installation tokens for automated repo / Pages / secret setup. Paste the full -----BEGIN…END----- PEM.",
	},
	githubInstallUrl: {
		type: "url",
		label: "GitHub App install URL",
		description:
			"e.g. https://github.com/apps/premium-cms — where a customer installs the App on their account.",
	},
	githubFrontendTemplate: {
		type: "string",
		label: "Fallback frontend template repo (owner/repo)",
		description:
			"Used only when a theme has no repository on the marketplace: a GitHub template repo (the frontend-static tooling + a theme) a project's site repo is generated from. Plain owner/repo, or a JSON map by theme.",
	},
	pluginTemplate: {
		type: "string",
		label: "Plugin starter template (owner/repo)",
		description:
			"The GitHub template repo 'Create and fork plugin' generates new plugin repos from. It ships the publish workflow.",
	},
	instanceBundle: {
		type: "string",
		label: "Instance bundle",
		description:
			"The golden bundle every provisioned instance runs (themes are repos + seeds, not bundles). Default: instance.",
	},
	marketplaceSeedToken: {
		type: "secret",
		label: "Marketplace publisher token",
		description:
			"The marketplace's trusted-publisher token — lets this control plane register projects marked 'Is theme / demo' as marketplace themes.",
	},
};

/**
 * One provisioning tick: provision the FIRST pending Projects row (empty `url`,
 * with a `label` + `theme`) end to end, one per tick to bound the work. Runs in
 * a fresh invocation (the `tick` route, driven by the instance's own scheduled
 * handler) so it has a full subrequest budget — unlike `content:afterSave`,
 * which shares the content-save request's exhausted budget. On any error the
 * row's `url` is left empty, so the next tick retries (provisioning is
 * idempotent). Rows whose `url` is already set are done and skipped.
 */
async function runProvisionTick(
	ctx: PluginContext,
): Promise<{ provisioned: number; error?: string }> {
	const settings = await readSettings(ctx);
	if (!validate(settings).ok) return { provisioned: 0 };

	const rows = await listProjectRows(ctx);

	// This control plane's own origin is baked into every child (top-up,
	// connect-GitHub and custom-domain URLs all point back here). When our
	// parent moves us to a new home, re-push those so the children follow.
	const origin = (ctx.site?.url ?? "").replace(/\/$/, "");
	const known = str(await ctx.kv.get("self:url"));
	if (origin && origin !== known) {
		for (const row of rows) {
			if (!str(row.data.url) || !isUlid(row.id)) continue;
			try {
				const d1Id = await findD1IdByName(ctx, credsOf(settings), `${resourceName(row.id)}-db`);
				if (d1Id) await pushCreditsSettings(ctx, settings, d1Id, row.id, str(row.data.url));
			} catch (err) {
				ctx.log.warn(`[premiumcms-projects] re-push parent url to ${row.id} failed`, err);
			}
		}
		await ctx.kv.set("self:url", origin);
		if (known)
			ctx.log.info(`[premiumcms-projects] parent origin ${known} -> ${origin}: children updated`);
	}

	for (const row of rows) {
		if (str(row.data.url)) continue; // provisioned already → done
		if (!str(row.data.label) || !str(row.data.theme)) continue; // not ready to provision
		if (!isUlid(row.id)) {
			ctx.log.warn(`[premiumcms-projects] row ${row.id} is not a ULID — skipping`);
			continue;
		}
		try {
			await provisionAll(ctx, settings, row);
			return { provisioned: 1 }; // one project per tick — bound the work
		} catch (err) {
			// Leave `url` empty so the next tick retries from scratch.
			const message = err instanceof Error ? err.message : String(err);
			ctx.log.error(`[premiumcms-projects] provision of ${row.id} failed`, message);
			return { provisioned: 0, error: message }; // one heavy op per tick, even on failure
		}
	}
	return { provisioned: 0 };
}

/**
 * Build a provisioned project's managed static frontend and flip its proxy on:
 * generate the customer's GitHub repo from the template, wire the backend↔CI
 * preview secret + build secrets, enable Pages + a first build, redeploy the
 * child worker with `FRONTEND_ORIGIN` pointing at the Pages URL, and record the
 * enabled status + the owner token (kept for later rebuilds). Throws on a hard
 * failure so the OAuth callback can report it. SITE_URL is the child's own
 * canonical domain — the proxy serves the build at the domain root, so its
 * links resolve with base "/".
 */
async function enableFrontend(
	ctx: PluginContext,
	settings: Settings,
	project: string,
	token: string,
	owner: string,
): Promise<string> {
	const creds = credsOf(settings);
	const rn = resourceName(project);
	const d1Id = await findD1IdByName(ctx, creds, `${rn}-db`);
	if (!d1Id) throw new Error("child D1 not found — is the project provisioned?");
	const kvId = await findKvIdByName(ctx, creds, `${rn}-session`);
	const zone = (await resolveZone(ctx, creds, siteZone(ctx))).name;
	const backendUrl = `https://${rn}.${zone}`;
	const repo = `site-${project.toLowerCase()}`;
	const row = ctx.content?.get ? await ctx.content.get(COLLECTION, project) : null;
	const rowData = (row?.data ?? {}) as Record<string, unknown>;
	const label = str(rowData.label);
	const theme = str(rowData.theme) || "marketing";

	// A theme is a repo: the site repo is generated from the marketplace theme's
	// repository. The settings map is only a fallback for themes without one.
	const fromMarketplace = await themeRepo(ctx, settings, theme).catch(() => null);
	const template = fromMarketplace
		? `${fromMarketplace.owner}/${fromMarketplace.repo}`
		: templateForTheme(settings.githubFrontendTemplate, theme);
	if (!template) throw new Error(`theme "${theme}" has no repository to copy the frontend from`);

	const gen = await createFromTemplate(ctx, token, template, owner, repo, label || project);
	if (!gen.ok) throw new Error(gen.error || "repo create failed");

	const previewSecret = `prev_${crypto.randomUUID().replace(/-/g, "")}`;
	await d1Query(
		ctx,
		creds,
		d1Id,
		"INSERT INTO options (name,value) VALUES ('emdash:preview_secret', ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
		[JSON.stringify(previewSecret)],
	);

	for (const [name, value] of [
		["BACKEND_URL", backendUrl],
		["SITE_URL", backendUrl],
		["EMDASH_PREVIEW_SECRET", previewSecret],
		["SEED_SECRET", settings.deployKey],
	] as Array<[string, string]>) {
		const r = await setSecret(ctx, token, owner, repo, name, value);
		if (!r.ok) ctx.log.warn(`[premiumcms-projects] secret ${name}: ${r.error}`);
	}

	await enablePages(ctx, token, owner, repo);
	await dispatchRebuild(ctx, token, owner, repo);
	const pagesUrl = `https://${owner.toLowerCase()}.github.io/${repo}`;

	// Redeploy the child worker with the proxy target so the public site starts
	// serving the Pages build. Every binding is re-supplied (the deploy replaces
	// the set); FRONTEND_ORIGIN is the new one.
	const bindings = [
		...projectBindings(rn, { d1_id: d1Id, kv_id: kvId, bucket: `${rn}-media`, label }, settings),
		{ type: "plain_text", name: "FRONTEND_ORIGIN", text: pagesUrl },
	];
	await deployService(ctx, settings, "/api/v1/deploy", {
		accountId: settings.cfAccountId,
		apiToken: settings.cfApiToken,
		script: rn,
		theme: settings.instanceBundle,
		version: "latest",
		bindings,
		cron: "* * * * *",
	});

	await d1Query(
		ctx,
		creds,
		d1Id,
		"INSERT INTO options (name,value) VALUES ('frontend:enabled','true') ON CONFLICT(name) DO UPDATE SET value='true'",
	);
	// "View site" points at the CANONICAL domain (served at the root through the
	// proxy), not the raw github.io URL — that only resolves at the domain root
	// because the build uses base "/".
	await d1Query(
		ctx,
		creds,
		d1Id,
		"INSERT INTO options (name,value) VALUES ('frontend:pages_url', ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
		[JSON.stringify(backendUrl)],
	);
	// Where the site lives on GitHub — shown on the child's dashboard.
	await d1Query(
		ctx,
		creds,
		d1Id,
		"INSERT INTO options (name,value) VALUES ('frontend:repo_url', ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
		[JSON.stringify(`https://github.com/${owner}/${repo}`)],
	);
	await ctx.kv.set(`github:token:${project}`, token);
	await ctx.kv.set(`github:owner:${project}`, owner);
	await ctx.kv.set(`github:repo:${project}`, repo);
	return pagesUrl;
}

// ─── Plugin Descriptor (for a theme's `plugins: [...]` config) ───

/**
 * Descriptor consumed by `plugins: [premiumcmsProjects()]`. `entrypoint` is
 * the package name; the runtime imports `createPlugin` from its `main` to
 * build the resolved plugin. No `adminPages`/`adminWidgets`: settings are the
 * declarative `settingsSchema` form, so there is no custom admin page.
 */
export function premiumcmsProjects(): PluginDescriptor {
	return {
		id: "premiumcms-projects",
		version: "0.1.0",
		entrypoint: "@premium-cms/plugin-premiumcms-projects",
		capabilities: [...CAPABILITIES],
		allowedHosts: ALLOWED_HOSTS,
	};
}

// ─── Plugin Implementation ───────────────────────────────────────

export function createPlugin(): ResolvedPlugin {
	return definePlugin({
		id: "premiumcms-projects",
		version: "0.1.0",
		capabilities: [...CAPABILITIES],
		allowedHosts: ALLOWED_HOSTS,

		hooks: {
			"plugin:install": {
				handler: async (_event, ctx) => {
					ctx.log.info(
						"Projects (provider) installed — add Cloudflare credentials + the deploy key on its settings page, then create a Projects row.",
					);
				},
			},

			/**
			 * Operator credit top-up. Fires for every content save; acts only on the
			 * `projects` collection. When a provisioned row (its `url` is set) is
			 * saved with a positive `add_credits`, grant that many dollars into the
			 * child's ledger and clear the input. Provisioning itself is NOT done
			 * here — afterSave runs inside the content-save request and has no
			 * subrequest budget for the CF API calls; the tick owns that.
			 *
			 * The child's D1 is resolved with NO stored state: rn = resourceName(id),
			 * then the D1 uuid is looked up by the name `${rn}-db`. Clearing
			 * add_credits re-saves with add_credits=null, so there is no loop.
			 */
			"content:afterSave": {
				timeout: STEP_TIMEOUT_MS,
				handler: async (event, ctx) => {
					if (event.collection !== COLLECTION) return;
					if (!ctx.content?.update) return;

					const fields = fieldsOf(event.content);
					const id = str((event.content as Record<string, unknown>).id);
					const addCredits = Number(fields.add_credits);

					// Only act on provisioned rows (url set).
					if (!str(fields.url) || !id || !isUlid(id)) return;

					const settings = await readSettings(ctx);
					if (!validate(settings).ok) return;

					// Platform-zone hostname: reconcile what the operator asked for with
					// what is attached to the child's Worker. A rejected value is
					// cleared so the row never claims a hostname it doesn't hold.
					if ("domain" in fields) {
						try {
							const { url, changes } = await applyPlatformDomain(
								ctx,
								settings,
								id,
								str(fields.domain),
								await listProjectRows(ctx),
							);
							if (changes.length)
								ctx.log.info(`[premiumcms-projects] domain ${id}: ${changes.join(", ")}`);
							// The row's url is how this control plane reaches the child.
							if (str(fields.url) !== url) await ctx.content.update(COLLECTION, id, { url });
						} catch (err) {
							const message = err instanceof Error ? err.message : String(err);
							ctx.log.error(`[premiumcms-projects] domain for ${id} rejected: ${message}`);
							if (str(fields.domain)) await ctx.content.update(COLLECTION, id, { domain: null });
						}
					}

					// "Is theme / demo": publish this project as a marketplace theme —
					// its seed into its repo, the repo as a template, the listing.
					if (fields.is_theme) {
						try {
							const done = await publishTheme(ctx, settings, { id, data: fields });
							ctx.log.info(`[premiumcms-projects] theme ${id}: ${done}`);
						} catch (err) {
							ctx.log.warn(
								`[premiumcms-projects] theme ${id} not published yet: ${err instanceof Error ? err.message : String(err)}`,
							);
						}
					}

					if (!Number.isFinite(addCredits) || addCredits <= 0) return;

					try {
						const rn = resourceName(id);
						const d1Id = await findD1IdByName(ctx, credsOf(settings), `${rn}-db`);
						if (!d1Id) {
							ctx.log.warn(`[premiumcms-projects] add-credits: no D1 for ${id} (${rn}-db)`);
							return;
						}
						const micros = Math.round(addCredits * 1_000_000);
						await grantCredits(
							ctx,
							settings,
							d1Id,
							micros,
							`operator:${id}:${Date.now()}`,
							"Operator credit (parent admin)",
						);
						// Clear the action input. This re-save carries add_credits=null.
						await ctx.content.update(COLLECTION, id, { add_credits: null });
					} catch (err) {
						ctx.log.error(`[premiumcms-projects] operator top-up for ${id} failed`, err);
					}
				},
			},

			/**
			 * Teardown on delete. When a `projects` row is deleted, tear down every
			 * Cloudflare resource named from its id (worker, custom domain, D1, KV,
			 * R2 bucket) by deterministic name. Idempotent and best-effort — ignores
			 * not-found and never throws out of the hook. The event carries only the
			 * id (no data), which is all we need: names derive from it.
			 */
			"content:afterDelete": {
				timeout: STEP_TIMEOUT_MS,
				handler: async (event, ctx) => {
					if (event.collection !== COLLECTION) return;
					if (!isUlid(event.id)) return;
					try {
						const settings = await readSettings(ctx);
						if (!validate(settings).ok) return;
						const { removed, warnings } = await destroyProject(ctx, settings, event.id);
						ctx.log.info(
							`[premiumcms-projects] torn down ${event.id}: removed [${removed.join(", ")}]` +
								(warnings.length ? ` warnings [${warnings.join("; ")}]` : ""),
						);
					} catch (err) {
						ctx.log.error(`[premiumcms-projects] teardown for ${event.id} failed`, err);
					}
				},
			},
		},

		routes: {
			/**
			 * Provisioning tick — provisions ONE pending project per call. Public so
			 * any instance's scheduled() handler can drive it via a SELF service
			 * binding without minting a per-instance admin token: it only advances
			 * projects an admin already queued (empty-`url` rows), is idempotent and
			 * bounded to one project per call, and no-ops unless Cloudflare
			 * credentials are configured — so a stray public trigger can at most run
			 * the maintenance that runs every minute anyway. Each call is a fresh
			 * invocation with a full subrequest budget (unlike afterSave). Metering
			 * lives inside each child, so there is no parent-side billing pass.
			 */
			tick: {
				public: true,
				handler: async (ctx) => {
					const prov = await runProvisionTick(ctx);
					return { success: true, ...prov };
				},
			},

			/**
			 * Public credit-checkout endpoint. A child instance's "add credits"
			 * button proxies here with its project id + amount; we create a Stripe
			 * hosted Checkout Session and return its URL. Public because the caller
			 * is an unauthenticated child Worker — the project id must resolve to a
			 * real provisioned project, and payment itself is authenticated by
			 * Stripe. No credits are granted here; that happens on the webhook.
			 */
			billingCheckout: {
				public: true,
				handler: async (ctx) => {
					const settings = await readSettings(ctx);
					if (!settings.stripeSecretKey) {
						return { success: false, error: "Card top-ups are not enabled for this host." };
					}
					// The runtime already parsed the request body and exposes it as
					// ctx.input (ctx.request.json() would throw).
					const body = (ctx.input ?? {}) as {
						projectId?: unknown;
						amount?: unknown;
						returnUrl?: unknown;
					};
					const projectId = typeof body.projectId === "string" ? body.projectId : "";
					const amount = Number(body.amount);
					if (!projectId || !isUlid(projectId) || !Number.isFinite(amount) || amount <= 0) {
						return {
							success: false,
							error: "A valid projectId and a positive amount are required.",
						};
					}
					// Stateless: the child sends its own row id. Resolve its resources by
					// name to confirm it is a real provisioned project, and read its label
					// (for the line-item title) from the content row.
					const rn = resourceName(projectId);
					const d1Id = await findD1IdByName(ctx, credsOf(settings), `${rn}-db`);
					if (!d1Id) return { success: false, error: "Unknown project." };
					const row = ctx.content?.get ? await ctx.content.get(COLLECTION, projectId) : null;
					const label = row ? str((row.data as Record<string, unknown>).label) : "";
					const returnUrl =
						typeof body.returnUrl === "string" && body.returnUrl
							? body.returnUrl
							: (row ? str((row.data as Record<string, unknown>).url) : "") || `https://${rn}`;
					try {
						const { url } = await createCheckout(ctx, settings, {
							projectId,
							email: "",
							title: label || projectId,
							amountCents: Math.round(amount * 100),
							returnUrl,
						});
						return { success: true, checkoutUrl: url };
					} catch (err) {
						ctx.log.error("[premiumcms-projects] checkout failed", err);
						return {
							success: false,
							error: err instanceof Error ? err.message : "Checkout failed.",
						};
					}
				},
			},

			/**
			 * Public Stripe webhook. Verifies the signature against the configured
			 * signing secret, then grants the purchased credits into the paying
			 * child's ledger. Idempotent: the Stripe session id is the ledger ref,
			 * so a redelivered event does not double-credit.
			 */
			billingWebhook: {
				public: true,
				handler: async (ctx) => {
					const settings = await readSettings(ctx);
					if (!settings.stripeSecretKey) {
						return { success: false, error: "Stripe not configured." };
					}
					// The runtime consumed the body into ctx.input, so we cannot HMAC
					// the raw bytes. Instead we re-fetch the session from Stripe with
					// our secret key: that both authenticates the event and confirms
					// it was paid. Idempotent via the ledger ref (`stripe:<session>`).
					const sessionId = checkoutSessionIdFromEvent(ctx.input);
					if (!sessionId) return { success: true, ignored: true };
					try {
						const session = await retrieveCheckoutSession(ctx, settings, sessionId);
						if (session.paymentStatus !== "paid") return { success: true, ignored: true };
						if (!session.projectId || !isUlid(session.projectId) || session.creditsMicros <= 0) {
							return { success: false, error: "Session is missing project/credits metadata." };
						}
						// Stateless: resolve the paying child's D1 by deterministic name.
						const rn = resourceName(session.projectId);
						const d1Id = await findD1IdByName(ctx, credsOf(settings), `${rn}-db`);
						if (!d1Id) return { success: false, error: "Unknown project." };
						await grantCredits(
							ctx,
							settings,
							d1Id,
							session.creditsMicros,
							`stripe:${session.id}`,
							"Stripe top-up",
							{ sessionId: session.id },
						);
						return { success: true };
					} catch (err) {
						ctx.log.error("[premiumcms-projects] webhook grant failed", err);
						return { success: false, error: "Failed to process payment." };
					}
				},
			},

			/**
			 * Start the managed-frontend GitHub OAuth (redirect flow). The child's
			 * Settings → General "Connect GitHub" button links here with the child's
			 * `project` id and a `return` URL; both are stashed against the OAuth
			 * state and the browser is redirected to GitHub. Public — redirect only.
			 */
			githubAuthStart: {
				public: true,
				handler: async (ctx) => {
					const settings = await readSettings(ctx);
					if (!settings.githubClientId) {
						return { success: false, error: "GitHub is not configured on this platform." };
					}
					const url = new URL(ctx.request.url);
					const project = url.searchParams.get("project") ?? "";
					const ret = url.searchParams.get("return") ?? "";
					if (!isUlid(project)) return { success: false, error: "A valid project is required." };
					const state = `s_${crypto.randomUUID().replace(/-/g, "")}`;
					await ctx.kv.set(`github:oauth:${state}`, JSON.stringify({ project, ret }));
					const origin = (ctx.site?.url ?? "").replace(/\/$/, "");
					const redirectUri = `${origin}/_emdash/api/plugins/premiumcms-projects/githubCallback`;
					return { __redirect: authorizeUrl(settings, redirectUri, state) };
				},
			},

			/**
			 * GitHub OAuth callback: exchange the code for the customer's token, build
			 * their site's static frontend (repo + Pages), flip the child worker's
			 * proxy on, and redirect the browser back to the child admin. Public
			 * (GitHub redirects here with ?code&state).
			 */
			githubCallback: {
				public: true,
				handler: async (ctx) => {
					const settings = await readSettings(ctx);
					const url = new URL(ctx.request.url);
					const code = url.searchParams.get("code") ?? "";
					const state = url.searchParams.get("state") ?? "";
					const raw = state ? await ctx.kv.get<string>(`github:oauth:${state}`) : null;
					if (!code || !raw) {
						return { success: false, error: "Invalid or expired GitHub authorization." };
					}
					let project = "";
					let ret = "";
					try {
						const parsed = JSON.parse(raw) as { project?: unknown; ret?: unknown };
						project = typeof parsed.project === "string" ? parsed.project : "";
						ret = typeof parsed.ret === "string" ? parsed.ret : "";
					} catch {
						// falls through to the invalid-project guard below
					}
					await ctx.kv.set(`github:oauth:${state}`, ""); // one-time use
					if (!isUlid(project)) return { success: false, error: "Invalid project." };
					const backBase = /^https:\/\//.test(ret) ? ret : (ctx.site?.url ?? "").replace(/\/$/, "");
					const back = (status: string) =>
						`${backBase}${backBase.includes("?") ? "&" : "?"}frontend=${status}`;

					const token = await exchangeCode(ctx, settings, code);
					if (!token) return { __redirect: back("error") };
					const who = await whoami(ctx, token);
					if (!who?.login) return { __redirect: back("error") };
					try {
						await enableFrontend(ctx, settings, project, token, who.login);
						return { __redirect: back("connected") };
					} catch (err) {
						ctx.log.error(`[premiumcms-projects] enableFrontend for ${project} failed`, err);
						return { __redirect: back("error") };
					}
				},
			},

			/**
			 * Custom-domain setup/check for a provisioned instance (Cloudflare for
			 * SaaS). Called server-side by a child's core Settings → General route.
			 * Public because the caller is the instance backend, not an admin
			 * session; the project id must resolve to a real provisioned project.
			 * action=check ensures the custom hostname exists + maps it in the
			 * router KV + returns the records to add and the live status;
			 * action=reset removes the hostname + mapping.
			 */
			/**
			 * Options for the Projects form's "Copy from theme/demo" select: every
			 * marketplace theme (each one a project published as a repo + seed).
			 */
			themeOptions: {
				public: true,
				cacheControl: "public, max-age=60",
				handler: async (ctx) => {
					const settings = await readSettings(ctx);
					if (!settings.marketplaceUrl) return { options: [] };
					const themes = await listThemes(ctx, settings);
					return {
						options: themes.map((t) => ({
							value: t.id,
							label: t.description ? `${t.name} — ${t.description}` : t.name,
						})),
					};
				},
			},

			/**
			 * Create a plugin as a git repo for a project owner: generate it from
			 * the starter template into their connected GitHub account (or take an
			 * existing repo they can push to), give it a marketplace publish token
			 * as a repo secret, and register the listing. Every push to the repo
			 * then releases a version through its own workflow.
			 */
			pluginFork: {
				public: true,
				handler: async (ctx) => {
					const settings = await readSettings(ctx);
					if (!validate(settings).ok)
						return { success: false, error: "Plugins are not configured on this platform." };
					const body = (ctx.input ?? {}) as {
						project?: unknown;
						id?: unknown;
						name?: unknown;
						description?: unknown;
						repositoryUrl?: unknown;
					};
					const project = str(body.project);
					if (!isUlid(project)) return { success: false, error: "A valid project is required." };
					const id = str(body.id).trim().toLowerCase();
					if (!/^[a-z][a-z0-9-]{1,63}$/.test(id))
						return { success: false, error: "Plugin id: lowercase letters, numbers and hyphens." };
					const name = str(body.name).trim() || id;
					const gh = str(await ctx.kv.get(`github:token:${project}`));
					const owner = str(await ctx.kv.get(`github:owner:${project}`));
					if (!gh || !owner)
						return { success: false, error: "Connect GitHub in Settings → General first." };

					let repo: { owner: string; repo: string };
					const linked = str(body.repositoryUrl).trim();
					if (linked) {
						const parsed = parseRepoUrl(linked);
						if (!parsed)
							return { success: false, error: "Repository must be a GitHub URL (owner/repo)." };
						if (!(await canPush(ctx, gh, parsed.owner, parsed.repo)))
							return {
								success: false,
								error: `Your GitHub account can't push to ${parsed.owner}/${parsed.repo}.`,
							};
						repo = parsed;
					} else {
						const gen = await createFromTemplate(
							ctx,
							gh,
							settings.pluginTemplate,
							owner,
							`plugin-${id}`,
							name,
						);
						if (!gen.ok)
							return { success: false, error: gen.error || "Could not create the repo." };
						repo = { owner, repo: `plugin-${id}` };
					}

					const token = await authorToken(ctx, settings, owner);
					for (const [k, v] of [
						["MARKETPLACE_URL", settings.marketplaceUrl],
						["MARKETPLACE_TOKEN", token],
						["PLUGIN_ID", id],
					] as Array<[string, string]>) {
						const r = await setSecret(ctx, gh, repo.owner, repo.repo, k, v);
						if (!r.ok)
							return { success: false, error: `Could not store ${k} on the repo: ${r.error}` };
					}
					const repositoryUrl = `https://github.com/${repo.owner}/${repo.repo}`;
					const listing = await createPluginListing(ctx, settings, token, {
						id,
						name,
						description: str(body.description).trim() || undefined,
						repositoryUrl,
					});
					if (!listing.created && !linked) return { success: false, error: listing.error };
					return {
						success: true,
						id,
						repositoryUrl,
						listed: listing.created,
						note: listing.created ? undefined : listing.error,
					};
				},
			},

			customDomain: {
				public: true,
				handler: async (ctx) => {
					const settings = await readSettings(ctx);
					if (!validate(settings).ok) {
						return { success: false, error: "Custom domains are not configured on this platform." };
					}
					const body = (ctx.input ?? {}) as {
						project?: unknown;
						domain?: unknown;
						action?: unknown;
					};
					const project = str(body.project);
					if (!isUlid(project)) return { success: false, error: "A valid project is required." };
					const creds = credsOf(settings);
					const rn = resourceName(project);
					const zone = (await resolveZone(ctx, creds, siteZone(ctx))).name;
					const zoneId = await cfZoneId(ctx, creds, zone);
					const kvId = settings.customDomainsKvId;
					const backend = `${rn}.${zone}`;
					// "Default" = the platform hostname the parent assigned (row.domain),
					// else the instance's own p<ulid> hostname.
					const row = (await listProjectRows(ctx)).find((r) => r.id === project);
					const home = normalizeDomain(str(row?.data.domain)) || backend;
					const domain = normalizeDomain(str(body.domain));
					const action = str(body.action) || "check";

					if (action === "reset") {
						if (domain && domain !== home) {
							const ch = await findCustomHostname(ctx, creds, zoneId, domain);
							if (ch) await deleteCustomHostname(ctx, creds, zoneId, ch.id);
							if (kvId) await unmapDomain(ctx, creds, kvId, domain);
						}
						await applyCanonicalUrl(ctx, settings, project, `https://${home}`);
						return { success: true, reset: true, defaultUrl: `https://${home}` };
					}

					if (!domain) return { success: false, error: "A domain is required." };
					if (domain === zone || domain.endsWith(`.${zone}`)) {
						return {
							success: false,
							error: `${domain} is a platform domain and can't be added as a custom domain.`,
						};
					}
					let ch = await findCustomHostname(ctx, creds, zoneId, domain);
					if (!ch) ch = await createCustomHostname(ctx, creds, zoneId, domain);
					if (!ch) return { success: false, error: "Could not create the custom hostname." };
					if (kvId) await mapDomain(ctx, creds, kvId, domain, home);
					const active = isActive(ch);
					// Once live, the custom domain becomes the canonical origin and the
					// frontend is rebuilt with it.
					if (active) await applyCanonicalUrl(ctx, settings, project, `https://${domain}`);
					return {
						success: true,
						domain,
						status: ch.status,
						sslStatus: ch.ssl?.status ?? null,
						active,
						records: recordsFor(domain, ch),
					};
				},
			},

			/**
			 * Projects (from the content collection), for a custom admin screen. No
			 * registry any more: a row's `url` being set is what "provisioned" means.
			 */
			/**
			 * Roll every provisioned child forward (bundle / plugins / seed /
			 * frontend, see roll.ts) and cascade the same request down the tree.
			 * Admin-authenticated: CI calls the root with its platform token, and
			 * each parent calls its children with the tokens it minted for them.
			 * An instance that isn't a control plane answers `skipped`.
			 */
			roll: {
				handler: async (ctx) => {
					const settings = await readSettings(ctx);
					if (!validate(settings).ok) return { success: true, skipped: "not a control plane" };
					const body = (ctx.input ?? {}) as {
						steps?: unknown;
						cascade?: unknown;
						project?: unknown;
					};
					const wanted = Array.isArray(body.steps) ? body.steps.map(str) : [];
					const steps = (wanted.length ? wanted : [...ROLL_STEPS]).filter((s): s is RollStep =>
						(ROLL_STEPS as readonly string[]).includes(s),
					);
					const project = str(body.project) || undefined;
					if (project && !isUlid(project)) return { success: false, error: "invalid project" };
					const results = await rollChildren(ctx, settings, {
						steps,
						cascade: body.cascade !== false,
						project,
					});
					return { success: results.every((r) => r.ok), steps, results };
				},
			},

			projects: {
				handler: async (ctx) => {
					const rows = await listProjectRows(ctx);
					return {
						projects: rows.map((r) => ({
							id: r.id,
							label: str(r.data.label),
							theme: str(r.data.theme),
							url: str(r.data.url) || null,
							provisioned: Boolean(str(r.data.url)),
						})),
					};
				},
			},
		},

		admin: {
			settingsSchema: SETTINGS_SCHEMA,
		},
	});
}

export default premiumcmsProjects;

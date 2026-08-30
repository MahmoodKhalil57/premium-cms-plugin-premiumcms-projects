/**
 * Provider settings, stored in ctx.kv under the `settings:` prefix.
 *
 * Credentials come from the plugin's own settings page (Plugins → Projects →
 * Settings) rather than the Worker env: the Cloudflare API token and the
 * marketplace deploy key are the two secrets, so they get the same
 * empty-submit-keeps / "clear"-wipes treatment as any other secret field
 * (see cloudflare-email-byo). Non-secret text fields have sensible defaults.
 */

import type { PluginContext } from "@premium-cms/emdash/plugin";

export const KV_PREFIX = "settings:";

export const DEFAULT_MARKETPLACE_URL = "https://marketplace.premium-cms.com";

/** Cloudflare account IDs are 32 lowercase hex characters. */
const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/;

export interface Settings {
	/** Marketplace plugins installed into every new project (comma-separated ids). */
	defaultPlugins: string;
	/** User-configured, shown on the settings form. */
	cfAccountId: string;
	cfApiToken: string;
	/**
	 * Fallback email provider for provisioned children (shown on the form).
	 * A Cloudflare account with Email Sending onboarded for `emailFrom`'s
	 * domain, and a token with Email:Send. Provisioned instances get these as
	 * their cloudflare-email-byo settings so magic-link login works before the
	 * owner sets up their own email. Optional — skipped when blank.
	 */
	emailAccountId: string;
	emailApiToken: string;
	emailFrom: string;
	/**
	 * Cost-plus billing for provisioned children (shown on the form).
	 * `stripeSecretKey` / `stripeWebhookSecret` power self-serve credit top-ups;
	 * `creditsMarkup` multiplies the underlying Cloudflare cost; `creditsEnforce`
	 * turns on metering + suspend-when-empty on children.
	 */
	stripeSecretKey: string;
	stripeWebhookSecret: string;
	/** Key GitHub must present (`?key=`) on the App webhook URL; forwarded events go to the child that owns the repo. */
	githubWebhookSecret: string;
	creditsMarkup: number;
	creditsEnforce: boolean;
	/**
	 * GitHub App credentials for the static-frontend hosting mode: provision a
	 * GitHub repo (Astro frontend + seed), enable Pages, and set build secrets so
	 * the public site is a static GitHub Pages build (never hosted on Cloudflare).
	 * The App ID + client id/secret + install URL are public-ish; the private key
	 * (PEM) is the sensitive one — it's what mints installation tokens for
	 * automated repo/Pages/secret setup.
	 */
	githubAppId: string;
	githubClientId: string;
	githubClientSecret: string;
	githubPrivateKey: string;
	githubInstallUrl: string;
	/** owner/repo of the frontend-static template repo to generate project repos from. */
	githubFrontendTemplate: string;
	/** The `custom-domains` KV namespace id the router worker reads (platform-level). */
	customDomainsKvId: string;
	/** Marketplace trusted-publisher token (registers projects as themes). */
	marketplaceSeedToken: string;
	/** GitHub template repo (owner/repo) new plugins are generated from. */
	pluginTemplate: string;
	/** The golden bundle every instance runs (themes are repos, not bundles). */
	instanceBundle: string;
	/**
	 * Set up behind the scenes (not on the settings form) — the operator seeds
	 * these on a platform instance; the site owner only enters credentials above.
	 */
	marketplaceUrl: string;
	ownerEmail: string;
	deployKey: string;
}

/**
 * The Cloudflare zone new instances are provisioned under, derived from the
 * site's canonical URL (Settings → General → Site URL) rather than a plugin
 * field: the registrable domain (last two labels) of the site hostname.
 */
export function siteZone(ctx: PluginContext): string {
	const url = (ctx.site?.url ?? "").trim();
	if (!url) return "";
	try {
		const host = new URL(url).hostname;
		const labels = host.split(".").filter(Boolean);
		return labels.length >= 2 ? labels.slice(-2).join(".") : host;
	} catch {
		return "";
	}
}

/** Credential pair passed to the Cloudflare REST client. */
export interface CfCreds {
	accountId: string;
	apiToken: string;
}

export function credsOf(settings: Settings): CfCreds {
	return { accountId: settings.cfAccountId, apiToken: settings.cfApiToken };
}

function asString(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return Number.isFinite(n) ? n : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") return value === "true" || value === "1";
	return fallback;
}

/** Read settings from kv. Never throws — a failed read degrades to blanks/defaults. */
export async function readSettings(ctx: PluginContext): Promise<Settings> {
	try {
		const entries = await ctx.kv.list(KV_PREFIX);
		const map: Record<string, unknown> = {};
		for (const entry of entries) map[entry.key.replace(KV_PREFIX, "")] = entry.value;
		return {
			cfAccountId: asString(map.cfAccountId).trim().toLowerCase(),
			cfApiToken: asString(map.cfApiToken),
			emailAccountId: asString(map.emailAccountId).trim().toLowerCase(),
			emailApiToken: asString(map.emailApiToken),
			emailFrom: asString(map.emailFrom).trim(),
			stripeSecretKey: asString(map.stripeSecretKey),
			stripeWebhookSecret: asString(map.stripeWebhookSecret),
			githubWebhookSecret: asString(map.githubWebhookSecret),
			creditsMarkup: asNumber(map.creditsMarkup, 2),
			creditsEnforce: asBoolean(map.creditsEnforce, false),
			githubAppId: asString(map.githubAppId).trim(),
			githubClientId: asString(map.githubClientId).trim(),
			githubClientSecret: asString(map.githubClientSecret),
			githubPrivateKey: asString(map.githubPrivateKey),
			githubInstallUrl: asString(map.githubInstallUrl).trim(),
			githubFrontendTemplate: asString(map.githubFrontendTemplate).trim(),
			customDomainsKvId: asString(map.customDomainsKvId).trim(),
			marketplaceSeedToken: asString(map.marketplaceSeedToken).trim(),
	defaultPlugins: asString(map.defaultPlugins).trim() || "premium-github-agent, premium-cms-agent",
			pluginTemplate:
				asString(map.pluginTemplate).trim() || "MahmoodKhalil57/premium-cms-plugin-template",
			instanceBundle: asString(map.instanceBundle).trim() || "instance",
			marketplaceUrl: (asString(map.marketplaceUrl).trim() || DEFAULT_MARKETPLACE_URL).replace(
				/\/$/,
				"",
			),
			ownerEmail: asString(map.ownerEmail).trim(),
			deployKey: asString(map.deployKey),
		};
	} catch (error) {
		ctx.log.error("Failed to read settings", error);
		return {
			cfAccountId: "",
			cfApiToken: "",
			emailAccountId: "",
			emailApiToken: "",
			emailFrom: "",
			stripeSecretKey: "",
			stripeWebhookSecret: "",
			githubWebhookSecret: "",
			creditsMarkup: 2,
			creditsEnforce: false,
			githubAppId: "",
			githubClientId: "",
			githubClientSecret: "",
			githubPrivateKey: "",
			githubInstallUrl: "",
			githubFrontendTemplate: "",
			customDomainsKvId: "",
			marketplaceSeedToken: "",
			pluginTemplate: "MahmoodKhalil57/premium-cms-plugin-template",
			instanceBundle: "instance",
			marketplaceUrl: DEFAULT_MARKETPLACE_URL,
			ownerEmail: "",
			deployKey: "",
			defaultPlugins: "premium-github-agent, premium-cms-agent",
		};
	}
}

/**
 * Everything needed to provision, or a list of what is missing. Returned as a
 * discriminated union rather than throwing so both the hooks and the settings
 * page report the same reasons.
 */
export function validate(settings: Settings): { ok: true } | { ok: false; missing: string[] } {
	const missing: string[] = [];
	if (!settings.cfAccountId) missing.push("Cloudflare account ID");
	else if (!ACCOUNT_ID_RE.test(settings.cfAccountId))
		missing.push("a valid account ID (32 hex characters)");
	if (!settings.cfApiToken) missing.push("Cloudflare API token");
	if (!settings.deployKey) missing.push("marketplace deploy key");
	return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

// Note: this plugin is a TRUSTED, in-process plugin. Settings are written by
// the admin's declarative settings form (declared via `admin.settingsSchema`
// in index.ts), which persists each field under the `settings:` kv prefix —
// the same prefix `readSettings` reads. There is therefore no hand-rolled
// `saveSettings`/`redact` here anymore; the framework owns the write side.

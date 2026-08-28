/**
 * Cost-plus credits for provisioned child instances.
 *
 * Metering now happens INSIDE each child (a core credits middleware prices the
 * child's own Cloudflare usage against the price book seeded here). The parent
 * (this plugin) only:
 *   - seeds the child's `credits:*` options at provision time (price book,
 *     markup, enforcement flag, top-up target, the child's own project id), and
 *   - grants credits into the child's ledger (`_emdash_usage`, created by core
 *     migration 073) over the D1 API — the initial balance, operator top-ups,
 *     and Stripe purchases all land as negative-charge rows, so the child's
 *     balance is `-SUM(charge_micros)`.
 *
 * Everything is addressed by the child's D1 uuid, resolved from the row id via
 * `resourceName(id)` → `${rn}-db` → `findD1IdByName`. There is no parent-side
 * state and no parent-side CF-analytics metering.
 */

import type { PluginContext } from "@premium-cms/emdash/plugin";
import { d1Query, type CfResult } from "./cf.js";
import { credsOf, type CfCreds, type Settings } from "./settings.js";

/** Parent cost per unit in micro-dollars (1e-6 USD). */
export const BASE_PRICES: Record<string, number> = {
	"cf:request": 0.3,
	"cf:cpu_ms": 0.02,
	"cf:d1_rows_read": 0.001,
	"cf:d1_rows_written": 1,
	"cf:r2_class_a": 4.5,
	"cf:r2_class_b": 0.36,
	"cf:r2_gb_day": 0.5,
	"cf:egress_gb": 0,
};

export function priceBook(settings: Settings): { prices: Record<string, number>; markup: number } {
	const markup = settings.creditsMarkup > 1 ? settings.creditsMarkup : 2;
	return { prices: { ...BASE_PRICES }, markup };
}

/* ── child ledger access (over the D1 API) ─────────────────────────── */

export interface LedgerRow {
	kind: string;
	key: string;
	quantity: number;
	costMicros: number;
	chargeMicros: number;
	ref: string;
	day: string;
	meta?: Record<string, unknown>;
}

/** Append rows to a child's ledger; idempotent on `ref` (INSERT OR IGNORE). */
export async function childInsertUsage(
	ctx: PluginContext,
	creds: CfCreds,
	d1Id: string,
	rows: LedgerRow[],
): Promise<number> {
	if (rows.length === 0) return 0;
	// One statement for all rows: a busy child produces many rows and a
	// scheduled invocation has a small subrequest budget, so a per-row
	// round-trip would exhaust it and the tick would be cancelled.
	const tuple = "(?, datetime('now'), ?, ?, ?, ?, ?, ?, NULL, ?, 'parent', ?)";
	const params: unknown[] = [];
	for (const r of rows) {
		params.push(
			`u_${r.ref}`.slice(0, 120),
			r.day,
			r.kind,
			r.key,
			r.quantity,
			Math.round(r.costMicros),
			Math.round(r.chargeMicros),
			r.meta ? JSON.stringify(r.meta) : null,
			r.ref,
		);
	}
	const sql =
		"INSERT OR IGNORE INTO _emdash_usage (id, ts, day, kind, key, quantity, cost_micros, charge_micros, actor_id, meta, source, ref) VALUES " +
		rows.map(() => tuple).join(", ");
	const res = await d1Query(ctx, creds, d1Id, sql, params);
	return res.success ? rows.length : 0;
}

/** Upsert a single option into a child's `options` table. */
export async function childSetOption(
	ctx: PluginContext,
	creds: CfCreds,
	d1Id: string,
	name: string,
	value: unknown,
): Promise<void> {
	await d1Query(
		ctx,
		creds,
		d1Id,
		"INSERT INTO options (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
		[name, JSON.stringify(value)],
	);
}

/** Upsert several options in a single statement (fewer subrequests). */
export async function childSetOptions(
	ctx: PluginContext,
	creds: CfCreds,
	d1Id: string,
	entries: Array<[string, unknown]>,
): Promise<void> {
	if (entries.length === 0) return;
	const params: unknown[] = [];
	for (const [name, value] of entries) params.push(name, JSON.stringify(value));
	const sql =
		"INSERT INTO options (name, value) VALUES " +
		entries.map(() => "(?, ?)").join(", ") +
		" ON CONFLICT(name) DO UPDATE SET value = excluded.value";
	await d1Query(ctx, creds, d1Id, sql, params);
}

/** Read a child's current balance in micro-dollars (`-SUM(charge)`). */
export async function childBalanceMicros(
	ctx: PluginContext,
	creds: CfCreds,
	d1Id: string,
): Promise<number> {
	const res = await d1Query<Array<{ results?: Array<{ charged: number | null }> }>>(
		ctx,
		creds,
		d1Id,
		"SELECT COALESCE(SUM(charge_micros),0) AS charged FROM _emdash_usage",
	);
	const charged = res.result?.[0]?.results?.[0]?.charged ?? 0;
	return -(Number(charged) || 0);
}

/**
 * The parent's credit-checkout URL for a child's "add credits" button.
 */
function billingCheckoutUrl(ctx: PluginContext): string {
	return `${(ctx.site?.url ?? "").replace(/\/$/, "")}/_emdash/api/plugins/premiumcms-projects/billingCheckout`;
}

/**
 * Seed the price book, markup, enforcement flag, currency and top-up target
 * into a child's `options` table (at provision time). This is what makes the
 * child's own credits middleware meter at the right prices and its "add
 * credits" button reach back to the parent. `credits:project_id` (and the
 * legacy `billing:project_id`) let the child send its own id back to the
 * parent — the parent resolves the child's resources from that id alone.
 *
 * Does NOT touch `credits:balance_micros`; the balance is owned by grants
 * (`seedInitialCredits` / `grantCredits`), so re-pushing settings never resets it.
 */
export async function pushCreditsSettings(
	ctx: PluginContext,
	settings: Settings,
	d1Id: string,
	id: string,
	defaultUrl: string,
): Promise<void> {
	const creds = credsOf(settings);
	const book = priceBook(settings);
	const checkoutUrl = billingCheckoutUrl(ctx);
	// Per-write charge the child's self-metering middleware deducts on each
	// content/media mutation: a representative write ≈ 1 request + 4 D1 rows
	// written + 8 read, priced from the same book and markup.
	const perWriteMicros = Math.round(
		(book.prices["cf:request"] +
			4 * book.prices["cf:d1_rows_written"] +
			8 * book.prices["cf:d1_rows_read"]) *
			book.markup,
	);
	const parentOrigin = (ctx.site?.url ?? "").replace(/\/$/, "");
	await childSetOptions(ctx, creds, d1Id, [
		["credits:prices", book.prices],
		["credits:markup", book.markup],
		["credits:price_per_write_micros", perWriteMicros],
		["credits:enforce", settings.creditsEnforce],
		["credits:project_id", id],
		["credits:topup_url", checkoutUrl],
		["billing:parent_url", checkoutUrl],
		["billing:project_id", id],
		["billing:currency", "USD"],
		// Managed static-frontend hosting: the child's Settings → General
		// "Connect GitHub" button links here; the frontend stays disabled (a
		// placeholder) until this OAuth flow enables it.
		[
			"frontend:connect_url",
			`${parentOrigin}/_emdash/api/plugins/premiumcms-projects/githubAuthStart`,
		],
		[
			"custom_domain:api_url",
			`${parentOrigin}/_emdash/api/plugins/premiumcms-projects/customDomain`,
		],
		// Base of this control plane's plugin routes, for child features that
		// need the parent (plugin repo creation, …).
		["platform:api_url", `${parentOrigin}/_emdash/api/plugins/premiumcms-projects`],
		["custom_domain:default_url", defaultUrl],
		// The child's own origin, as the runtime sees it (plugin ctx.site.url,
		// outbound links, passkey rpId). The setup wizard would write this; a
		// provisioned instance never runs it.
		["emdash:site_url", defaultUrl],
	]);
}

/**
 * Seed a child's INITIAL credit balance (in dollars) at provision time. Writes
 * the balance option and, when positive, one negative-charge grant row keyed on
 * `initial:<id>` (idempotent). Always sets `credits:balance_micros` — even to 0
 * — so the child's enforcement middleware has a value to read.
 */
export async function seedInitialCredits(
	ctx: PluginContext,
	settings: Settings,
	d1Id: string,
	id: string,
	dollars: number,
): Promise<void> {
	const creds = credsOf(settings);
	const micros = Math.round((Number(dollars) || 0) * 1_000_000);
	if (micros > 0) {
		await childInsertUsage(ctx, creds, d1Id, [
			{
				kind: "credit",
				key: "credit:initial",
				quantity: 1,
				costMicros: 0,
				chargeMicros: -micros,
				ref: `initial:${id}`,
				day: new Date().toISOString().slice(0, 10),
				meta: { note: "Initial credits" },
			},
		]);
	}
	const balance = await childBalanceMicros(ctx, creds, d1Id);
	await childSetOption(ctx, creds, d1Id, "credits:balance_micros", balance);
}

/**
 * Add credits to a child (a top-up): a negative-charge ledger row addressed by
 * the child's D1 uuid. Idempotent on `ref` (a redelivered Stripe event or a
 * repeated operator save does not double-credit). Refreshes the cached balance
 * the enforcement middleware reads.
 */
export async function grantCredits(
	ctx: PluginContext,
	settings: Settings,
	d1Id: string,
	micros: number,
	ref: string,
	note: string,
	meta?: Record<string, unknown>,
): Promise<boolean> {
	if (!d1Id) throw new Error("project has no database");
	const creds = credsOf(settings);
	const day = new Date().toISOString().slice(0, 10);
	const n = await childInsertUsage(ctx, creds, d1Id, [
		{
			kind: "credit",
			key: "credit:purchase",
			quantity: 1,
			costMicros: 0,
			chargeMicros: -Math.abs(micros),
			ref,
			day,
			meta: { note, ...(meta ?? {}) },
		},
	]);
	const balance = await childBalanceMicros(ctx, creds, d1Id);
	await childSetOption(ctx, creds, d1Id, "credits:balance_micros", balance);
	return n > 0;
}

// Keep CfResult referenced for downstream type-only consumers.
export type { CfResult };

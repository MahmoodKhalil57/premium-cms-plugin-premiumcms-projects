/**
 * Stripe checkout + webhook for credit top-ups.
 *
 * The parent holds the Stripe keys (plugin settings). A child's "add credits"
 * button proxies to the parent's public `billingCheckout` route, which creates
 * a hosted Checkout Session priced in the requested amount and tagged with the
 * child's project id. When Stripe confirms payment it POSTs to the parent's
 * public `billingWebhook` route; we verify the signature, then grant the
 * credits into that child's ledger.
 */

import type { PluginContext } from "@premium-cms/emdash/plugin";
import { http } from "./cf.js";
import type { Settings } from "./settings.js";

type Params = Record<string, string | number | boolean | undefined>;

function encodeForm(params: Params): string {
	return Object.entries(params)
		.filter(([, v]) => v !== undefined)
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
		.join("&");
}

async function stripeApi<T>(
	ctx: PluginContext,
	settings: Settings,
	method: "GET" | "POST",
	path: string,
	params?: Params,
): Promise<T> {
	if (!settings.stripeSecretKey) throw new Error("Stripe is not configured");
	const body = params ? encodeForm(params) : undefined;
	const url =
		method === "GET" && body
			? `https://api.stripe.com/v1${path}?${body}`
			: `https://api.stripe.com/v1${path}`;
	const res = await http(ctx, url, {
		method,
		headers: {
			Authorization: `Bearer ${settings.stripeSecretKey}`,
			"Content-Type": "application/x-www-form-urlencoded",
			"Stripe-Version": "2024-06-20",
		},
		body: method === "POST" ? body : undefined,
	});
	const json = res.json<{ error?: { message?: string } } & T>();
	if (!res.ok) throw new Error(`Stripe: ${json.error?.message ?? `HTTP ${res.status}`}`);
	return json;
}

/**
 * Create a hosted Checkout Session for `amountCents` of credits for `projectId`.
 * The full amount becomes credits (the markup is already baked into usage
 * charges, so top-ups are 1:1). Returns the hosted checkout URL.
 */
export async function createCheckout(
	ctx: PluginContext,
	settings: Settings,
	opts: {
		projectId: string;
		email: string;
		title: string;
		amountCents: number;
		returnUrl: string;
	},
): Promise<{ url: string; sessionId: string }> {
	const successUrl = `${opts.returnUrl}${opts.returnUrl.includes("?") ? "&" : "?"}topup=success`;
	const cancelUrl = `${opts.returnUrl}${opts.returnUrl.includes("?") ? "&" : "?"}topup=cancelled`;
	const session = await stripeApi<{ id: string; url: string }>(
		ctx,
		settings,
		"POST",
		"/checkout/sessions",
		{
			mode: "payment",
			"line_items[0][price_data][currency]": "usd",
			"line_items[0][price_data][unit_amount]": opts.amountCents,
			"line_items[0][price_data][product_data][name]": `Hosting credits — ${opts.title}`,
			"line_items[0][quantity]": 1,
			customer_email: opts.email || undefined,
			"metadata[project]": opts.projectId,
			"metadata[credits_micros]": opts.amountCents * 10_000, // cents → micro-dollars
			"payment_intent_data[metadata][project]": opts.projectId,
			success_url: successUrl,
			cancel_url: cancelUrl,
		},
	);
	return { url: session.url, sessionId: session.id };
}

/** The bits of a Checkout Session we need to credit a paid top-up. */
export interface CheckoutSession {
	id: string;
	paymentStatus: string;
	projectId: string;
	creditsMicros: number;
}

/**
 * Retrieve a Checkout Session from Stripe by id. Used to verify a webhook: the
 * plugin runtime consumes the request body (exposing it as ctx.input), so the
 * raw bytes needed for HMAC signature verification are unavailable — instead we
 * re-fetch the session with our secret key, which both authenticates the event
 * (only we can read it) and confirms it was actually paid.
 */
export async function retrieveCheckoutSession(
	ctx: PluginContext,
	settings: Settings,
	sessionId: string,
): Promise<CheckoutSession> {
	const s = await stripeApi<{
		id: string;
		payment_status?: string;
		metadata?: Record<string, string>;
	}>(ctx, settings, "GET", `/checkout/sessions/${encodeURIComponent(sessionId)}`);
	return {
		id: s.id,
		paymentStatus: s.payment_status ?? "",
		projectId: s.metadata?.project ?? "",
		creditsMicros: Number(s.metadata?.credits_micros) || 0,
	};
}

/** Extract a completed-checkout session id from a Stripe event payload. */
export function checkoutSessionIdFromEvent(event: unknown): string | null {
	if (!event || typeof event !== "object") return null;
	const e = event as { type?: string; data?: { object?: { id?: string } } };
	if (e.type !== "checkout.session.completed") return null;
	return e.data?.object?.id ?? null;
}

/* ── Webhook signature verification (Stripe v1 scheme, HMAC-SHA256) ── */

function timingSafeEqualHex(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let out = 0;
	for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return out === 0;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Verify a Stripe-Signature header against the raw request body. Returns true
 * when a v1 signature matches within the tolerance window (default 5 min).
 */
export async function verifyStripeSignature(
	payload: string,
	sigHeader: string,
	secret: string,
	toleranceSec = 300,
): Promise<boolean> {
	if (!sigHeader || !secret) return false;
	const parts = Object.fromEntries(
		sigHeader.split(",").map((p) => {
			const [k, ...rest] = p.split("=");
			return [k.trim(), rest.join("=")];
		}),
	);
	const t = parts.t;
	const v1 = parts.v1;
	if (!t || !v1) return false;
	const age = Math.abs(Date.now() / 1000 - Number(t));
	if (!Number.isFinite(age) || age > toleranceSec) return false;
	const expected = await hmacSha256Hex(secret, `${t}.${payload}`);
	return timingSafeEqualHex(expected, v1);
}

/** Shape we care about from a `checkout.session.completed` event. */
export interface CheckoutCompleted {
	projectId: string;
	creditsMicros: number;
	sessionId: string;
}

/** Parse a verified Stripe event body; returns the completed top-up or null. */
export function parseCheckoutCompleted(body: string): CheckoutCompleted | null {
	let event: {
		type?: string;
		data?: { object?: { id?: string; metadata?: Record<string, string> } };
	};
	try {
		event = JSON.parse(body) as typeof event;
	} catch {
		return null;
	}
	if (event.type !== "checkout.session.completed") return null;
	const obj = event.data?.object;
	const meta = obj?.metadata ?? {};
	const projectId = meta.project;
	const creditsMicros = Number(meta.credits_micros);
	if (!projectId || !Number.isFinite(creditsMicros) || creditsMicros <= 0) return null;
	return { projectId, creditsMicros, sessionId: obj?.id ?? "" };
}

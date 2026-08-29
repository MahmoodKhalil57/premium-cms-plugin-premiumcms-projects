/**
 * GitHub App integration for the static-frontend hosting mode.
 *
 * A project's public site is a static build on GitHub Pages (never Cloudflare):
 * this module, using an OAuth **user** access token (the customer authorizes the
 * premium-cms App once), creates the frontend repo in the customer's account,
 * pushes the frontend-static tooling + the project's seed, sets the build
 * secrets, enables Pages, and can trigger rebuilds via repository_dispatch.
 *
 * Why a user token (not an installation token): GitHub Apps can only create
 * repos in ORGS, not personal accounts — but an App *user* token can (verified).
 * Config is written as Actions *secrets* (encrypted); Actions *variables* are
 * not writable by the App token, so everything goes through secrets.
 *
 * Crypto: GitHub secrets require a libsodium sealed box. Cloudflare Workers
 * block runtime WASM, so we use pure-JS tweetnacl + blakejs (verified accepted).
 */

import nacl from "tweetnacl";
import { blake2b } from "blakejs";

import { http } from "./cf.js";
import type { PluginContext } from "@premium-cms/emdash/plugin";
import type { Settings } from "./settings.js";

const GH = "https://api.github.com";

interface GhResult {
	status: number;
	ok: boolean;
	json<T = Record<string, unknown>>(): T;
	text: string;
}

/** Authenticated GitHub REST call over ctx.http (pinned to api.github.com). */
async function gh(
	ctx: PluginContext,
	token: string,
	method: string,
	path: string,
	body?: unknown,
): Promise<GhResult> {
	const res = await http(ctx, `${GH}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			"User-Agent": "premium-cms",
			"X-GitHub-Api-Version": "2022-11-28",
			...(body !== undefined ? { "Content-Type": "application/json" } : {}),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return {
		status: res.status,
		ok: res.ok,
		text: res.text,
		json<T = Record<string, unknown>>(): T {
			try {
				return JSON.parse(res.text) as T;
			} catch {
				return {} as T;
			}
		},
	};
}

/* ── OAuth (redirect flow) ─────────────────────────────────────────── */

/** The URL to send a customer to so they authorize the App on their account. */
export function authorizeUrl(settings: Settings, redirectUri: string, state: string): string {
	const p = new URLSearchParams({
		client_id: settings.githubClientId,
		redirect_uri: redirectUri,
		state,
	});
	return `https://github.com/login/oauth/authorize?${p.toString()}`;
}

/** Exchange an OAuth `code` for a user access token. */
export async function exchangeCode(
	ctx: PluginContext,
	settings: Settings,
	code: string,
): Promise<string | null> {
	const res = await http(ctx, "https://github.com/login/oauth/access_token", {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json" },
		body: JSON.stringify({
			client_id: settings.githubClientId,
			client_secret: settings.githubClientSecret,
			code,
		}),
	});
	const data = res.json<{ access_token?: string }>();
	return data.access_token ?? null;
}

/* ── Provisioning primitives ───────────────────────────────────────── */

/** crypto_box_seal (libsodium) in pure JS, for GitHub Actions secrets. */
function sealBox(message: Uint8Array, recipientPk: Uint8Array): Uint8Array {
	const eph = nacl.box.keyPair();
	const nonce = blake2b(new Uint8Array([...eph.publicKey, ...recipientPk]), undefined, 24);
	const boxed = nacl.box(message, nonce, recipientPk, eph.secretKey);
	const out = new Uint8Array(eph.publicKey.length + boxed.length);
	out.set(eph.publicKey);
	out.set(boxed, eph.publicKey.length);
	return out;
}

const toB64 = (u8: Uint8Array): string => btoa(String.fromCharCode(...u8));
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export interface GithubUser {
	login: string;
}

/** The authenticated user (repo owner). */
export async function whoami(ctx: PluginContext, token: string): Promise<GithubUser | null> {
	const r = await gh(ctx, token, "GET", "/user");
	if (!r.ok) return null;
	return r.json<GithubUser>();
}

/** Create the frontend repo from the platform's template repo (all files in one call). */
export async function createFromTemplate(
	ctx: PluginContext,
	token: string,
	template: string, // "owner/repo"
	owner: string,
	name: string,
	description: string,
): Promise<{ ok: boolean; error?: string }> {
	const [tOwner, tRepo] = template.split("/");
	if (!tOwner || !tRepo) return { ok: false, error: "frontendTemplate must be owner/repo" };
	const r = await gh(ctx, token, "POST", `/repos/${tOwner}/${tRepo}/generate`, {
		owner,
		name,
		description,
		private: false,
		include_all_branches: false,
	});
	if (r.ok || r.status === 201) return { ok: true };
	if (r.status === 422 && r.text.includes("already exists")) return { ok: true }; // idempotent
	return { ok: false, error: `generate ${r.status}: ${r.text.slice(0, 150)}` };
}

/** Commit a set of text files to the repo's default branch (git Trees API). */
export async function pushFiles(
	ctx: PluginContext,
	token: string,
	owner: string,
	repo: string,
	files: Array<{ path: string; content: string | null; encoding?: "utf-8" | "base64" }>,
	message: string,
	branch = "main",
): Promise<{ ok: boolean; error?: string }> {
	const ref = await gh(ctx, token, "GET", `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
	if (!ref.ok) return { ok: false, error: `ref ${ref.status}` };
	const baseSha = ref.json<{ object: { sha: string } }>().object.sha;
	const baseCommit = await gh(ctx, token, "GET", `/repos/${owner}/${repo}/git/commits/${baseSha}`);
	const baseTree = baseCommit.json<{ tree: { sha: string } }>().tree.sha;

	const tree: Array<{ path: string; mode: string; type: string; sha: string | null }> = [];
	for (const f of files) {
		// `content: null` deletes the path.
		if (f.content === null) {
			tree.push({ path: f.path, mode: "100644", type: "blob", sha: null });
			continue;
		}
		const blob = await gh(ctx, token, "POST", `/repos/${owner}/${repo}/git/blobs`, {
			content: f.content,
			encoding: f.encoding ?? "utf-8",
		});
		if (!blob.ok) return { ok: false, error: `blob ${f.path}: ${blob.status}` };
		tree.push({
			path: f.path,
			mode: "100644",
			type: "blob",
			sha: blob.json<{ sha: string }>().sha,
		});
	}
	const treeRes = await gh(ctx, token, "POST", `/repos/${owner}/${repo}/git/trees`, {
		base_tree: baseTree,
		tree,
	});
	if (!treeRes.ok) return { ok: false, error: `tree ${treeRes.status}` };
	const commit = await gh(ctx, token, "POST", `/repos/${owner}/${repo}/git/commits`, {
		message,
		tree: treeRes.json<{ sha: string }>().sha,
		parents: [baseSha],
	});
	if (!commit.ok) return { ok: false, error: `commit ${commit.status}` };
	const upd = await gh(ctx, token, "PATCH", `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
		sha: commit.json<{ sha: string }>().sha,
	});
	return upd.ok
		? { ok: true }
		: { ok: false, error: `ref update ${upd.status}: ${upd.text.slice(0, 120)}` };
}

/** Set an encrypted Actions secret (sealed box). */
export async function setSecret(
	ctx: PluginContext,
	token: string,
	owner: string,
	repo: string,
	name: string,
	value: string,
): Promise<{ ok: boolean; error?: string }> {
	const pkRes = await gh(ctx, token, "GET", `/repos/${owner}/${repo}/actions/secrets/public-key`);
	if (!pkRes.ok) return { ok: false, error: `public-key ${pkRes.status}` };
	const pk = pkRes.json<{ key: string; key_id: string }>();
	const enc = toB64(sealBox(new TextEncoder().encode(value), fromB64(pk.key)));
	const r = await gh(ctx, token, "PUT", `/repos/${owner}/${repo}/actions/secrets/${name}`, {
		encrypted_value: enc,
		key_id: pk.key_id,
	});
	return r.status === 201 || r.status === 204
		? { ok: true }
		: { ok: false, error: `secret ${r.status}` };
}

/** Enable GitHub Pages with the GitHub Actions build type. */
export async function enablePages(
	ctx: PluginContext,
	token: string,
	owner: string,
	repo: string,
): Promise<{ ok: boolean; url?: string }> {
	let r = await gh(ctx, token, "POST", `/repos/${owner}/${repo}/pages`, { build_type: "workflow" });
	if (r.status === 409) {
		r = await gh(ctx, token, "PUT", `/repos/${owner}/${repo}/pages`, { build_type: "workflow" });
	}
	const info = await gh(ctx, token, "GET", `/repos/${owner}/${repo}/pages`);
	const url = info.ok ? info.json<{ html_url?: string }>().html_url : undefined;
	return { ok: r.ok || r.status === 204 || r.status === 409, url };
}

/** Trigger a rebuild of the static site. */
export async function dispatchRebuild(
	ctx: PluginContext,
	token: string,
	owner: string,
	repo: string,
): Promise<boolean> {
	const r = await gh(ctx, token, "POST", `/repos/${owner}/${repo}/dispatches`, {
		event_type: "content-published",
	});
	return r.status === 204;
}

/* ── Template resolution + re-sync ─────────────────────────────────── */

/**
 * Resolve the frontend template repo (`owner/repo`) for a theme. `spec` is
 * either a plain `owner/repo` used for every theme, or a JSON map
 * `{"<theme>":"owner/repo", "*":"owner/repo"}` with an optional `*` fallback.
 */
export function templateForTheme(spec: string, theme: string): string {
	const s = (spec || "").trim();
	if (!s) return "";
	if (s.startsWith("{")) {
		try {
			const map = JSON.parse(s) as Record<string, unknown>;
			const hit = map[theme] ?? map["*"];
			return typeof hit === "string" ? hit : "";
		} catch {
			return "";
		}
	}
	return s;
}

interface TreeEntry {
	path: string;
	type: string;
	sha: string;
}

async function repoTree(
	ctx: PluginContext,
	token: string,
	ownerRepo: string,
): Promise<Map<string, string> | null> {
	const r = await gh(ctx, token, "GET", `/repos/${ownerRepo}/git/trees/HEAD?recursive=1`);
	if (!r.ok) return null;
	const out = new Map<string, string>();
	for (const e of r.json<{ tree?: TreeEntry[] }>().tree ?? []) {
		if (e.type === "blob") out.set(e.path, e.sha);
	}
	return out;
}

/** The build tooling a template repo owns in every site repo generated from it. */
const TOOLING_PATHS = /^(bin\/|\.github\/workflows\/|tests\/ci\/)/;
/**
 * Tooling the platform has retired: removed from site repos when present.
 * The static site is built by the platform (GitHub Agent plugin → container)
 * and served from `static/<default branch>`, so the Actions workflow is gone.
 */
const TOOLING_REMOVED = [".github/workflows/deploy.yml", "bin/apply-seed.mjs"];

/**
 * Copy the template repo's build tooling into a site repo: every tooling path
 * whose blob differs (or is missing) is committed. Everything else — seed,
 * content, sources, config — belongs to the site (a theme's repo IS its
 * source) and is never touched. Returns how many files changed.
 */
export async function syncTemplate(
	ctx: PluginContext,
	token: string,
	template: string, // "owner/repo"
	owner: string,
	repo: string,
): Promise<{ ok: boolean; changed: number; error?: string }> {
	const src = await repoTree(ctx, token, template);
	if (!src) return { ok: false, changed: 0, error: `template ${template} unreadable` };
	const dst = (await repoTree(ctx, token, `${owner}/${repo}`)) ?? new Map<string, string>();

	const files: Array<{ path: string; content: string; encoding: "base64" }> = [];
	for (const [path, sha] of src) {
		if (!TOOLING_PATHS.test(path) || dst.get(path) === sha) continue;
		const blob = await gh(ctx, token, "GET", `/repos/${template}/git/blobs/${sha}`);
		if (!blob.ok) return { ok: false, changed: 0, error: `blob ${path}: ${blob.status}` };
		const content = blob.json<{ content?: string }>().content ?? "";
		files.push({ path, content: content.replace(/\n/g, ""), encoding: "base64" });
	}
	const removals = TOOLING_REMOVED.filter((path) => dst.has(path) && !src.has(path));
	if (files.length === 0 && removals.length === 0) return { ok: true, changed: 0 };
	const push = await pushFiles(
		ctx,
		token,
		owner,
		repo,
		[...files, ...removals.map((path) => ({ path, content: null }))],
		"chore: sync frontend template",
	);
	return push.ok
		? { ok: true, changed: files.length + removals.length }
		: { ok: false, changed: 0, error: push.error };
}

/* ── Repo metadata + raw files ─────────────────────────────────────── */

/** Mark (or unmark) a repo as a GitHub template so others can generate from it. */
export async function setTemplateRepo(
	ctx: PluginContext,
	token: string,
	owner: string,
	repo: string,
	isTemplate: boolean,
): Promise<{ ok: boolean; error?: string }> {
	const r = await gh(ctx, token, "PATCH", `/repos/${owner}/${repo}`, { is_template: isTemplate });
	return r.ok ? { ok: true } : { ok: false, error: `repo patch ${r.status}` };
}

/** Whether the token's user can push to `owner/repo` (owns it or is a collaborator with write). */
export async function canPush(
	ctx: PluginContext,
	token: string,
	owner: string,
	repo: string,
): Promise<boolean> {
	const r = await gh(ctx, token, "GET", `/repos/${owner}/${repo}`);
	if (!r.ok) return false;
	const perms = r.json<{ permissions?: { push?: boolean; admin?: boolean } }>().permissions;
	return Boolean(perms?.push || perms?.admin);
}

const B64_NEWLINES = /\n/g;
const GIT_SUFFIX = /\.git$/;
const REPO_URL = /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?$/;

/** A file from a repo's default branch (public repos need no token). */
export async function fetchRepoFile(
	ctx: PluginContext,
	owner: string,
	repo: string,
	path: string,
	token?: string,
): Promise<string | null> {
	const r = await gh(ctx, token ?? "", "GET", `/repos/${owner}/${repo}/contents/${path}`);
	if (!r.ok) return null;
	const d = r.json<{ content?: string; encoding?: string }>();
	if (!d.content) return null;
	return new TextDecoder().decode(fromB64(d.content.replace(B64_NEWLINES, "")));
}

/** Parse `https://github.com/owner/repo(.git)` (or `owner/repo`) → { owner, repo }. */
export function parseRepoUrl(input: string): { owner: string; repo: string } | null {
	const m = input.trim().replace(GIT_SUFFIX, "").match(REPO_URL);
	return m ? { owner: m[1]!, repo: m[2]! } : null;
}

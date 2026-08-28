/**
 * Projects collection reader. The `projects` collection is created by a seed
 * elsewhere; this plugin only reads its rows (to drive provisioning) and writes
 * a single field back — `url`, the live URL of a provisioned instance, which is
 * ALSO the "already provisioned" marker.
 *
 * There is NO parent-side registry any more: every Cloudflare resource is named
 * deterministically from the content row's id (a ULID), so the content row is
 * the only persistent state. Fields (all under ContentItem.data):
 *   label (string, required), theme (string, create-only),
 *   starting_credits (number, create-only, dollars),
 *   url (url, read-only — set by provisioning, and the provisioned marker),
 *   add_credits (number, edit-only — operator grant in dollars, cleared on save).
 */

import type { PluginContext } from "@premium-cms/emdash/plugin";

export const COLLECTION = "projects";

/** Pull the custom-field bag off a content event record (event.content) or item. */
export function fieldsOf(row: unknown): Record<string, unknown> {
	if (row && typeof row === "object" && "data" in row) {
		const data = (row as { data?: unknown }).data;
		if (data && typeof data === "object") return data as Record<string, unknown>;
	}
	return {};
}

/**
 * Every Projects row, as `{ id, data }`. The tick walks these: a row with an
 * empty `url` and a `label` + `theme` is provisioned; a row whose `url` is set
 * is already done and skipped. Paginates defensively (bounded pages).
 */
export async function listProjectRows(
	ctx: PluginContext,
): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
	if (!ctx.content) return [];
	const out: Array<{ id: string; data: Record<string, unknown> }> = [];
	let cursor: string | undefined;
	for (let page = 0; page < 20; page++) {
		const res = await ctx.content.list(COLLECTION, { limit: 100, cursor });
		for (const item of res.items) out.push({ id: item.id, data: fieldsOf(item) });
		if (!res.hasMore || !res.cursor) break;
		cursor = res.cursor;
	}
	return out;
}

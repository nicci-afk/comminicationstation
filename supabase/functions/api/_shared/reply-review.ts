import { HttpError } from "./util.ts";
import { checkReply, type Claim, type Draft, type Snapshot } from "./reply-evidence.ts";
export type ReplyDatabase = {
    rpc(name: string, args: Record<string, unknown>): PromiseLike<{
        data: unknown;
        error: {
            message?: string;
        } | null;
    }>;
};
export type ReplyState = Omit<Snapshot, "evidenceRead"> & {
    evidenceRead: {
        complete: boolean;
        revision: string;
    };
    sources: {
        id: string;
        hash: string;
        text: string | null;
        sentAt: string;
        contactId: string;
    }[];
};
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function id(value: unknown): string { if (typeof value !== "string" || !uuidPattern.test(value))
    throw new HttpError(400, "invalid reply identifier"); return value; }
function str(value: unknown, limit: number): string { if (typeof value !== "string" || !value.trim() || value.length > limit)
    throw new HttpError(400, "invalid reply text field"); return value; }
function number(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new HttpError(400, "invalid reply version or offset"); return Number(value); }
function list(value: unknown): unknown[] { if (!Array.isArray(value) || value.length > 64)
    throw new HttpError(400, "invalid reply list"); return value; }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "invalid reply request"); return value as Record<string, unknown>; }
function kind(value: unknown): Claim["kind"] { if (!["price", "date", "commitment"].includes(String(value)))
    throw new HttpError(400, "invalid reply claim kind"); return value as Claim["kind"]; }
function claims(value: unknown): Claim[] { return list(value).map(v => { const c = record(v); return { id: str(c.id, 100), kind: kind(c.kind), start: number(c.start), end: number(c.end), quote: str(c.quote, 20000), factKey: str(c.factKey, 300), value: str(c.value, 1000), evidenceIds: list(c.evidenceIds).map(id) }; }); }
export async function replyCommand(db: ReplyDatabase, actor: string, operation: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { data, error } = await db.rpc("mcc_reply_command", { p_actor: actor, p_operation: operation, p_input: input });
    if (error)
        throw new HttpError(409, error.message?.startsWith("reply ") || error.message?.startsWith("source ") || error.message?.startsWith("explicit ") || error.message?.startsWith("exact ") ? error.message : "reply review could not be completed; refresh and review again");
    return record(data);
}
export function replyDispatchEnabled(): boolean { return Deno.env.get("MCC_REPLY_DISPATCH_ENABLED") === "true"; }
export async function reviewReply(db: ReplyDatabase, actor: string, input: unknown): Promise<Record<string, unknown>> {
    const b = record(input);
    const op = str(b.operation, 20);
    let result: Record<string, unknown>;
    switch (op) {
        case "SAVE":
            result = await replyCommand(db, actor, op, { queue_item_id: id(b.queue_item_id), draft_id: id(b.draft_id), revision: number(b.revision), text: str(b.text, 20000), claims: claims(b.claims) });
            break;
        case "SNAPSHOT":
            result = await replyCommand(db, actor, op, { draft_id: id(b.draft_id) });
            break;
        case "EVIDENCE": {
            if (b.reviewed !== true)
                throw new HttpError(400, "explicit source review required");
            const hash = str(b.source_hash, 64);
            if (!/^[0-9a-f]{64}$/.test(hash))
                throw new HttpError(400, "invalid source revision");
            const until = str(b.valid_until, 40);
            if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(until) || !Number.isFinite(Date.parse(until)))
                throw new HttpError(400, "invalid evidence expiry");
            result = await replyCommand(db, actor, op, { draft_id: id(b.draft_id), revision: number(b.revision), message_id: id(b.message_id), source_hash: hash, kind: kind(b.kind), fact_key: str(b.fact_key, 300), value: str(b.value, 1000), start: number(b.start), end: number(b.end), excerpt: str(b.excerpt, 4000), valid_until: until, reviewed: true, supersedes: list(b.supersedes ?? []).map(id) });
            break;
        }
        case "REVOKE":
            result = await replyCommand(db, actor, op, { draft_id: id(b.draft_id), revision: number(b.revision), evidence_id: id(b.evidence_id) });
            break;
        case "CHECK": {
            const draftId = id(b.draft_id);
            const state = await replyCommand(db, actor, "SNAPSHOT", { draft_id: draftId }) as unknown as ReplyState;
            const now = new Date().toISOString();
            const resultCheck = await checkReply({ ...state, evidenceRead: { ...state.evidenceRead, readAt: now } }, now);
            result = await replyCommand(db, actor, op, { draft_id: draftId, revision: state.draft.revision, state, result: resultCheck });
            break;
        }
        case "APPROVE":
            if (b.coverage_reviewed !== true)
                throw new HttpError(400, "full reply and source review required");
            result = await replyCommand(db, actor, op, { check_id: id(b.check_id), snapshot_key: str(b.snapshot_key, 64), review_key: str(b.review_key, 64), coverage_reviewed: true });
            break;
        case "CANCEL":
            result = await replyCommand(db, actor, op, { dispatch_id: id(b.dispatch_id) });
            break;
        case "STATUS":
            result = await replyCommand(db, actor, op, b.dispatch_id ? { dispatch_id: id(b.dispatch_id) } : { approval_id: id(b.approval_id) });
            break;
        default: throw new HttpError(400, "unsupported reply review operation");
    }
    return { ...result, dispatch_enabled: replyDispatchEnabled() };
}
export async function beginReplyDispatch(db: ReplyDatabase, actor: string, input: unknown, channel: Draft["channel"]): Promise<Record<string, unknown> & {
    payload?: Draft;
}> {
    const b = record(input);
    // Runtime kill switch is server-owned and off by default. No legacy/manual bypass.
    if (!replyDispatchEnabled())
        throw new HttpError(503, "reply sending is disabled in this environment");
    const reserved = await replyCommand(db, actor, "RESERVE", { approval_id: id(b.approval_id), channel });
    if (reserved.existing)
        return reserved;
    try {
        return await replyCommand(db, actor, "BEGIN", { dispatch_id: id(reserved.dispatch_id), channel }) as Record<string, unknown> & {
            payload?: Draft;
        };
    }
    catch {
        return await replyCommand(db, actor, "CANCEL", { dispatch_id: id(reserved.dispatch_id) });
    }
}
export async function finishReplyDispatch(db: ReplyDatabase, actor: string, dispatchId: string, status: "SENT" | "FAILED" | "UNKNOWN", providerId?: string, ingestionPending = false): Promise<boolean> {
    try {
        await replyCommand(db, actor, "FINISH", { dispatch_id: dispatchId, status, provider_id: providerId ?? null, ingestion_pending: ingestionPending });
        return true;
    }
    catch {
        return false;
    }
}

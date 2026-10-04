/**
 * Deterministic checks used by the local reply-review integration.
 * All snapshots, coverage reviews and approvals MUST be loaded server-side.
 * Matching a reviewed assertion means source-supported, never proven true.
 * No network, model, database, storage, timers or content logging here.
 */
export const REPLY_CHECK_VERSION = "reply-evidence-v1";
const READ_MAX_AGE_MS = 60000;
const APPROVAL_MAX_AGE_MS = 5 * 60000;
export type ClaimKind = "price" | "date" | "commitment";
export type Scope = {
    userId: string;
    clientId: string;
    businessId: string;
    contextId: string;
};
export type Draft = {
    id: string;
    revision: number;
    scope: Scope;
    queueItemId: string;
    threadId: string;
    channel: "email" | "sms" | "whatsapp";
    fromAccountId: string;
    recipients: string[];
    subject: string;
    text: string;
    updatedAt: string;
    transport?: {
        from: string;
        to: string;
        subject?: string;
        providerThreadId?: string;
        inReplyTo?: string | null;
        references?: string[];
        lastInboundAt?: string;
    };
};
export type Claim = {
    id: string;
    kind: ClaimKind;
    start: number;
    end: number;
    quote: string;
    /** Stable subject + property, e.g. quote:Q123:total; never merely "price". */
    factKey: string;
    /** Typed, canonical value; e.g. USD:125000 or 2026-10-20@America/New_York. */
    value: string;
    evidenceIds: string[];
};
export type Evidence = {
    id: string;
    scope: Scope;
    kind: ClaimKind;
    factKey: string;
    value: string;
    source: {
        id: string;
        revision: string;
        locator: string;
        occurredAt: string;
        excerpt: string;
    };
    verification: {
        basis: "source_system" | "human_reviewed" | "model" | "text_match";
        verifiedBy: string;
        verifiedAt: string;
    };
    /** Required explicit validity window, assigned by the trusted source adapter/reviewer. */
    validUntil: string;
    revoked: boolean;
    /** Explicit same-fact replacement, never inferred from latest timestamp. */
    supersedes: string[];
};
export type Snapshot = {
    draft: Draft;
    claims: Claim[];
    evidence: Evidence[];
    /** A successful, complete scoped read, with a revision bumped on any evidence change. */
    evidenceRead: {
        complete: boolean;
        revision: string;
        readAt: string;
    };
};
export type Citation = {
    evidenceId: string;
    sourceId: string;
    sourceRevision: string;
    locator: string;
    sourceDate: string;
    verifiedAt: string;
    validUntil: string;
    excerpt: string;
};
export type Issue = {
    code: string;
    claimId?: string;
};
export type Check = {
    status: "BLOCKED" | "SOURCE_SUPPORTED_REQUIRES_REVIEW";
    reviewKey: string;
    snapshotKey: string;
    checkedAt: string;
    issues: Issue[];
    claims: {
        id: string;
        citations: Citation[];
    }[];
    detectedRisks: Risk[];
    disclaimer: string;
};
export type Risk = {
    kind: ClaimKind;
    start: number;
    end: number;
    text: string;
};
export type CoverageReview = {
    reviewKey: string;
    snapshotKey: string;
    reviewedBy: string;
    reviewedAt: string;
};
export type Approval = {
    id: string;
    userId: string;
    snapshotKey: string;
    reviewKey: string;
    approvedBy: string;
    approvedAt: string;
    expiresAt: string;
};
function filled(value: unknown): value is string { return typeof value === "string" && !!value.trim(); }
function timestamp(value: string): number {
    // Explicit offsets only: server timezone must not affect validity.
    return typeof value === "string" && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
}
function validScope(scope: Scope): boolean {
    return !!scope && [scope.userId, scope.clientId, scope.businessId, scope.contextId].every(filled);
}
function sameScope(a: Scope, b: Scope): boolean {
    return validScope(a) && validScope(b) && a.userId === b.userId && a.clientId === b.clientId
        && a.businessId === b.businessId && a.contextId === b.contextId;
}
function safeLocator(locator: string): boolean {
    if (/^\/item\/[0-9a-f-]{36}\?message=[0-9a-f-]{36}$/i.test(locator))
        return true;
    try {
        const url = new URL(locator);
        return url.protocol === "https:" && !url.username && !url.password;
    }
    catch {
        return false;
    }
}
function validKind(kind: string): kind is ClaimKind { return ["price", "date", "commitment"].includes(kind); }
function canonical(value: unknown): string {
    if (Array.isArray(value))
        return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record).sort().map(k => `${JSON.stringify(k)}:${canonical(record[k])}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}
async function digest(value: unknown): Promise<string> {
    const bytes = new TextEncoder().encode(canonical(value));
    const result = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(result), b => b.toString(16).padStart(2, "0")).join("");
}
/** Conservative, English-language prompts for review, not exhaustive claim extraction. */
export function detectReplyRisks(text: string): Risk[] {
    const patterns: [
        ClaimKind,
        RegExp
    ][] = [
        ["price", /(?:[$€£]\s*\d[\d,]*(?:\.\d{1,2})?|\b(?:USD|EUR|GBP|CAD|AUD)\s*\d[\d,.]*|\b\d[\d,.]*\s*(?:dollars?|euros?|pounds?))\b/gi],
        ["date", /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,?\s+\d{4})?|today|tomorrow|tonight|next\s+(?:week|month|year|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/gi],
        ["commitment", /\b(?:(?:I|we)(?:['’]ll|\s+(?:will|promise|guarantee|confirm|commit))|(?:is|are|has been|have been)\s+(?:booked|confirmed|paid|reserved|guaranteed)|(?:booking|reservation|payment)\s+(?:is\s+)?(?:confirmed|complete|received))\b/gi],
    ];
    return patterns.flatMap(([kind, pattern]) => Array.from(text.matchAll(pattern), match => ({
        kind, start: match.index!, end: match.index! + match[0].length, text: match[0],
    }))).sort((a, b) => a.start - b.start || a.kind.localeCompare(b.kind));
}
export async function checkReply(snapshot: Snapshot, now: string): Promise<Check> {
    // Isolate async digest work from caller mutation; production still needs the DB fence.
    const { draft, claims, evidence, evidenceRead } = structuredClone(snapshot);
    const nowMs = timestamp(now);
    const issues: Issue[] = [];
    const add = (code: string, claimId?: string) => {
        if (!issues.some(i => i.code === code && i.claimId === claimId))
            issues.push({ code, ...(claimId ? { claimId } : {}) });
    };
    const reviewKey = await digest({ version: REPLY_CHECK_VERSION, draft, claims });
    // Fresh reads do not invalidate unchanged evidence; expiry is ALWAYS reevaluated below.
    const snapshotKey = await digest({ version: REPLY_CHECK_VERSION, draft, claims, evidence,
        evidenceRevision: evidenceRead.revision, complete: evidenceRead.complete });
    const detectedRisks = detectReplyRisks(draft.text);
    if (!Number.isFinite(nowMs))
        add("INVALID_CLOCK");
    if (!filled(draft.id) || !Number.isSafeInteger(draft.revision) || draft.revision < 1
        || !validScope(draft.scope) || !filled(draft.queueItemId) || !filled(draft.threadId)
        || !["email", "sms", "whatsapp"].includes(draft.channel) || !filled(draft.fromAccountId)
        || !draft.recipients.length || !draft.recipients.every(filled) || !filled(draft.text)
        || !Number.isFinite(timestamp(draft.updatedAt)) || timestamp(draft.updatedAt) > nowMs)
        add("INVALID_DRAFT");
    const readAt = timestamp(evidenceRead.readAt);
    if (!evidenceRead.complete || !filled(evidenceRead.revision))
        add("INCOMPLETE_EVIDENCE_READ");
    if (!Number.isFinite(readAt) || readAt > nowMs || nowMs - readAt >= READ_MAX_AGE_MS)
        add("STALE_EVIDENCE_READ");
    const claimIds = new Set<string>();
    for (const c of claims) {
        if (!filled(c.id) || claimIds.has(c.id))
            add("INVALID_CLAIM_ID");
        claimIds.add(c.id);
        if (!validKind(c.kind) || !filled(c.factKey) || !filled(c.value) || !filled(c.quote)
            || !Number.isSafeInteger(c.start) || !Number.isSafeInteger(c.end) || c.start < 0 || c.end <= c.start
            || c.end > draft.text.length || draft.text.slice(c.start, c.end) !== c.quote)
            add("CLAIM_TEXT_CHANGED", c.id);
        // A broad span must not hide multiple detected assertions behind one fact/value.
        if (detectedRisks.filter(r => r.kind === c.kind && c.start <= r.start && c.end >= r.end).length > 1)
            add("AMBIGUOUS_CLAIM_SPAN", c.id);
    }
    for (const risk of detectedRisks) {
        if (!claims.some(c => c.kind === risk.kind && c.start <= risk.start && c.end >= risk.end))
            add("UNREVIEWED_" + risk.kind.toUpperCase());
    }
    const allIds = new Set<string>();
    for (const e of evidence) {
        if (!filled(e.id) || allIds.has(e.id))
            add("DUPLICATE_OR_INVALID_EVIDENCE_ID");
        allIds.add(e.id);
        // Do not leak foreign source identifiers, metadata or content in a report.
        if (!sameScope(e.scope, draft.scope))
            add("FOREIGN_EVIDENCE");
    }
    const scoped = evidence.filter(e => sameScope(e.scope, draft.scope));
    const byId = new Map(scoped.map(e => [e.id, e]));
    const metadataValid = (e: Evidence): boolean => {
        const occurredAt = timestamp(e.source.occurredAt);
        const verifiedAt = timestamp(e.verification.verifiedAt);
        const validUntil = timestamp(e.validUntil);
        return validKind(e.kind) && [e.factKey, e.value, e.source.id, e.source.revision, e.source.locator,
            e.source.excerpt, e.verification.verifiedBy].every(filled)
            && typeof e.revoked === "boolean" && safeLocator(e.source.locator)
            && [occurredAt, verifiedAt, validUntil].every(Number.isFinite)
            && occurredAt <= verifiedAt && verifiedAt <= nowMs && validUntil > verifiedAt;
    };
    const authoritative = (e: Evidence) => ["source_system", "human_reviewed"].includes(e.verification.basis);
    const replaced = new Set<string>();
    for (const e of scoped) {
        for (const priorId of e.supersedes) {
            const prior = byId.get(priorId);
            if (!prior || prior.id === e.id || prior.factKey !== e.factKey || prior.kind !== e.kind
                || !metadataValid(e) || !metadataValid(prior) || !authoritative(e) || !authoritative(prior)
                || e.revoked || timestamp(e.source.occurredAt) <= timestamp(prior.source.occurredAt)
                || timestamp(e.verification.verifiedAt) < timestamp(prior.verification.verifiedAt)) {
                add("INVALID_SUPERSESSION");
            }
            else
                replaced.add(priorId);
        }
    }
    const results = claims.map(c => {
        const citations: Citation[] = [];
        const relevant = scoped.filter(e => e.factKey === c.factKey && e.kind === c.kind);
        const current = relevant.filter(e => !replaced.has(e.id) && !e.revoked);
        if (!c.evidenceIds.length)
            add("MISSING_EVIDENCE", c.id);
        for (const id of c.evidenceIds) {
            const e = byId.get(id);
            if (!e || e.factKey !== c.factKey || e.kind !== c.kind) {
                add("MISSING_OR_MISMATCHED_EVIDENCE", c.id);
                continue;
            }
            if (replaced.has(id)) {
                add("SUPERSEDED_EVIDENCE", c.id);
                continue;
            }
            if (e.revoked) {
                add("REVOKED_EVIDENCE", c.id);
                continue;
            }
            if (metadataValid(e))
                citations.push({ evidenceId: id, sourceId: e.source.id, sourceRevision: e.source.revision,
                    locator: e.source.locator, sourceDate: e.source.occurredAt, verifiedAt: e.verification.verifiedAt,
                    validUntil: e.validUntil, excerpt: e.source.excerpt });
        }
        for (const e of current) {
            if (!metadataValid(e))
                add("INVALID_EVIDENCE_METADATA", c.id);
            if (!authoritative(e))
                add("UNVERIFIED_EVIDENCE", c.id);
            if (e.revoked)
                add("REVOKED_EVIDENCE", c.id);
            if (timestamp(e.validUntil) <= nowMs)
                add("STALE_EVIDENCE", c.id);
        }
        const qualified = current.filter(e => metadataValid(e) && authoritative(e) && !e.revoked && timestamp(e.validUntil) > nowMs);
        if (qualified.some(e => e.value !== c.value))
            add("CONFLICTING_EVIDENCE", c.id);
        if (!qualified.some(e => e.value === c.value && c.evidenceIds.includes(e.id)))
            add("UNSUPPORTED_CLAIM", c.id);
        return { id: c.id, citations };
    });
    return { status: issues.length ? "BLOCKED" : "SOURCE_SUPPORTED_REQUIRES_REVIEW", reviewKey, snapshotKey,
        checkedAt: now, issues, claims: results, detectedRisks,
        disclaimer: "Source support is not a guarantee of truth. Detection is incomplete; review the entire reply, sources, scope and recipient before approving." };
}
/** Build a record to persist ONLY after a separate authenticated, explicit review action. */
export async function prepareReplyApproval(input: {
    snapshot: Snapshot;
    coverageReview: CoverageReview;
    actorId: string;
    approvalId: string;
    now: string;
}): Promise<Approval> {
    const { snapshot, coverageReview, actorId, approvalId, now } = structuredClone(input);
    const check = await checkReply(snapshot, now);
    const reviewedAt = timestamp(coverageReview.reviewedAt);
    const nowMs = timestamp(now);
    if (!filled(approvalId) || actorId !== snapshot.draft.scope.userId
        || coverageReview.reviewedBy !== actorId || coverageReview.reviewKey !== check.reviewKey
        || coverageReview.snapshotKey !== check.snapshotKey
        || !Number.isFinite(reviewedAt) || reviewedAt > nowMs || reviewedAt < timestamp(snapshot.draft.updatedAt)
        || nowMs - reviewedAt >= APPROVAL_MAX_AGE_MS || check.status === "BLOCKED")
        throw new Error("REPLY_NOT_APPROVABLE");
    const expiries = snapshot.evidence.filter(e => snapshot.claims.some(c => c.evidenceIds.includes(e.id))).map(e => timestamp(e.validUntil));
    return { id: approvalId, userId: actorId, approvedBy: actorId, approvedAt: now,
        reviewKey: check.reviewKey, snapshotKey: check.snapshotKey,
        expiresAt: new Date(Math.min(nowMs + APPROVAL_MAX_AGE_MS, ...expiries)).toISOString() };
}
/**
 * Pure approval-store contract for unit testing. The integrated routes use the
 * durable SQL command path; never substitute an in-memory store for that path:
 * - load only authenticated-user-owned persisted approvals, never a request-body record
 * - consume atomically with evidence/draft revision checks in ONE transaction/CAS
 * - persist an immutable, idempotent dispatch intent for dispatchPayload; return its ID
 * - dispatch ONLY that persisted intent by ID; never use the browser/request body
 * - record UNKNOWN on provider ambiguity, never reuse approval to blindly retry
 */
export interface ApprovalStore {
    load(approvalId: string, userId: string): Promise<Approval | null>;
    consume(input: {
        approvalId: string;
        userId: string;
        snapshotKey: string;
        draftId: string;
        draftRevision: number;
        evidenceRevision: string;
        now: string;
        dispatchPayload: Draft;
    }): Promise<string | null>;
}
/** Returns permission for ONE dispatch reservation, not proof of a send or factual accuracy. */
export async function reserveReplyDispatch(input: {
    snapshot: Snapshot;
    approvalId: string;
    actorId: string;
    now: string;
    store: ApprovalStore;
}): Promise<{
    allowed: false;
    reason: string;
} | {
    allowed: true;
    reason: "DISPATCH_RESERVED";
    dispatchId: string;
}> {
    const { approvalId, actorId, now, store } = input;
    const snapshot = structuredClone(input.snapshot);
    if (!filled(approvalId) || actorId !== snapshot.draft.scope.userId)
        return { allowed: false, reason: "INVALID_APPROVAL" };
    const check = await checkReply(snapshot, now);
    if (check.status === "BLOCKED")
        return { allowed: false, reason: "EVIDENCE_BLOCKED" };
    try {
        const approval = await store.load(approvalId, actorId);
        const nowMs = timestamp(now);
        if (!approval || approval.id !== approvalId || approval.userId !== actorId || approval.approvedBy !== actorId
            || approval.snapshotKey !== check.snapshotKey || approval.reviewKey !== check.reviewKey
            || !Number.isFinite(timestamp(approval.approvedAt)) || timestamp(approval.approvedAt) > nowMs
            || !Number.isFinite(timestamp(approval.expiresAt)) || timestamp(approval.expiresAt) <= nowMs
            || timestamp(approval.expiresAt) <= timestamp(approval.approvedAt)
            || timestamp(approval.expiresAt) - timestamp(approval.approvedAt) > APPROVAL_MAX_AGE_MS)
            return { allowed: false, reason: "INVALID_APPROVAL" };
        const dispatchId = await store.consume({ approvalId, userId: actorId, snapshotKey: check.snapshotKey,
            draftId: snapshot.draft.id, draftRevision: snapshot.draft.revision,
            evidenceRevision: snapshot.evidenceRead.revision, now, dispatchPayload: structuredClone(snapshot.draft) });
        return filled(dispatchId) ? { allowed: true, reason: "DISPATCH_RESERVED", dispatchId }
            : { allowed: false, reason: "APPROVAL_USED_OR_STATE_CHANGED" };
    }
    catch {
        return { allowed: false, reason: "APPROVAL_STORE_UNAVAILABLE" };
    }
}

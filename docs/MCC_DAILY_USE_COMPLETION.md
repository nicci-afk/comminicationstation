# MCC daily-use completion candidate — 2026-10-01

Status: PREPARED; LOCAL VALIDATION PASSED; BROWSER CI REQUIRED; PRODUCTION APPROVAL PENDING.

Production baseline remains release `37754b86f6ce910fe06903624d55cea03745ed1c`, API version 22. Signed-in desktop acceptance passed with a labeled test item; the original 14 records were unchanged. This candidate does not apply database/API changes or enable automation.

## Problem and final behavior

A confirmed capture could leave the review inbox but rank below the daily summary limit. Review now leaves a saved receipt outside the disappearing review form, with View action and Undo. View action exits Focus and shows the specific saved item above the bounded summary, without changing priority, expanding the backlog or duplicating its card. Back to daily summary dismisses that view. Done retains its existing Undo receipt. Failed or unconfirmed review retains the typed action and reports the error. Manual actions invalidate the capture inbox immediately, so Undo review returns its original note for clarification without waiting for the periodic refresh.

Each section shows its displayed count and total when items are hidden, such as 3 of 6. The existing Show all active obligations control exposes the full list. Focus continues to choose the database-ranked eligible NICCI action.

Receipts and revealed-card selection live in the current authenticated screen; they are cleared by reload/account transition. Canonical capture, review, action and history persist in Supabase. Refresh persistence and history remain separate from the temporary receipt.

## Daily-use acceptance coverage

| Requirement | Evidence |
|---|---|
| Capture fragments accurately | Production verbatim capture and refresh passed |
| Complete in one step | Production Done and persistent Undo passed |
| Small actionable list | Existing deterministic caps; candidate visible totals |
| ChatGPT preparation ownership | Production Need help persisted; Undo restored NICCI |
| Waiting and follow-up | Existing named-party/follow-up UI and schema validation |
| Trace source and history | Existing evidence UI, source links and append-only audit |
| Explain why now | Existing deterministic reasons retained |
| Inspect/undo state changes | Existing history plus production and isolated Undo tests |
| Exclude historical inbox noise | Existing current-obligation view; no backlog migration |

## Validation and approval

The full local Phase 3B suite, static safety tests and TypeScript/Vite build passed. The React regression reproduces the low-ranked capture disappearing under the cap, failed review/retry, saved receipt, single-card reveal, dismissal and unchanged Focus selection. The real Supabase browser suite additionally covers review Undo/re-review, mobile layout and account isolation. Run results at the exact candidate commit are attached to its PR; browser CI must pass before approval is requested.

Only after explicit approval: publish this frontend candidate through the controlled Vercel release path, verify the live bundle and routes, and test the handoff with a labeled capture. Backend functions, source-system integrations and automation settings remain as deployed.

## Later roadmap

The initial daily-use build is separate from the full MCC roadmap. Message intake relay, Anchor extraction, AgentEdge/Calendar linkage, document/screenshot capture, richer classification/dedupe and the universal natural-language command bar require separately validated increments. Existing financial/booking systems remain authoritative; external sends and consequential changes retain their approval gates.

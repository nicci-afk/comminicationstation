import {
  handleOptions,
  HttpError,
  json,
  requireUser,
  serviceClient,
} from "./_shared/util.ts";

const ACTIONS = new Set(["DONE","BLOCKED","WAITING","NEED_HELP","UNDO_LAST"]);

export default async function handler(req: Request): Promise<Response> {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== "POST") return json({ error: "POST required" }, 405);

  const db = serviceClient();

  try {
    const { userId } = await requireUser(req, db);
    const body = await req.json();

    const obligationId = String(body.obligation_id ?? "").trim();
    const action = String(body.action ?? "").trim().toUpperCase();
    const reason = body.reason == null ? null : String(body.reason).trim().slice(0, 2000);
    const waitingOn = body.waiting_on == null ? null : String(body.waiting_on).trim().slice(0, 500);
    const followUpAt = body.follow_up_at == null || body.follow_up_at === ""
      ? null
      : String(body.follow_up_at);

    if (!/^[0-9a-f-]{36}$/i.test(obligationId)) throw new HttpError(400, "invalid obligation id");
    if (!ACTIONS.has(action)) throw new HttpError(400, "unsupported action");
    if (action === "BLOCKED" && !reason) throw new HttpError(400, "blocked reason is required");
    if (action === "WAITING" && !waitingOn) throw new HttpError(400, "waiting_on is required");
    if (followUpAt && Number.isNaN(Date.parse(followUpAt))) throw new HttpError(400, "invalid follow_up_at");

    const { data, error } = await db.rpc("mcc_apply_manual_action", {
      p_user_id: userId,
      p_obligation_id: obligationId,
      p_action: action,
      p_reason: reason,
      p_waiting_on: waitingOn,
      p_follow_up_at: followUpAt,
    });

    if (error) {
      const msg = error.message ?? "manual action failed";
      if (/not found/i.test(msg)) throw new HttpError(404, "obligation not found");
      if (/required|terminal|unsupported|cancelled|reversible/i.test(msg)) throw new HttpError(409, msg);
      throw new Error(msg);
    }

    return json(data ?? { ok: true });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: (e as Error).message }, status);
  }
}

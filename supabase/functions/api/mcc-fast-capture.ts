import { handleOptions, HttpError, json, requireUser, serviceClient } from "./_shared/util.ts";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export default async function handler(req: Request): Promise<Response> {
  const opt = handleOptions(req); if (opt) return opt;
  if (req.method !== "POST") return json({ error: "POST required" }, 405);
  try {
    const db = serviceClient();
    const { userId } = await requireUser(req, db);
    let body;
    try { body = await req.json(); } catch { throw new HttpError(400, "invalid JSON"); }
    if (!body || typeof body !== "object") throw new HttpError(400, "object required");
    const review = body.operation === "REVIEW";
    if (body.operation !== "CAPTURE" && !review) throw new HttpError(400, "unsupported operation");
    const id = review ? body.obligation_id : body.request_id;
    if (typeof id !== "string" || !uuid.test(id)) throw new HttpError(400, "valid id required");
    const text = review ? body.next_action : body.note;
    if (typeof text !== "string" || !text.trim() || text.length > (review ? 2000 : 10000)) throw new HttpError(400, "invalid text length");
    if (review && body.project_id != null && (typeof body.project_id !== "string" || !uuid.test(body.project_id))) throw new HttpError(400, "invalid project id");
    const { data, error } = review
      ? await db.rpc("mcc_review_capture", { p_user_id: userId, p_obligation_id: body.obligation_id, p_next_action: text, p_project_id: body.project_id ?? null })
      : await db.rpc("mcc_fast_capture", { p_user_id: userId, p_request_id: body.request_id, p_note: text });
    if (error) {
      if (/not found/.test(error.message)) throw new HttpError(404, "capture not found");
      if (/required|already used|no longer|characters/.test(error.message)) throw new HttpError(409, error.message);
      console.error("MCC capture RPC failed", error.code);
      throw new HttpError(500, "Capture could not be confirmed. Keep the note and retry.");
    }
    return json(data);
  } catch (e) { return json({ error: e instanceof Error ? e.message : "capture failed" }, e instanceof HttpError ? e.status : 500); }
}

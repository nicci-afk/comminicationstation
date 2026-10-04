import { handleOptions, HttpError, json, requireUser, serviceClient } from "./_shared/util.ts";
import { reviewReply } from "./_shared/reply-review.ts";
export default async function handler(req: Request): Promise<Response> {
    const opt = handleOptions(req);
    if (opt)
        return opt;
    if (req.method !== "POST")
        return json({ error: "POST required" }, 405);
    try {
        const db = serviceClient();
        const { userId } = await requireUser(req, db);
        const text = await req.text();
        if (text.length > 100000)
            throw new HttpError(413, "reply request too large");
        let body: unknown;
        try {
            body = JSON.parse(text);
        }
        catch {
            throw new HttpError(400, "invalid JSON");
        }
        return json(await reviewReply(db, userId, body));
    }
    catch (e) {
        return json({ error: (e as Error).message }, e instanceof HttpError ? e.status : 500);
    }
}

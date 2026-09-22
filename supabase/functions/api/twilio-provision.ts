// Guided number provisioning ("Connect a number" in Settings). Built now,
// used later when the user is ready to go live with texting — searches and
// purchases a number on THEIR Twilio account and points its webhook here.

import {
  getConfig,
  handleOptions,
  HttpError,
  json,
  requireUser,
  serviceClient,
  SUPABASE_URL,
} from "./_shared/util.ts";
import { getUserSecret } from "./_shared/util.ts";

export default async function handler(req: Request): Promise<Response> {
  const opt = handleOptions(req);
  if (opt) return opt;
  const db = serviceClient();
  try {
    const { userId } = await requireUser(req, db);
    const body = await req.json();
    const areaCode = body.area_code as string | undefined;

    const sid = await getUserSecret(db, userId, "twilio_account_sid");
    const token = await getUserSecret(db, userId, "twilio_auth_token");
    if (!sid || !token) throw new HttpError(400, "add your Twilio credentials in Settings first");
    const auth = "Basic " + btoa(`${sid}:${token}`);

    if (body.action === "search") {
      const params = new URLSearchParams({ SmsEnabled: "true", PageSize: "10" });
      if (areaCode) params.set("AreaCode", areaCode);
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/AvailablePhoneNumbers/US/Local.json?${params}`,
        { headers: { Authorization: auth } },
      );
      if (!res.ok) throw new HttpError(502, `Twilio search failed: ${(await res.text()).slice(0, 300)}`);
      const data = await res.json();
      return json({
        numbers: (data.available_phone_numbers ?? []).map(
          (n: { phone_number: string; friendly_name: string; locality?: string }) => ({
            phone_number: n.phone_number,
            friendly_name: n.friendly_name,
            locality: n.locality ?? "",
          }),
        ),
      });
    }

    if (body.action === "purchase") {
      const phone = body.phone_number as string;
      if (!phone) throw new HttpError(400, "phone_number required");
      const base = ((await getConfig(db, "worker_base_url"))?.url as string) ??
        `${SUPABASE_URL}/functions/v1`;
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json`,
        {
          method: "POST",
          headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            PhoneNumber: phone,
            SmsUrl: `${base}/twilio-inbound`,
            SmsMethod: "POST",
          }),
        },
      );
      if (!res.ok) throw new HttpError(502, `Twilio purchase failed: ${(await res.text()).slice(0, 300)}`);
      const bought = await res.json();
      const { error } = await db.from("twilio_numbers").insert({
        user_id: userId,
        phone_e164: bought.phone_number,
        friendly_name: bought.friendly_name ?? "",
        status: "active",
      });
      if (error) throw new Error(error.message);
      return json({ ok: true, phone_number: bought.phone_number });
    }

    // Register an existing number already owned in Twilio — updates its webhook to point here.
    if (body.action === "register") {
      const rawPhone = (body.phone_number as string ?? "").replace(/\D/g, "");
      if (!rawPhone) throw new HttpError(400, "phone_number required");
      const e164 = rawPhone.startsWith("1") ? `+${rawPhone}` : `+1${rawPhone}`;
      const base = ((await getConfig(db, "worker_base_url"))?.url as string) ??
        `${SUPABASE_URL}/functions/v1`;

      // Look up the number in the account to get its SID
      const lookup = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(e164)}`,
        { headers: { Authorization: auth } },
      );
      if (!lookup.ok) throw new HttpError(502, `Twilio lookup failed: ${(await lookup.text()).slice(0, 300)}`);
      const lookupData = await lookup.json();
      const existing = lookupData.incoming_phone_numbers?.[0];
      if (!existing) throw new HttpError(404, `Number ${e164} not found in your Twilio account. Make sure the Account SID/Auth Token match the account that owns this number.`);

      // Update the webhook on the existing number
      const update = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers/${existing.sid}.json`,
        {
          method: "POST",
          headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            SmsUrl: `${base}/twilio-inbound`,
            SmsMethod: "POST",
          }),
        },
      );
      if (!update.ok) throw new HttpError(502, `Twilio webhook update failed: ${(await update.text()).slice(0, 300)}`);
      const updated = await update.json();

      // Upsert into twilio_numbers
      const { error } = await db.from("twilio_numbers").upsert(
        { user_id: userId, phone_e164: updated.phone_number, friendly_name: updated.friendly_name ?? "", status: "active" },
        { onConflict: "phone_e164" },
      );
      if (error) throw new Error(error.message);
      return json({ ok: true, phone_number: updated.phone_number });
    }

    throw new HttpError(400, "action must be 'search', 'purchase', or 'register'");
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: (e as Error).message }, status);
  }
}

import { FormEvent, useState } from "react";
import { supabase } from "../lib/supabase";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"password" | "magic">("password");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    if (mode === "magic") {
      // shouldCreateUser:false — the allowlist stays closed; links only go to
      // the two existing household accounts.
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: false, emailRedirectTo: window.location.origin },
      });
      if (error) setError(error.message);
      else setNotice("Check your email — the sign-in link is on its way.");
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setError(error.message);
    }
    setBusy(false);
  }

  return (
    <div className="min-h-screen grid place-items-center bg-slate-100">
      <form onSubmit={submit} className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 w-96 space-y-4">
        <div className="text-center">
          <div className="text-3xl">📬</div>
          <h1 className="text-xl font-semibold mt-2">Command Center</h1>
          <p className="text-sm text-slate-500">Private — invited accounts only</p>
        </div>
        <input
          type="email" required placeholder="Email" value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
        />
        {mode === "password" && (
          <input
            type="password" required placeholder="Password" value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
          />
        )}
        {error && <p className="text-sm text-red-600">{error}</p>}
        {notice && <p className="text-sm text-emerald-600">{notice}</p>}
        <button
          disabled={busy}
          className="w-full bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg py-2 text-sm font-medium disabled:opacity-50"
        >
          {busy ? "Working…" : mode === "magic" ? "Email me a sign-in link" : "Sign in"}
        </button>
        <button
          type="button"
          onClick={() => { setMode(mode === "magic" ? "password" : "magic"); setError(""); setNotice(""); }}
          className="w-full text-sm text-indigo-600 hover:underline"
        >
          {mode === "magic" ? "Use a password instead" : "Email me a magic link instead"}
        </button>
      </form>
    </div>
  );
}

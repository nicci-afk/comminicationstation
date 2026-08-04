import { useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { Inbox, Landmark, ListTodo, Settings as SettingsIcon, Sunrise, Users } from "lucide-react";
import { supabase } from "./lib/supabase";
import { useQueueRealtime } from "./lib/hooks";
import Login from "./pages/Login";
import Today from "./pages/Today";
import Queue from "./pages/Queue";
import ItemDetail from "./pages/ItemDetail";
import Contacts from "./pages/Contacts";
import ContactDetail from "./pages/ContactDetail";
import Backlog from "./pages/Backlog";
import Settings from "./pages/Settings";

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!ready) return <div className="p-10 text-slate-500 dark:text-slate-400">Loading…</div>;
  if (!session) return <Login />;
  return <Shell />;
}

function Shell() {
  useQueueRealtime();
  const nav = [
    { to: "/today", label: "Today", icon: Sunrise },
    { to: "/queue", label: "Queue", icon: ListTodo },
    { to: "/contacts", label: "Contacts", icon: Users },
    { to: "/backlog", label: "Backlog", icon: Inbox },
    { to: "/settings", label: "Settings", icon: SettingsIcon },
  ];
  return (
    <div className="min-h-[100dvh] flex">
      {/* Sidebar — desktop only */}
      <aside className="hidden sm:flex w-52 shrink-0 border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex-col">
        <div className="px-4 py-4 flex items-center gap-2 border-b border-slate-100 dark:border-slate-800">
          <Landmark className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
          <span className="font-semibold">Command Center</span>
        </div>
        <nav className="flex-1 p-2 space-y-1">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition ${
                  isActive
                    ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"
                    : "text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                }`
              }
            >
              <Icon className="w-4 h-4" /> {label}
            </NavLink>
          ))}
        </nav>
        <button
          onClick={() => supabase.auth.signOut()}
          className="m-2 px-3 py-2 text-left text-sm text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg"
        >
          Sign out
        </button>
      </aside>

      {/* Main content — extra bottom padding on mobile for bottom nav */}
      <main className="flex-1 min-w-0 pb-16 sm:pb-0">
        <Routes>
          <Route path="/" element={<Navigate to="/today" replace />} />
          <Route path="/today" element={<Today />} />
          <Route path="/queue" element={<Queue />} />
          <Route path="/item/:id" element={<ItemDetail />} />
          <Route path="/contacts" element={<Contacts />} />
          <Route path="/contacts/:id" element={<ContactDetail />} />
          <Route path="/backlog" element={<Backlog />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/today" replace />} />
        </Routes>
      </main>

      {/* Bottom nav — mobile only */}
      <nav className="sm:hidden fixed bottom-0 inset-x-0 z-40 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex safe-area-pb">
        {nav.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex-1 flex flex-col items-center justify-center py-2 gap-0.5 text-[10px] font-medium transition min-h-[56px] ${
                isActive
                  ? "text-indigo-600 dark:text-indigo-400"
                  : "text-slate-500 dark:text-slate-400"
              }`
            }
          >
            <Icon className="w-5 h-5" />
            {label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

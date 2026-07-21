// Public client configuration. The anon key is a publishable value by design
// (all data access is enforced by Postgres RLS, not by key secrecy); baking it
// here keeps the Vercel deployment entirely secret-free.
export const SUPABASE_URL = "https://bgpjpomqrnwsdmrofudb.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJncGpwb21xcm53c2Rtcm9mdWRiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ2NjA5MzMsImV4cCI6MjEwMDIzNjkzM30.S2yXmOg6RoYYn7WarqYr9FF05Lb4ucxRvlh2YB9Gvso";
export const API_BASE = `${SUPABASE_URL}/functions/v1/api`;

# MCC Phase 3A production runner

One-shot deployment runner for the already approved Phase 3A production release.

Safety properties:
- requires the exact approved Phase 3A merge commit to be an ancestor of the runner commit
- fails before deployment if GitHub Actions credentials are absent
- deploys the existing Supabase `api` Edge Function from merged repository source
- preserves the function's existing `verify_jwt=false` configuration because the routed API performs endpoint-specific authentication
- deploys the Vercel web app from `apps/web` using a pinned CLI and prebuilt production artifact
- does not run schema SQL, send external communication, modify bookings, or move money

Required repository secrets:
- `SUPABASE_ACCESS_TOKEN`
- `VERCEL_TOKEN`

Known fixed, non-secret deployment targets:
- Supabase project: `bgpjpomqrnwsdmrofudb`
- Vercel team: `team_VyloIj0OJAb3IN63CmPGvqeG`
- Vercel project: `prj_kypK3A8FOS9XdLadXmAr6pUHW7hA`

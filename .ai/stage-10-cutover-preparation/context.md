# Context

- Stages 0-9 are implemented and two complete rehearsals passed.
- Production admin still reads and writes Supabase.
- `getomerch_production` exists on the VPS and is empty.
- `getomerch-worker.service` is not installed in production.
- The current backup timer protects the Supabase source once per day.
- Stage 10 needs a maintenance gate, local database backup, explicit cutover
  state transitions and an enforced pre-write rollback boundary.

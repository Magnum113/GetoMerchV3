# Implementation

- Added runtime read-only maintenance state, API enforcement, a visible admin
  banner and an operational enable/disable/status command.
- Added an encrypted hourly local PostgreSQL backup, mandatory off-site upload,
  retention tiers and a disposable restore drill.
- Generalized the verified data rehearsal for an empty production target while
  preserving the previous database for pre-write rollback.
- Added a root-only cutover state machine with explicit `preflight`, `prepare`,
  `go` and pre-write `abort` confirmations.
- Added a read-only Ozon connectivity check, worker and backup systemd units,
  and an idempotent cutover installer.
- Deployed Release E artifacts to the VPS without running `prepare` or `go`.
- Rehearsed both target modes, tested a real production-format backup/restore,
  then returned `getomerch_production` to its original empty state.

The production application still reads and writes Supabase. The local worker
and local database backup timer are installed but disabled until Go.

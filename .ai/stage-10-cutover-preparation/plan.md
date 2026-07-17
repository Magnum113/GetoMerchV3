# Plan

- [x] Add a visible and API-enforced read-only maintenance mode.
- [x] Add an hourly encrypted local PostgreSQL backup and restore verification.
- [x] Reuse the verified candidate import for `getomerch_production`.
- [x] Add explicit `preflight`, `prepare`, `go`, `abort`, and `status` cutover states.
- [x] Verify locally and on the VPS without executing `prepare` or `go`.
- [x] Update migration status and operational documentation.

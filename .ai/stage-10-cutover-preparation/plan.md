# Plan

1. Add a visible and API-enforced read-only maintenance mode.
2. Add an hourly encrypted local PostgreSQL backup and restore verification.
3. Reuse the verified candidate import for `getomerch_production`.
4. Add explicit `preflight`, `prepare`, `go`, `abort`, and `status` cutover states.
5. Verify locally and on the VPS without executing `prepare` or `go`.
6. Update migration status and operational documentation.

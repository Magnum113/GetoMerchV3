# Stage 10 cutover preparation

Implement the agreed production-cutover defaults without opening writes or
switching the production source of truth until a separate final Go command:

- 60-minute maintenance window;
- hourly encrypted off-site PostgreSQL backup;
- rollback to Supabase only before the first local production write;
- worker starts only after Go;
- automatic Ozon timers remain disabled for the first 24 hours;
- Supabase remains unchanged for at least 30 days.

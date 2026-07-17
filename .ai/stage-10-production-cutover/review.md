# Review

## Findings resolved

1. The first `prepare` attempt found that a maintenance reason containing
   spaces was written without shell quoting. It failed before backup/import,
   and automatic pre-write rollback restored Supabase and the empty target.
   Commit `26284a9` added shell-safe quoting and the second attempt passed.
2. The first local backup inherited the KOMUI staging S3 prefix. Commit
   `327477a` gave GetoMerch backups an independent default namespace; a new
   backup confirmed the corrected destination.

## Verification

- Pre-write and post-write full UI/KOMUI/load smoke: passed.
- Ozon connectivity and first real queued orders sync: passed.
- Final source/target fingerprint and integrity checks: passed.
- Pre-Go and post-write encrypted backup/restore: passed.
- Web, worker, PostgreSQL and timer state: passed.

## Residual risk

- Simple Supabase rollback is no longer valid after the first local write.
- The old Supabase DB password still requires rotation during stabilization.
- Disk has about 4.5 GiB free; WAL/PITR requires a separate capacity step.

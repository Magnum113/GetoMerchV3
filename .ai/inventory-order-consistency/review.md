# Review

## Result

No production quantity data was lost. Frozen-source quantities plus all
post-cutover movements exactly match the current local PostgreSQL quantities.

The user-visible inconsistency was caused by the order page receiving only ten
positive inventory rows. The inventory matrix used the complete dataset, so the
two screens legitimately calculated from different snapshots.

## Remaining constraints

- Inventory pagination is bounded at 10,000 positive rows. Exceeding this limit
  is a visible error rather than a silent partial result.
- A concurrent change that makes offset pages overlap is also a visible retry
  error. Current production has 64 positive rows and is served in one page.
- Supabase remains read-only/frozen and was used only for reconciliation.

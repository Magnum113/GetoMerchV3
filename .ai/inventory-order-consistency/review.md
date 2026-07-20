# Review

## Result

No production quantity data was lost. Frozen-source quantities plus all
post-cutover movements exactly match the current local PostgreSQL quantities.

The user-visible inconsistency was caused by the order page receiving only ten
positive inventory rows. The inventory matrix used the complete dataset, so the
two screens legitimately calculated from different snapshots.

The audit also found a 50-order client cap. It did not exclude any of the 15
currently active FBS orders, but it could exclude an older active order in the
future and under-reserve stock. The client now loads all persisted order pages.

## Remaining constraints

- Inventory pagination is bounded at 10,000 positive rows. Exceeding this limit
  is a visible error rather than a silent partial result.
- Ozon order loading is bounded at 10,000 persisted orders with the same visible
  failure policy.
- A concurrent change that makes offset pages overlap is also a visible retry
  error. Current production has 64 positive rows and is served in one page.
- Supabase remains read-only/frozen and was used only for reconciliation.

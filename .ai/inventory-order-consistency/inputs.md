# Inventory and Ozon order consistency

## Request

Audit the complete inventory flow because warehouse quantities appear wrong and
Ozon orders report no white S blank T-shirt while the inventory dashboard shows
stock. Verify whether the server migration lost data, whether quantities are
calculated incorrectly, and whether the two screens use inconsistent data.

## Constraints

- Production source of truth is VPS PostgreSQL `getomerch_production`.
- Supabase is read-only/frozen and may only be used for migration reconciliation.
- Do not change production quantities without a proven data mismatch.
- Preserve unrelated local worktree changes.

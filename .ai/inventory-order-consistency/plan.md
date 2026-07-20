# Implementation plan

1. Add server pagination metadata to the inventory list route and repository.
2. Add a bounded client helper that fetches every positive inventory page.
3. Use the complete snapshot in both Ozon order availability and inventory UI.
4. Paginate the Ozon order source so all active FBS orders participate in stock
   reservation instead of only the newest 50 persisted rows.
5. Aggregate equivalent SKU stock in matrix cells and include variant dimensions
   in finished-product grouping.
6. Expand repository checks to verify pagination has no overlap and matrix totals
   equal the complete inventory list.
7. Build and run focused checks locally, deploy through the GetoMerch release
   process, then verify white S and aggregate quantities on production.

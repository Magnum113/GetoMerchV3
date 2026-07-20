# Implementation plan

1. Add server pagination metadata to the inventory list route and repository.
2. Add a bounded client helper that fetches every positive inventory page.
3. Use the complete snapshot in both Ozon order availability and inventory UI.
4. Aggregate equivalent SKU stock in matrix cells and include variant dimensions
   in finished-product grouping.
5. Expand repository checks to verify pagination has no overlap and matrix totals
   equal the complete inventory list.
6. Build and run focused checks locally, deploy through the GetoMerch release
   process, then verify white S and aggregate quantities on production.

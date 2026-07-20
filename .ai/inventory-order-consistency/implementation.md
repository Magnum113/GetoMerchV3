# Implementation

## Inventory list

- Added bounded `offset` pagination to the PostgreSQL and Supabase repository
  adapters and to `/api/admin/inventory`.
- Replaced the client-side `limit=10` request with a complete bounded page loop.
- Added duplicate and non-advancing-page guards so the UI does not silently use
  a partial or double-counted snapshot.

## Matrix

- Matrix cells now sum inventory from equivalent legacy/new product records
  instead of overwriting the previous product's quantities.
- Finished matrix keys include `design_version`, `hoodie_fit`, and
  `hoodie_fabric`, so physically different variants are not merged.

## Verification

- BFF smoke checks validate inventory page metadata and non-overlapping pages.
- Repository checks fetch every positive inventory row and require exact parity
  between list totals and matrix totals for blank and finished products.
- Production migration reconciliation compared every product/warehouse and
  print/warehouse pair against frozen Supabase plus post-cutover movements.

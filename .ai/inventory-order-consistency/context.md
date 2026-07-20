# Context and findings

## Confirmed root cause

`api.listInventory()` requests `limit=10`. Both `/orders` availability and the
inventory `Products` tab use this call, while the dashboard matrix queries all
inventory rows. Production currently has 64 positive inventory rows. The white
regular S blank row is position 13 and the matching finished D15 row is position
52, so neither reaches the order availability calculation.

## Production reconciliation

- Frozen Supabase inventory: 132 rows, 124 units.
- Local PostgreSQL inventory: 132 rows, 123 units.
- Post-cutover product movement delta: -1 unit.
- Expected current quantity: 123 units.
- Per product/warehouse mismatches: 0.
- Frozen Supabase print inventory: 12 rows, 50 units.
- Local PostgreSQL print inventory: 12 rows, 45 units.
- Post-cutover print movement delta: -5 units.
- Per design/warehouse mismatches: 0.
- Product IDs and warehouse IDs match frozen Supabase exactly.

No inventory data was lost during or after cutover.

## White S production state

- Blank SKU: `TSHIRT-REG-BELYY-S-BLANK`.
- Own warehouse blank quantity: 3.
- Workshop blank quantity: 1.
- Active order SKU: `D15-TSH-PRT-WHT-S`, quantity 1.
- Matching finished quantity on own warehouse: 1.

With complete inventory input the order is ready from finished stock; the UI's
zero-stock result is caused by the ten-row client cap.

## Secondary display risk

The matrix groups finished products into cells and assigns each product to the
cell. Duplicate legacy/new SKUs in one cell can overwrite an earlier stock map.
The matrix must aggregate stock across equivalent SKUs and distinguish actual
hoodie variants in its grouping key.

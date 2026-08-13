WITH function_source AS (
  SELECT pg_get_functiondef(
    'getomerch_marking.assert_product_profile_ready(uuid)'::regprocedure
  ) AS definition
)
SELECT
  'marking_live_ozon_requirement' AS check_name,
  definition LIKE '%fulfillment_order.source_status <> ALL%' AS ok,
  CASE
    WHEN definition LIKE '%fulfillment_order.source_status <> ALL%'
      THEN 'terminal statuses excluded'
    ELSE 'terminal statuses included'
  END AS actual,
  'terminal statuses excluded' AS expected
FROM function_source;

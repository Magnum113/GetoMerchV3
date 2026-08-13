-- Product readiness must use current actionable Ozon FBS postings. A terminal
-- posting is historical evidence and must not block a product profile.

CREATE OR REPLACE FUNCTION getomerch_marking.assert_product_profile_ready(
  p_profile_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  profile_record record;
  shared_profile record;
BEGIN
  SELECT
    profile.id,
    profile.trade_item_id,
    profile.requires_marking,
    profile.marking_requirement,
    profile.verification_status,
    profile.operational_status,
    profile.archived_at,
    product.is_blank AS product_is_blank,
    trade_item.product_group,
    trade_item.verification_status AS trade_verification_status,
    trade_item.archived_at AS trade_archived_at,
    trade_item.declared_color,
    trade_item.declared_size_int,
    color.name AS product_color,
    size.name AS product_size
  INTO profile_record
  FROM public.merch_marking_product_profiles AS profile
  JOIN public.merch_products AS product
    ON product.id = profile.product_id
  LEFT JOIN public.merch_colors AS color
    ON color.id = product.color_id
  LEFT JOIN public.merch_sizes AS size
    ON size.id = product.size_id
  LEFT JOIN public.merch_marking_trade_items AS trade_item
    ON trade_item.id = profile.trade_item_id
  WHERE profile.id = p_profile_id;

  IF FOUND
    AND profile_record.archived_at IS NULL
    AND profile_record.product_is_blank
  THEN
    RAISE EXCEPTION 'active marking profile must reference a sellable product'
      USING ERRCODE = 'MZ104';
  END IF;

  IF NOT FOUND
    OR profile_record.archived_at IS NOT NULL
    OR profile_record.operational_status <> 'enabled'
  THEN
    RETURN;
  END IF;

  IF profile_record.marking_requirement = 'unknown' THEN
    RAISE EXCEPTION 'enabled marking profile cannot have unknown requirement'
      USING ERRCODE = 'MZ105';
  END IF;

  IF NOT profile_record.requires_marking THEN
    RETURN;
  END IF;

  IF profile_record.verification_status <> 'verified'
    OR profile_record.trade_item_id IS NULL
    OR profile_record.product_group IS NULL
    OR profile_record.product_group = ''
    OR profile_record.trade_verification_status <> 'verified'
    OR profile_record.trade_archived_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'enabled marking profile requires an active verified trade item'
      USING ERRCODE = 'MZ101';
  END IF;

  IF (
    profile_record.declared_color IS NOT NULL
    AND profile_record.product_color IS NOT NULL
    AND getomerch_marking.normalized_attribute(profile_record.declared_color)
      <> getomerch_marking.normalized_attribute(profile_record.product_color)
  ) OR (
    profile_record.declared_size_int IS NOT NULL
    AND profile_record.product_size IS NOT NULL
    AND getomerch_marking.normalized_attribute(profile_record.declared_size_int)
      <> getomerch_marking.normalized_attribute(profile_record.product_size)
  ) THEN
    RAISE EXCEPTION 'catalog attributes conflict with product variant'
      USING ERRCODE = 'MZ106';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.merch_marking_product_profile_channels AS channel
    JOIN LATERAL (
      SELECT item.marking_requirement
      FROM public.merch_fulfillment_order_items AS item
      JOIN public.merch_fulfillment_orders AS fulfillment_order
        ON fulfillment_order.id = item.fulfillment_order_id
      WHERE fulfillment_order.source_channel = 'ozon_fbs'
        AND item.source_active
        AND fulfillment_order.source_status <> ALL (
          ARRAY[
            'delivering',
            'delivered',
            'driver_pickup',
            'sent_by_seller',
            'arbitration',
            'client_arbitration',
            'not_accepted',
            'cancelled'
          ]::text[]
        )
        AND item.offer_id = channel.offer_id
      ORDER BY item.updated_at DESC, item.id DESC
      LIMIT 1
    ) AS observed ON true
    WHERE channel.product_profile_id = profile_record.id
      AND channel.channel = 'ozon_fbs'
      AND channel.is_enabled
      AND observed.marking_requirement <> 'unknown'
      AND observed.marking_requirement <> profile_record.marking_requirement
  ) THEN
    RAISE EXCEPTION 'Ozon marking requirement conflicts with product profile'
      USING ERRCODE = 'MZ107';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.merch_marking_evidence AS evidence
    WHERE evidence.product_profile_id = profile_record.id
      AND evidence.evidence_type = 'product_profile_mapping'
      AND evidence.verification_status = 'verified'
  ) THEN
    RAISE EXCEPTION 'enabled marking profile requires verified product mapping evidence'
      USING ERRCODE = 'MZ102';
  END IF;

  FOR shared_profile IN
    SELECT other_profile.id
    FROM public.merch_marking_product_profiles AS other_profile
    WHERE other_profile.trade_item_id = profile_record.trade_item_id
      AND other_profile.id <> profile_record.id
      AND other_profile.archived_at IS NULL
      AND other_profile.requires_marking
      AND other_profile.verification_status = 'verified'
      AND other_profile.operational_status = 'enabled'
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM public.merch_marking_evidence AS evidence
      WHERE evidence.product_profile_id = profile_record.id
        AND evidence.evidence_type = 'shared_trade_item_mapping'
        AND evidence.verification_status = 'verified'
    ) OR NOT EXISTS (
      SELECT 1
      FROM public.merch_marking_evidence AS evidence
      WHERE evidence.product_profile_id = shared_profile.id
        AND evidence.evidence_type = 'shared_trade_item_mapping'
        AND evidence.verification_status = 'verified'
    ) THEN
      RAISE EXCEPTION 'shared trade item requires explicit verified evidence'
        USING ERRCODE = 'MZ103';
    END IF;
  END LOOP;
END
$function$;

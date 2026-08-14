DO $check$
DECLARE function_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'getomerch_marking.get_introduction_document_material(uuid,text)'::regprocedure
  ) INTO function_definition;

  IF function_definition !~ 'JOIN public[.]merch_fulfillment_order_items AS item'
     OR function_definition !~ 'item[.]offer_id'
     OR function_definition ~ 'assignment[.]offer_id' THEN
    RAISE EXCEPTION 'CRPT introduction material must read offer_id from fulfillment item';
  END IF;
END
$check$;


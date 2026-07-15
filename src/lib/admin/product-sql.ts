import "server-only";

export const ADMIN_PRODUCT_RELATION_JOINS = `
  LEFT JOIN merch_product_categories product_category ON product_category.id = p.category_id
  LEFT JOIN merch_fabric_types product_fabric ON product_fabric.id = p.fabric_id
  LEFT JOIN merch_colors product_color ON product_color.id = p.color_id
  LEFT JOIN merch_sizes product_size ON product_size.id = p.size_id
  LEFT JOIN merch_designs product_design ON product_design.id = p.design_id
  LEFT JOIN merch_decoration_types product_decoration_type ON product_decoration_type.id = p.decoration_type_id
`;

const ADMIN_PRODUCT_CATEGORY_JSON = `
  CASE
    WHEN product_category.id IS NULL THEN NULL
    ELSE jsonb_build_object(
      'id', product_category.id,
      'name', product_category.name,
      'slug', product_category.slug,
      'created_at', product_category.created_at
    )
  END
`;

const ADMIN_FABRIC_JSON = `
  CASE
    WHEN product_fabric.id IS NULL THEN NULL
    ELSE jsonb_build_object(
      'id', product_fabric.id,
      'name', product_fabric.name,
      'slug', product_fabric.slug,
      'created_at', product_fabric.created_at
    )
  END
`;

const ADMIN_COLOR_JSON = `
  CASE
    WHEN product_color.id IS NULL THEN NULL
    ELSE jsonb_build_object(
      'id', product_color.id,
      'name', product_color.name,
      'hex_code', product_color.hex_code,
      'created_at', product_color.created_at
    )
  END
`;

const ADMIN_SIZE_JSON = `
  CASE
    WHEN product_size.id IS NULL THEN NULL
    ELSE jsonb_build_object(
      'id', product_size.id,
      'name', product_size.name,
      'sort_order', product_size.sort_order,
      'created_at', product_size.created_at
    )
  END
`;

const ADMIN_DESIGN_JSON = `
  CASE
    WHEN product_design.id IS NULL THEN NULL
    ELSE jsonb_build_object(
      'id', product_design.id,
      'name', product_design.name,
      'type', product_design.type,
      'code', product_design.code,
      'description', product_design.description,
      'image_url', product_design.image_url,
      'created_at', product_design.created_at
    )
  END
`;

const ADMIN_DECORATION_TYPE_JSON = `
  CASE
    WHEN product_decoration_type.id IS NULL THEN NULL
    ELSE jsonb_build_object(
      'id', product_decoration_type.id,
      'name', product_decoration_type.name,
      'slug', product_decoration_type.slug,
      'made_at', product_decoration_type.made_at,
      'created_at', product_decoration_type.created_at
    )
  END
`;

export const ADMIN_PRODUCT_JSON = `
  CASE
    WHEN p.id IS NULL THEN NULL
    ELSE jsonb_build_object(
      'id', p.id,
      'category_id', p.category_id,
      'fabric_id', p.fabric_id,
      'color_id', p.color_id,
      'size_id', p.size_id,
      'design_id', p.design_id,
      'decoration_type_id', p.decoration_type_id,
      'sku', p.sku,
      'ozon_sku', p.ozon_sku,
      'legacy_skus', p.legacy_skus,
      'design_version', p.design_version,
      'hoodie_fit', p.hoodie_fit,
      'hoodie_fabric', p.hoodie_fabric,
      'is_blank', p.is_blank,
      'cost_price', p.cost_price,
      'sale_price', p.sale_price,
      'created_at', p.created_at,
      'category', ${ADMIN_PRODUCT_CATEGORY_JSON},
      'fabric', ${ADMIN_FABRIC_JSON},
      'color', ${ADMIN_COLOR_JSON},
      'size', ${ADMIN_SIZE_JSON},
      'design', ${ADMIN_DESIGN_JSON},
      'decoration_type', ${ADMIN_DECORATION_TYPE_JSON}
    )
  END
`;

export const ADMIN_WAREHOUSE_JSON = `
  CASE
    WHEN w.id IS NULL THEN NULL
    ELSE jsonb_build_object(
      'id', w.id,
      'name', w.name,
      'type', w.type,
      'address', w.address,
      'contact', w.contact,
      'notes', w.notes,
      'created_at', w.created_at
    )
  END
`;

export const ADMIN_INVENTORY_JSON = `
  jsonb_build_object(
    'id', i.id,
    'product_id', i.product_id,
    'warehouse_id', i.warehouse_id,
    'quantity', i.quantity,
    'updated_at', i.updated_at,
    'product', ${ADMIN_PRODUCT_JSON},
    'warehouse', ${ADMIN_WAREHOUSE_JSON}
  )
`;

export const ADMIN_OZON_ORDER_ITEM_JSON = `
  jsonb_build_object(
    'id', i.id,
    'order_id', i.order_id,
    'offer_id', i.offer_id,
    'ozon_sku', i.ozon_sku,
    'name', i.name,
    'quantity', i.quantity,
    'price', i.price,
    'product_id', i.product_id,
    'created_at', i.created_at,
    'shipped_from_warehouse_id', i.shipped_from_warehouse_id,
    'product', ${ADMIN_PRODUCT_JSON}
  )
`;

import "server-only";

export const ADMIN_PRODUCT_RELATION_JOINS = `
  LEFT JOIN merch_product_categories product_category ON product_category.id = p.category_id
  LEFT JOIN merch_fabric_types product_fabric ON product_fabric.id = p.fabric_id
  LEFT JOIN merch_colors product_color ON product_color.id = p.color_id
  LEFT JOIN merch_sizes product_size ON product_size.id = p.size_id
  LEFT JOIN merch_designs product_design ON product_design.id = p.design_id
  LEFT JOIN merch_decoration_types product_decoration_type ON product_decoration_type.id = p.decoration_type_id
`;

export const ADMIN_PRODUCT_JSON = `
  CASE
    WHEN p.id IS NULL THEN NULL
    ELSE to_jsonb(p) || jsonb_build_object(
      'category', to_jsonb(product_category),
      'fabric', to_jsonb(product_fabric),
      'color', to_jsonb(product_color),
      'size', to_jsonb(product_size),
      'design', to_jsonb(product_design),
      'decoration_type', to_jsonb(product_decoration_type)
    )
  END
`;

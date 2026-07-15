import "server-only";

export const ADMIN_PRODUCT_SELECT = `
  *,
  category:merch_product_categories(*),
  fabric:merch_fabric_types(*),
  color:merch_colors(*),
  size:merch_sizes(*),
  design:merch_designs(*),
  decoration_type:merch_decoration_types(*)
`;

export const ADMIN_PRODUCT_SELECT_INLINE = ADMIN_PRODUCT_SELECT.replace(/\s+/g, " ").trim();

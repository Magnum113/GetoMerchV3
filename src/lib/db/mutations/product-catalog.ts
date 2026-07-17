import "server-only";

import type { DatabaseQueryExecutor } from "@/lib/db/pool";
import { PostgresCatalogRepository } from "@/lib/db/repositories/catalog";
import { PostgresProductRepository } from "@/lib/db/repositories/products";
import type { Design, ExpenseCategory, Product } from "@/lib/types";
import { pickPatch, updateColumns } from "@/lib/db/mutations/crud";
import type { MutationOutcome } from "@/lib/db/mutations/runner";
import {
  conflict,
  dateValue,
  moneyValue,
  notFound,
  objectValue,
  oneOf,
  optionalString,
  positiveInteger,
  stringValue,
  uuidValue,
} from "@/lib/db/mutations/validation";

export type ProductInput = {
  categoryId: string;
  fabricId: string;
  colorId: string;
  sizeId: string;
  designId: string | null;
  decorationTypeId: string | null;
  designVersion: string | null;
  hoodieFit: string | null;
  hoodieFabric: string | null;
};

type ProductRow = Product;

export async function findOrCreateProduct(
  query: DatabaseQueryExecutor,
  raw: unknown,
): Promise<MutationOutcome<Product>> {
  const input = parseProductInput(raw);
  const result = await findOrCreateProductInternal(query, input);
  return {
    data: result.product,
    audit: {
      entityType: "product",
      entityId: result.product.id,
      before: result.created ? {} : criticalProduct(result.product),
      after: { ...criticalProduct(result.product), created: result.created },
    },
  };
}

export async function findOrCreateProductInternal(
  query: DatabaseQueryExecutor,
  input: ProductInput,
) {
  const isBlank = !input.designId && !input.decorationTypeId;
  if (!isBlank && (!input.designId || !input.decorationTypeId)) {
    conflict("invalid_product_variant", "Для готового товара нужны дизайн и тип нанесения.");
  }
  const lockKey = [
    input.categoryId,
    input.fabricId,
    input.colorId,
    input.sizeId,
    input.designId ?? "blank",
    input.decorationTypeId ?? "blank",
  ].join(":");
  await query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`product:${lockKey}`]);

  const values: unknown[] = [
    input.categoryId,
    input.fabricId,
    input.colorId,
    input.sizeId,
    isBlank,
  ];
  const conditions = [
    "category_id = $1::uuid",
    "fabric_id = $2::uuid",
    "color_id = $3::uuid",
    "size_id = $4::uuid",
    "is_blank = $5",
  ];
  if (isBlank) {
    conditions.push("design_id IS NULL", "decoration_type_id IS NULL");
  } else {
    values.push(input.designId, input.decorationTypeId);
    conditions.push(`design_id = $${values.length - 1}::uuid`);
    conditions.push(`decoration_type_id = $${values.length}::uuid`);
  }
  for (const [column, value] of [
    ["design_version", input.designVersion],
    ["hoodie_fit", input.hoodieFit],
    ["hoodie_fabric", input.hoodieFabric],
  ] as const) {
    if (value !== null) {
      values.push(value);
      conditions.push(`${column} = $${values.length}`);
    }
  }
  const matches = (
    await query<{ id: string }>(
      `SELECT id FROM merch_products WHERE ${conditions.join(" AND ")} ORDER BY id FOR UPDATE`,
      values,
    )
  ).rows;
  if (matches.length > 1) {
    conflict(
      "ambiguous_product_variant",
      "Несколько вариантов SKU для этой комбинации. Уточните версию, посадку или ткань.",
    );
  }
  if (matches[0]) {
    return { product: await hydrateProduct(query, matches[0].id), created: false };
  }

  const version = isBlank ? null : (input.designVersion ?? "V01");
  const sku = await buildSku(query, { ...input, designVersion: version }, isBlank);
  const inserted = (
    await query<{ id: string }>(
      `
        INSERT INTO merch_products (
          category_id,
          fabric_id,
          color_id,
          size_id,
          design_id,
          decoration_type_id,
          is_blank,
          design_version,
          hoodie_fit,
          hoodie_fabric,
          sku
        )
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8, $9, $10, $11)
        ON CONFLICT (sku) DO NOTHING
        RETURNING id
      `,
      [
        input.categoryId,
        input.fabricId,
        input.colorId,
        input.sizeId,
        input.designId,
        input.decorationTypeId,
        isBlank,
        version,
        input.hoodieFit,
        input.hoodieFabric,
        sku,
      ],
    )
  ).rows[0];
  const id = inserted?.id ?? (
    await query<{ id: string }>("SELECT id FROM merch_products WHERE sku = $1 FOR UPDATE", [sku])
  ).rows[0]?.id;
  if (!id) conflict("product_create_conflict", "Не удалось создать товар из-за параллельного изменения.");
  return { product: await hydrateProduct(query, id), created: Boolean(inserted) };
}

export async function updateProductPricesAction(
  query: DatabaseQueryExecutor,
  rawId: unknown,
  rawPatch: unknown,
): Promise<MutationOutcome<null>> {
  const id = uuidValue(rawId, "productId");
  const input = objectValue(rawPatch, "prices");
  const before = await lockProduct(query, id);
  const patch: Record<string, unknown> = {};
  if ("cost_price" in input) patch.cost_price = moneyValue(input.cost_price, "cost_price");
  if ("sale_price" in input) patch.sale_price = moneyValue(input.sale_price, "sale_price");
  await updateColumns(query, "merch_products", id, patch);
  return { data: null, audit: { entityType: "product", entityId: id, before, after: { ...before, ...patch } } };
}

export async function updateProductAction(
  query: DatabaseQueryExecutor,
  rawId: unknown,
  rawPatch: unknown,
): Promise<MutationOutcome<null>> {
  const id = uuidValue(rawId, "productId");
  const input = objectValue(rawPatch, "product");
  const before = await lockProduct(query, id);
  const patch: Record<string, unknown> = {};
  if ("sku" in input) patch.sku = optionalString(input.sku, "sku", 300);
  if ("cost_price" in input) patch.cost_price = moneyValue(input.cost_price, "cost_price");
  if ("sale_price" in input) patch.sale_price = moneyValue(input.sale_price, "sale_price");
  if ("design_id" in input) patch.design_id = input.design_id == null ? null : uuidValue(input.design_id, "design_id");
  await updateColumns(query, "merch_products", id, patch);
  return { data: null, audit: { entityType: "product", entityId: id, before, after: { ...before, ...patch } } };
}

export async function deleteProductAction(
  query: DatabaseQueryExecutor,
  rawId: unknown,
): Promise<MutationOutcome<null>> {
  const id = uuidValue(rawId, "productId");
  const before = await lockProduct(query, id);
  await query("DELETE FROM merch_products WHERE id = $1::uuid", [id]);
  return { data: null, audit: { entityType: "product", entityId: id, before, after: { deleted: true } } };
}

export async function catalogMutation(
  query: DatabaseQueryExecutor,
  action: string,
  args: unknown[],
): Promise<MutationOutcome<unknown>> {
  switch (action) {
    case "createDesign": {
      const input = objectValue(args[0], "design");
      const type = oneOf(input.type, ["print", "embroidery"] as const, "type");
      const row = (
        await query<Design>(
          `
            INSERT INTO merch_designs (name, type, description, image_url, code)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, name, type, code, description, image_url, created_at
          `,
          [
            stringValue(input.name, "name", 300),
            type,
            optionalString(input.description, "description"),
            optionalString(input.image_url, "image_url", 2000),
            optionalString(input.code, "code", 100),
          ],
        )
      ).rows[0];
      return { data: row, audit: { entityType: "design", entityId: row.id, after: row } };
    }
    case "updateDesign": {
      const id = uuidValue(args[0], "designId");
      const input = objectValue(args[1], "design");
      const before = await lockRow(query, "merch_designs", id, "id, name, type, code, description, image_url");
      const patch = pickPatch(input, { name: "name", type: "type", code: "code", description: "description", image_url: "image_url" });
      if (patch.name !== undefined) patch.name = stringValue(patch.name, "name", 300);
      if (patch.type !== undefined) patch.type = oneOf(patch.type, ["print", "embroidery"] as const, "type");
      for (const key of ["code", "description", "image_url"]) {
        if (patch[key] !== undefined) patch[key] = optionalString(patch[key], key, key === "image_url" ? 2000 : 5000);
      }
      await updateColumns(query, "merch_designs", id, patch);
      return { data: null, audit: { entityType: "design", entityId: id, before, after: { ...before, ...patch } } };
    }
    case "deleteDesign":
      return deleteSimple(query, "merch_designs", "design", args[0]);
    case "createColor": {
      const input = objectValue(args[0], "color");
      const row = (
        await query<{ id: string; name: string; hex_code: string | null }>(
          "INSERT INTO merch_colors (name, hex_code) VALUES ($1, $2) RETURNING id, name, hex_code",
          [stringValue(input.name, "name", 200), optionalString(input.hex_code, "hex_code", 20)],
        )
      ).rows[0];
      return { data: null, audit: { entityType: "color", entityId: row.id, after: row } };
    }
    case "updateColor":
      return updateSimple(query, "merch_colors", "color", args[0], args[1], { name: "name", hex_code: "hex_code" });
    case "deleteColor":
      return deleteSimple(query, "merch_colors", "color", args[0]);
    case "createSize": {
      const input = objectValue(args[0], "size");
      const row = (
        await query<{ id: string; name: string; sort_order: number }>(
          "INSERT INTO merch_sizes (name, sort_order) VALUES ($1, $2) RETURNING id, name, sort_order",
          [stringValue(input.name, "name", 100), Number.isSafeInteger(input.sort_order) ? input.sort_order : 0],
        )
      ).rows[0];
      return { data: null, audit: { entityType: "size", entityId: row.id, after: row } };
    }
    case "deleteSize":
      return deleteSimple(query, "merch_sizes", "size", args[0]);
    case "createWarehouse": {
      const input = objectValue(args[0], "warehouse");
      const row = (
        await query<{ id: string; name: string; type: string }>(
          `
            INSERT INTO merch_warehouses (name, type, address, contact, notes)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, name, type
          `,
          [
            stringValue(input.name, "name", 300),
            oneOf(input.type, ["own", "workshop"] as const, "type"),
            optionalString(input.address, "address"),
            optionalString(input.contact, "contact"),
            optionalString(input.notes, "notes"),
          ],
        )
      ).rows[0];
      return { data: null, audit: { entityType: "warehouse", entityId: row.id, after: row } };
    }
    case "updateWarehouse":
      return updateSimple(query, "merch_warehouses", "warehouse", args[0], args[1], {
        name: "name", type: "type", address: "address", contact: "contact", notes: "notes",
      });
    case "deleteWarehouse":
      return deleteSimple(query, "merch_warehouses", "warehouse", args[0]);
    case "createExpenseCategory": {
      const input = objectValue(args[0], "expenseCategory");
      const row = (
        await query<ExpenseCategory>(
          `
            INSERT INTO merch_expense_categories (name, color, sort_order)
            VALUES ($1, $2, $3)
            RETURNING id, name, color, sort_order, archived, created_at
          `,
          [
            stringValue(input.name, "name", 300),
            optionalString(input.color, "color", 30),
            Number.isSafeInteger(input.sort_order) ? input.sort_order : 0,
          ],
        )
      ).rows[0];
      return { data: row, audit: { entityType: "expense_category", entityId: row.id, after: row } };
    }
    case "updateExpenseCategory":
      return updateSimple(query, "merch_expense_categories", "expense_category", args[0], args[1], {
        name: "name", color: "color", sort_order: "sort_order", archived: "archived",
      });
    case "deleteExpenseCategory":
      return deleteSimple(query, "merch_expense_categories", "expense_category", args[0]);
    case "createExpense": {
      const input = objectValue(args[0], "expense");
      const row = (
        await query<{ id: string; category_id: string | null; amount: number; occurred_at: string; description: string | null }>(
          `
            INSERT INTO merch_expenses (category_id, amount, occurred_at, description)
            VALUES ($1::uuid, $2, $3::date, $4)
            RETURNING id, category_id, amount::float8 AS amount, occurred_at::text, description
          `,
          [
            input.categoryId == null ? null : uuidValue(input.categoryId, "categoryId"),
            positiveMoney(input.amount, "amount"),
            dateValue(input.occurredAt, "occurredAt"),
            optionalString(input.description, "description", 5000),
          ],
        )
      ).rows[0];
      return { data: null, audit: { entityType: "expense", entityId: row.id, after: row } };
    }
    case "updateExpense": {
      const id = uuidValue(args[0], "expenseId");
      const input = objectValue(args[1], "expense");
      const before = await lockRow(query, "merch_expenses", id, "id, category_id, amount::float8 AS amount, occurred_at::text, description");
      const patch: Record<string, unknown> = {};
      if ("categoryId" in input) patch.category_id = input.categoryId == null ? null : uuidValue(input.categoryId, "categoryId");
      if ("amount" in input) patch.amount = positiveMoney(input.amount, "amount");
      if ("occurredAt" in input) patch.occurred_at = dateValue(input.occurredAt, "occurredAt");
      if ("description" in input) patch.description = optionalString(input.description, "description", 5000);
      await updateColumns(query, "merch_expenses", id, patch);
      return { data: null, audit: { entityType: "expense", entityId: id, before, after: { ...before, ...patch } } };
    }
    case "deleteExpense":
      return deleteSimple(query, "merch_expenses", "expense", args[0]);
    default:
      conflict("unsupported_mutation", `Server mutation ${action} не реализована.`);
  }
}

async function updateSimple(
  query: DatabaseQueryExecutor,
  table: string,
  entityType: string,
  rawId: unknown,
  rawPatch: unknown,
  allowed: Record<string, string>,
): Promise<MutationOutcome<null>> {
  const id = uuidValue(rawId, `${entityType}Id`);
  const input = objectValue(rawPatch, entityType);
  const before = await lockRow(query, table, id, "*");
  const patch = pickPatch(input, allowed);
  await updateColumns(query, table, id, patch);
  return { data: null, audit: { entityType, entityId: id, before, after: { ...before, ...patch } } };
}

async function deleteSimple(
  query: DatabaseQueryExecutor,
  table: string,
  entityType: string,
  rawId: unknown,
): Promise<MutationOutcome<null>> {
  const id = uuidValue(rawId, `${entityType}Id`);
  const before = await lockRow(query, table, id, "*");
  await query(`DELETE FROM ${table} WHERE id = $1::uuid`, [id]);
  return { data: null, audit: { entityType, entityId: id, before, after: { deleted: true } } };
}

async function lockProduct(query: DatabaseQueryExecutor, id: string) {
  const row = (
    await query<Record<string, unknown>>(
      `
        SELECT id, sku, design_id, cost_price::float8 AS cost_price, sale_price::float8 AS sale_price, is_blank
        FROM merch_products
        WHERE id = $1::uuid
        FOR UPDATE
      `,
      [id],
    )
  ).rows[0];
  if (!row) notFound("Товар не найден.");
  return row;
}

async function lockRow(
  query: DatabaseQueryExecutor,
  table: string,
  id: string,
  columns: string,
) {
  const row = (
    await query<Record<string, unknown>>(
      `SELECT ${columns} FROM ${table} WHERE id = $1::uuid FOR UPDATE`,
      [id],
    )
  ).rows[0];
  if (!row) notFound("Запись не найдена.");
  return row;
}

async function hydrateProduct(query: DatabaseQueryExecutor, id: string) {
  const catalog = new PostgresCatalogRepository(query);
  const repository = new PostgresProductRepository(query, catalog);
  const product = (await repository.listByIds([id]))[0];
  if (!product) notFound("Товар не найден.");
  return product;
}

async function buildSku(query: DatabaseQueryExecutor, input: ProductInput, isBlank: boolean) {
  const row = (
    await query<{
      category_slug: string;
      fabric_slug: string;
      color_name: string;
      size_name: string;
      design_name: string | null;
      decoration_slug: string | null;
    }>(
      `
        SELECT
          category.slug AS category_slug,
          fabric.slug AS fabric_slug,
          color.name AS color_name,
          size.name AS size_name,
          design.name AS design_name,
          decoration.slug AS decoration_slug
        FROM merch_product_categories category
        JOIN merch_fabric_types fabric ON fabric.id = $2::uuid
        JOIN merch_colors color ON color.id = $3::uuid
        JOIN merch_sizes size ON size.id = $4::uuid
        LEFT JOIN merch_designs design ON design.id = $5::uuid
        LEFT JOIN merch_decoration_types decoration ON decoration.id = $6::uuid
        WHERE category.id = $1::uuid
      `,
      [input.categoryId, input.fabricId, input.colorId, input.sizeId, input.designId, input.decorationTypeId],
    )
  ).rows[0];
  if (!row) notFound("Не найдены справочники для создания товара.");
  let sku = `${row.category_slug}-${row.fabric_slug}-${slugify(row.color_name)}-${row.size_name}`;
  if (!isBlank) {
    if (!row.design_name || !row.decoration_slug) notFound("Дизайн или тип нанесения не найден.");
    sku += `-${slugify(row.design_name)}-${row.decoration_slug}`;
    if (input.hoodieFit) sku += `-${input.hoodieFit}`;
    if (input.hoodieFabric) sku += `-${input.hoodieFabric}`;
  } else {
    sku += "-blank";
  }
  return sku.toUpperCase();
}

function parseProductInput(raw: unknown): ProductInput {
  const input = objectValue(raw, "product");
  const designId = input.design_id == null ? null : uuidValue(input.design_id, "design_id");
  const decorationTypeId = input.decoration_type_id == null
    ? null
    : uuidValue(input.decoration_type_id, "decoration_type_id");
  return {
    categoryId: uuidValue(input.category_id, "category_id"),
    fabricId: uuidValue(input.fabric_id, "fabric_id"),
    colorId: uuidValue(input.color_id, "color_id"),
    sizeId: uuidValue(input.size_id, "size_id"),
    designId,
    decorationTypeId,
    designVersion: optionalString(input.design_version, "design_version", 30),
    hoodieFit: input.hoodie_fit == null ? null : oneOf(input.hoodie_fit, ["REG", "CRP"] as const, "hoodie_fit"),
    hoodieFabric: input.hoodie_fabric == null ? null : oneOf(input.hoodie_fabric, ["FLC", "NF"] as const, "hoodie_fabric"),
  };
}

function criticalProduct(product: Product) {
  return {
    id: product.id,
    sku: product.sku,
    ozon_sku: product.ozon_sku,
    design_id: product.design_id,
    cost_price: product.cost_price,
    sale_price: product.sale_price,
  };
}

function positiveMoney(value: unknown, name: string) {
  const parsed = moneyValue(value, name, false);
  if (parsed == null || parsed <= 0) conflict("invalid_amount", `${name}: сумма должна быть больше нуля.`);
  return parsed;
}

function slugify(text: string) {
  const map: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
    и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
    с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch",
    ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  };
  return text
    .toLowerCase()
    .split("")
    .map((character) => map[character] ?? character)
    .join("")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

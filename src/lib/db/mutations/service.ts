import "server-only";

import { DatabaseBusinessError } from "@/lib/db/errors";
import { inventoryMutation } from "@/lib/db/mutations/inventory-actions";
import {
  catalogMutation,
  deleteProductAction,
  findOrCreateProduct,
  updateProductAction,
  updateProductPricesAction,
} from "@/lib/db/mutations/product-catalog";
import { ozonMutation } from "@/lib/db/mutations/ozon";
import { runServerMutation, type ServerMutationContext } from "@/lib/db/mutations/runner";
import { workshopMutation } from "@/lib/db/mutations/workshop";

const INVENTORY_ACTIONS = new Set([
  "adjustInventory",
  "receive",
  "transfer",
  "sale",
  "writeoff",
  "adjust",
  "produce",
  "adjustPrintInventory",
  "receivePrint",
  "writeoffPrint",
  "adjustPrint",
]);

const WORKSHOP_ACTIONS = new Set([
  "createWorkshopOrder",
  "updateWorkshopOrderStatus",
]);

const OZON_ACTIONS = new Set([
  "shipOzonOrder",
  "unshipOzonOrder",
  "createWorkshopOrderFromOzon",
  "fulfillOzonViaWorkshop",
  "fulfillOzonViaProduction",
]);

const CATALOG_ACTIONS = new Set([
  "createDesign",
  "updateDesign",
  "deleteDesign",
  "createColor",
  "updateColor",
  "deleteColor",
  "createSize",
  "deleteSize",
  "createWarehouse",
  "updateWarehouse",
  "deleteWarehouse",
  "createExpenseCategory",
  "updateExpenseCategory",
  "deleteExpenseCategory",
  "createExpense",
  "updateExpense",
  "deleteExpense",
]);

export async function dispatchServerAdminMutation(
  action: string,
  args: unknown[],
  context: ServerMutationContext,
) {
  return runServerMutation({
    operation: `admin.rpc.${action}`,
    payload: args,
    context,
    execute: async (query, checkpoint) => {
      switch (action) {
        case "findOrCreateProduct":
          return findOrCreateProduct(query, args[0]);
        case "updateProductPrices":
          return updateProductPricesAction(query, args[0], args[1]);
        case "updateProduct":
          return updateProductAction(query, args[0], args[1]);
        case "deleteProduct":
          return deleteProductAction(query, args[0]);
        default:
          if (INVENTORY_ACTIONS.has(action)) return inventoryMutation(query, action, args, checkpoint);
          if (WORKSHOP_ACTIONS.has(action)) return workshopMutation(query, action, args, checkpoint);
          if (OZON_ACTIONS.has(action)) return ozonMutation(query, action, args, checkpoint);
          if (CATALOG_ACTIONS.has(action)) return catalogMutation(query, action, args);
          throw new DatabaseBusinessError(
            "unsupported_mutation",
            `Server mutation ${action} не реализована.`,
            400,
          );
      }
    },
  });
}

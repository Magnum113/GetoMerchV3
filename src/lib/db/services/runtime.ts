import "server-only";

import { getDatabaseRuntimeConfig, type DatabaseSource } from "@/lib/db/config";
import { queryServerDatabase } from "@/lib/db/pool";
import {
  PostgresCatalogRepository,
  SupabaseCatalogRepository,
  type CatalogRepository,
} from "@/lib/db/repositories/catalog";
import {
  PostgresProductRepository,
  SupabaseProductRepository,
  type ProductRepository,
} from "@/lib/db/repositories/products";
import {
  PostgresInventoryRepository,
  SupabaseInventoryRepository,
  type InventoryRepository,
} from "@/lib/db/repositories/inventory";
import {
  PostgresTransactionRepository,
  SupabaseTransactionRepository,
  type TransactionRepository,
} from "@/lib/db/repositories/transactions";
import {
  PostgresWorkshopRepository,
  SupabaseWorkshopRepository,
  type WorkshopRepository,
} from "@/lib/db/repositories/workshop";
import {
  PostgresOzonOrderRepository,
  SupabaseOzonOrderRepository,
  type OzonOrderRepository,
} from "@/lib/db/repositories/ozon-orders";
import {
  PostgresExpenseRepository,
  SupabaseExpenseRepository,
  type ExpenseRepository,
} from "@/lib/db/repositories/expenses";
import {
  PostgresFinanceRepository,
  SupabaseFinanceRepository,
  type FinanceRepository,
} from "@/lib/db/repositories/finance";
import {
  PostgresImportHistoryRepository,
  SupabaseImportHistoryRepository,
  type ImportHistoryRepository,
} from "@/lib/db/repositories/import-history";
import { CatalogService } from "@/lib/db/services/catalog-service";
import { ExpenseService } from "@/lib/db/services/expense-service";
import { FinanceService } from "@/lib/db/services/finance-service";
import { ImportHistoryService } from "@/lib/db/services/import-history-service";
import { InventoryService } from "@/lib/db/services/inventory-service";
import { OzonOrderService } from "@/lib/db/services/ozon-order-service";
import { ProductService } from "@/lib/db/services/product-service";
import { TransactionService } from "@/lib/db/services/transaction-service";
import { WorkshopService } from "@/lib/db/services/workshop-service";
import { getAdminSupabaseClient } from "@/lib/supabase/server";

export type DatabaseReadServices = {
  readSource: DatabaseSource;
  shadowSource: DatabaseSource | null;
  catalog: CatalogService;
  products: ProductService;
  inventory: InventoryService;
  transactions: TransactionService;
  workshop: WorkshopService;
  ozonOrders: OzonOrderService;
  expenses: ExpenseService;
  finance: FinanceService;
  importHistory: ImportHistoryService;
};

export function createDatabaseReadServices(): DatabaseReadServices {
  const config = getDatabaseRuntimeConfig();
  const primary = createRepositories(config.readSource);
  const shadowSource = config.shadowCompare ? otherSource(config.readSource) : null;
  const shadow = shadowSource ? createRepositories(shadowSource) : null;

  return {
    readSource: config.readSource,
    shadowSource,
    catalog: new CatalogService(
      primary.catalog,
      shadow?.catalog ?? null,
      config.shadowCompareStrict,
    ),
    products: new ProductService(
      primary.products,
      shadow?.products ?? null,
      config.shadowCompareStrict,
    ),
    inventory: new InventoryService(
      primary.inventory,
      shadow?.inventory ?? null,
      config.shadowCompareStrict,
    ),
    transactions: new TransactionService(
      primary.transactions,
      shadow?.transactions ?? null,
      config.shadowCompareStrict,
    ),
    workshop: new WorkshopService(
      primary.workshop,
      shadow?.workshop ?? null,
      config.shadowCompareStrict,
    ),
    ozonOrders: new OzonOrderService(
      primary.ozonOrders,
      shadow?.ozonOrders ?? null,
      config.shadowCompareStrict,
    ),
    expenses: new ExpenseService(
      primary.expenses,
      shadow?.expenses ?? null,
      config.shadowCompareStrict,
    ),
    finance: new FinanceService(
      primary.finance,
      shadow?.finance ?? null,
      config.shadowCompareStrict,
    ),
    importHistory: new ImportHistoryService(
      primary.importHistory,
      shadow?.importHistory ?? null,
      config.shadowCompareStrict,
    ),
  };
}

type RepositoryBundle = {
  catalog: CatalogRepository;
  products: ProductRepository;
  inventory: InventoryRepository;
  transactions: TransactionRepository;
  workshop: WorkshopRepository;
  ozonOrders: OzonOrderRepository;
  expenses: ExpenseRepository;
  finance: FinanceRepository;
  importHistory: ImportHistoryRepository;
};

function createRepositories(source: DatabaseSource): RepositoryBundle {
  if (source === "server") {
    const catalog = new PostgresCatalogRepository(queryServerDatabase);
    const products = new PostgresProductRepository(queryServerDatabase, catalog);
    return {
      catalog,
      products,
      inventory: new PostgresInventoryRepository(queryServerDatabase, catalog, products),
      transactions: new PostgresTransactionRepository(queryServerDatabase, catalog, products),
      workshop: new PostgresWorkshopRepository(queryServerDatabase, catalog, products),
      ozonOrders: new PostgresOzonOrderRepository(queryServerDatabase, products),
      expenses: new PostgresExpenseRepository(queryServerDatabase, catalog),
      finance: new PostgresFinanceRepository(queryServerDatabase, products),
      importHistory: new PostgresImportHistoryRepository(queryServerDatabase),
    };
  }

  const client = getAdminSupabaseClient();
  const catalog = new SupabaseCatalogRepository(client);
  const products = new SupabaseProductRepository(client, catalog);
  return {
    catalog,
    products,
    inventory: new SupabaseInventoryRepository(client, catalog, products),
    transactions: new SupabaseTransactionRepository(client, catalog, products),
    workshop: new SupabaseWorkshopRepository(client, catalog, products),
    ozonOrders: new SupabaseOzonOrderRepository(client, products),
    expenses: new SupabaseExpenseRepository(client, catalog),
    finance: new SupabaseFinanceRepository(client, products),
    importHistory: new SupabaseImportHistoryRepository(client),
  };
}

function otherSource(source: DatabaseSource): DatabaseSource {
  return source === "server" ? "supabase" : "server";
}

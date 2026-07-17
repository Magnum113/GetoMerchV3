import "server-only";

import type {
  OzonOrderListOptions,
  OzonOrderRepository,
} from "@/lib/db/repositories/ozon-orders";
import { runShadowedRead } from "@/lib/db/services/shadow-compare";

export class OzonOrderService {
  constructor(
    private readonly primary: OzonOrderRepository,
    private readonly shadow: OzonOrderRepository | null,
    private readonly strict: boolean,
  ) {}

  list(options: OzonOrderListOptions) {
    return runShadowedRead({
      operation: "ozonOrders.list",
      primary: () => this.primary.list(options),
      shadow: this.shadow ? () => this.shadow!.list(options) : null,
      strict: this.strict,
    });
  }
}

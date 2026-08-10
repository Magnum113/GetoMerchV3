import { MarkingDomainError } from "@/lib/marking/domain/errors";
import {
  MARKING_FULFILLMENT_MODES,
  MARKING_PRODUCTION_MODES,
  type MarkingFulfillmentMode,
  type MarkingProductionMode,
  type MarkingVerificationStatus,
} from "@/lib/marking/domain/states";

export function normalizeGtin14(value: string) {
  const digits = value.trim();
  if (!/^\d{8,14}$/.test(digits)) {
    throw new MarkingDomainError("invalid_gtin", "GTIN must contain 8 to 14 digits");
  }
  const canonical = digits.padStart(14, "0");
  if (!isValidGtin14(canonical)) {
    throw new MarkingDomainError("invalid_gtin", "GTIN check digit is invalid");
  }
  return canonical;
}

export function isValidGtin14(value: string) {
  if (!/^\d{14}$/.test(value) || value === "00000000000000") return false;
  let sum = 0;
  for (let index = 0; index < 13; index += 1) {
    sum += Number(value[index]) * (index % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === Number(value[13]);
}

export function assertProductProfileInvariant(input: {
  requiresMarking: boolean;
  productionMode: MarkingProductionMode;
  fulfillmentMarkingMode: MarkingFulfillmentMode;
  verificationStatus: MarkingVerificationStatus;
  tradeItemId?: string | null;
  verifiedProductMappingEvidenceCount?: number;
}) {
  if (!(MARKING_PRODUCTION_MODES as readonly string[]).includes(input.productionMode)) {
    throw new MarkingDomainError("invalid_product_profile", "Unknown production mode");
  }
  if (
    !(MARKING_FULFILLMENT_MODES as readonly string[])
      .includes(input.fulfillmentMarkingMode)
  ) {
    throw new MarkingDomainError(
      "invalid_product_profile",
      "Unknown fulfillment marking mode",
    );
  }
  const minorCustomization = input.productionMode === "pre_marked_minor_customization";
  if (
    minorCustomization
    !== (input.fulfillmentMarkingMode === "pre_marked_minor_customization")
  ) {
    throw new MarkingDomainError(
      "invalid_product_profile",
      "Production and fulfillment modes are incompatible",
    );
  }
  if (
    input.requiresMarking
    && input.verificationStatus === "verified"
    && (!input.tradeItemId || (input.verifiedProductMappingEvidenceCount ?? 0) < 1)
  ) {
    throw new MarkingDomainError(
      "invalid_product_profile",
      "Verified marking profile requires a trade item and verified mapping evidence",
    );
  }
}

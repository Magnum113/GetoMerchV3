import { NextRequest } from "next/server";
import { AdminApiError, adminErrorResponse, adminJson } from "@/lib/admin/http";
import {
  markingMutationError,
  requireMarkingAdminSession,
  requireMarkingMutationContext,
  requireObjectBody,
  requiredString,
} from "@/lib/marking/http";
import {
  getCrptReadWorkspace,
  requestCrptAuthRefresh,
  requestCrptReadCheck,
} from "@/lib/marking/services/crpt-read-service";
import {
  retryCrptCirculationConfirmation,
  reconcileCrptIntroduction,
  retryCrptIntroduction,
} from "@/lib/marking/services/crpt-introduction-service";
import { retryCrptWithdrawal } from "@/lib/marking/services/crpt-withdrawal-service";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireMarkingAdminSession();
    return adminJson({ data: await getCrptReadWorkspace() });
  } catch (error) {
    return adminErrorResponse(markingMutationError(error));
  }
}

export async function POST(request: NextRequest) {
  try {
    const context = await requireMarkingMutationContext(request);
    const body = requireObjectBody(await request.json().catch(() => null));
    const operation = requiredString(body, "operation");
    if (operation === "refresh_auth") {
      const data = await requestCrptAuthRefresh(context);
      return adminJson({ data }, { status: 202 });
    }
    if (operation === "check_code") {
      const data = await requestCrptReadCheck({
        queryType: "code_status",
        markingCodeId: requiredString(body, "markingCodeId"),
      }, context);
      return adminJson({ data }, { status: 202 });
    }
    if (operation === "check_document") {
      const data = await requestCrptReadCheck({
        queryType: "document_status",
        externalDocumentId: requiredString(body, "externalDocumentId"),
      }, context);
      return adminJson({ data }, { status: 202 });
    }
    if (operation === "retry_introduction") {
      const data = await retryCrptIntroduction(requiredString(body, "assignmentId"), context);
      return adminJson({ data }, { status: 202 });
    }
    if (operation === "reconcile_introduction") {
      const data = await reconcileCrptIntroduction({
        documentId: requiredString(body, "documentId"),
        externalDocumentId: requiredString(body, "externalDocumentId"),
      }, context);
      return adminJson({ data }, { status: 202 });
    }
    if (operation === "retry_circulation") {
      const data = await retryCrptCirculationConfirmation(
        requiredString(body, "documentId"),
        context,
      );
      return adminJson({ data }, { status: 202 });
    }
    if (operation === "retry_withdrawal") {
      const data = await retryCrptWithdrawal(requiredString(body, "handoverId"), context);
      return adminJson({ data }, { status: 202 });
    }
    throw new AdminApiError(400, "bad_request", "Invalid CRPT operation");
  } catch (error) {
    return adminErrorResponse(markingMutationError(error));
  }
}

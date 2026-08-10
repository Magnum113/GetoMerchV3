import { NextRequest, NextResponse } from "next/server";
import { adminErrorResponse } from "@/lib/admin/http";
import {
  markingMutationError,
  requireMarkingMutationContext,
  requireObjectBody,
  requiredInteger,
} from "@/lib/marking/http";
import { generateJitMarkingLabel } from "@/lib/marking/services/label-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  contextInput: { params: Promise<{ id: string }> },
) {
  try {
    const context = await requireMarkingMutationContext(request);
    const body = requireObjectBody(await request.json().catch(() => null));
    const { id } = await contextInput.params;
    const result = await generateJitMarkingLabel({
      assignmentId: id,
      expectedRevision: requiredInteger(body, "expectedRevision"),
    }, context);
    return new NextResponse(Buffer.from(result.pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${result.filename}"`,
        "Cache-Control": "no-store, private",
        Pragma: "no-cache",
        "X-Content-Type-Options": "nosniff",
        "X-Marking-Assignment-Revision": String(
          result.receipt.assignmentRevision,
        ),
        "X-Marking-Render-Count": String(result.receipt.renderCount),
        "X-Marking-Template-Version": result.receipt.templateVersion,
      },
    });
  } catch (error) {
    return adminErrorResponse(markingMutationError(error));
  }
}

import "server-only";

import { queryServerDatabase } from "@/lib/db/pool";
import type { ServerMutationContext } from "@/lib/db/mutations/runner";
import { runServerMutation } from "@/lib/db/mutations/runner";
import {
  getMarkingRuntimeConfig,
  type MarkingRuntimeConfig,
} from "@/lib/marking/config";
import { MarkingDomainError } from "@/lib/marking/domain/errors";
import {
  MARKING_LABEL_TEMPLATE_VERSION,
  renderMarkingLabelPdf,
} from "@/lib/marking/labels/template";
import {
  getJitLabelMaterial,
  recordJitLabelRender,
} from "@/lib/marking/repositories/labels";
import {
  loadMarkingKeyring,
  type MarkingKeyring,
} from "@/lib/marking/security/keyring";

type LabelDependencies = {
  config?: MarkingRuntimeConfig;
  keyring?: MarkingKeyring;
};

export async function generateJitMarkingLabel(
  input: { assignmentId: string; expectedRevision: number },
  context: ServerMutationContext,
  dependencies: LabelDependencies = {},
) {
  assertUuid(input.assignmentId);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new MarkingDomainError(
      "invalid_label",
      "Некорректная версия назначения",
    );
  }
  const config = dependencies.config ?? getMarkingRuntimeConfig();
  assertLabelOperatorAccess(config, context.actor);
  const material = await getJitLabelMaterial(queryServerDatabase, {
    ...input,
    actorId: context.actor,
  });
  assertLabelAccess(config, context.actor, material.gtin, material.offerId);
  const keyring = dependencies.keyring ?? await loadMarkingKeyring(config.keyringFile);
  const code = keyring.decryptBytes({
    algorithm: "aes-256-gcm",
    keyVersion: material.encryptionKeyVersion,
    ciphertext: material.codeCiphertext.toString("base64"),
    iv: material.codeNonce.toString("base64"),
    authTag: material.codeAuthTag.toString("base64"),
  });

  try {
    const rendered = await renderMarkingLabelPdf(code, {
      gtin: material.gtin,
      fingerprint: material.codeFingerprint,
      offerId: material.offerId,
      productSku: material.productSku,
      postingNumber: material.postingNumber,
      unitOrdinal: material.unitOrdinal,
      itemQuantity: material.itemQuantity,
    });
    const receipt = await runServerMutation({
      operation: "marking.label.render",
      payload: {
        assignmentId: material.assignmentId,
        expectedRevision: input.expectedRevision,
        codeBindingId: material.codeBindingId,
        codeFingerprint: material.codeFingerprint,
        templateVersion: MARKING_LABEL_TEMPLATE_VERSION,
      },
      context,
      execute: async (query, checkpoint) => {
        const recorded = await recordJitLabelRender(query, {
          assignmentId: material.assignmentId,
          expectedRevision: input.expectedRevision,
          codeBindingId: material.codeBindingId,
          codeFingerprint: material.codeFingerprint,
          templateVersion: MARKING_LABEL_TEMPLATE_VERSION,
          actorId: context.actor,
        });
        checkpoint("label_render_recorded");
        return {
          data: recorded,
          audit: {
            entityType: "marking_label",
            entityId: material.assignmentId,
            before: {
              assignmentRevision: input.expectedRevision,
              labelState: material.labelState,
              renderCount: material.renderCount,
            },
            after: recorded,
          },
        };
      },
    });
    return {
      pdf: rendered.pdf,
      receipt,
      filename: `marking-label-${material.assignmentId.slice(0, 8)}.pdf`,
    };
  } finally {
    code.fill(0);
    material.codeCiphertext.fill(0);
    material.codeNonce.fill(0);
    material.codeAuthTag.fill(0);
  }
}

export function assertLabelAccess(
  config: MarkingRuntimeConfig,
  actor: string,
  gtin: string,
  offerId: string | null,
) {
  assertLabelOperatorAccess(config, actor);
  if (!config.allowedGtins.includes(gtin)) {
    throw new MarkingDomainError(
      "assignment_access_denied",
      "GTIN не включён в контур печати КМ",
    );
  }
  if (!offerId || !config.allowedOffers.includes(offerId)) {
    throw new MarkingDomainError(
      "assignment_access_denied",
      "Артикул не включён в контур печати КМ",
    );
  }
}

function assertLabelOperatorAccess(
  config: MarkingRuntimeConfig,
  actor: string,
) {
  if (!config.enabled || !config.labelsEnabled || !config.justInTimeEnabled) {
    throw new MarkingDomainError(
      "assignment_access_denied",
      "Генерация этикеток отключена",
    );
  }
  if (!config.allowedAdminIds.includes(actor)) {
    throw new MarkingDomainError(
      "assignment_access_denied",
      "Оператор не включён в контур печати КМ",
    );
  }
}

function assertUuid(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value)) {
    throw new MarkingDomainError(
      "invalid_label",
      "Некорректный идентификатор назначения",
    );
  }
}

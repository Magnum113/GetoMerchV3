import "server-only";

import type { DatabaseQueryExecutor } from "@/lib/db/pool";

export type MarkingLabelMaterial = {
  assignmentId: string;
  assignmentRevision: number;
  codeBindingId: string;
  encryptionKeyVersion: number;
  codeCiphertext: Buffer;
  codeNonce: Buffer;
  codeAuthTag: Buffer;
  gtin: string;
  codeFingerprint: string;
  offerId: string | null;
  productSku: string | null;
  postingNumber: string | null;
  unitOrdinal: number;
  itemQuantity: number;
  labelState: string;
  renderCount: number;
};

export type MarkingLabelReceipt = {
  assignmentId: string;
  assignmentRevision: number;
  labelState: string;
  renderCount: number;
  templateVersion: string;
  renderedAt: string;
  isReprint: boolean;
};

export async function getJitLabelMaterial(
  query: DatabaseQueryExecutor,
  input: {
    assignmentId: string;
    expectedRevision: number;
    actorId: string;
  },
): Promise<MarkingLabelMaterial> {
  const row = (
    await query<{
      assignment_id: string;
      assignment_revision: string;
      code_binding_id: string;
      encryption_key_version: number;
      code_ciphertext: Buffer;
      code_nonce: Buffer;
      code_auth_tag: Buffer;
      gtin: string;
      code_fingerprint: string;
      offer_id: string | null;
      product_sku: string | null;
      posting_number: string | null;
      unit_ordinal: number;
      item_quantity: number;
      label_state: string;
      render_count: number;
    }>(
      `
        SELECT
          assignment_id,
          assignment_revision,
          code_binding_id,
          encryption_key_version,
          code_ciphertext,
          code_nonce,
          code_auth_tag,
          gtin,
          code_fingerprint,
          offer_id,
          product_sku,
          posting_number,
          unit_ordinal,
          item_quantity,
          label_state,
          render_count
        FROM getomerch_marking.get_jit_label_material($1::uuid, $2::bigint, $3)
      `,
      [input.assignmentId, input.expectedRevision, input.actorId],
    )
  ).rows[0];
  return {
    assignmentId: row.assignment_id,
    assignmentRevision: Number(row.assignment_revision),
    codeBindingId: row.code_binding_id,
    encryptionKeyVersion: row.encryption_key_version,
    codeCiphertext: row.code_ciphertext,
    codeNonce: row.code_nonce,
    codeAuthTag: row.code_auth_tag,
    gtin: row.gtin,
    codeFingerprint: row.code_fingerprint,
    offerId: row.offer_id,
    productSku: row.product_sku,
    postingNumber: row.posting_number,
    unitOrdinal: row.unit_ordinal,
    itemQuantity: row.item_quantity,
    labelState: row.label_state,
    renderCount: row.render_count,
  };
}

export async function recordJitLabelRender(
  query: DatabaseQueryExecutor,
  input: {
    assignmentId: string;
    expectedRevision: number;
    codeBindingId: string;
    codeFingerprint: string;
    templateVersion: string;
    actorId: string;
  },
): Promise<MarkingLabelReceipt> {
  const row = (
    await query<{
      assignment_id: string;
      assignment_revision: string;
      label_state: string;
      render_count: number;
      template_version: string;
      rendered_at: Date | string;
      is_reprint: boolean;
    }>(
      `
        SELECT
          assignment_id,
          assignment_revision,
          label_state,
          render_count,
          template_version,
          rendered_at,
          is_reprint
        FROM getomerch_marking.record_jit_label_render(
          $1::uuid,
          $2::bigint,
          $3::uuid,
          $4,
          $5,
          $6
        )
      `,
      [
        input.assignmentId,
        input.expectedRevision,
        input.codeBindingId,
        input.codeFingerprint,
        input.templateVersion,
        input.actorId,
      ],
    )
  ).rows[0];
  return {
    assignmentId: row.assignment_id,
    assignmentRevision: Number(row.assignment_revision),
    labelState: row.label_state,
    renderCount: row.render_count,
    templateVersion: row.template_version,
    renderedAt: new Date(row.rendered_at).toISOString(),
    isReprint: row.is_reprint,
  };
}

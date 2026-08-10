export type MarkingCursorKind =
  | "readiness"
  | "processes"
  | "events"
  | "code_pool"
  | "code_imports"
  | "assignments";

export class InvalidMarkingCursorError extends Error {
  constructor() {
    super("Invalid marking cursor");
    this.name = "InvalidMarkingCursorError";
  }
}

type CursorPayload = {
  v: 1;
  kind: MarkingCursorKind;
  timestamp: string;
  id: string;
};

export function encodeMarkingCursor(
  kind: MarkingCursorKind,
  timestamp: string,
  id: string,
) {
  const payload: CursorPayload = { v: 1, kind, timestamp, id };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeMarkingCursor(
  value: string | null | undefined,
  expectedKind: MarkingCursorKind,
) {
  if (!value) return null;
  if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new InvalidMarkingCursorError();
  }
  try {
    const payload = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<CursorPayload>;
    if (
      payload.v !== 1
      || payload.kind !== expectedKind
      || typeof payload.timestamp !== "string"
      || !Number.isFinite(Date.parse(payload.timestamp))
      || typeof payload.id !== "string"
      || payload.id.length < 1
      || payload.id.length > 80
      || (
        expectedKind === "events"
          ? !/^\d+$/.test(payload.id)
          : !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
            .test(payload.id)
      )
    ) {
      throw new InvalidMarkingCursorError();
    }
    return { timestamp: payload.timestamp, id: payload.id };
  } catch (error) {
    if (error instanceof InvalidMarkingCursorError) throw error;
    throw new InvalidMarkingCursorError();
  }
}

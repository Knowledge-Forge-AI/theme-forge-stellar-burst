import { createHmac, timingSafeEqual } from "node:crypto";

import type { WorkspaceRecordKey } from "../workspace-list.js";
import { ProtocolError } from "./errors.js";
import type { StudioProtocolVersion } from "./v1-types.js";

export type CursorScope =
  | { readonly method: "asset.list"; readonly kind: "project"; readonly handle: string }
  | { readonly method: "asset.list"; readonly kind: "workspace"; readonly handle: string }
  | { readonly method: "source.analyze"; readonly kind: "source"; readonly handle: string }
  | { readonly method: "brand.family.list" | "brand.token.list" | "brand.consumer.profile.list" | "brand.export.status" | "brand.qa.profile.list"; readonly kind: "project"; readonly handle: string };

export type CursorRecordKey = WorkspaceRecordKey | { readonly projectId: string; readonly kind: "brand"; readonly id: string };

export interface ServiceCursorPayloadV1 {
  readonly protocolVersion: StudioProtocolVersion;
  readonly scope: CursorScope;
  readonly viewDigest: string;
  readonly streamDigest?: string;
  readonly lastKey: CursorRecordKey;
  readonly pageSize: number;
}

interface CursorEnvelope { readonly payload: string; readonly mac: string }

function canonical(value: ServiceCursorPayloadV1): string { return JSON.stringify(value); }

export class CursorCodec {
  #secret: Buffer | undefined;

  constructor(secret: Uint8Array) { this.#secret = Buffer.from(secret); }

  encode(value: ServiceCursorPayloadV1): string {
    const secret = this.#secret;
    if (secret === undefined) throw new ProtocolError("CURSOR_INVALID");
    const payload = Buffer.from(canonical(value), "utf8").toString("base64url");
    const mac = createHmac("sha256", secret).update(payload).digest("base64url");
    return Buffer.from(JSON.stringify({ payload, mac } satisfies CursorEnvelope), "utf8").toString("base64url");
  }

  decode(encoded: string, expectedScope: CursorScope, expectedPageSize: number, expectedProtocolVersion: StudioProtocolVersion = "1.0"): ServiceCursorPayloadV1 {
    const secret = this.#secret;
    if (secret === undefined || !/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length > 16_384) throw new ProtocolError("CURSOR_INVALID");
    try {
      const outerBytes = Buffer.from(encoded, "base64url");
      if (outerBytes.toString("base64url") !== encoded) throw new ProtocolError("CURSOR_INVALID");
      const outerText = new TextDecoder("utf8", { fatal: true }).decode(outerBytes);
      const envelope = JSON.parse(outerText) as unknown;
      if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope) || Object.keys(envelope).join(",") !== "payload,mac") throw new ProtocolError("CURSOR_INVALID");
      const { payload, mac } = envelope as Partial<CursorEnvelope>;
      if (typeof payload !== "string" || typeof mac !== "string") throw new ProtocolError("CURSOR_INVALID");
      const actual = Buffer.from(mac, "base64url");
      const expected = createHmac("sha256", secret).update(payload).digest();
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new ProtocolError("CURSOR_INVALID");
      const payloadBytes = Buffer.from(payload, "base64url");
      if (payloadBytes.toString("base64url") !== payload) throw new ProtocolError("CURSOR_INVALID");
      const payloadText = new TextDecoder("utf8", { fatal: true }).decode(payloadBytes);
      const value = JSON.parse(payloadText) as ServiceCursorPayloadV1;
      if (canonical(value) !== payloadText || value.protocolVersion !== expectedProtocolVersion || !Number.isInteger(value.pageSize) || value.pageSize !== expectedPageSize || value.pageSize < 1 || value.pageSize > 128) throw new ProtocolError("CURSOR_INVALID");
      if (JSON.stringify(value.scope) !== JSON.stringify(expectedScope)) throw new ProtocolError("CURSOR_INVALID");
      const key = value.lastKey;
      if (typeof value.viewDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.viewDigest) || value.streamDigest !== undefined && !/^sha256:[0-9a-f]{64}$/.test(value.streamDigest) || typeof key !== "object" || key === null || typeof key.projectId !== "string" || (key.kind !== "asset" && key.kind !== "companion" && key.kind !== "brand") || typeof key.id !== "string") throw new ProtocolError("CURSOR_INVALID");
      return value;
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError("CURSOR_INVALID");
    }
  }

  destroy(): void {
    this.#secret?.fill(0);
    this.#secret = undefined;
  }
}

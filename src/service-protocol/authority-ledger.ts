import { ProtocolError } from "./errors.js";
import { canonicalJson } from "./canonical-json.js";

/** The fixed accounting constants shared by handles and retained plans. */
export const MAX_RETAINED_AUTHORITY_BYTES = 201_326_592 as const;
export const MAX_RETAINED_NATIVE_SNAPSHOT_PLANS = 1 as const;
export const PLAN_METADATA_CHARGE_BYTES = 1_048_576 as const;

export type AuthorityReservationKind = "handle" | "plan";

export interface AuthorityLedgerOptions {
  readonly maxRetainedBytes?: number;
  readonly maxRetainedNativeSnapshotPlans?: number;
}

export interface AuthorityAdmission {
  readonly kind: AuthorityReservationKind;
  /** The complete charge for this reservation, in bytes. */
  readonly retainedBytes: number;
  readonly nativeSnapshot?: boolean;
}

export interface RetainedAuthorityParts {
  /** Every retained byte-array instance, including copies, appears separately. */
  readonly byteArrays?: readonly ArrayBufferView[];
  /** Every retained string occurrence appears separately. */
  readonly strings?: readonly string[];
  /** Pre-measured UTF-8 lengths, useful with a private retention inspector. */
  readonly stringByteLengths?: readonly number[];
  /** A public summary is serialized with the supplied canonical encoder. */
  readonly summary?: unknown;
  /** Use when the caller already measured the canonical public summary. */
  readonly summaryBytes?: number;
  /** Additional fixed/object charge, normally PLAN_METADATA_CHARGE_BYTES. */
  readonly metadataBytes?: number;
}

/**
 * Count explicit retained byte/string instances.  This helper intentionally
 * does not walk arbitrary objects: WeakMap-owned plan state must be inspected
 * by its owner and reported explicitly rather than estimated from a DTO.
 */
export function retainedAuthorityBytes(parts: RetainedAuthorityParts): number {
  let total = 0;
  for (const bytes of parts.byteArrays ?? []) {
    if (!ArrayBuffer.isView(bytes)) {
      throw new TypeError("Retained byte arrays must be byte views.");
    }
    total = checkedAdd(total, checkedNonNegativeInteger(bytes.byteLength));
  }
  for (const string of parts.strings ?? []) {
    if (typeof string !== "string") throw new TypeError("Retained strings must be strings.");
    total = checkedAdd(total, Buffer.byteLength(string, "utf8"));
  }
  for (const length of parts.stringByteLengths ?? []) total = checkedAdd(total, checkedNonNegativeInteger(length));
  const summaryProvided = Object.hasOwn(parts, "summary");
  if (summaryProvided) {
    total = checkedAdd(total, canonicalSummaryBytes(parts.summary));
  }
  if (parts.summaryBytes !== undefined) {
    if (summaryProvided) throw new TypeError("Specify summary or summaryBytes, not both.");
    total = checkedAdd(total, checkedNonNegativeInteger(parts.summaryBytes));
  }
  if (parts.metadataBytes !== undefined) total = checkedAdd(total, checkedNonNegativeInteger(parts.metadataBytes));
  return total;
}

function checkedNonNegativeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Authority byte charges must be non-negative safe integers.");
  return value;
}

function checkedAdd(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw new TypeError("Authority byte charge exceeds the safe integer range.");
  return sum;
}

function canonicalSummaryBytes(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), "utf8");
}

/** A releasable, single-owner reservation in an AuthorityLedger. */
export class AuthorityLease {
  readonly #ledger: AuthorityLedger;
  readonly #kind: AuthorityReservationKind;
  readonly #bytes: number;
  readonly #nativeSnapshot: boolean;
  #released = false;

  /** @internal */
  constructor(ledger: AuthorityLedger, kind: AuthorityReservationKind, bytes: number, nativeSnapshot: boolean) {
    this.#ledger = ledger;
    this.#kind = kind;
    this.#bytes = bytes;
    this.#nativeSnapshot = nativeSnapshot;
  }

  get kind(): AuthorityReservationKind { return this.#kind; }
  get retainedBytes(): number { return this.#bytes; }
  get nativeSnapshot(): boolean { return this.#nativeSnapshot; }
  get released(): boolean { return this.#released; }

  /** Release this reservation. Repeated calls are intentionally harmless. */
  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#ledger.releaseLease(this);
  }

  /** @internal */
  get owner(): AuthorityLedger { return this.#ledger; }
}

/**
 * Session-shared accounting for opened handles and authentic retained plans.
 * Admission checks all limits before changing any counter.
 */
export class AuthorityLedger {
  readonly maxRetainedBytes: number;
  readonly maxRetainedNativeSnapshotPlans: number;
  readonly #leases = new Set<AuthorityLease>();
  #retainedBytes = 0;
  #retainedNativeSnapshotPlans = 0;

  constructor(options: AuthorityLedgerOptions = {}) {
    this.maxRetainedBytes = checkedNonNegativeInteger(options.maxRetainedBytes ?? MAX_RETAINED_AUTHORITY_BYTES);
    this.maxRetainedNativeSnapshotPlans = checkedNonNegativeInteger(
      options.maxRetainedNativeSnapshotPlans ?? MAX_RETAINED_NATIVE_SNAPSHOT_PLANS,
    );
  }

  get retainedBytes(): number { return this.#retainedBytes; }
  get retainedAuthorityBytes(): number { return this.#retainedBytes; }
  get retainedNativeSnapshotPlans(): number { return this.#retainedNativeSnapshotPlans; }
  get activeReservations(): number { return this.#leases.size; }

  canAdmit(admission: AuthorityAdmission): boolean {
    if (admission.kind !== "handle" && admission.kind !== "plan") throw new TypeError("Unknown authority reservation kind.");
    const bytes = checkedNonNegativeInteger(admission.retainedBytes);
    const native = admission.kind === "plan" && admission.nativeSnapshot === true;
    return this.#retainedBytes <= this.maxRetainedBytes - bytes
      && (!native || this.#retainedNativeSnapshotPlans < this.maxRetainedNativeSnapshotPlans);
  }

  admit(admission: AuthorityAdmission): AuthorityLease;
  admit(kind: AuthorityReservationKind, retainedBytes: number, nativeSnapshot?: boolean): AuthorityLease;
  admit(
    admissionOrKind: AuthorityAdmission | AuthorityReservationKind,
    retainedBytes?: number,
    nativeSnapshot = false,
  ): AuthorityLease {
    const admission: AuthorityAdmission = typeof admissionOrKind === "string"
      ? { kind: admissionOrKind, retainedBytes: retainedBytes ?? 0, nativeSnapshot }
      : admissionOrKind;
    if (admission.kind !== "handle" && admission.kind !== "plan") throw new TypeError("Unknown authority reservation kind.");
    const bytes = checkedNonNegativeInteger(admission.retainedBytes);
    const hasNativeSnapshot = admission.kind === "plan" && admission.nativeSnapshot === true;
    if (this.#retainedBytes > this.maxRetainedBytes - bytes || hasNativeSnapshot && this.#retainedNativeSnapshotPlans >= this.maxRetainedNativeSnapshotPlans) {
      throw new ProtocolError("REQUEST_BUSY");
    }
    const lease = new AuthorityLease(this, admission.kind, bytes, hasNativeSnapshot);
    this.#leases.add(lease);
    this.#retainedBytes += bytes;
    if (hasNativeSnapshot) this.#retainedNativeSnapshotPlans += 1;
    return lease;
  }

  reserveHandle(retainedBytes: number): AuthorityLease {
    return this.admit("handle", retainedBytes);
  }

  reserve(kind: AuthorityReservationKind, retainedBytes: number, nativeSnapshot = false): AuthorityLease {
    return this.admit(kind, retainedBytes, nativeSnapshot);
  }

  /** Reserve an exact plan charge; callers may use planRetentionCharge below. */
  reservePlan(retainedBytes: number, nativeSnapshot = false): AuthorityLease {
    return this.admit("plan", retainedBytes, nativeSnapshot);
  }

  /** Add the fixed metadata charge to a private-byte report before admission. */
  reservePlanWithMetadata(privateBytes: number, nativeSnapshot = false): AuthorityLease {
    return this.reservePlan(checkedAdd(checkedNonNegativeInteger(privateBytes), PLAN_METADATA_CHARGE_BYTES), nativeSnapshot);
  }

  /** Release a lease directly; the lease itself remains the preferred API. */
  release(lease: AuthorityLease): void {
    lease.release();
  }

  /** Release all remaining reservations, idempotently. */
  clear(): void {
    for (const lease of [...this.#leases]) lease.release();
  }

  /** @internal */
  releaseLease(lease: AuthorityLease): void {
    if (lease.owner !== this || !this.#leases.delete(lease)) return;
    this.#retainedBytes -= lease.retainedBytes;
    if (lease.nativeSnapshot) this.#retainedNativeSnapshotPlans -= 1;
  }
}

/** Compute a plan charge including the fixed per-plan metadata reservation. */
export function planRetentionCharge(parts: Omit<RetainedAuthorityParts, "metadataBytes">): number {
  return retainedAuthorityBytes({ ...parts, metadataBytes: PLAN_METADATA_CHARGE_BYTES });
}

export const computeRetainedAuthorityBytes = retainedAuthorityBytes;
export const computePlanRetentionCharge = planRetentionCharge;

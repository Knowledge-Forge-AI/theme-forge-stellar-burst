import { randomBytes } from "node:crypto";

import {
  AuthorityLedger,
  type AuthorityLease,
  MAX_RETAINED_AUTHORITY_BYTES,
  MAX_RETAINED_NATIVE_SNAPSHOT_PLANS as DEFAULT_MAX_RETAINED_NATIVE_SNAPSHOT_PLANS,
  PLAN_METADATA_CHARGE_BYTES,
  planRetentionCharge,
} from "./authority-ledger.js";
import {
  canonicalJson,
  computePlanDigest,
  type PlanDigestEnvelope,
  type StudioPlanDigest,
} from "./canonical-json.js";
import { ProtocolError } from "./errors.js";

export const PLAN_TTL_MS = 600_000 as const;
export const MAX_ACTIVE_PLANS = 4 as const;
export const MAX_RETAINED_PLAN_BYTES = MAX_RETAINED_AUTHORITY_BYTES;
export const MAX_RETAINED_NATIVE_SNAPSHOT_PLANS = DEFAULT_MAX_RETAINED_NATIVE_SNAPSHOT_PLANS;
export const MAX_RETAINED_NATIVE_SNAPSHOT_PLAN_COUNT = MAX_RETAINED_NATIVE_SNAPSHOT_PLANS;
export const MAX_CONCURRENT_APPLIES = 1 as const;
export const PLAN_TOKEN_BYTES = 32 as const;
export const PLAN_TOKEN_LENGTH = 43 as const;

export type PlanBindingValue = string | null;

/** Session-local opaque binding digests. Absolute paths must not be supplied. */
export interface PlanBindings {
  readonly sessionNonce?: string;
  readonly session?: string;
  readonly sessionId?: string;
  readonly method?: string;
  readonly root?: PlanBindingValue;
  readonly source?: PlanBindingValue;
  readonly auxiliary?: readonly PlanBindingValue[];
  readonly aux?: readonly PlanBindingValue[];
}

export interface StudioPlanResult<TSummary = unknown> {
  readonly planToken: string;
  readonly planDigest: StudioPlanDigest;
  readonly expiresInMs: number;
  readonly method: string;
  readonly summary: TSummary;
}

export interface PlanRegistration<TPlan = unknown, TSummary = unknown> {
  readonly method: string;
  /** The authentic domain plan. It is retained by reference and never rebuilt. */
  readonly plan: TPlan;
  readonly summary: TSummary;
  readonly bindings?: PlanBindings;
  readonly sessionNonce?: string;
  readonly planDigest?: string;
  readonly digest?: string;
  readonly envelope?: PlanDigestEnvelope;
  /** Complete charge, including metadata, summary, strings, and byte arrays. */
  readonly retainedPlanBytes?: number;
  /** Alias for retainedPlanBytes. */
  readonly retainedBytes?: number;
  /** Private charge excluding metadata; metadata is added by the registry. */
  readonly planPrivateBytes?: number;
  readonly nativeSnapshot?: boolean;
  readonly nativeSnapshotPlan?: boolean;
  readonly dispose?: (plan: TPlan) => void | Promise<void>;
  readonly disposer?: (plan: TPlan) => void | Promise<void>;
  /** Private dispatcher used by plan.apply; never selected from request data. */
  readonly executor?: PlanExecutor<TPlan, TSummary, unknown>;
  readonly execute?: PlanExecutor<TPlan, TSummary, unknown>;
  readonly signal?: AbortSignal;
}

export interface PlanApplyRequest {
  readonly sessionNonce: string;
  readonly planToken: string;
  readonly expectedPlanDigest?: string;
  readonly planDigest?: string;
  readonly session?: string;
  readonly sessionId?: string;
  readonly method?: string;
  readonly root?: PlanBindingValue;
  readonly rootBinding?: PlanBindingValue;
  readonly source?: PlanBindingValue;
  readonly sourceBinding?: PlanBindingValue;
  readonly auxiliary?: readonly PlanBindingValue[];
  readonly auxiliaryBindings?: readonly PlanBindingValue[];
  readonly aux?: readonly PlanBindingValue[];
  readonly bindings?: PlanBindings;
  readonly signal?: AbortSignal;
}

export interface AuthenticatedPlan<TPlan = unknown, TSummary = unknown> {
  readonly plan: TPlan;
  readonly method: string;
  readonly summary: TSummary;
  readonly planDigest: StudioPlanDigest;
  readonly bindings: PlanBindings;
  readonly createdAt: number;
  readonly retainedPlanBytes: number;
  readonly nativeSnapshot: boolean;
  /** Release/dispose the consumed authentic plan exactly once. */
  readonly dispose: () => void;
  readonly release: () => void;
}

export type PlanExecutor<TPlan, TSummary, TResult> = (
  plan: TPlan,
  authenticated: AuthenticatedPlan<TPlan, TSummary>,
) => TResult | PromiseLike<TResult>;

export interface PlanRegistryOptions {
  readonly sessionNonce?: string;
  readonly now?: () => number;
  readonly clock?: () => number;
  readonly planTtlMs?: number;
  readonly maxActivePlans?: number;
  readonly maxRetainedPlanBytes?: number;
  readonly maxRetainedNativeSnapshotPlans?: number;
  readonly maxConcurrentApplies?: number;
  readonly ledger?: AuthorityLedger;
  readonly authorityLedger?: AuthorityLedger;
}

export interface PlanRegistryLimits {
  readonly maxActivePlans: number;
  readonly maxRetainedPlanBytes: number;
  readonly maxRetainedNativeSnapshotPlans: number;
  readonly planTtlMs: number;
  readonly maxConcurrentApplies: 1;
}

interface NormalizedBindings {
  readonly sessionNonce?: string;
  readonly sessionId?: string;
  readonly method?: string;
  readonly root?: PlanBindingValue;
  readonly source?: PlanBindingValue;
  readonly auxiliary?: readonly PlanBindingValue[];
}

function checkedNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative safe integer.`);
  return value;
}

function checkedPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe integer.`);
  return value;
}

export function isPlanToken(value: unknown): value is string {
  return typeof value === "string" && value.length === PLAN_TOKEN_LENGTH && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function generatePlanToken(): string {
  const token = randomBytes(PLAN_TOKEN_BYTES).toString("base64url");
  if (!isPlanToken(token)) throw new Error("The random plan token did not have the required shape.");
  return token;
}

export const createPlanToken = generatePlanToken;

function equalSecretText(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  const length = Math.max(leftBytes.byteLength, rightBytes.byteLength);
  let difference = leftBytes.byteLength ^ rightBytes.byteLength;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function equalBindingValue(left: PlanBindingValue | undefined, right: PlanBindingValue | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left === null || right === null) return left === right;
  return equalSecretText(left, right);
}

function equalBindingList(left: readonly PlanBindingValue[] | undefined, right: readonly PlanBindingValue[] | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.length !== right.length) return false;
  let equal = true;
  for (let index = 0; index < left.length; index += 1) {
    if (!equalBindingValue(left[index], right[index])) equal = false;
  }
  return equal;
}

function normalizeBindings(bindings: PlanBindings | undefined): NormalizedBindings {
  const source = bindings ?? {};
  if ((source.sessionNonce !== undefined && typeof source.sessionNonce !== "string") || (source.session !== undefined && typeof source.session !== "string")) {
    throw new TypeError("Session bindings must be strings.");
  }
  if ((source.sessionId !== undefined && typeof source.sessionId !== "string") || (source.method !== undefined && typeof source.method !== "string")) {
    throw new TypeError("Plan bindings must be strings.");
  }
  for (const value of [source.root, source.source]) {
    if (value !== undefined && value !== null && typeof value !== "string") throw new TypeError("Root and source bindings must be strings or null.");
  }
  for (const value of source.auxiliary ?? source.aux ?? []) {
    if (value !== null && typeof value !== "string") throw new TypeError("Auxiliary bindings must be strings or null.");
  }
  const sessionNonce = source.sessionNonce ?? source.session;
  const sessionId = source.sessionId;
  const auxiliary = source.auxiliary ?? source.aux;
  if (source.auxiliary !== undefined && source.aux !== undefined && !equalBindingList(source.auxiliary, source.aux)) {
    throw new TypeError("Conflicting auxiliary bindings.");
  }
  return Object.freeze({
    ...(sessionNonce === undefined ? {} : { sessionNonce }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(source.method === undefined ? {} : { method: source.method }),
    ...(source.root === undefined ? {} : { root: source.root }),
    ...(source.source === undefined ? {} : { source: source.source }),
    ...(auxiliary === undefined ? {} : { auxiliary: Object.freeze([...auxiliary]) }),
  });
}

function normalizeRequestBindings(request: PlanApplyRequest): NormalizedBindings {
  const nested = normalizeBindings(request.bindings);
  const auxiliary = request.auxiliary ?? request.auxiliaryBindings ?? request.aux;
  if (request.auxiliary !== undefined && request.auxiliaryBindings !== undefined && !equalBindingList(request.auxiliary, request.auxiliaryBindings)) {
    throw new TypeError("Conflicting auxiliary bindings.");
  }
  if (request.auxiliary !== undefined && request.aux !== undefined && !equalBindingList(request.auxiliary, request.aux)) {
    throw new TypeError("Conflicting auxiliary bindings.");
  }
  return Object.freeze({
    ...(request.sessionNonce === undefined ? {} : { sessionNonce: request.sessionNonce }),
    ...((request.sessionId ?? request.session) === undefined ? {} : { sessionId: request.sessionId ?? request.session }),
    ...((request.method ?? nested.method) === undefined ? {} : { method: request.method ?? nested.method }),
    ...((request.root !== undefined ? request.root : request.rootBinding !== undefined ? request.rootBinding : nested.root) === undefined ? {}
      : { root: request.root !== undefined ? request.root : request.rootBinding !== undefined ? request.rootBinding : nested.root }),
    ...((request.source !== undefined ? request.source : request.sourceBinding !== undefined ? request.sourceBinding : nested.source) === undefined ? {}
      : { source: request.source !== undefined ? request.source : request.sourceBinding !== undefined ? request.sourceBinding : nested.source }),
    ...(auxiliary === undefined ? {} : { auxiliary: Object.freeze([...auxiliary]) }),
  });
}

function safeDispose<TPlan>(disposer: ((plan: TPlan) => void | Promise<void>) | undefined, plan: TPlan): Promise<void> {
  try { return Promise.resolve(disposer?.(plan)).then(() => undefined, () => undefined); }
  catch {
    // Disposal is best effort but still exactly once.  The registry must not
    // leak a token or reveal an internal disposal error through protocol text.
    return Promise.resolve();
  }
}

class RetainedPlanEntry<TPlan, TSummary> {
  #disposed = false;
  #consumed = false;
  readonly #onDisposed: (task: Promise<void>) => void;

  constructor(
    readonly plan: TPlan,
    readonly summary: TSummary,
    readonly method: string,
    readonly planDigest: StudioPlanDigest,
    readonly bindings: PlanBindings,
    readonly createdAt: number,
    readonly retainedPlanBytes: number,
    readonly nativeSnapshot: boolean,
    readonly disposer: ((plan: TPlan) => void | Promise<void>) | undefined,
    readonly executor: PlanExecutor<TPlan, TSummary, unknown> | undefined,
    onDisposed: (task: Promise<void>) => void,
  ) {
    this.#onDisposed = onDisposed;
  }

  get disposed(): boolean { return this.#disposed; }
  get consumed(): boolean { return this.#consumed; }
  markConsumed(): void { this.#consumed = true; }

  disposeOnce(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#onDisposed(safeDispose(this.disposer, this.plan));
  }
}

class AuthenticatedPlanHandle<TPlan, TSummary> implements AuthenticatedPlan<TPlan, TSummary> {
  readonly #entry: RetainedPlanEntry<TPlan, TSummary>;

  constructor(entry: RetainedPlanEntry<TPlan, TSummary>) { this.#entry = entry; }

  get plan(): TPlan { return this.#entry.plan; }
  get method(): string { return this.#entry.method; }
  get summary(): TSummary { return this.#entry.summary; }
  get planDigest(): StudioPlanDigest { return this.#entry.planDigest; }
  get bindings(): PlanBindings { return this.#entry.bindings; }
  get createdAt(): number { return this.#entry.createdAt; }
  get retainedPlanBytes(): number { return this.#entry.retainedPlanBytes; }
  get nativeSnapshot(): boolean { return this.#entry.nativeSnapshot; }
  dispose(): void { this.#entry.disposeOnce(); }
  release(): void { this.#entry.disposeOnce(); }

  async dispatch<TResult>(fallback?: PlanExecutor<TPlan, TSummary, TResult>): Promise<TResult> {
    const dispatch = (this.#entry.executor ?? fallback) as PlanExecutor<TPlan, TSummary, TResult> | undefined;
    if (dispatch === undefined) throw new ProtocolError("DOMAIN_OPERATION_FAILED");
    return await dispatch(this.#entry.plan, this);
  }
}

/**
 * Private session registry for authentic plans.  The map stores the domain
 * object itself; only the public summary and token leave the registry.
 */
export class PlanRegistry {
  readonly planTtlMs: number;
  readonly maxActivePlans: number;
  readonly maxRetainedPlanBytes: number;
  readonly maxRetainedNativeSnapshotPlans: number;
  readonly maxConcurrentApplies = MAX_CONCURRENT_APPLIES;
  readonly ledger: AuthorityLedger;
  readonly #sessionNonce: string | undefined;
  readonly #clock: () => number;
  readonly #records = new Map<string, RetainedPlanEntry<unknown, unknown>>();
  readonly #pendingDisposals = new Set<Promise<void>>();
  #retainedPlanCount = 0;
  #retainedPlanBytes = 0;
  #applyBusy = false;
  #activeApply: Promise<unknown> | undefined;
  #closed = false;
  #shutdownPromise: Promise<void> | undefined;

  constructor(optionsOrLedger: PlanRegistryOptions | AuthorityLedger = {}) {
    const options = optionsOrLedger instanceof AuthorityLedger ? { ledger: optionsOrLedger } : optionsOrLedger;
    this.#sessionNonce = options.sessionNonce;
    this.#clock = options.clock ?? options.now ?? (() => performance.now());
    this.planTtlMs = checkedPositiveInteger(options.planTtlMs ?? PLAN_TTL_MS, "planTtlMs");
    this.maxActivePlans = checkedPositiveInteger(options.maxActivePlans ?? MAX_ACTIVE_PLANS, "maxActivePlans");
    this.ledger = options.ledger ?? options.authorityLedger ?? new AuthorityLedger({
      maxRetainedBytes: options.maxRetainedPlanBytes ?? MAX_RETAINED_PLAN_BYTES,
      maxRetainedNativeSnapshotPlans: options.maxRetainedNativeSnapshotPlans ?? MAX_RETAINED_NATIVE_SNAPSHOT_PLANS,
    });
    this.maxRetainedPlanBytes = this.ledger.maxRetainedBytes;
    this.maxRetainedNativeSnapshotPlans = this.ledger.maxRetainedNativeSnapshotPlans;
    const concurrency = options.maxConcurrentApplies ?? MAX_CONCURRENT_APPLIES;
    if (concurrency !== MAX_CONCURRENT_APPLIES) throw new TypeError("The Studio apply lane is single and unqueued.");
  }

  get size(): number { return this.#records.size; }
  get activePlanCount(): number { return this.#retainedPlanCount; }
  get retainedPlanBytes(): number { return this.#retainedPlanBytes; }
  get retainedAuthorityBytes(): number { return this.ledger.retainedBytes; }
  get applying(): boolean { return this.#applyBusy; }
  get closed(): boolean { return this.#closed; }

  get limits(): PlanRegistryLimits {
    return Object.freeze({
      maxActivePlans: this.maxActivePlans,
      maxRetainedPlanBytes: this.maxRetainedPlanBytes,
      maxRetainedNativeSnapshotPlans: this.maxRetainedNativeSnapshotPlans,
      planTtlMs: this.planTtlMs,
      maxConcurrentApplies: MAX_CONCURRENT_APPLIES,
    });
  }

  register<TPlan, TSummary>(input: PlanRegistration<TPlan, TSummary>): StudioPlanResult<TSummary> {
    this.ensureOpen();
    this.sweepExpired();
    if (input.signal?.aborted) {
      safeDispose(input.dispose ?? input.disposer, input.plan);
      throw new ProtocolError("REQUEST_CANCELLED");
    }

    let digest: StudioPlanDigest;
    let charge: number;
    let bindings: NormalizedBindings;
    try {
      if (typeof input.method !== "string" || input.method.length === 0) throw new TypeError("A plan method is required.");
      digest = this.resolveDigest(input);
      charge = this.resolveCharge(input);
      bindings = normalizeBindings({
        ...(input.bindings ?? {}),
        method: input.bindings?.method ?? input.method,
        ...(input.sessionNonce === undefined ? {} : { sessionNonce: input.sessionNonce }),
      });
      if (bindings.method !== input.method) throw new TypeError("Plan method and method binding must match.");
      if (this.#sessionNonce !== undefined && bindings.sessionNonce !== undefined && bindings.sessionNonce !== this.#sessionNonce) {
        throw new ProtocolError("SESSION_NONCE_INVALID");
      }
    } catch (error) {
      safeDispose(input.dispose ?? input.disposer, input.plan);
      throw error;
    }

    if (this.#retainedPlanCount >= this.maxActivePlans) {
      safeDispose(input.dispose ?? input.disposer, input.plan);
      throw new ProtocolError("REQUEST_BUSY");
    }

    const nativeSnapshot = input.nativeSnapshot ?? input.nativeSnapshotPlan ?? false;
    let lease: AuthorityLease;
    try { lease = this.ledger.reservePlan(charge, nativeSnapshot); }
    catch (error) {
      safeDispose(input.dispose ?? input.disposer, input.plan);
      throw error;
    }

    let createdAt: number;
    let token: string;
    try {
      createdAt = this.readClock();
      token = generatePlanToken();
      if (this.#records.has(token)) throw new Error("A generated plan token collided with an existing token.");
    } catch (error) {
      lease.release();
      safeDispose(input.dispose ?? input.disposer, input.plan);
      throw error;
    }

    const entry = new RetainedPlanEntry<TPlan, TSummary>(
      input.plan,
      input.summary,
      input.method,
      digest,
      Object.freeze({
        ...(bindings.sessionNonce === undefined ? {} : { sessionNonce: bindings.sessionNonce }),
        ...(bindings.sessionId === undefined ? {} : { sessionId: bindings.sessionId }),
        ...(bindings.method === undefined ? {} : { method: bindings.method }),
        ...(bindings.root === undefined ? {} : { root: bindings.root }),
        ...(bindings.source === undefined ? {} : { source: bindings.source }),
        ...(bindings.auxiliary === undefined ? {} : { auxiliary: bindings.auxiliary }),
      }),
      createdAt,
      charge,
      nativeSnapshot,
      input.dispose ?? input.disposer,
      input.executor ?? input.execute,
      (task) => {
        lease.release();
        this.#retainedPlanCount -= 1;
        this.#retainedPlanBytes -= charge;
        this.#pendingDisposals.add(task);
        void task.finally(() => { this.#pendingDisposals.delete(task); });
      },
    );
    this.#records.set(token, entry as RetainedPlanEntry<unknown, unknown>);
    this.#retainedPlanCount += 1;
    this.#retainedPlanBytes += charge;
    return Object.freeze({ planToken: token, planDigest: digest as StudioPlanDigest, expiresInMs: this.planTtlMs, method: input.method, summary: input.summary });
  }

  create<TPlan, TSummary>(input: PlanRegistration<TPlan, TSummary>): StudioPlanResult<TSummary> {
    return this.register(input);
  }

  admit<TPlan, TSummary>(input: PlanRegistration<TPlan, TSummary>): StudioPlanResult<TSummary> {
    return this.register(input);
  }

  discard(request: { readonly sessionNonce: string; readonly planToken: string }): { readonly discarded: true };
  discard(sessionNonce: string, planToken: string): { readonly discarded: true };
  discard(
    requestOrSession: { readonly sessionNonce: string; readonly planToken: string } | string,
    positionalToken?: string,
  ): { readonly discarded: true } {
    const request = typeof requestOrSession === "string"
      ? { sessionNonce: requestOrSession, planToken: positionalToken }
      : requestOrSession;
    this.ensureOpen();
    this.sweepExpired();
    try { this.validateRegistrySession(request.sessionNonce); }
    catch { throw new ProtocolError("PLAN_TOKEN_INVALID"); }
    if (!isPlanToken(request.planToken)) throw new ProtocolError("PLAN_TOKEN_INVALID");
    const entry = this.#records.get(request.planToken);
    if (entry === undefined || entry.disposed || entry.consumed) throw new ProtocolError("PLAN_TOKEN_INVALID");
    if (!this.entrySessionMatches(entry, request.sessionNonce)) throw new ProtocolError("PLAN_TOKEN_INVALID");
    this.#records.delete(request.planToken);
    entry.disposeOnce();
    return { discarded: true };
  }

  authenticate<TPlan = unknown, TSummary = unknown>(request: PlanApplyRequest): AuthenticatedPlan<TPlan, TSummary> {
    this.ensureOpen();
    this.sweepExpired();
    if (request.signal?.aborted) throw new ProtocolError("REQUEST_CANCELLED");
    return this.authenticateInternal<TPlan, TSummary>(request);
  }

  consume<TPlan = unknown, TSummary = unknown>(request: PlanApplyRequest): AuthenticatedPlan<TPlan, TSummary> {
    return this.authenticate(request);
  }

  async apply<TResult, TPlan = unknown, TSummary = unknown>(
    request: PlanApplyRequest,
    executor?: PlanExecutor<TPlan, TSummary, TResult>,
  ): Promise<TResult> {
    if (request.signal?.aborted) throw new ProtocolError("REQUEST_CANCELLED");
    this.ensureOpen();
    if (this.#applyBusy) throw new ProtocolError("REQUEST_BUSY");
    this.#applyBusy = true;
    let task: Promise<TResult>;
    try {
      this.sweepExpired();
      task = this.performApply<TResult, TPlan, TSummary>(request, executor);
    } catch (error) {
      this.#applyBusy = false;
      throw error;
    }
    this.#activeApply = task;
    try { return await task; }
    finally {
      if (this.#activeApply === task) this.#activeApply = undefined;
      this.#applyBusy = false;
    }
  }

  sweepExpired(now = this.readClock()): number {
    let removed = 0;
    for (const [token, entry] of [...this.#records]) {
      if (now - entry.createdAt < this.planTtlMs) continue;
      this.#records.delete(token);
      entry.disposeOnce();
      removed += 1;
    }
    return removed;
  }

  sweep(now = this.readClock()): number { return this.sweepExpired(now); }

  async shutdown(): Promise<void> {
    if (this.#shutdownPromise !== undefined) return this.#shutdownPromise;
    this.#closed = true;
    this.sweepExpired();
    for (const [token, entry] of [...this.#records]) {
      this.#records.delete(token);
      entry.disposeOnce();
    }
    const active = this.#activeApply;
    this.#shutdownPromise = (async () => {
      if (active !== undefined) await active.then(() => undefined, () => undefined);
      while (this.#pendingDisposals.size > 0) await Promise.allSettled([...this.#pendingDisposals]);
    })();
    return this.#shutdownPromise;
  }

  close(): Promise<void> { return this.shutdown(); }

  private ensureOpen(): void {
    if (this.#closed) throw new ProtocolError("SESSION_NOT_INITIALIZED");
  }

  private readClock(): number {
    const now = this.#clock();
    if (!Number.isFinite(now)) throw new TypeError("The monotonic clock returned a non-finite value.");
    return now;
  }

  private resolveDigest<TPlan, TSummary>(input: PlanRegistration<TPlan, TSummary>): StudioPlanDigest {
    const explicit = input.planDigest ?? input.digest;
    const computed = input.envelope === undefined ? undefined : computePlanDigest(input.envelope);
    if (explicit !== undefined && computed !== undefined && !equalSecretText(explicit, computed)) {
      throw new ProtocolError("PLAN_DIGEST_MISMATCH");
    }
    const digest = explicit ?? computed;
    if (digest === undefined || digest.length === 0) throw new TypeError("A plan digest is required.");
    return digest as StudioPlanDigest;
  }

  private resolveCharge<TPlan, TSummary>(input: PlanRegistration<TPlan, TSummary>): number {
    const supplied = [input.retainedPlanBytes, input.retainedBytes].filter((value): value is number => value !== undefined);
    if (supplied.length > 1 && supplied[0] !== supplied[1]) throw new TypeError("Conflicting retained plan byte charges.");
    if (supplied.length > 0) return checkedNonNegativeInteger(supplied[0]!, "retainedPlanBytes");
    if (input.planPrivateBytes !== undefined) return checkedNonNegativeInteger(input.planPrivateBytes + PLAN_METADATA_CHARGE_BYTES, "retainedPlanBytes");
    return planRetentionCharge({ summary: input.summary });
  }

  private validateRegistrySession(sessionNonce: string): void {
    if (typeof sessionNonce !== "string" || this.#sessionNonce !== undefined && !equalSecretText(sessionNonce, this.#sessionNonce)) {
      throw new ProtocolError("SESSION_NONCE_INVALID");
    }
  }

  private entrySessionMatches(entry: RetainedPlanEntry<unknown, unknown>, sessionNonce: string): boolean {
    const binding = entry.bindings.sessionNonce;
    return binding === undefined || equalSecretText(binding, sessionNonce);
  }

  private authenticateInternal<TPlan, TSummary>(request: PlanApplyRequest): AuthenticatedPlan<TPlan, TSummary> {
    this.validateRegistrySession(request.sessionNonce);
    if (!isPlanToken(request.planToken)) throw new ProtocolError("PLAN_TOKEN_INVALID");
    const entry = this.#records.get(request.planToken);
    if (entry === undefined || entry.disposed || entry.consumed) throw new ProtocolError("PLAN_TOKEN_INVALID");
    if (!this.entrySessionMatches(entry, request.sessionNonce)) throw new ProtocolError("PLAN_TOKEN_INVALID");

    const now = this.readClock();
    if (now - entry.createdAt >= this.planTtlMs) {
      this.#records.delete(request.planToken);
      entry.disposeOnce();
      throw new ProtocolError("PLAN_TOKEN_INVALID");
    }

    const requested = normalizeRequestBindings(request);
    if (!this.bindingsMatch(entry.bindings, requested)) throw new ProtocolError("PLAN_TOKEN_INVALID");

    const expectedDigest = request.expectedPlanDigest ?? request.planDigest;
    if (expectedDigest === undefined || !equalSecretText(expectedDigest, entry.planDigest)) {
      throw new ProtocolError("PLAN_DIGEST_MISMATCH");
    }

    this.#records.delete(request.planToken);
    entry.markConsumed();
    return new AuthenticatedPlanHandle<TPlan, TSummary>(entry as unknown as RetainedPlanEntry<TPlan, TSummary>);
  }

  private bindingsMatch(stored: PlanBindings, requested: NormalizedBindings): boolean {
    const storedNormalized = normalizeBindings(stored);
    if (requested.sessionId !== undefined && !equalBindingValue(requested.sessionId, storedNormalized.sessionId)) return false;
    if (requested.method !== undefined && !equalBindingValue(requested.method, storedNormalized.method)) return false;
    if (requested.root !== undefined && !equalBindingValue(requested.root, storedNormalized.root)) return false;
    if (requested.source !== undefined && !equalBindingValue(requested.source, storedNormalized.source)) return false;
    if (requested.auxiliary !== undefined && !equalBindingList(requested.auxiliary, storedNormalized.auxiliary)) return false;
    return true;
  }

  private async performApply<TResult, TPlan, TSummary>(
    request: PlanApplyRequest,
    executor: PlanExecutor<TPlan, TSummary, TResult> | undefined,
  ): Promise<TResult> {
    const authenticated = this.authenticateInternal<TPlan, TSummary>(request);
    try {
      if (request.signal?.aborted) throw new ProtocolError("REQUEST_CANCELLED");
      return await (authenticated as AuthenticatedPlanHandle<TPlan, TSummary>).dispatch(executor);
    } finally {
      authenticated.dispose();
    }
  }
}

export { PLAN_METADATA_CHARGE_BYTES };

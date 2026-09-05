import { randomBytes } from "node:crypto";

import { AuthorityLedger } from "./authority-ledger.js";
import { CursorCodec } from "./cursor.js";
import { loadRasterCapability, type RasterCapabilityStatus } from "../brand/raster-capability.js";
import type { StudioProtocolVersion } from "./v1-types.js";
import { ProtocolError } from "./errors.js";
import { HandleRegistry } from "./handles.js";
import { PlanRegistry } from "./plan-registry.js";
import { MAX_CONCURRENT_READS, MAX_QUEUED_READS } from "./v1-registry.js";
import type { JsonRpcId } from "./v1-types.js";

interface QueuedRead<T = unknown> {
  readonly idKey: string;
  readonly lane: string;
  readonly controller: AbortController;
  readonly task: (signal: AbortSignal) => Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function idKey(id: JsonRpcId): string { return `${typeof id}:${String(id)}`; }

interface ActiveMutation {
  readonly controller: AbortController;
  readonly promise: Promise<unknown>;
}

export class ReadScheduler {
  readonly #active = new Map<string, QueuedRead>();
  readonly #runningLanes = new Set<string>();
  readonly #queue: QueuedRead[] = [];
  #running = 0;

  has(id: JsonRpcId): boolean { return this.#active.has(idKey(id)); }

  submit<T>(id: JsonRpcId, lane: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const key = idKey(id);
    if (this.#active.has(key)) return Promise.reject(new ProtocolError("INVALID_REQUEST_ID"));
    const laneBusy = this.#runningLanes.has(lane) || this.#queue.some((item) => item.lane === lane);
    if (!laneBusy && this.#running >= MAX_CONCURRENT_READS || laneBusy && this.#queue.length >= MAX_QUEUED_READS) return Promise.reject(new ProtocolError("REQUEST_BUSY"));
    return new Promise<T>((resolve, reject) => {
      const item: QueuedRead<T> = { idKey: key, lane, controller: new AbortController(), task, resolve, reject };
      this.#active.set(key, item as QueuedRead);
      if (laneBusy) this.#queue.push(item as QueuedRead);
      else this.#start(item);
    });
  }

  cancel(id: JsonRpcId): void {
    const key = idKey(id);
    const item = this.#active.get(key);
    if (item === undefined) return;
    item.controller.abort();
    const index = this.#queue.indexOf(item);
    if (index >= 0) {
      this.#queue.splice(index, 1);
      this.#active.delete(key);
      item.reject(new ProtocolError("REQUEST_CANCELLED"));
      this.#drain();
    }
  }

  cancelAll(): void { for (const item of this.#active.values()) item.controller.abort(); }
  get size(): number { return this.#active.size; }

  async idle(): Promise<void> {
    while (this.#active.size > 0) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  #start<T>(item: QueuedRead<T>): void {
    this.#running += 1;
    this.#runningLanes.add(item.lane);
    void item.task(item.controller.signal).then(item.resolve, item.reject).finally(() => {
      this.#running -= 1;
      this.#runningLanes.delete(item.lane);
      this.#active.delete(item.idKey);
      this.#drain();
    });
  }

  #drain(): void {
    for (let index = 0; index < this.#queue.length && this.#running < MAX_CONCURRENT_READS;) {
      const item = this.#queue[index]!;
      if (this.#runningLanes.has(item.lane)) { index += 1; continue; }
      this.#queue.splice(index, 1);
      this.#start(item);
    }
  }
}

export class StudioSession {
  readonly nonce: string;
  readonly authorityLedger: AuthorityLedger;
  readonly handles: HandleRegistry;
  readonly plans: PlanRegistry;
  readonly scheduler = new ReadScheduler();
  readonly cursors: CursorCodec;
  readonly #mutations = new Map<string, ActiveMutation>();
  negotiatedVersion: StudioProtocolVersion | undefined;
  rasterCapability: RasterCapabilityStatus | undefined;
  initialized = false;
  shuttingDown = false;
  shutdownComplete = false;
  nonceFailures = 0;

  constructor() {
    this.nonce = randomBytes(32).toString("base64url");
    this.authorityLedger = new AuthorityLedger();
    this.handles = new HandleRegistry({ ledger: this.authorityLedger, sessionNonce: this.nonce });
    this.plans = new PlanRegistry({ ledger: this.authorityLedger, sessionNonce: this.nonce });
    const secret = randomBytes(32);
    this.cursors = new CursorCodec(secret);
    secret.fill(0);
  }

  async negotiate(version: StudioProtocolVersion): Promise<void> {
    if (this.negotiatedVersion !== undefined) throw new ProtocolError("INVALID_REQUEST");
    this.negotiatedVersion = version;
    if (version === "1.1" || version === "1.2") this.rasterCapability = await loadRasterCapability();
  }

  validateNonce(value: string): boolean {
    if (value === this.nonce) { this.nonceFailures = 0; return true; }
    this.nonceFailures += 1;
    return false;
  }

  checkCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw new ProtocolError("REQUEST_CANCELLED");
  }

  hasRequest(id: JsonRpcId): boolean {
    return this.scheduler.has(id) || this.#mutations.has(idKey(id));
  }

  runMutation<T>(id: JsonRpcId, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const key = idKey(id);
    if (this.hasRequest(id)) return Promise.reject(new ProtocolError("INVALID_REQUEST_ID"));
    const controller = new AbortController();
    const promise = task(controller.signal);
    this.#mutations.set(key, { controller, promise });
    void promise.finally(() => { this.#mutations.delete(key); }).catch(() => undefined);
    return promise;
  }

  cancel(id: JsonRpcId): void {
    this.scheduler.cancel(id);
    this.#mutations.get(idKey(id))?.controller.abort();
  }

  cancelAll(): void {
    this.scheduler.cancelAll();
    for (const mutation of this.#mutations.values()) mutation.controller.abort();
  }

  async idle(): Promise<void> {
    await this.scheduler.idle();
    while (this.#mutations.size > 0) {
      await Promise.allSettled([...this.#mutations.values()].map((item) => item.promise));
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.cancelAll();
    await this.plans.shutdown();
    await this.idle();
    await this.handles.dispose();
    this.cursors.destroy();
    this.initialized = false;
    this.shutdownComplete = true;
  }

  destroy(): void {
    this.cancelAll();
    void this.plans.shutdown();
    this.handles.clear();
    this.cursors.destroy();
    this.initialized = false;
  }
}

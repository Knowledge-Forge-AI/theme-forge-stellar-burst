import type { Readable, Writable } from "node:stream";

import { FramingError, NdjsonFramer, encodeFrame } from "./framing.js";
import { errorResponse, ProtocolError, toProtocolError } from "./errors.js";
import { MutationMethods } from "./mutation-methods.js";
import { ReadMethods } from "./read-methods.js";
import { StudioSession } from "./session.js";
import {
  BRAND_PLAN_METHODS, BRAND_READ_METHODS, BRAND_READ_METHODS_1_2, createStudioCapabilitiesV1_1, createStudioCapabilitiesV1_2, isKnownMethod,
  isQualifiedStudioRasterCapability, isUnavailablePlanMethod, STUDIO_CAPABILITIES,
  SUPPORTED_REQUEST_METHODS, SUPPORTED_REQUEST_METHODS_1_1, SUPPORTED_REQUEST_METHODS_1_2, type SupportedRequestMethod,
} from "./v1-registry.js";
import { ValidationError, validateInboundMessage, validateJsonRpcId, validateResult } from "./v1-validate.js";
import {
  STUDIO_PROTOCOL_IDENTIFIER, STUDIO_PROTOCOL_VERSION, type JsonRpcId, type StudioProtocolVersion,
  type StudioInboundMessage, type StudioMutationMethod, type StudioProgressStage,
} from "./v1-types.js";
import { TOOL_VERSION } from "../version.js";

export interface StudioServerIo {
  readonly input: Readable;
  readonly output: Writable;
  readonly error: Writable;
  readonly onExitCode?: (code: number) => void;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function requestId(raw: unknown): JsonRpcId | null {
  if (!plainObject(raw) || !Object.hasOwn(raw, "id")) return null;
  try { return validateJsonRpcId(raw.id); } catch { return null; }
}

function negotiate(minVersion: string, maxVersion: string): StudioProtocolVersion | undefined {
  const min = /^1\.(0|[1-9]\d*)$/.exec(minVersion); const max = /^1\.(0|[1-9]\d*)$/.exec(maxVersion);
  if (min === null || max === null) return undefined;
  const low = Number(min[1]), high = Number(max[1]);
  if (low > high) return undefined;
  if (low <= 2 && high >= 2) return "1.2";
  if (low <= 1 && high >= 1) return "1.1";
  if (low <= 0 && high >= 0) return "1.0";
  return undefined;
}

const MUTATION_METHODS = new Set<StudioMutationMethod>([
  "asset.edit.plan", "project.import.plan", "project.reconcile.plan",
  "project.migrate.plan", "project.fmt.plan", "project.build.plan",
  "project.install.plan", "preview.plan", "plan.discard", "plan.apply",
  ...BRAND_PLAN_METHODS,
]);

export class StudioServer {
  readonly #framer = new NdjsonFramer();
  readonly #session = new StudioSession();
  readonly #reads = new ReadMethods(this.#session);
  readonly #mutations = new MutationMethods(this.#session);
  readonly #io: StudioServerIo;
  #initializeSeen = false;
  #clientProgress = false;
  #closed = false;
  #exitCode = 0;
  #shutdownTask: Promise<void> | undefined;

  constructor(io: StudioServerIo) { this.#io = io; }

  start(): void {
    this.#io.input.on("data", (chunk: Buffer | string) => {
      if (this.#closed) return;
      try {
        for (const value of this.#framer.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)) void this.#handle(value);
      } catch (error) { this.#framingFailure(error); }
    });
    this.#io.input.once("end", () => { void this.#eof(); });
    this.#io.input.once("error", () => { this.#log("input-error"); void this.#close(1); });
  }

  #log(event: string, code?: string): void {
    const value = { component: "tfsb-studio-service", event, ...(code === undefined ? {} : { code }) };
    this.#io.error.write(`${JSON.stringify(value)}\n`);
  }

  #write(value: unknown): void {
    if (this.#closed) return;
    this.#io.output.write(encodeFrame(value));
  }

  #sendError(id: JsonRpcId | null, error: ProtocolError): void {
    try { this.#write(errorResponse(id, error)); }
    catch { this.#write(errorResponse(id, new ProtocolError("MESSAGE_TOO_LARGE"))); }
  }

  #sendResult(id: JsonRpcId, result: unknown): void {
    try { this.#write({ jsonrpc: "2.0", id, result }); }
    catch (error) {
      if (error instanceof FramingError && error.symbolicCode === "MESSAGE_TOO_LARGE") this.#sendError(id, new ProtocolError("MESSAGE_TOO_LARGE"));
      else this.#sendError(id, new ProtocolError("INTERNAL_ERROR"));
    }
  }

  #framingFailure(error: unknown): void {
    const code = error instanceof FramingError ? error.symbolicCode : "PARSE_ERROR";
    this.#sendError(null, new ProtocolError(code));
    this.#log("session-closed", code);
    void this.#close(1);
  }

  async #handle(raw: unknown): Promise<void> {
    const id = requestId(raw);
    try {
      if (plainObject(raw) && typeof raw.method === "string" && isUnavailablePlanMethod(raw.method)) {
        await this.#handleUnavailable(raw, id);
        return;
      }
      if (plainObject(raw) && typeof raw.method === "string" && !isKnownMethod(raw.method)) {
        this.#sendError(id, new ProtocolError("METHOD_NOT_FOUND"));
        return;
      }
      const message = validateInboundMessage(raw);
      await this.#handleValidated(message);
    } catch (error) {
      const mapped = error instanceof ValidationError ? new ProtocolError(error.symbolicCode) : toProtocolError(error);
      if (id !== null) this.#sendError(id, mapped);
      else this.#log("notification-rejected", mapped.symbolicCode);
    }
  }

  async #handleUnavailable(raw: Record<string, unknown>, id: JsonRpcId | null): Promise<void> {
    if (id === null || raw.jsonrpc !== "2.0" || Object.keys(raw).some((key) => !["jsonrpc", "id", "method", "params"].includes(key)) || !plainObject(raw.params)) {
      if (id !== null) this.#sendError(id, new ProtocolError("INVALID_REQUEST"));
      return;
    }
    if (!this.#initializeSeen || !this.#session.initialized) { this.#sendError(id, new ProtocolError("SESSION_NOT_INITIALIZED")); return; }
    const nonce = raw.params.sessionNonce;
    if (typeof nonce !== "string" || !this.#session.validateNonce(nonce)) { await this.#nonceFailure(id); return; }
    this.#sendError(id, new ProtocolError("METHOD_CAPABILITY_UNAVAILABLE"));
  }

  async #handleValidated(message: StudioInboundMessage): Promise<void> {
    if (message.method === "exit") {
      if (this.#shutdownTask !== undefined) await this.#shutdownTask;
      await this.#close(this.#session.shutdownComplete ? 0 : 1);
      return;
    }
    if (message.method === "initialize") {
      if (this.#initializeSeen) { this.#sendError(message.id, new ProtocolError("INVALID_REQUEST")); return; }
      this.#initializeSeen = true;
      const selectedVersion = message.params.protocol === STUDIO_PROTOCOL_IDENTIFIER ? negotiate(message.params.minVersion, message.params.maxVersion) : undefined;
      if (selectedVersion === undefined) {
        this.#sendError(message.id, new ProtocolError("PROTOCOL_VERSION_UNSUPPORTED"));
        return;
      }
      await this.#session.negotiate(selectedVersion);
      this.#clientProgress = message.params.capabilities.progress;
      const result = {
        protocol: STUDIO_PROTOCOL_IDENTIFIER, selectedVersion,
        server: { name: "tfsb-studio-service", version: TOOL_VERSION },
        sessionNonce: this.#session.nonce,
        capabilities: selectedVersion === "1.0" ? STUDIO_CAPABILITIES : selectedVersion === "1.1" ? createStudioCapabilitiesV1_1(this.#session.rasterCapability) : createStudioCapabilitiesV1_2(this.#session.rasterCapability),
      };
      validateResult("initialize", result);
      this.#sendResult(message.id, result);
      return;
    }
    if (this.#session.shuttingDown) {
      if ("id" in message) this.#sendError(message.id, new ProtocolError("SESSION_NOT_INITIALIZED"));
      else this.#log("notification-rejected", "SESSION_NOT_INITIALIZED");
      return;
    }
    if (!this.#initializeSeen) {
      if ("id" in message) this.#sendError(message.id, new ProtocolError("SESSION_NOT_INITIALIZED"));
      else this.#log("notification-rejected", "SESSION_NOT_INITIALIZED");
      return;
    }
    if (message.method === "initialized") {
      if (!this.#session.validateNonce(message.params.sessionNonce)) { await this.#nonceFailure(null); return; }
      this.#session.initialized = true;
      return;
    }
    if (!this.#session.initialized) {
      if ("id" in message) this.#sendError(message.id, new ProtocolError("SESSION_NOT_INITIALIZED"));
      else this.#log("notification-rejected", "SESSION_NOT_INITIALIZED");
      return;
    }
    if (!this.#session.validateNonce(message.params.sessionNonce)) {
      await this.#nonceFailure("id" in message ? message.id : null);
      return;
    }
    const isBrandMethod = (BRAND_READ_METHODS as readonly string[]).includes(message.method) || (BRAND_PLAN_METHODS as readonly string[]).includes(message.method);
    const isBrandMethodV1_2 = (BRAND_READ_METHODS_1_2 as readonly string[]).includes(message.method);
    if (isBrandMethod && this.#session.negotiatedVersion === "1.0" || isBrandMethodV1_2 && this.#session.negotiatedVersion !== "1.2") { this.#sendError("id" in message ? message.id : null, new ProtocolError("METHOD_CAPABILITY_UNAVAILABLE")); return; }
    if (message.method === "brand.visual.evidence.get" && !isQualifiedStudioRasterCapability(this.#session.rasterCapability)) { this.#sendError(message.id, new ProtocolError("METHOD_CAPABILITY_UNAVAILABLE")); return; }
    if ((message.method === "brand.qa.baseline.plan" || message.method === "brand.export.plan") && !isQualifiedStudioRasterCapability(this.#session.rasterCapability)) { this.#sendError(message.id, new ProtocolError("METHOD_CAPABILITY_UNAVAILABLE")); return; }
    if (message.method === "source.open" && this.#session.negotiatedVersion === "1.0") {
      const purpose = (message.params as { readonly purpose?: string }).purpose;
      if (purpose === "brand-bundle" || purpose === "npm-installed-package") { this.#sendError(message.id, new ProtocolError("INVALID_PARAMS")); return; }
    }
    if (message.method === "$/cancelRequest") { this.#session.cancel(message.params.id); return; }
    if (message.method === "shutdown") { await this.#shutdown(message.id); return; }
    const supported = this.#session.negotiatedVersion === "1.2" ? SUPPORTED_REQUEST_METHODS_1_2 : this.#session.negotiatedVersion === "1.1" ? SUPPORTED_REQUEST_METHODS_1_1 : SUPPORTED_REQUEST_METHODS;
    if (!(supported as readonly string[]).includes(message.method)) { this.#sendError(message.id, new ProtocolError("METHOD_NOT_FOUND")); return; }
    const method = message.method as SupportedRequestMethod;
    if (method === "initialize" || method === "shutdown") return;
    if (this.#session.hasRequest(message.id)) { this.#sendError(message.id, new ProtocolError("INVALID_REQUEST_ID")); return; }
    const progress = (stage: StudioProgressStage, completed: number, total?: number): void => {
      if (!this.#clientProgress || this.#closed) return;
      this.#write({ jsonrpc: "2.0", method: "$/progress", params: { requestId: message.id, stage, completed, ...(total === undefined ? {} : { total }) } });
    };
    if (MUTATION_METHODS.has(method as StudioMutationMethod)) {
      const mutationMethod = method as StudioMutationMethod;
      try {
        const execute = (signal: AbortSignal): Promise<unknown> => this.#mutations.execute(
          mutationMethod, message.params, signal, message.id, progress,
        );
        const result = mutationMethod === "plan.apply"
          ? await this.#session.runMutation(message.id, execute)
          : await this.#session.scheduler.submit(message.id, this.#mutations.lane(mutationMethod, message.params), execute);
        validateResult(method, result);
        this.#sendResult(message.id, result);
      } catch (error) { this.#sendError(message.id, toProtocolError(error)); }
      return;
    }
    let lane: string;
    try { lane = this.#reads.lane(method, message.params); }
    catch (error) { this.#sendError(message.id, toProtocolError(error)); return; }
    try {
      const result = await this.#session.scheduler.submit(message.id, lane, async (signal) => this.#reads.execute(
        method, message.params, signal, message.id,
        (stage, completed, total) => {
          if (!this.#clientProgress || this.#closed) return;
          this.#write({ jsonrpc: "2.0", method: "$/progress", params: { requestId: message.id, stage, completed, ...(total === undefined ? {} : { total }) } });
        },
      ));
      validateResult(method, result);
      this.#sendResult(message.id, result);
    } catch (error) { this.#sendError(message.id, toProtocolError(error)); }
  }

  async #nonceFailure(id: JsonRpcId | null): Promise<void> {
    if (id !== null) this.#sendError(id, new ProtocolError("SESSION_NONCE_INVALID"));
    this.#log("nonce-rejected", "SESSION_NONCE_INVALID");
    if (this.#session.nonceFailures >= 3) await this.#close(1);
  }

  async #shutdown(id: JsonRpcId): Promise<void> {
    this.#shutdownTask ??= this.#performShutdown();
    await this.#shutdownTask;
    validateResult("shutdown", null);
    this.#sendResult(id, null);
  }

  async #performShutdown(): Promise<void> {
    await this.#session.shutdown();
  }

  async #eof(): Promise<void> {
    if (this.#closed) return;
    try { this.#framer.end(); }
    catch (error) { this.#framingFailure(error); return; }
    this.#session.shuttingDown = true;
    this.#session.cancelAll();
    let timedOut = false;
    await Promise.race([
      this.#session.shutdown(),
      new Promise<void>((resolve) => setTimeout(() => { timedOut = true; resolve(); }, 5_000)),
    ]);
    await this.#close(timedOut ? 1 : 0);
  }

  async #close(code: number): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#exitCode = Math.max(this.#exitCode, code);
    this.#session.destroy();
    this.#io.input.pause();
    this.#io.onExitCode?.(this.#exitCode);
  }
}

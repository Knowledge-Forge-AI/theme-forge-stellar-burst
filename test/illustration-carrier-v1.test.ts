import { describe, expect, it } from "vitest";

import {
  createIllustrationCarrierManifest,
  createIllustrationConsumerLock,
  createIllustrationConsumerProfile,
  deriveIllustrationCarrierPaths,
  parseIllustrationCarrierManifest,
  parseIllustrationConsumerLock,
  parseIllustrationConsumerProfile,
  serializeIllustrationCarrierManifest,
  serializeIllustrationConsumerLock,
  serializeIllustrationConsumerProfile,
  validateIllustrationCarrierManifest,
  validateIllustrationConsumerLock,
  validateIllustrationConsumerProfile,
  IllustrationCarrierValidationError,
  type IllustrationCarrierDigest,
  type IllustrationCarrierManifestInput,
  type IllustrationConsumerLockInput,
  type IllustrationConsumerProfileInput,
  type IllustrationCarrierValidationCode,
} from "../src/illustration/carrier-v1.js";

const SHA_A = `sha256:${"a".repeat(64)}` as IllustrationCarrierDigest;
const SHA_B = `sha256:${"b".repeat(64)}` as IllustrationCarrierDigest;
const SHA_C = `sha256:${"c".repeat(64)}` as IllustrationCarrierDigest;

const DERIVATIVES = [
  {
    id: "thumb",
    recipeDigest: SHA_B,
    mime: "image/webp" as const,
    sha256: SHA_C,
    byteLength: 1024,
    width: 320,
    height: 180,
    alpha: "unknown" as const,
  },
  {
    id: "hero",
    recipeDigest: SHA_A,
    mime: "image/png" as const,
    sha256: SHA_B,
    byteLength: 2048,
    width: 1024,
    height: 768,
    alpha: "has-alpha" as const,
  },
] as const;

function manifestInput(overrides: Partial<IllustrationCarrierManifestInput> = {}): IllustrationCarrierManifestInput {
  return {
    packageId: "study-carrier",
    illustrationId: "study-illustration",
    revision: 7,
    recordDigest: SHA_A,
    derivatives: DERIVATIVES,
    ...overrides,
  };
}

function profileInput(overrides: Partial<IllustrationConsumerProfileInput> = {}): IllustrationConsumerProfileInput {
  return {
    id: "site-assets",
    packageId: "study-carrier",
    illustrationId: "study-illustration",
    mappings: [
      { derivativeId: "thumb", destination: "public/images/thumb.webp" },
      { derivativeId: "hero", destination: "public/images/hero.png" },
    ],
    ...overrides,
  };
}

function lockInput(
  profileDigest: IllustrationCarrierDigest,
  manifestDigest: IllustrationCarrierDigest,
  overrides: Partial<IllustrationConsumerLockInput> = {},
): IllustrationConsumerLockInput {
  return {
    packageId: "study-carrier",
    illustrationId: "study-illustration",
    carrierRevision: 7,
    profileDigest,
    manifestDigest,
    recordDigest: SHA_A,
    mappings: [
      {
        derivativeId: "thumb",
        destination: "public/images/thumb.webp",
        recipeDigest: SHA_B,
        sha256: SHA_C,
        mime: "image/webp",
        byteLength: 1024,
      },
      {
        derivativeId: "hero",
        destination: "public/images/hero.png",
        recipeDigest: SHA_A,
        sha256: SHA_B,
        mime: "image/png",
        byteLength: 2048,
      },
    ],
    ...overrides,
  };
}

function errorCode(action: () => unknown): IllustrationCarrierValidationCode {
  try {
    action();
  } catch (error) {
    if (error instanceof IllustrationCarrierValidationError) return error.code;
    throw error;
  }
  throw new Error("Expected carrier validation to fail");
}

function expectDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) expectDeepFrozen(descriptor.value, seen);
  }
}

describe("illustration directory carrier v1", () => {
  it("creates an immutable sorted manifest and derives only standard carrier paths", () => {
    const manifest = createIllustrationCarrierManifest(manifestInput());
    expect(manifest.packageId).toBe("study-carrier");
    expect(manifest.illustrationId).toBe("study-illustration");
    expect(manifest.revision).toBe(7);
    expect(manifest.derivatives.map((derivative) => derivative.id)).toEqual(["hero", "thumb"]);
    expectDeepFrozen(manifest);

    const wire = serializeIllustrationCarrierManifest(manifest);
    expect(wire.endsWith("\n")).toBe(true);
    expect(parseIllustrationCarrierManifest(wire)).toEqual(manifest);
    expect(parseIllustrationCarrierManifest(Buffer.from(wire, "utf8"))).toEqual(manifest);
    expect(deriveIllustrationCarrierPaths(manifest)).toEqual({
      manifest: "manifest.json",
      record: "record.json",
      recipes: ["recipes/hero.json", "recipes/thumb.json"],
      derivatives: ["derivatives/hero.png", "derivatives/thumb.webp"],
      all: [
        "manifest.json",
        "record.json",
        "recipes/hero.json",
        "recipes/thumb.json",
        "derivatives/hero.png",
        "derivatives/thumb.webp",
      ],
    });
  });

  it("creates canonical profile and lock mappings with immutable outputs", () => {
    const manifest = createIllustrationCarrierManifest(manifestInput());
    const profile = createIllustrationConsumerProfile(profileInput());
    const lock = createIllustrationConsumerLock(lockInput(profile.profileDigest, manifest.manifestDigest));
    expect(profile.packageId).toBe("study-carrier");
    expect(profile.illustrationId).toBe("study-illustration");
    expect(lock.packageId).toBe("study-carrier");
    expect(lock.illustrationId).toBe("study-illustration");
    expect(lock.carrierRevision).toBe(7);
    expect(profile.mappings.map((mapping) => mapping.derivativeId)).toEqual(["hero", "thumb"]);
    expect(lock.mappings.map((mapping) => mapping.derivativeId)).toEqual(["hero", "thumb"]);
    expectDeepFrozen(profile);
    expectDeepFrozen(lock);
    expect(parseIllustrationConsumerProfile(serializeIllustrationConsumerProfile(profile))).toEqual(profile);
    expect(parseIllustrationConsumerLock(serializeIllustrationConsumerLock(lock))).toEqual(lock);
    expect(lock.mappings.map((mapping) => mapping.destination)).toEqual([
      "public/images/hero.png",
      "public/images/thumb.webp",
    ]);
  });

  it("rejects digest tampering, duplicate identities, and duplicate JSON fields", () => {
    const manifest = createIllustrationCarrierManifest(manifestInput());
    expect(errorCode(() => validateIllustrationCarrierManifest({ ...manifest, revision: 8 }))).toBe("DIGEST_MISMATCH");
    expect(errorCode(() => validateIllustrationCarrierManifest({ ...manifest, illustrationId: "other-illustration" }))).toBe("DIGEST_MISMATCH");
    const profile = createIllustrationConsumerProfile(profileInput());
    expect(errorCode(() => validateIllustrationConsumerProfile({ ...profile, packageId: "other-package" }))).toBe("DIGEST_MISMATCH");
    const lock = createIllustrationConsumerLock(lockInput(profile.profileDigest, manifest.manifestDigest));
    expect(errorCode(() => validateIllustrationConsumerLock({ ...lock, carrierRevision: 6 }))).toBe("DIGEST_MISMATCH");

    const duplicateDerivative = { ...DERIVATIVES[0]!, id: "hero" };
    expect(errorCode(() => createIllustrationCarrierManifest(manifestInput({ derivatives: [...DERIVATIVES, duplicateDerivative] })))).toBe("DUPLICATE");

    const duplicateMapping = { derivativeId: "thumb", destination: "public/images/other.png" };
    expect(errorCode(() => createIllustrationConsumerProfile(profileInput({ mappings: [profileInput().mappings[0]!, duplicateMapping] })))).toBe("DUPLICATE");
    expect(errorCode(() => createIllustrationConsumerProfile(profileInput({ mappings: [
      { derivativeId: "hero", destination: "public/images/same.png" },
      { derivativeId: "thumb", destination: "public/images/same.png" },
    ] })))).toBe("DUPLICATE");
    expect(errorCode(() => createIllustrationConsumerProfile(profileInput({ mappings: [
      { derivativeId: "hero", destination: "public/art.png" },
      { derivativeId: "thumb", destination: "public/art.png/child.png" },
    ] })))).toBe("DUPLICATE");
    expect(errorCode(() => createIllustrationConsumerProfile(profileInput({ mappings: [
      { derivativeId: "hero", destination: "public/ART.PNG" },
      { derivativeId: "thumb", destination: "public/art.png/child.png" },
    ] })))).toBe("DUPLICATE");
    expect(errorCode(() => createIllustrationConsumerLock(lockInput(SHA_A, manifest.manifestDigest, {
      mappings: [
        { derivativeId: "hero", destination: "public/art.png", recipeDigest: SHA_A, sha256: SHA_B, mime: "image/png", byteLength: 1 },
        { derivativeId: "thumb", destination: "public/art.png/child.png", recipeDigest: SHA_B, sha256: SHA_C, mime: "image/webp", byteLength: 1 },
      ],
    })))).toBe("DUPLICATE");

    const duplicateFieldWire = serializeIllustrationCarrierManifest(manifest).replace(
      /\n  "packageId": "study-carrier",/u,
      "\n  \"packageId\": \"study-carrier\",\n  \"packageId\": \"study-carrier\",",
    );
    expect(errorCode(() => parseIllustrationCarrierManifest(duplicateFieldWire))).toBe("INVALID_JSON");
  });

  it("rejects private paths, URLs, protected destinations, and token-like IDs without echoing values", () => {
    const unsafeDestinations = [
      "../../private-fixture/output.png",
      "/home/private-fixture/output.png",
      "https://token@host/private.png",
      "public/.git/config",
      "public/.tfsb/state.json",
      "public/.tfsb-preview/state.json",
      "public/.serena/state.json",
      "public/node_modules/module.png",
      "public/profile.json",
      "public/build.lock.json",
      "public\\image.png",
    ];
    for (const destination of unsafeDestinations) {
      const code = errorCode(() => createIllustrationConsumerProfile(profileInput({ mappings: [{ derivativeId: "hero", destination }] })));
      expect(code).toBe("INVALID_PATH");
    }

    const tokenId = "token-secret";
    let error: IllustrationCarrierValidationError | undefined;
    try {
      createIllustrationCarrierManifest(manifestInput({ packageId: tokenId }));
    } catch (caught) {
      error = caught as IllustrationCarrierValidationError;
    }
    expect(error?.code).toBe("INVALID_ID");
    expect(error?.message).not.toContain(tokenId);
    expect(error?.message).not.toContain("private-fixture");
  });

  it("rejects accessors, symbols, non-plain prototypes, and unsafe collection bounds", () => {
    const manifest = createIllustrationCarrierManifest(manifestInput());
    let invoked = false;
    const getter = { ...manifest };
    Object.defineProperty(getter, "packageId", {
      enumerable: true,
      get: () => {
        invoked = true;
        return "study-carrier";
      },
    });
    expect(errorCode(() => validateIllustrationCarrierManifest(getter))).toBe("INVALID_ACCESSOR");
    expect(invoked).toBe(false);

    const symbolValue = { ...manifest, [Symbol("private")]: true };
    expect(errorCode(() => validateIllustrationCarrierManifest(symbolValue))).toBe("UNKNOWN_FIELD");

    const prototypeValue = Object.assign(Object.create({ inherited: true }), manifest);
    expect(errorCode(() => validateIllustrationCarrierManifest(prototypeValue))).toBe("INVALID_PROTOTYPE");

    const mappings = Array.from({ length: 17 }, (_, index) => ({
      derivativeId: `derivative-${String(index).padStart(2, "0")}`,
      destination: `public/images/derivative-${String(index).padStart(2, "0")}.png`,
    }));
    expect(errorCode(() => createIllustrationConsumerProfile(profileInput({ mappings })))).toBe("BOUNDS_EXCEEDED");
    expect(errorCode(() => createIllustrationCarrierManifest(manifestInput({
      derivatives: [{ ...DERIVATIVES[0]!, byteLength: 0 }],
    })))).toBe("INVALID_VALUE");
    expect(errorCode(() => createIllustrationCarrierManifest({
      packageId: "study-carrier",
      revision: 7,
      recordDigest: SHA_A,
      derivatives: DERIVATIVES,
    } as unknown as IllustrationCarrierManifestInput))).toBe("MISSING_FIELD");
    expect(errorCode(() => createIllustrationConsumerProfile({
      id: "site-assets",
      mappings: [],
    } as unknown as IllustrationConsumerProfileInput))).toBe("MISSING_FIELD");
    expect(errorCode(() => createIllustrationConsumerLock({
      profileDigest: SHA_A,
      manifestDigest: SHA_B,
      recordDigest: SHA_C,
      mappings: [],
    } as unknown as IllustrationConsumerLockInput))).toBe("MISSING_FIELD");
    expect(errorCode(() => createIllustrationConsumerLock(lockInput(SHA_A, SHA_B, { carrierRevision: 0 })))).toBe("INVALID_VALUE");
  });

  it("rejects BOM, malformed UTF-8, excessive depth, noncanonical JSON, and non-NFC paths", () => {
    const manifest = createIllustrationCarrierManifest(manifestInput());
    const wire = serializeIllustrationCarrierManifest(manifest);
    expect(errorCode(() => parseIllustrationCarrierManifest(`\uFEFF${wire}`))).toBe("BOM_FORBIDDEN");
    expect(errorCode(() => parseIllustrationCarrierManifest(Uint8Array.of(0xc3, 0x28)))).toBe("INVALID_UTF8");
    expect(errorCode(() => parseIllustrationCarrierManifest("[".repeat(33)))).toBe("NESTING_EXCEEDED");
    expect(errorCode(() => parseIllustrationCarrierManifest(JSON.stringify(manifest)))).toBe("NONCANONICAL_JSON");
    const tooDeep = `public/${Array.from({ length: 32 }, (_, index) => `d${index}`).join("/")}/image.png`;
    expect(errorCode(() => createIllustrationConsumerProfile(profileInput({
      mappings: [{ derivativeId: "hero", destination: tooDeep }],
    })))).toBe("BOUNDS_EXCEEDED");
    expect(errorCode(() => createIllustrationConsumerProfile(profileInput({
      mappings: [{ derivativeId: "hero", destination: "public/cafe\u0301.png" }],
    })))).toBe("INVALID_TEXT");
  });
});

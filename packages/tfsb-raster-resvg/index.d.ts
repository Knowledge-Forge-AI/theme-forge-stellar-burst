export interface RasterAdapterDescriptor {
  readonly adapterId: "resvg-png-v1";
  readonly companionPackage: "@knowledge-forge-ai/tfsb-raster-resvg";
  readonly companionVersion: "0.0.0-tfsb47f";
  readonly backend: "wasm";
  readonly rendererPackage: "@resvg/resvg-wasm";
  readonly rendererVersion: "2.6.2";
  readonly rendererBuildDigest: `sha256:${string}`;
  readonly nodeMajor: 22;
  readonly platformClaim: string;
  readonly qualificationId: string;
}

export interface RasterRenderRequest {
  readonly canonicalSvgBytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly backgroundRgba: readonly [number, number, number, number] | null;
  readonly alpha: "straight" | "opaque";
  readonly fit: "contain-pad";
  readonly colorSpace: "srgb";
}

export interface RasterAdapterRenderResult {
  readonly width: number;
  readonly height: number;
  readonly rgba8: Uint8Array;
  readonly pngBytes: Uint8Array;
  readonly descriptor: RasterAdapterDescriptor;
}

export declare const descriptor: RasterAdapterDescriptor;
export declare function renderSvg(request: RasterRenderRequest): Promise<RasterAdapterRenderResult>;

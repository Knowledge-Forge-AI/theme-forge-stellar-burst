# Studio service protocol v1 transcript

The arrows are transcript annotations and are not part of newline-delimited
JSON framing. Each JSON object occupies one strict UTF-8 line. Opaque values
are redacted examples rather than live credentials or handles.

```text
client -> {"jsonrpc":"2.0","id":"1","method":"initialize","params":{"protocol":"tfsb.studio","minVersion":"1.0","maxVersion":"1.0","client":{"name":"tfsb-studio","version":"0.1.0"},"capabilities":{"progress":true,"cancellation":true}}}
server -> {"jsonrpc":"2.0","id":"1","result":{"protocol":"tfsb.studio","selectedVersion":"1.0","server":{"name":"tfsb-studio-service","version":"0.3.0"},"sessionNonce":"REDACTED_EXAMPLE_NONCE","capabilities":{"methods":{"workspaceOpen":true,"projectOpen":true,"sourceOpen":true,"workspaceStatus":true,"projectList":true,"assetList":true,"assetGet":true,"assetValidate":true,"assetDiff":true,"sourceAnalyze":true,"previewStatus":true,"progress":true,"cancellation":true,"mutationPlans":false,"planApply":false},"limits":{"maxFrameBytes":16777216,"maxConcurrentReads":4,"maxQueuedReads":4,"assetPageSizeMin":1,"assetPageSizeDefault":64,"assetPageSizeMax":128,"sourceDetailPageSizeMin":1,"sourceDetailPageSizeDefault":64,"sourceDetailPageSizeMax":128}}}}
client -> {"jsonrpc":"2.0","method":"initialized","params":{"sessionNonce":"REDACTED_EXAMPLE_NONCE"}}
client -> {"jsonrpc":"2.0","id":"2","method":"source.open","params":{"sessionNonce":"REDACTED_EXAMPLE_NONCE","path":"/path-selected-by-rust-host"}}
server -> {"jsonrpc":"2.0","id":"2","result":{"sourceHandle":"source_REDACTED_EXAMPLE_HANDLE","rootKind":"source","sourceKind":"directory","digest":"sha256:7777777777777777777777777777777777777777777777777777777777777777","candidateCount":1,"capabilities":{"analyze":true,"mutation":false}}}
client -> {"jsonrpc":"2.0","id":"3","method":"source.analyze","params":{"sessionNonce":"REDACTED_EXAMPLE_NONCE","sourceHandle":"source_REDACTED_EXAMPLE_HANDLE","includeDetails":false,"pageSize":64}}
server -> {"jsonrpc":"2.0","method":"$/progress","params":{"requestId":"3","stage":"started","completed":0}}
server -> {"jsonrpc":"2.0","method":"$/progress","params":{"requestId":"3","stage":"complete","completed":1,"total":1}}
server -> {"jsonrpc":"2.0","id":"3","result":{"sourceKind":"directory","status":"ok","summary":{"totals":{"files":1,"svgFiles":1},"profiles":{"schema1":{"profile":"tfsb-svg-schema-1","counts":{"directlyImportable":1,"importableWithNormalization":0,"unsupported":0,"unsafe":0},"diagnosticCounts":{},"featureCounts":{},"normalizationCounts":{}},"commonV03":{"profile":"tfsb-svg-common-v0.3","counts":{"directlyImportable":1,"importableWithNormalization":0,"unsupported":0,"unsafe":0},"diagnosticCounts":{},"featureCounts":{},"normalizationCounts":{}}},"resourceObservations":{"sourceBytes":100,"maxFileBytes":100,"xmlElements":2},"identity":{"invalidAssetIdentities":0,"assetIdCollisions":{"groups":0,"affectedFiles":0},"portablePathCollisions":{"groups":0,"affectedFiles":0}}},"details":{"count":0,"items":[],"nextCursor":null}}}
client -> {"jsonrpc":"2.0","id":"4","method":"plan.apply","params":{"sessionNonce":"REDACTED_EXAMPLE_NONCE"}}
server -> {"jsonrpc":"2.0","id":"4","error":{"code":-32020,"message":"The typed method is unavailable in this service capability set.","data":{"code":"METHOD_CAPABILITY_UNAVAILABLE","message":"The typed method is unavailable in this service capability set.","retryable":false}}}
client -> {"jsonrpc":"2.0","id":"5","method":"shutdown","params":{"sessionNonce":"REDACTED_EXAMPLE_NONCE"}}
server -> {"jsonrpc":"2.0","id":"5","result":null}
client -> {"jsonrpc":"2.0","method":"exit","params":{}}
```

TFSB45B replaces the unavailable plan response with the separately reviewed
typed plan registry/apply authority while preserving protocol 1.0.

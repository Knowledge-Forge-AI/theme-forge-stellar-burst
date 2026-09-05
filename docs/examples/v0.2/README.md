# TFSB v0.2 lifecycle examples

These are non-authoritative design examples for the
v0.2 lifecycle model. They use the real
Terminal Nova production fixture as their scenario source. Hashes in the JSON
examples were calculated from the named fixture bytes and the current canonical
schema-1 serializers during TFSB20.

```text
project.toml                 # unchanged schema-1 production policy shape
provenance.json              # selected central provenance representation
tfsb-manifest.json           # selected three-asset/README bundle inventory
check-result.json            # versioned machine check result
reconcile-result.json        # versioned conflict result
preview-result.json          # static preview JSON v1 success envelope
model.ts                     # typed lifecycle/API boundary sketch
```

`project.toml` demonstrates that v0.2 does not require schema migration. The
asset TOML language remains exactly the v0.1 shape; see the
[v0.1 assets](../v0.1/README.md) for full syntax examples.

`provenance.json` is committed reconciliation evidence but not schema-1 source.
The example is deliberately partial: missing records are supported and use the
bootstrap classification rules.

`tfsb-manifest.json` represents a selected outbound bundle containing three
fresh canonical SVGs and the opaque brand README. The manifest itself is not
listed in its `files` array and never validates content by assertion alone.

The TypeScript file is a design sketch, not current implementation source. It
shows the intended separation between pure plans, transaction execution,
public result values, and CLI presentation.

`preview-result.json` contains only project-relative gallery paths,
deterministic asset/companion status DTOs, and the best-effort opener outcome.
It deliberately excludes generated HTML, CSS, SVG and marker bytes, absolute
roots, archive source paths, and host or environment data.

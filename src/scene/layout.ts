import { fail, type DiagnosticContext } from "../diagnostics.js";
import {
  computeElementBounds,
  getCardinalAnchor,
  type ElementBounds,
} from "./geometry.js";
import type {
  CardinalAnchor,
  LayoutDirective,
  SceneElement,
  SymbolDef,
  TransformOperation,
} from "./types.js";

interface DependencyNode {
  readonly directive: LayoutDirective;
  readonly index: number;
  readonly targets: ReadonlySet<string>;
  readonly references: ReadonlySet<string>;
}

/**
 * Topologically sort layout directives and detect cycles.
 */
function topologicalSortDirectives(
  directives: readonly LayoutDirective[],
  ctx: DiagnosticContext,
  location: string,
): readonly LayoutDirective[] {
  const nodes: DependencyNode[] = directives.map((d, index) => {
    const targets = new Set<string>();
    const references = new Set<string>();

    switch (d.type) {
      case "align": {
        for (const t of d.targets) targets.add(t);
        if (d.relativeTo !== undefined) references.add(d.relativeTo);
        break;
      }
      case "distribute": {
        for (const t of d.targets) targets.add(t);
        break;
      }
      case "grid": {
        for (const t of d.targets) targets.add(t);
        break;
      }
      case "anchor": {
        targets.add(d.target);
        references.add(d.relativeTo);
        if (d.target === d.relativeTo) {
          fail(
            ctx,
            "SCENE_CYCLIC_LAYOUT",
            `Element '${d.target}' cannot anchor to itself.`,
            `${location}[${index}]`,
          );
        }
        break;
      }
    }

    return { directive: d, index, targets, references };
  });

  // Build adjacency list: node i must precede node j if j references what i targets
  const adj = new Map<number, Set<number>>();
  const inDegree = new Array(nodes.length).fill(0);

  for (let i = 0; i < nodes.length; i += 1) {
    adj.set(i, new Set());
  }

  for (let i = 0; i < nodes.length; i += 1) {
    const nodeI = nodes[i]!;
    for (let j = 0; j < nodes.length; j += 1) {
      if (i === j) continue;
      const nodeJ = nodes[j]!;
      // If nodeJ references an element modified by nodeI, nodeI must execute before nodeJ
      let depends = false;
      for (const ref of nodeJ.references) {
        if (nodeI.targets.has(ref)) {
          depends = true;
          break;
        }
      }
      // If both target the same element, preserve authored order
      if (!depends && i < j) {
        for (const t of nodeJ.targets) {
          if (nodeI.targets.has(t)) {
            depends = true;
            break;
          }
        }
      }
      if (depends) {
        adj.get(i)!.add(j);
      }
    }
  }

  for (let i = 0; i < nodes.length; i += 1) {
    for (const j of adj.get(i)!) {
      inDegree[j] += 1;
    }
  }

  const queue: number[] = [];
  for (let i = 0; i < nodes.length; i += 1) {
    if (inDegree[i] === 0) {
      queue.push(i);
    }
  }

  const sorted: LayoutDirective[] = [];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    sorted.push(nodes[curr]!.directive);
    for (const neighbor of adj.get(curr)!) {
      inDegree[neighbor] -= 1;
      if (inDegree[neighbor] === 0) {
        queue.push(neighbor);
      }
    }
  }

  if (sorted.length !== directives.length) {
    fail(
      ctx,
      "SCENE_CYCLIC_LAYOUT",
      "Cyclic dependency detected in layout directives.",
      location,
    );
  }

  return sorted;
}

/**
 * Apply layout directives once to elements, updating their transforms.
 */
export function lowerLayout(
  elements: readonly SceneElement[],
  directives: readonly LayoutDirective[] | undefined,
  symbolsById: ReadonlyMap<string, SymbolDef>,
  ctx: DiagnosticContext,
  location: string,
): readonly SceneElement[] {
  if (directives === undefined || directives.length === 0) {
    return elements;
  }

  const order = new Map(elements.filter((e) => e.id !== undefined).map((e, i) => [e.id!, i]));
  const writes = new Set<string>();
  const normalized = directives.map((directive) => {
    const targets = directive.type === "anchor" ? [directive.target] : [...directive.targets];
    if (new Set(targets).size !== targets.length) fail(ctx, "SCENE_CONTRADICTORY_LAYOUT", "Layout targets cannot be repeated.", location);
    const refs = directive.type === "anchor" || directive.type === "align" ? [directive.relativeTo].filter((id): id is string => id !== undefined) : [];
    for (const id of [...targets, ...refs]) {
      if (!order.has(id)) fail(ctx, "SCENE_MISSING_LAYOUT_TARGET", "Layout targets and references must be top-level elements in this scene.", location);
    }
    const axes = directive.type === "anchor" || directive.type === "grid" ? ["x", "y"] : directive.type === "distribute" ? [directive.axis === "horizontal" ? "x" : "y"] : [["left", "center", "right"].includes(directive.alignment) ? "x" : "y"];
    for (const id of targets) for (const axis of axes) {
      const key = `${id}/${axis}`;
      if (writes.has(key)) fail(ctx, "SCENE_CONTRADICTORY_LAYOUT", "Multiple layout directives write the same element axis.", location);
      writes.add(key);
    }
    if (directive.type === "anchor") return directive;
    targets.sort((a, b) => order.get(a)! - order.get(b)!);
    return { ...directive, targets };
  });
  const sortedDirectives = topologicalSortDirectives(normalized, ctx, location);

  // Map element by ID
  const elementMap = new Map<string, SceneElement>();
  const boundsMap = new Map<string, ElementBounds>();

  function registerElements(items: readonly SceneElement[]): void {
    for (const item of items) {
      if (item.id !== undefined) {
        elementMap.set(item.id, item);
        const b = computeElementBounds(item, symbolsById);
        if (b !== undefined) {
          boundsMap.set(item.id, b);
        }
      }
      if (item.type === "group") {
        registerElements(item.children);
      }
    }
  }

  registerElements(elements);

  // Helper to get bounds or fail
  function getRequiredBounds(id: string, dirLoc: string): ElementBounds {
    const el = elementMap.get(id);
    if (el === undefined) {
      fail(
        ctx,
        "SCENE_MISSING_LAYOUT_TARGET",
        `Layout directive references unknown element '${id}'.`,
        dirLoc,
      );
    }
    const b = boundsMap.get(id);
    if (b === undefined) {
      fail(
        ctx,
        "SCENE_MISSING_BOUNDS",
        `Element '${id}' has no determinable bounding box for layout. Group/use elements require explicit bounds.`,
        dirLoc,
      );
    }
    return b;
  }

  function applyDelta(id: string, dx: number, dy: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) fail(ctx, "SCENE_NON_FINITE_LAYOUT", "Layout produced non-finite coordinates.", location);
    if (dx === 0 && dy === 0) return;
    const el = elementMap.get(id)!;
    const existing = el.transform ?? [];
    const newOp: TransformOperation = {
      type: "translate",
      x: Object.is(dx, -0) ? 0 : dx,
      ...(dy !== 0 ? { y: Object.is(dy, -0) ? 0 : dy } : {}),
    };
    const updatedEl: SceneElement = {
      ...el,
      transform: [newOp, ...existing],
    };
    elementMap.set(id, updatedEl);

    // Update bounds
    const oldB = boundsMap.get(id)!;
    boundsMap.set(id, [oldB[0] + dx, oldB[1] + dy, oldB[2], oldB[3]]);
  }

  for (let dIdx = 0; dIdx < sortedDirectives.length; dIdx += 1) {
    const directive = sortedDirectives[dIdx]!;
    const dirLoc = `${location}[${dIdx}]`;

    switch (directive.type) {
      case "align": {
        if (directive.targets.length === 0) {
          fail(ctx, "SCENE_INVALID_LAYOUT", "align directive requires at least one target.", dirLoc);
        }

        let refCoord: number;
        if (directive.relativeTo !== undefined) {
          const refB = getRequiredBounds(directive.relativeTo, dirLoc);
          switch (directive.alignment) {
            case "left":
              refCoord = refB[0];
              break;
            case "center":
              refCoord = refB[0] + refB[2] / 2;
              break;
            case "right":
              refCoord = refB[0] + refB[2];
              break;
            case "top":
              refCoord = refB[1];
              break;
            case "middle":
              refCoord = refB[1] + refB[3] / 2;
              break;
            case "bottom":
              refCoord = refB[1] + refB[3];
              break;
          }
        } else {
          // Compute collective reference coordinate
          const boundsList = directive.targets.map((t) => getRequiredBounds(t, dirLoc));
          switch (directive.alignment) {
            case "left":
              refCoord = Math.min(...boundsList.map((b) => b[0]));
              break;
            case "center": {
              const minX = Math.min(...boundsList.map((b) => b[0]));
              const maxX = Math.max(...boundsList.map((b) => b[0] + b[2]));
              refCoord = (minX + maxX) / 2;
              break;
            }
            case "right":
              refCoord = Math.max(...boundsList.map((b) => b[0] + b[2]));
              break;
            case "top":
              refCoord = Math.min(...boundsList.map((b) => b[1]));
              break;
            case "middle": {
              const minY = Math.min(...boundsList.map((b) => b[1]));
              const maxY = Math.max(...boundsList.map((b) => b[1] + b[3]));
              refCoord = (minY + maxY) / 2;
              break;
            }
            case "bottom":
              refCoord = Math.max(...boundsList.map((b) => b[1] + b[3]));
              break;
          }
        }

        for (const t of directive.targets) {
          const b = getRequiredBounds(t, dirLoc);
          let dx = 0;
          let dy = 0;
          switch (directive.alignment) {
            case "left":
              dx = refCoord - b[0];
              break;
            case "center":
              dx = refCoord - (b[0] + b[2] / 2);
              break;
            case "right":
              dx = refCoord - (b[0] + b[2]);
              break;
            case "top":
              dy = refCoord - b[1];
              break;
            case "middle":
              dy = refCoord - (b[1] + b[3] / 2);
              break;
            case "bottom":
              dy = refCoord - (b[1] + b[3]);
              break;
          }
          applyDelta(t, dx, dy);
        }
        break;
      }

      case "distribute": {
        if (directive.targets.length < 2) {
          fail(ctx, "SCENE_INVALID_LAYOUT", "distribute directive requires at least two targets.", dirLoc);
        }
        const boundsList = directive.targets.map((t) => getRequiredBounds(t, dirLoc));

        if (directive.axis === "horizontal") {
          if (directive.spacing !== undefined) {
            let cursorX = boundsList[0]![0];
            for (let i = 0; i < directive.targets.length; i += 1) {
              const t = directive.targets[i]!;
              const b = boundsMap.get(t)!;
              const dx = cursorX - b[0];
              applyDelta(t, dx, 0);
              cursorX += b[2] + directive.spacing;
            }
          } else {
            const first = boundsList[0]!;
            const last = boundsList[boundsList.length - 1]!;
            const totalSpan = (last[0] + last[2]) - first[0];
            const sumWidths = boundsList.reduce((acc, b) => acc + b[2], 0);
            const totalGap = totalSpan - sumWidths;
            const gap = totalGap / (directive.targets.length - 1);
            let cursorX = first[0];
            for (let i = 0; i < directive.targets.length; i += 1) {
              const t = directive.targets[i]!;
              const b = boundsMap.get(t)!;
              const dx = cursorX - b[0];
              applyDelta(t, dx, 0);
              cursorX += b[2] + gap;
            }
          }
        } else {
          // vertical
          if (directive.spacing !== undefined) {
            let cursorY = boundsList[0]![1];
            for (let i = 0; i < directive.targets.length; i += 1) {
              const t = directive.targets[i]!;
              const b = boundsMap.get(t)!;
              const dy = cursorY - b[1];
              applyDelta(t, 0, dy);
              cursorY += b[3] + directive.spacing;
            }
          } else {
            const first = boundsList[0]!;
            const last = boundsList[boundsList.length - 1]!;
            const totalSpan = (last[1] + last[3]) - first[1];
            const sumHeights = boundsList.reduce((acc, b) => acc + b[3], 0);
            const totalGap = totalSpan - sumHeights;
            const gap = totalGap / (directive.targets.length - 1);
            let cursorY = first[1];
            for (let i = 0; i < directive.targets.length; i += 1) {
              const t = directive.targets[i]!;
              const b = boundsMap.get(t)!;
              const dy = cursorY - b[1];
              applyDelta(t, 0, dy);
              cursorY += b[3] + gap;
            }
          }
        }
        break;
      }

      case "grid": {
        if (directive.targets.length === 0) {
          fail(ctx, "SCENE_INVALID_LAYOUT", "grid directive requires at least one target.", dirLoc);
        }
        if (directive.columns < 1 || directive.columns > directive.targets.length || !Number.isInteger(directive.columns)) {
          fail(ctx, "SCENE_INVALID_NUMBER", "grid columns must be a positive integer.", `${dirLoc}.columns`);
        }
        const colGap = directive.columnGap ?? 0;
        const rowGap = directive.rowGap ?? 0;
        const firstB = getRequiredBounds(directive.targets[0]!, dirLoc);
        const startX = directive.startX ?? firstB[0];
        const startY = directive.startY ?? firstB[1];

        // Determine column widths and row heights
        const cols = directive.columns;
        const colWidths: number[] = new Array(cols).fill(0);
        const rowHeights: number[] = [];

        for (let i = 0; i < directive.targets.length; i += 1) {
          const t = directive.targets[i]!;
          const b = getRequiredBounds(t, dirLoc);
          const col = i % cols;
          const row = Math.floor(i / cols);
          if (b[2] > (colWidths[col] ?? 0)) {
            colWidths[col] = b[2];
          }
          while (rowHeights.length <= row) {
            rowHeights.push(0);
          }
          if (b[3] > (rowHeights[row] ?? 0)) {
            rowHeights[row] = b[3];
          }
        }

        // Compute row top positions
        const rowPositions: number[] = [startY];
        for (let r = 1; r < rowHeights.length; r += 1) {
          rowPositions.push(rowPositions[r - 1]! + rowHeights[r - 1]! + rowGap);
        }

        // Compute column left positions
        const colPositions: number[] = [startX];
        for (let c = 1; c < cols; c += 1) {
          colPositions.push(colPositions[c - 1]! + colWidths[c - 1]! + colGap);
        }

        for (let i = 0; i < directive.targets.length; i += 1) {
          const t = directive.targets[i]!;
          const b = getRequiredBounds(t, dirLoc);
          const col = i % cols;
          const row = Math.floor(i / cols);
          const targetX = colPositions[col]!;
          const targetY = rowPositions[row]!;
          applyDelta(t, targetX - b[0], targetY - b[1]);
        }
        break;
      }

      case "anchor": {
        const targetB = getRequiredBounds(directive.target, dirLoc);
        const refB = getRequiredBounds(directive.relativeTo, dirLoc);

        const targetAnchorCoord = getCardinalAnchor(targetB, directive.targetAnchor);
        const refAnchorCoord = getCardinalAnchor(refB, directive.relativeToAnchor);

        const offsetX = directive.offsetX ?? 0;
        const offsetY = directive.offsetY ?? 0;

        const dx = refAnchorCoord[0] + offsetX - targetAnchorCoord[0];
        const dy = refAnchorCoord[1] + offsetY - targetAnchorCoord[1];

        applyDelta(directive.target, dx, dy);
        break;
      }
    }
  }

  // Reconstruct element tree with updated elements
  function updateTree(items: readonly SceneElement[]): readonly SceneElement[] {
    return items.map((item) => {
      let updated = item.id !== undefined && elementMap.has(item.id) ? elementMap.get(item.id)! : item;
      if (updated.type === "group") {
        updated = {
          ...updated,
          children: updateTree(updated.children),
        };
      }
      return updated;
    });
  }

  return updateTree(elements);
}

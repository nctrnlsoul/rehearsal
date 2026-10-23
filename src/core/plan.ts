/**
 * Dependency ordering for scenario steps. Pure: no I/O, no clock, no randomness,
 * so the dry run and the real run produce byte-identical plans.
 */

export type PlanNode = {
  readonly id: string;
  readonly needs: readonly string[];
};

export type PlanErrorCode = "duplicate-id" | "dangling-dependency" | "self-dependency" | "cycle";

export type PlanError = {
  readonly code: PlanErrorCode;
  readonly message: string;
  readonly ids: string[];
};

export type PlanResult =
  | { readonly ok: true; readonly order: string[]; readonly waves: string[][] }
  | { readonly ok: false; readonly errors: PlanError[] };

export function topologicalOrder(nodes: readonly PlanNode[]): PlanResult {
  const errors: PlanError[] = [];

  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.id)) {
      errors.push({
        code: "duplicate-id",
        message: `step id ${node.id} is declared more than once`,
        ids: [node.id],
      });
    }
    seen.add(node.id);
  }

  for (const node of nodes) {
    for (const need of node.needs) {
      if (need === node.id) {
        errors.push({
          code: "self-dependency",
          message: `step ${node.id} depends on itself`,
          ids: [node.id],
        });
      } else if (!seen.has(need)) {
        errors.push({
          code: "dangling-dependency",
          message: `step ${node.id} depends on ${need}, which is not a step in this scenario`,
          ids: [node.id, need],
        });
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // Kahn's algorithm, seeded in declaration order so the plan is reproducible.
  const remaining = new Map<string, Set<string>>();
  for (const node of nodes) {
    remaining.set(node.id, new Set(node.needs));
  }

  const order: string[] = [];
  const waves: string[][] = [];
  const done = new Set<string>();

  while (remaining.size > 0) {
    const wave = nodes
      .map((node) => node.id)
      .filter((id) => remaining.has(id) && remaining.get(id)!.size === 0);

    if (wave.length === 0) {
      // Everything left is in, or blocked behind, a cycle.
      const stuck = [...remaining.keys()].sort();
      errors.push({
        code: "cycle",
        message: `these steps form or depend on a dependency cycle: ${stuck.join(", ")}`,
        ids: stuck,
      });
      return { ok: false, errors };
    }

    waves.push(wave);
    for (const id of wave) {
      order.push(id);
      done.add(id);
      remaining.delete(id);
    }
    for (const needs of remaining.values()) {
      for (const d of done) needs.delete(d);
    }
  }

  return { ok: true, order, waves };
}

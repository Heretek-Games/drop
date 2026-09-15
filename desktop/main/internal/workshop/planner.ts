/**
 * Drop Workshop mod planner (#20 mod manager).
 *
 * Given the manifests of the mods a user subscribed to, compute a dependency-
 * first install order, report missing dependencies, and surface file conflicts
 * (two mods shipping the same relative path). Pure and unit-tested so the
 * desktop can plan a load order without touching the filesystem.
 */

export interface ModDependency {
  id: string;
  version?: string;
}

export interface ModManifest {
  id: string;
  name: string;
  version: string;
  dependencies?: ModDependency[];
  files?: string[];
}

export interface ModConflict {
  path: string;
  mods: string[];
}

export interface ModLoadPlan {
  order: string[];
  missing: string[];
  conflicts: ModConflict[];
}

/**
 * Compute the load plan.
 *
 * @throws when the dependency graph contains a cycle.
 */
export function planModLoad(mods: ModManifest[]): ModLoadPlan {
  const manifests = new Map(mods.map((mod) => [mod.id, mod]));
  const order: string[] = [];
  const missing = new Set<string>();
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      throw new Error(`Mod dependency cycle detected at '${id}'`);
    }
    visiting.add(id);
    const manifest = manifests.get(id);
    for (const dependency of manifest?.dependencies ?? []) {
      if (!manifests.has(dependency.id)) {
        missing.add(dependency.id);
        continue;
      }
      visit(dependency.id);
    }
    visiting.delete(id);
    visited.add(id);
    order.push(id);
  };

  // Deterministic: iterate mods in a stable (sorted) order.
  for (const mod of [...mods].sort((a, b) => a.id.localeCompare(b.id))) {
    visit(mod.id);
  }

  const fileOwners = new Map<string, string[]>();
  for (const mod of mods) {
    for (const path of mod.files ?? []) {
      const owners = fileOwners.get(path) ?? [];
      owners.push(mod.id);
      fileOwners.set(path, owners);
    }
  }
  const conflicts: ModConflict[] = [...fileOwners.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([path, mods]) => ({
      path,
      mods: [...mods].sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  return {
    order,
    missing: [...missing].sort((a, b) => a.localeCompare(b)),
    conflicts,
  };
}

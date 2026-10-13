import { LATENCY_SERIES_COLORS } from './latency';

export type LatencyColorAssignment = ReadonlyMap<string, string>;
export type NodeLatencyColorRegistry = Map<string, Map<string, string>>;
export type LatencyColorPlan = { assignments: Map<string, string>; overflowTaskIds: string[] };

function isStableTaskId(taskId: string): boolean {
  return !taskId.startsWith('series-');
}

export function reconcileLatencyColors(registry: NodeLatencyColorRegistry, uuid: string, taskIds: readonly string[]): LatencyColorPlan {
  const knownIds = [...new Set(taskIds)].sort();
  const stableIds = knownIds.filter(isStableTaskId);
  const known = new Set(stableIds);
  const existing = registry.get(uuid) ?? new Map<string, string>();
  const assignments = new Map([...existing].filter(([taskId]) => known.has(taskId)));
  const usedColors = new Set(assignments.values());
  for (const taskId of stableIds) {
    if (assignments.has(taskId)) continue;
    const freeColor = LATENCY_SERIES_COLORS.find((color) => !usedColors.has(color));
    if (!freeColor) continue;
    assignments.set(taskId, freeColor);
    usedColors.add(freeColor);
  }
  registry.set(uuid, assignments);
  return { assignments, overflowTaskIds: knownIds.filter((taskId) => !assignments.has(taskId)) };
}

export function serializeLatencyColorRegistry(registry: NodeLatencyColorRegistry): unknown {
  return [...registry.entries()].map(([uuid, assignments]) => [uuid, [...assignments.entries()]]);
}

export function parseLatencyColorRegistry(value: unknown, maxScopes = 32): NodeLatencyColorRegistry {
  if (!Array.isArray(value) || value.length > maxScopes) return new Map();
  const registry: NodeLatencyColorRegistry = new Map();
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !Array.isArray(entry[1])) return new Map();
    const [uuid, rawAssignments] = entry as [string, unknown[]];
    if (!uuid || rawAssignments.length > LATENCY_SERIES_COLORS.length) return new Map();
    const assignments = new Map<string, string>();
    for (const item of rawAssignments) {
      if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || typeof item[1] !== 'string') return new Map();
      const [taskId, color] = item;
      if (!taskId || !LATENCY_SERIES_COLORS.includes(color as typeof LATENCY_SERIES_COLORS[number]) || assignments.has(taskId) || [...assignments.values()].includes(color)) return new Map();
      assignments.set(taskId, color);
    }
    registry.set(uuid, assignments);
  }
  return registry;
}

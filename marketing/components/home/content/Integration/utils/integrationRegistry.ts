import type { IntegrationBase, IntegrationCategory } from "../types";

export function getAllCategories(
  integrations: IntegrationBase[]
): IntegrationCategory[] {
  const categories = new Set(integrations.map((i) => i.category));
  return Array.from(categories).sort();
}

export function getRelatedIntegrations(
  integrations: IntegrationBase[],
  integration: IntegrationBase,
  limit: number = 4
): IntegrationBase[] {
  const candidates = integrations.filter((i) => i.slug !== integration.slug);

  return candidates
    .sort((a, b) => {
      const aMatch = a.category === integration.category ? 0 : 1;
      const bMatch = b.category === integration.category ? 0 : 1;
      return aMatch - bMatch;
    })
    .slice(0, limit);
}

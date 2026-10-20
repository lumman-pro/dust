import type { PluginListItem } from "@app/lib/api/poke/types";

export interface PokeListPluginsForScopeResponseBody {
  plugins: PluginListItem[];
  // True when the user's poke roles could not be resolved, so role-gated plugins are hidden.
  pokeRolesUnavailable: boolean;
}

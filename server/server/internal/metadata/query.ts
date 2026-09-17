import { fuzzy } from "fast-fuzzy";
import type { InternalGameMetadataResult } from "./types";

const YEAR_SUFFIX = /\((\d{4})\)\s*$/;

export interface ParsedSearchQuery {
  title: string;
  year?: number;
}

/**
 * Folder names commonly look like "Game Name (2005)" rather than the plain
 * title metadata providers expect. The trailing year is stripped for the
 * provider query and returned separately so results from a matching year can
 * be boosted without hiding results with mismatched year metadata.
 */
export function parseSearchQuery(query: string): ParsedSearchQuery {
  const match = query.match(YEAR_SUFFIX);
  if (!match) return { title: query };
  const title = query.slice(0, match.index).trim();
  if (!title) return { title: query };
  return { title, year: parseInt(match[1]) };
}

/**
 * Ranks provider results against the cleaned title, and boosts results whose
 * release year matches the parsed query year (remakes share titles, so the
 * year disambiguates) without hiding matches with wrong year metadata.
 */
export function rankSearchResults(
  results: InternalGameMetadataResult[],
  search: ParsedSearchQuery,
): Array<InternalGameMetadataResult & { fuzzy: number }> {
  return results
    .map((result) => {
      const match = fuzzy(search.title, result.name);
      const yearBoost = search.year && result.year === search.year ? 1 : 0;
      return { ...result, fuzzy: match + yearBoost };
    })
    .sort((a, b) => b.fuzzy - a.fuzzy);
}

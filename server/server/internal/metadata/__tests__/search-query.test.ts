import test from "node:test";
import assert from "node:assert/strict";
import { parseSearchQuery, rankSearchResults } from "../query";
import type { InternalGameMetadataResult } from "../types";

test("parseSearchQuery leaves plain titles untouched", () => {
  assert.deepEqual(parseSearchQuery("Baby Steps"), {
    title: "Baby Steps",
  });
  assert.deepEqual(parseSearchQuery("Doom 2"), { title: "Doom 2" });
});

test("parseSearchQuery strips a trailing (YYYY) and extracts the year", () => {
  assert.deepEqual(parseSearchQuery("Baby Steps (2025)"), {
    title: "Baby Steps",
    year: 2025,
  });
  assert.deepEqual(parseSearchQuery("Resident Evil (2005)"), {
    title: "Resident Evil",
    year: 2005,
  });
});

test("parseSearchQuery handles surrounding whitespace and inner years", () => {
  assert.deepEqual(parseSearchQuery("  Baby Steps   (2025)  "), {
    title: "Baby Steps",
    year: 2025,
  });
  assert.deepEqual(parseSearchQuery("( sic ) 2 (2025)"), {
    title: "( sic ) 2",
    year: 2025,
  });
  assert.deepEqual(parseSearchQuery("Game (2004) (2025)"), {
    title: "Game (2004)",
    year: 2025,
  });
});

test("parseSearchQuery falls back when the title would be empty", () => {
  assert.deepEqual(parseSearchQuery("(2025)"), { title: "(2025)" });
});

test("parseSearchQuery does not treat non-year parentheticals as years", () => {
  assert.deepEqual(parseSearchQuery("Doom (GOG)"), { title: "Doom (GOG)" });
  assert.deepEqual(parseSearchQuery("Game (20055)"), { title: "Game (20055)" });
});

function makeResult(
  id: string,
  name: string,
  year: number,
): InternalGameMetadataResult {
  return {
    id,
    name,
    icon: "",
    description: "",
    year,
    sourceId: "Steam",
    sourceName: "Steam",
  };
}

test("rankSearchResults only fuzzy-scores when no year was parsed", () => {
  const parsed = parseSearchQuery("Baby Steps");
  const results = [
    makeResult("a", "Baby Steps", 2021),
    makeResult("b", "Baby Steps", 2025),
  ];

  const ranked = rankSearchResults(results, parsed);
  assert.equal(ranked[0].fuzzy, ranked[1].fuzzy);
});

test("rankSearchResults boosts the result matching the parsed query year", () => {
  const parsed = parseSearchQuery("Baby Steps (2025)");
  const results = [
    makeResult("a", "Baby Steps", 2021),
    makeResult("b", "Baby Steps", 2025),
  ];

  const ranked = rankSearchResults(results, parsed);
  assert.equal(ranked[0].id, "b");
  assert.ok(ranked[0].fuzzy > ranked[1].fuzzy);
});

test("rankSearchResults keeps mismatched-year results instead of hiding them", () => {
  const parsed = parseSearchQuery("Baby Steps (2025)");
  const results = [makeResult("a", "Baby Steps", 2021)];

  const ranked = rankSearchResults(results, parsed);
  assert.equal(ranked.length, 1);
  assert.ok(ranked[0].fuzzy > 0);
});

import { expect, test } from "@playwright/test";
import { matchesQuery, matchRanges, normalizeSearchText, SEARCH_MIN_ITEMS, searchTerms, shouldOfferSearch } from "../../src/lib/search";

/** Pure list-search helpers (run in Node, no page): every searchable list matches the same way. */
test.describe("list search helpers", () => {
  test("normalises case, accents and whitespace", () => {
    expect(normalizeSearchText("  José   ÁLVAREZ\tNuñez ")).toBe("jose alvarez nunez");
    expect(normalizeSearchText("Zoë Ångström")).toBe("zoe angstrom");
    expect(searchTerms("  Acme   Q3  ")).toEqual(["acme", "q3"]);
    expect(searchTerms("   ")).toEqual([]);
  });

  test("an empty or blank query matches everything", () => {
    expect(matchesQuery("", "anything")).toBe(true);
    expect(matchesQuery("   ", null, undefined)).toBe(true);
    expect(matchesQuery("")).toBe(true);
  });

  test("matching is case- and accent-insensitive in both directions", () => {
    expect(matchesQuery("jose", "José Álvarez")).toBe(true);
    expect(matchesQuery("JOSÉ", "jose alvarez")).toBe(true);
    expect(matchesQuery("munchen", "Kickoff in München")).toBe(true);
    expect(matchesQuery("zurich", "Zürich office")).toBe(true);
  });

  test("every word must match, in any order, across any field", () => {
    expect(matchesQuery("acme kickoff", "Kickoff call", "acme.example")).toBe(true);
    expect(matchesQuery("kickoff acme", "Acme kickoff")).toBe(true);
    expect(matchesQuery("acme renewal", "Acme kickoff")).toBe(false);
    expect(matchesQuery("pri", "Priya Shah", "priya@acme.example")).toBe(true);
  });

  test("ignores empty fields, accepts numbers and flattens nested field lists", () => {
    expect(matchesQuery("owner", null, undefined, false, "", "Owner")).toBe(true);
    expect(matchesQuery("2026", 2026)).toBe(true);
    expect(matchesQuery("northwind", ["Standup", ["dana@northwind.example", null]])).toBe(true);
    expect(matchesQuery("nothing", [], [[null]])).toBe(false);
  });

  test("words never match across two separate fields", () => {
    expect(matchesQuery("smithjones", "Smith", "Jones")).toBe(false);
    expect(matchesQuery("smith jones", "Smith", "Jones")).toBe(true);
  });

  test("special characters in a query are matched literally", () => {
    expect(matchesQuery("+5:45", "Asia/Kathmandu UTC+5:45")).toBe(true);
    expect(matchesQuery("a.b(c", "a.b(c) literal")).toBe(true);
    expect(matchesQuery(".*", "no regex here")).toBe(false);
  });

  test("search is offered for lists above the threshold, or while a query is active", () => {
    expect(SEARCH_MIN_ITEMS).toBe(6);
    expect(shouldOfferSearch(3)).toBe(false);
    expect(shouldOfferSearch(5)).toBe(false);
    expect(shouldOfferSearch(6)).toBe(true);
    expect(shouldOfferSearch(40)).toBe(true);
    expect(shouldOfferSearch(2, "acme")).toBe(true);
    expect(shouldOfferSearch(2, "   ")).toBe(false);
  });

  test("match ranges point into the original text, accents included", () => {
    expect(matchRanges("José met Jose", "jose")).toEqual([[0, 4], [9, 13]]);
    expect(matchRanges("Budget review: budget approved", "BUDGET")).toEqual([[0, 6], [15, 21]]);
    expect(matchRanges("Kickoff with Acme", "acme kick")).toEqual([[0, 4], [13, 17]]);
    expect(matchRanges("anything", "")).toEqual([]);
    expect(matchRanges("", "x")).toEqual([]);
  });

  test("overlapping match ranges are merged", () => {
    expect(matchRanges("abcdef", "abc bcd")).toEqual([[0, 4]]);
    expect(matchRanges("aaaa", "aa")).toEqual([[0, 4]]);
  });
});

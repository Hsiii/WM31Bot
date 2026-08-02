import { describe, expect, test } from "bun:test";

import {
  buildToeflVocabMessagePayload,
  formatToeflVocabMessage,
  selectDailyToeflVocabEntry,
  type ToeflVocabEntry,
} from "./toefl-vocab";

const entries: ToeflVocabEntry[] = [
  {
    word: "abate",
    partOfSpeech: "verb",
    definition: "To lessen in force or intensity.",
    sourceUrl: "https://en.wiktionary.org/wiki/abate",
  },
  {
    word: "adapt",
    partOfSpeech: "verb",
    definition: "To make suitable.",
    sourceUrl: "https://en.wiktionary.org/wiki/adapt",
  },
];

describe("selectDailyToeflVocabEntry", () => {
  test("selects the same entry for the same date", () => {
    expect(selectDailyToeflVocabEntry(entries, "2026-06-27")).toEqual(
      selectDailyToeflVocabEntry(entries, "2026-06-27"),
    );
  });

  test("rotates entries by date", () => {
    expect(selectDailyToeflVocabEntry(entries, "2026-06-27").word).not.toBe(
      selectDailyToeflVocabEntry(entries, "2026-06-28").word,
    );
  });
});

describe("formatToeflVocabMessage", () => {
  test("formats a concise panel text display", () => {
    const message = formatToeflVocabMessage({
      entry: {
        ...entries[0],
        zhTw: "減弱；緩和",
        example: "The storm began to abate after midnight.",
        synonyms: ["lessen", "subside"],
      },
      attribution: {
        sourceName: "Wiktionary",
        sourceUrl: "https://en.wiktionary.org/wiki/Wiktionary:Main_Page",
        license: "CC BY-SA 4.0",
        licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
      },
    });

    expect(message).toBe(
      [
        "TOEFL Word of the Day",
        "## [abate](<https://en.wiktionary.org/wiki/abate>)",
        "*verb* · 減弱；緩和",
        "> The storm began to abate after midnight.",
        "",
        "[Wiktionary](<https://en.wiktionary.org/wiki/Wiktionary:Main_Page>) · [CC BY-SA 4.0](<https://creativecommons.org/licenses/by-sa/4.0/>)",
      ].join("\n"),
    );
    expect(message).not.toContain("To lessen in force or intensity.");
    expect(message).not.toContain("Example:");
    expect(message).not.toContain("Source:");
    expect(message).not.toContain("License:");
  });

  test("builds a Components V2 payload", () => {
    const payload = buildToeflVocabMessagePayload({
      entry: entries[1],
      wordBank: {
        sourceName: "AWL",
        sourceUrl: "https://www.eapfoundation.com/vocab/academic/awllists/",
      },
      attribution: {
        sourceName: "Wiktionary",
        sourceUrl: "https://en.wiktionary.org/wiki/Wiktionary:Main_Page",
        license: "CC BY-SA 4.0",
        licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
      },
    });

    expect(payload.flags).toBe((1 << 15) | (1 << 2));
    expect(payload.components).toEqual([
      {
        type: 10,
        content: [
          "TOEFL Word of the Day",
          "## [adapt](<https://en.wiktionary.org/wiki/adapt>)",
          "*verb*",
          "",
          "[AWL](<https://www.eapfoundation.com/vocab/academic/awllists/>) · [Wiktionary](<https://en.wiktionary.org/wiki/Wiktionary:Main_Page>) · [CC BY-SA 4.0](<https://creativecommons.org/licenses/by-sa/4.0/>)",
        ].join("\n"),
      },
    ]);
  });
});

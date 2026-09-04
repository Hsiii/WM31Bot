import { describe, expect, test } from "bun:test";

const rules = (await Bun.file(".dockerignore").text())
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

describe("Docker build context", () => {
  test("excludes every local environment variant", () => {
    expect(rules).toContain(".env");
    expect(rules).toContain(".env.*");
    expect(rules).toContain("!.env.example");
    expect(rules).toContain("!.env.*.example");
    expect(rules).not.toContain("!.env.production");
    expect(rules).not.toContain("!.env.worker");
  });

  test("excludes dependency trees from every package", () => {
    expect(rules).toContain("node_modules");
    expect(rules).toContain("**/node_modules");
  });
});

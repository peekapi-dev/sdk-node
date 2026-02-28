import { describe, it, expect } from "vitest";
import { sortQueryString } from "../middleware/shared";

describe("sortQueryString", () => {
  it("returns empty string when no query string", () => {
    expect(sortQueryString("/users")).toBe("");
    expect(sortQueryString("/")).toBe("");
  });

  it("returns sorted query params", () => {
    expect(sortQueryString("/search?z=1&a=2&m=3")).toBe("?a=2&m=3&z=1");
  });

  it("returns same string when already sorted", () => {
    expect(sortQueryString("/search?a=1&b=2")).toBe("?a=1&b=2");
  });

  it("handles single param", () => {
    expect(sortQueryString("/users?role=admin")).toBe("?role=admin");
  });

  it("handles empty query string (just ?)", () => {
    expect(sortQueryString("/users?")).toBe("");
  });

  it("handles params with no values", () => {
    expect(sortQueryString("/users?b&a")).toBe("?a&b");
  });

  it("normalizes unsorted params so /foo?b=2&a=1 == /foo?a=1&b=2", () => {
    expect(sortQueryString("/foo?b=2&a=1")).toBe(sortQueryString("/foo?a=1&b=2"));
  });
});

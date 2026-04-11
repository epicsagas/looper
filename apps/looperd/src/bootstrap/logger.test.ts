import { describe, expect, test } from "bun:test";

import { formatLocalTimestamp } from "./logger";

describe("formatLocalTimestamp", () => {
  test("formats with local timezone offset", () => {
    const realOffset = Date.prototype.getTimezoneOffset;

    try {
      Date.prototype.getTimezoneOffset = () => -480;

      const formatted = formatLocalTimestamp(
        new Date("2026-04-11T12:34:56.789Z"),
      );

      expect(formatted).toBe("2026-04-11T20:34:56.789+08:00");
    } finally {
      Date.prototype.getTimezoneOffset = realOffset;
    }
  });

  test("formats negative timezone offset", () => {
    const realOffset = Date.prototype.getTimezoneOffset;

    try {
      Date.prototype.getTimezoneOffset = () => 420;

      const formatted = formatLocalTimestamp(
        new Date("2026-04-11T12:34:56.789Z"),
      );

      expect(formatted).toBe("2026-04-11T05:34:56.789-07:00");
    } finally {
      Date.prototype.getTimezoneOffset = realOffset;
    }
  });
});

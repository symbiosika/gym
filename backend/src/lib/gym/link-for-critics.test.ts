import { describe, expect, test } from "bun:test";
import { linkForCritics } from "./datasets";

describe("linkForCritics", () => {
  const link = "http://localhost:3000/api/v1/files/shared/abc";

  test("GYM's own link gets the address the critics reach GYM by", () => {
    expect(linkForCritics(link, "http://localhost:3000", "http://host.docker.internal:3000/")).toBe("http://host.docker.internal:3000/api/v1/files/shared/abc");
  });

  test("without the setting, or for a link that is not GYM's, nothing changes", () => {
    expect(linkForCritics(link, "http://localhost:3000", "")).toBe(link);
    const presigned = "https://bucket.s3.example.com/x?X-Amz-Signature=1";
    expect(linkForCritics(presigned, "http://localhost:3000", "http://host.docker.internal:3000")).toBe(presigned);
  });

  test("a host that only starts like GYM's is not GYM's", () => {
    expect(linkForCritics("http://localhost:30001/x", "http://localhost:3000", "http://h:3000")).toBe("http://localhost:30001/x");
  });
});

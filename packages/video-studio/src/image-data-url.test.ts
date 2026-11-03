import { describe, expect, it } from "vitest";
import { encodeLocalImageDataUrl } from "./image-data-url.js";

describe("local image data URLs", () => {
  it.each([
    ["png", "89504e470d0a1a0a0000000d49484452"],
    ["jpeg", "ffd8ffe000104a4649460001"],
    ["webp", "524946460000000057454250"],
  ])("labels %s signatures and preserves input bytes", (subtype, hex) => {
    const bytes = Buffer.from(hex, "hex");
    expect(encodeLocalImageDataUrl(bytes)).toBe(`data:image/${subtype};base64,${bytes.toString("base64")}`);
  });

  it.each(["", "89504e47", "d24946460000000057454250", "474946383961"])(
    "rejects empty, truncated or unsupported signatures (%s)",
    (hex) => expect(encodeLocalImageDataUrl(Buffer.from(hex, "hex"))).toBeNull(),
  );
});

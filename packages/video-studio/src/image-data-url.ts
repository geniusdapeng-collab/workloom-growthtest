const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const JPEG_SIGNATURE = Buffer.from("ffd8ff", "hex");
const RIFF_SIGNATURE = Buffer.from("RIFF");
const WEBP_SIGNATURE = Buffer.from("WEBP");

/** Registered local portraits can contain JPEG bytes under a historical PNG filename. */
export function encodeLocalImageDataUrl(bytes: Buffer): string | null {
  let subtype: string;
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) subtype = "png";
  else if (bytes.subarray(0, 3).equals(JPEG_SIGNATURE)) subtype = "jpeg";
  else if (bytes.subarray(0, 4).equals(RIFF_SIGNATURE) && bytes.subarray(8, 12).equals(WEBP_SIGNATURE)) subtype = "webp";
  else return null;
  return `data:image/${subtype};base64,${bytes.toString("base64")}`;
}

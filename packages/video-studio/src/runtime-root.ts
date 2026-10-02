import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Source checkouts and installed physical workspace packages share the product root. */
export function videoRuntimeRoot(moduleUrl: string): string {
  let directory = path.dirname(fileURLToPath(moduleUrl));
  for (let depth = 0; depth < 10; depth++) {
    if (existsSync(path.join(directory, "product.manifest.json"))
      && existsSync(path.join(directory, "package.json"))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error("VIDEO_RUNTIME_INCOMPLETE: 未找到产品载荷根目录，请修复或重装客户端");
}

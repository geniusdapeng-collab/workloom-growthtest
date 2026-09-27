/**
 * Pinned, complete macOS package from the Real-ESRGAN upstream release.
 * The archive contains the universal ncnn executable and native .param/.bin
 * model pairs. The ncnn implementation is MIT; the Python upstream is BSD-3.
 *
 * https://github.com/xinntao/Real-ESRGAN/releases/tag/v0.2.5.0
 * https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan/blob/master/LICENSE
 */
export const ENGINE_PIN = Object.freeze({
  release: "Real-ESRGAN v0.2.5.0 / ncnn 20220424",
  url: "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-macos.zip",
  sha256: "e0ad05580abfeb25f8d8fb55aaf7bedf552c375b5b4d9bd3c8d59764d2cc333a",
  license: "MIT (ncnn executable); upstream Real-ESRGAN BSD-3-Clause",
  binary: "realesrgan-ncnn-vulkan",
  models: Object.freeze({
    "live-action": Object.freeze({ name: "realesrgan-x4plus", scale: 4 }),
    animation: Object.freeze({ name: "realesr-animevideov3", scales: Object.freeze([2, 3, 4]) }),
  }),
  archiveEntries: Object.freeze([
    "realesrgan-ncnn-vulkan",
    "models/realesrgan-x4plus.param",
    "models/realesrgan-x4plus.bin",
    "models/realesr-animevideov3-x2.param",
    "models/realesr-animevideov3-x2.bin",
    "models/realesr-animevideov3-x3.param",
    "models/realesr-animevideov3-x3.bin",
    "models/realesr-animevideov3-x4.param",
    "models/realesr-animevideov3-x4.bin",
  ]),
});

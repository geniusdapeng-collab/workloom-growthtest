/**
 * remotion.config.ts —— 口播解说片工程配置（受控模板）
 *
 * 只设三件在 render_shots.mjs 里会被读到的项：中间帧格式 / jpeg 质量 / CRF。
 * 命令行（--image-format / --jpeg-quality / --crf）优先级更高——生效值会打在渲染日志首行。
 */
import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat((process.env.TALKCRAFT_IMAGE_FORMAT as "png" | "jpeg" | undefined) ?? "jpeg");
Config.setJpegQuality(Number(process.env.TALKCRAFT_JPEG_QUALITY ?? 95));
Config.setCrf(Number(process.env.TALKCRAFT_CRF ?? 18));
Config.setConcurrency(Number(process.env.TALKCRAFT_CONCURRENCY ?? 1));
Config.overrideWebpackConfig((config) => config);

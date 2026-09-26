/**
 * scenes/index.ts —— 场景桶（**装配期被 project-builder 覆盖**）
 *
 * 模板自带的是空桶；`buildProject()` 会写成：
 *   import s01 from "./s01"; ... export const SCENES: Record<string, React.FC> = { s01, ... };
 * 之所以要桶文件而不是动态 import：Remotion 的 webpack bundle 需要静态可解析的依赖图。
 */
import React from "react";

export const SCENES: Record<string, React.FC> = {};

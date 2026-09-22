/**
 * 生成参数闸（T-2026-0923-0047）
 *
 * 真机事实（2026-09-23，Ark Seedance 2.5）：`service_tier: flex` 不支持视频生成，
 * 提交即 400 `the specified service_tier flex does not support content generation`。
 * 平台侧前置拒绝，避免把额度烧在一次必然失败的提交上；不静默降级——明确告知替代档位。
 *
 * 纯函数 + 常量导出，便于单测与工具复用（出片工具 `render-project.mts` 的 `--service-tier` 也走这里）。
 */

/** Ark 视频生成实测不支持的 service_tier（比较时大小写不敏感） */
export const UNSUPPORTED_VIDEO_SERVICE_TIERS = ["flex"] as const;

/**
 * 返回拒绝原因；档位可用（或未指定）时返回 null。
 * 空值放行：不传档位 = 走供应商默认（default）。
 */
export function serviceTierRejectionReason(tier?: string | null): string | null {
  const normalized = String(tier ?? "").trim().toLowerCase();
  if (!normalized) return null;
  if ((UNSUPPORTED_VIDEO_SERVICE_TIERS as readonly string[]).includes(normalized)) {
    return `服务档位 ${normalized} 不支持视频生成（Ark 实测 400：`
      + "the specified service_tier flex does not support content generation）；"
      + "请使用 default，或改用草稿模型档位";
  }
  return null;
}

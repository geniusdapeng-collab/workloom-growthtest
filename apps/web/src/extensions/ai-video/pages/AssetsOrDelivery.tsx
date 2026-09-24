/**
 * 单路由双视图（交付包版，T-2026-0924-0073）：
 *   /ai-video/assets              → 片库/脚本 CMS（原有能力）
 *   /ai-video/assets?tab=delivery → 交付包（多风格版本选择 · 旁挂字幕 · 本地返修）
 *
 * 为什么不做独立路由：`IndustryRoutes` 会校验"页面地址 + 能力来源"必须与服务端已验证的
 * Bundle 导航投影一致；新增路由需先改 bundles/ai-video 的导航投影并重装 bundle。
 * 本仓（growthtest 实验版）此前已下线生成工作室页，故只保留"片库 / 交付包"两个视图。
 */
import { useSearchParams } from "react-router";
import { PageExitLink } from "../../../shell/PageExitLink";
import Assets from "./Assets";
import Delivery from "./Delivery";

export default function AssetsOrDelivery() {
  const [params] = useSearchParams();
  if (params.get("tab") !== "delivery") return <Assets />;
  /** 交付包是二级页，自带统一出口（回归测试 PageExitAffordance 要求逐页有"返回/关闭"） */
  return (
    <>
      <div className="px-1 pt-1">
        <PageExitLink label="返回工作台" />
      </div>
      <Delivery />
    </>
  );
}

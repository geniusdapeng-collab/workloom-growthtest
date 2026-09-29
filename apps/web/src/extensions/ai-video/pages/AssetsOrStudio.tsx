/**
 * 单路由双视图（T-2026-0921-0002）：
 *   /ai-video/assets             → 片库/脚本 CMS（原有能力）
 *   /ai-video/assets?tab=studio  → 生成工作室（选模型 · 报价 · 出片 · 发布）
 *   /ai-video/assets?tab=delivery → 交付包（多风格版本选择 · 旁挂字幕 · 本地返修）
 *
 * 为什么不做独立路由：`IndustryRoutes` 会校验"页面地址 + 能力来源"必须与服务端已验证的
 * Bundle 导航投影一致；新增路由需先改 bundles/ai-video 的导航投影并重装 bundle。
 * 本轮先用同一路由的视图切换把"可见工作台"交付出来（不动权限声明），
 * bundle 升级后再拆成独立页（记入任务卡后续项）。
 */
import { useSearchParams } from "react-router";
import { PageExitLink } from "../../../shell/PageExitLink";
import Assets from "./Assets";
import Delivery from "./Delivery";
import Studio from "./Studio";

export default function AssetsOrStudio() {
  const [params] = useSearchParams();
  const tab = params.get("tab");
  if (tab === "delivery") {
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
  if (tab !== "studio") return <Assets />;
  /** 工作室是二级页，自带统一出口（回归测试 PageExitAffordance 要求逐页有"返回/关闭"） */
  return (
    <>
      <div className="px-1 pt-1">
        <PageExitLink label="返回工作台" />
      </div>
      <Studio />
    </>
  );
}

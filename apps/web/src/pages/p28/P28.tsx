/**
 * P28 · 统一待办（PRD §6.1：登录后默认首页——跨 membership 聚合的待办收件箱，按店分组）
 *
 * 2026-09-21 产品所有者口径（本机单人运行）：基座通用审批环节已随【审批中心】模块一并移除，
 * 本页不再聚合、不再展示任何待审批数量与审批入口；业务链路自带的关卡（如视频管线 G1–G10、
 * 定妆照确认）由各自业务页面就地放行，不经过本页。
 */
import { useEffect, useState } from "react";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import { MEMBER_ROLE_TEXT, dictText } from "../../lib/display";
import { AsyncState, Icon, clientValueText } from "@workloom/ui";

interface Group {
  workspaceId: string; slug: string; workspaceName: string; tenantName: string;
  role: string; industry: string;
}

export default function P28() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      await ensureDemoLogin(); // 真实登录由 /login 完成；开发期保持演示兼容
      try {
        const svc = trpc.accounts.inbox as unknown as { unified: { query: () => Promise<{ groups: Group[] }> } };
        const r = await svc.unified.query();
        setGroups(r.groups);
      } catch (e) {
        console.warn("加载统一待办失败", e);
        setErr("暂时无法加载待办，请稍后重试。");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <AsyncState status="loading" title="正在汇总统一待办" description="正在按您可访问的工作区核对待办事项。" />;

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="text-xl font-bold">统一待办</h1>
      <p className="mt-1 text-sm text-neutral-400">
        您在 {groups.length} 家店名下暂无可直接处理的待办事项
      </p>
      {err && <p className="mt-3 text-sm text-red-400">{err}</p>}
      <div className="mt-6 space-y-3">
        {groups.map((g) => (
          <div
            key={g.workspaceId}
            className="flex w-full items-center justify-between rounded-xl border border-neutral-800 bg-neutral-900 px-5 py-4 text-left"
          >
            <div>
              <div className="font-semibold">{g.workspaceName}</div>
              <div className="mt-0.5 text-body text-neutral-400">
                {g.tenantName} · {clientValueText(g.industry)} · 我的角色：{dictText(MEMBER_ROLE_TEXT, g.role)}
              </div>
            </div>
            <div className="text-right">
              <span className="inline-flex items-center gap-1 text-body text-emerald-500">无待办 <Icon name="check" size={14} /></span>
            </div>
          </div>
        ))}
        {groups.length === 0 && !err && (
          <p className="rounded-xl border border-neutral-800 p-6 text-center text-sm text-neutral-500">
            暂无工作区成员关系——接受邀请或注册开通后，这里会聚合您所有店的待办
          </p>
        )}
      </div>
    </div>
  );
}

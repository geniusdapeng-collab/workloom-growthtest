import { Bridge } from "../../../shell/Bridge";
import { PageExitLink } from "../../../shell/PageExitLink";
import { GATE_AGENT_MAP } from "../components/review/gateAgentMap";

export default function ReviewGuide() {
  return <Bridge><PageExitLink label="返回工作台" /><h2 className="mt-3 break-words text-h1 font-black text-ink">视频关卡分工</h2><p className="mt-1 break-words text-caption text-ink3">行业角色映射只在本页解释；业务关卡在各自业务页面就地放行（例如「片库与脚本」页的 G8 放行），并由围栏裁决。</p><div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">{Object.values(GATE_AGENT_MAP).map((item) => <div key={item.gate} className="rounded-lg border border-line bg-card p-3"><div className="text-body font-bold text-ink">{item.gate} 业务关卡 · {item.name}</div><div className="mt-1 text-caption text-ink3">负责本关卡的视频行业请示与说明，最终放行权仍由人类操作人持有。</div></div>)}</div></Bridge>;
}

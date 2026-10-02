/**
 * 获客用增 C 端服务前台适配器（geo-growth）。
 *
 * 本文件可以理解「获客增长」的服务语言（合作咨询 / 方案与报价 / 需求跟进），
 * 基座网关与通用对话层不得理解这些词。只有活动 Bundle 的完整性校验投影显式
 * 声明本适配器 id，注册表才会把请求路由到这里。
 *
 * 产品口径（theme=focus）：本适配器是「获客用增」主题的产品前台；
 * 酒店前端（hotel.service-front-v1）是首个垂直试点的业务前台夹具，两者互不越权。
 */
import {
  type BusinessContext,
  type BusinessDisplayField,
  type ServiceFrontBusinessAdapter,
} from "../../service/adapters/business.js";

const NO_BIND_HINT = "本合同台免身份绑定；提交合作需求后，可用工单编号跟进受理与进度。";

const GROWTH_SERVICES: Array<{
  id: string;
  title: string;
  summary: string;
  priceText: string;
  details: BusinessDisplayField[];
}> = [
  {
    id: "svc-social-video",
    title: "短视频社媒营销",
    summary: "选题 → 脚本 → 制作 → 多平台分发 → 复盘归因，全托管交付，按有效询盘计量。",
    priceText: "面议",
    details: [
      { label: "交付内容", value: "月度内容计划与分发战报" },
      { label: "计量口径", value: "有效询盘数（双入口对比）" },
    ],
  },
  {
    id: "svc-geo",
    title: "GEO 生成式搜索优化",
    summary: "query 集建设、信源分发、AI 能见度监测与引用源归因，承诺可测量可追溯。",
    priceText: "面议",
    details: [
      { label: "交付内容", value: "能见度基线、月度监测与引用源清单" },
      { label: "计量口径", value: "提及率 / 首推率 / 声量份额变化" },
    ],
  },
  {
    id: "svc-dual-growth",
    title: "双域融合获客（社媒 × GEO）",
    summary: "一次生产、两处变现：同一条选题同时产出短视频与 AI 答案版内容，统一编排分发。",
    priceText: "面议",
    details: [
      { label: "交付内容", value: "双域内容日历与跨域战报" },
      { label: "计量口径", value: "双入口询盘量与成交率对比" },
    ],
  },
  {
    id: "svc-lead-ops",
    title: "询盘承接与线索转化",
    summary: "评论私信四档分流、线索分级路由、培育序列与漏斗漏损修复。",
    priceText: "面议",
    details: [
      { label: "交付内容", value: "承接 SLA 与转化漏斗报告" },
      { label: "计量口径", value: "首响时长 / 有效率 / 成交率" },
    ],
  },
];

const GROWTH_DEPARTMENTS: Record<string, string> = {
  complaint: "客户成功组",
  consult: "增长顾问组",
  service_request: "交付运营组",
  other: "增长顾问组",
};

export const geoGrowthBizAdapter: ServiceFrontBusinessAdapter = {
  id: "geo-growth.service-front-v1",

  // 业务同义词与弱词归行业适配器所有；只有已验证活动 Bundle 选中本适配器后才生效。
  kbLexicon: {
    synonyms: [
      ["增长", "获客"], ["拓客", "获客"], ["询盘", "线索"], ["留资", "线索"],
      ["生成式引擎优化", "GEO"], ["报价", "价格"], ["费用", "价格"], ["对接", "合作"],
    ],
    weakTokens: [
      "服务", "可以", "怎么", "如何", "一下", "多少钱", "周期", "效果", "案例", "方案", "内容", "平台",
    ],
  },

  classify(text) {
    if (/(跟进|进度|进展|到哪一步|受理情况)/.test(text)) {
      return { tool: "query_order", answer: "为您查询合作需求的受理与跟进情况：" };
    }
    if (/(合作|咨询|方案|报价|费用|服务包|怎么收费|能做什么|做过什么)/.test(text)) {
      return { tool: "query_catalog", answer: "为您查询到以下获客增长服务：" };
    }
    return null;
  },

  ticketKind(text) {
    if (/(投诉|纠纷|维权|举报)/.test(text)) return "complaint";
    if (/(合作|咨询|需求|方案|报价|对接|试用)/.test(text)) return "consult";
    return null;
  },

  departmentForTicket(kind) {
    return GROWTH_DEPARTMENTS[kind] ?? GROWTH_DEPARTMENTS.other!;
  },

  async queryOrder(_ctx: BusinessContext) {
    // 合作需求的受理与跟进以工单为准；此处返回明确空态与指引，不读取任何客户明细。
    return {
      orders: [],
      demo: false,
      hint: "合作需求的受理与跟进进度以「工单」为准；提交需求后会生成工单编号。",
    };
  },

  async queryMember(_ctx: BusinessContext) {
    return { member: null, demo: false, bindRequired: false, hint: NO_BIND_HINT };
  },

  async queryCatalog(_ctx: BusinessContext) {
    return { cardTitle: "获客增长服务", items: GROWTH_SERVICES, demo: false };
  },
};

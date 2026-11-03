type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

/**
 * 正式营销的装订身份只能来自宿主已审A1，查询线索只供发现来源。
 * Vendor会用input填补raw里缺失的身份字段；两次装订必须使用同一投影，
 * 避免G1首次装订与Studio重装订把未核实品牌、类别或型号重新升级成事实。
 */
export function verifiedMarketingDossierInput(rawByAgent: RecordValue): RecordValue {
  const identity = record(record(rawByAgent.A1).identity);
  const input: RecordValue = {};
  for (const key of ["name", "brand", "category", "model"] as const) {
    const value = identity[key];
    if (value === undefined && key !== "name") continue;
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`MARKETING_G1_REQUIRED：已审A1的${key}身份字段无效`);
    }
    input[key] = value;
  }
  const competitors = record(rawByAgent.A3).competitors;
  if (Array.isArray(competitors) && competitors.length === 0
    && Array.isArray(identity.official_selling_points) && identity.official_selling_points.length > 0) {
    // Vendor默认把己方卖点与竞品卖点求差集；空竞品语料不能证明“竞品没讲”。
    // 空数组在既有装订合同里显式关闭该推导，己方有证据卖点仍留在A1事实区。
    input.sellingPointCandidates = [];
  }
  return input;
}

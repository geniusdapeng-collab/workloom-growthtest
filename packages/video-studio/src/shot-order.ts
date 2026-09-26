/**
 * 镜头顺序规范（2026-09-26 产品所有者口径）。
 *
 * 口径原文："我们在一个新的完整管线到后期输出成片的过程中，产出的视频镜头都是按照顺序的、
 * 镜头之间带有内容逻辑顺序的，你在后期制作中不要打乱顺序。"
 *
 * 两种合法路径：
 *   · `storyboard`（默认）：成片顺序 **必须等于分镜顺序**——后期只做取舍（整镜进出）与首尾微调，
 *     不许按配乐节拍/情绪曲线重排镜头；
 *   · `reuse-assembly`（例外）：素材来自**媒资库历史镜头**时，属于"有什么食材做什么菜"，
 *     允许重新组织顺序，但**必须带重组依据**（reusePlan），否则视为无据重排。
 *
 * 为什么做成显式判据：真机上出过"后期为了卡点把镜头打乱"的返修意见（内容逻辑断裂），
 * 这类问题在镜头级看不出来，只有把顺序当不变量来验才拦得住。
 */

export type OrderPolicy = "storyboard" | "reuse-assembly";

export interface OrderCheckOptions {
  /** 媒资库复用路径的**重组依据**（为什么是这个顺序：主题线/素材可得性/时长配平…） */
  reusePlan?: string;
}

export interface OrderCheck {
  ok: boolean;
  policy: OrderPolicy;
  expected: string[];
  actual: string[];
  detail: string;
  /** 第一处顺序分歧（便于定位"哪一刀错了"） */
  firstDivergence: { index: number; expected: string | null; actual: string | null } | null;
}

export function checkShotOrder(
  expected: readonly string[],
  actual: readonly string[],
  policy: OrderPolicy = "storyboard",
  options: OrderCheckOptions = {},
): OrderCheck {
  const expectedList = [...expected];
  const actualList = [...actual];
  let firstDivergence: OrderCheck["firstDivergence"] = null;
  const length = Math.max(expectedList.length, actualList.length);
  for (let index = 0; index < length; index += 1) {
    const want = expectedList[index] ?? null;
    const got = actualList[index] ?? null;
    if (want !== got) {
      firstDivergence = { index, expected: want, actual: got };
      break;
    }
  }
  if (policy === "reuse-assembly") {
    const plan = (options.reusePlan ?? "").trim();
    if (plan.length === 0) {
      return {
        ok: false, policy, expected: expectedList, actual: actualList, firstDivergence,
        detail: "媒资库复用路径（reuse-assembly）必须给出重组依据 reusePlan（为什么是这个顺序）；"
          + "缺依据的重排 = 无据打乱镜头顺序",
      };
    }
    return {
      ok: true, policy, expected: expectedList, actual: actualList, firstDivergence,
      detail: `媒资库复用路径：允许重组（依据：${plan.slice(0, 80)}${plan.length > 80 ? "…" : ""}）；`
        + `实际顺序 ${actualList.join(" → ")}`,
    };
  }
  const sameMembers = expectedList.length === actualList.length
    && [...expectedList].sort().join(",") === [...actualList].sort().join(",");
  if (firstDivergence === null) {
    return {
      ok: true, policy, expected: expectedList, actual: actualList, firstDivergence: null,
      detail: `镜头顺序与分镜一致（${expectedList.length} 镜，内容逻辑顺序保持）`,
    };
  }
  return {
    ok: false, policy, expected: expectedList, actual: actualList, firstDivergence,
    detail: sameMembers
      ? `镜头顺序被打乱：第 ${firstDivergence.index + 1} 位应为 ${firstDivergence.expected}，实际是 ${firstDivergence.actual}`
        + `（镜头集合相同、顺序不同 → 违反"后期不得重排"口径；确需重排请显式走 reuse-assembly 并给依据）`
      : `镜头集合与分镜不一致：第 ${firstDivergence.index + 1} 位应为 ${firstDivergence.expected ?? "(无)"}，`
        + `实际是 ${firstDivergence.actual ?? "(无)"}`,
  };
}

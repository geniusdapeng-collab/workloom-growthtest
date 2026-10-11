import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildEntityFilterComplex, isFoodLabel, planEntityGrade, summarizeEntityPlans,
} from "./entity-grade.mjs";

const signal = (overrides = {}) => ({
  segmentId: "seg-001",
  personRatio: 0,
  faces: [],
  personInstances: 0,
  personSkinRatio: null,
  personRequest: null,
  foodRatio: 0,
  foodLabels: [],
  sampledAt: [1],
  personMaskPath: "/tmp/person.png",
  foodMaskPath: "/tmp/food.png",
  ...overrides,
});

test("同镜人物+食物：两条都开、互不串色", () => {
  const plan = planEntityGrade(signal({
    personRatio: 0.18, personInstances: 1, faces: [{ x: 0.2, y: 0.1, w: 0.2, h: 0.3 }],
    foodRatio: 0.22, foodLabels: ["soup", "dish"],
  }));
  assert.equal(plan.person.enabled, true);
  assert.equal(plan.food.enabled, true);
  const outcome = buildEntityFilterComplex(plan, { width: 3840, height: 2160 });
  assert.equal(outcome.applied, true);
  assert.match(outcome.filterComplex, /colorbalance=rs=-0\.020/u);
  assert.match(outcome.filterComplex, /colorbalance=rs=0\.050/u);
  assert.match(outcome.filterComplex, /\[1:v\]format=gray/u);
  assert.match(outcome.filterComplex, /\[2:v\]format=gray/u);
});

test("俯拍食物镜的假人物掩膜不触发美白（无实例/人脸证据）", () => {
  const plan = planEntityGrade(signal({
    personRatio: 0.63, personRequest: "segmentation", personSkinRatio: 0.82,
    foodRatio: 0.21, foodLabels: ["food", "soup"],
  }));
  assert.equal(plan.person.enabled, false);
  assert.match(plan.person.reason, /疑似把食物\/桌面误判成人/u);
  assert.equal(plan.food.enabled, true);
});

test("食物词表整词匹配：table 不因 vegetable 误判", () => {
  assert.equal(isFoodLabel("hotpot"), true);
  assert.equal(isFoodLabel("Chinese cuisine"), true);
  assert.equal(isFoodLabel("羊汤"), true);
  assert.equal(isFoodLabel("wooden table"), false);
  assert.equal(isFoodLabel("person"), false);
});

test("无实体时恒等图；汇总可复算", () => {
  const idle = planEntityGrade(signal());
  assert.equal(buildEntityFilterComplex(idle, { width: 1920, height: 1080 }).applied, false);
  const plans = [
    planEntityGrade(signal({ segmentId: "a", personRatio: 0.2, personInstances: 1, foodRatio: 0.2, foodLabels: ["dish"] })),
    planEntityGrade(signal({ segmentId: "b", personRatio: 0.2, personInstances: 1 })),
  ];
  assert.deepEqual(summarizeEntityPlans(plans), { segments: 2, personSegments: 2, foodSegments: 1, bothSegments: 1 });
});

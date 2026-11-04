// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import DirectorStudio from "./DirectorStudio";

const api = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("../../../lib/trpc", () => ({ ensureDemoLogin: async () => {}, trpc: { video: { creative: {
  jobs: { query: async () => [] }, job: { query: async () => null }, start: { mutate: api.start },
} } } }));
vi.mock("../../../shell/NavigationAccess", () => ({ useNavigationAccess: () => ({ canAction: () => true }) }));
vi.mock("../../../shell/PageExitLink", () => ({ PageExitLink: () => null }));

let root: Root;
let host: HTMLDivElement;
beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  api.start.mockResolvedValue({ id: "DJ-unicode", projectId: "VID-unicode", status: "complete", variants: [] });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<MemoryRouter><DirectorStudio /></MemoryRouter>));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

async function enter(value: string) {
  const textarea = host.querySelector<HTMLTextAreaElement>("#director-intent")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return textarea;
}
const planButton = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "只做文字方案")!;

it("accepts 12000 supplementary Han characters and sends the complete original demand", async () => {
  const raw = "𠮷".repeat(12000);
  const textarea = await enter(raw);
  expect(textarea.value).toBe(raw);
  expect(textarea.hasAttribute("maxlength")).toBe(false);
  expect(host.querySelector("#director-intent-length")!.textContent).toContain("12000 / 12000");
  expect(planButton().disabled).toBe(false);
  await act(async () => planButton().click());
  expect(api.start).toHaveBeenCalledWith(expect.objectContaining({ intent: raw, mode: "plan" }));
});

it("shows overflow without truncating text and blocks submission until corrected", async () => {
  const raw = "汉".repeat(12001);
  const textarea = await enter(raw);
  expect(textarea.value).toBe(raw);
  expect(textarea.getAttribute("aria-invalid")).toBe("true");
  expect(host.querySelector("#director-intent-length")!.getAttribute("role")).toBe("alert");
  expect(planButton().disabled).toBe(true);
  expect(api.start).not.toHaveBeenCalled();
  await enter(raw.slice(0, 12000));
  expect(planButton().disabled).toBe(false);
  expect(textarea.getAttribute("aria-invalid")).toBe("false");
});

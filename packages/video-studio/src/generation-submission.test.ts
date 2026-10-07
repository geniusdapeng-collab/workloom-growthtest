import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { submitGenerationOnce, readGenerationSubmissionState } from "./generation-submission.mjs";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wl-paid-once-")); dirs.push(dir);
  return { dir, journalFile: join(dir, "paid.json"), endpoint: "https://synthetic.invalid/images/generations", body: '{"model":"synthetic","prompt":"private-reference"}', headers: { authorization: "Bearer test-only-key" } };
}
const image = () => new Response(JSON.stringify({ data: [{ url: "https://synthetic.invalid/temporary.png?signature=fixture" }] }));

describe("持久化生成提交", () => {
  it("成功响应在caller下载前落盘，重启读取响应且不存请求/凭据", async () => {
    const f = fixture(); let posts = 0; const fetchImpl = (async () => { posts += 1; return image(); }) as typeof fetch;
    const first = await submitGenerationOnce({ ...f, fetchImpl }); const repeated = await submitGenerationOnce({ ...f, fetchImpl });
    expect(first.called).toBe(true); expect(repeated).toMatchObject({ called: false, resumed: true, acceptance: "accepted" });
    expect(await repeated.response.text()).toBe(await first.response.text()); expect(posts).toBe(1);
    const text = readFileSync(f.journalFile, "utf8"); expect(text).not.toContain("test-only-key"); expect(text).not.toContain("private-reference");
    expect(statSync(f.journalFile).mode & 0o777).toBe(0o600);
  });
  it("网络超时/5xx/未明确拒绝的4xx均保持未知，不重发，包括改body", async () => {
    for (const result of [null, 503, 429, 403]) {
      const f = fixture(); let posts = 0;
      const fetchImpl = (async () => { posts += 1; if (result === null) throw new Error("accepted but connection lost"); return new Response("unknown", { status: result }); }) as typeof fetch;
      await expect(submitGenerationOnce({ ...f, fetchImpl })).rejects.toThrow(/OUTCOME_UNKNOWN/);
      await expect(submitGenerationOnce({ ...f, fetchImpl })).rejects.toThrow(/OUTCOME_UNKNOWN/);
      await expect(submitGenerationOnce({ ...f, body: "changed", fetchImpl })).rejects.toThrow(/REQUEST_CHANGED/); expect(posts).toBe(1);
      expect(readGenerationSubmissionState(f.journalFile)?.state).toBe("submission-unknown");
    }
  });
  it("格式错误/没有url/没有taskId的HTTP200也保留第一次响应，禁止重新收费", async () => {
    for (const text of ["{broken", "{}", '{"data":[]}']) {
      const f = fixture(); let posts = 0; const fetchImpl = (async () => { posts += 1; return new Response(text); }) as typeof fetch;
      await submitGenerationOnce({ ...f, fetchImpl });
      expect(await (await submitGenerationOnce({ ...f, fetchImpl })).response.text()).toBe(text); expect(posts).toBe(1);
    }
  });
  it("只有结构化明确拒绝可再次提交，400含已受理ID仍是未知", async () => {
    const f = fixture(); let posts = 0;
    const fetchImpl = (async () => { posts += 1; return posts === 1 ? new Response(JSON.stringify({ error: { code: "InvalidParameter", message: "rejected" } }), { status: 400 }) : image(); }) as typeof fetch;
    expect((await submitGenerationOnce({ ...f, fetchImpl })).acceptance).toBe("rejected");
    await submitGenerationOnce({ ...f, body: "corrected", fetchImpl }); await submitGenerationOnce({ ...f, body: "corrected", fetchImpl }); expect(posts).toBe(2);
    const bad = fixture(); await expect(submitGenerationOnce({ ...bad, fetchImpl: async () => new Response(JSON.stringify({ id: "already-accepted", error: { code: "InvalidParameter" } }), { status: 400 }) })).rejects.toThrow(/OUTCOME_UNKNOWN/);
  });
  it("并发的第二caller在第一次POST期间只报未知，不能再次提交", async () => {
    const f = fixture(); let posts = 0; let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }); const wait = new Promise<void>(resolve => { release = resolve; });
    const fetchImpl = (async () => { posts += 1; entered(); await wait; return image(); }) as typeof fetch;
    const first = submitGenerationOnce({ ...f, fetchImpl }); await started;
    await expect(submitGenerationOnce({ ...f, fetchImpl })).rejects.toThrow(/OUTCOME_UNKNOWN|BUSY/); release(); await first;
    await submitGenerationOnce({ ...f, fetchImpl }); expect(posts).toBe(1);
  });
  it("受理后残留进程锁仍能只读恢复；请求变化、破坏响应digest与symlink不允许提交", async () => {
    const f = fixture(); let posts = 0; const fetchImpl = (async () => { posts += 1; return image(); }) as typeof fetch;
    await submitGenerationOnce({ ...f, fetchImpl }); writeFileSync(`${f.journalFile}.lock`, "crashed-process");
    expect((await submitGenerationOnce({ ...f, fetchImpl })).resumed).toBe(true);
    await expect(submitGenerationOnce({ ...f, body: "changed", fetchImpl })).rejects.toThrow(/REQUEST_CHANGED/);
    const receipt = JSON.parse(readFileSync(f.journalFile, "utf8")); receipt.responseText = "tampered"; writeFileSync(f.journalFile, JSON.stringify(receipt));
    await expect(submitGenerationOnce({ ...f, fetchImpl })).rejects.toThrow(/JOURNAL_INVALID/); expect(posts).toBe(1);
    const linked = fixture(); symlinkSync(f.journalFile, linked.journalFile);
    await expect(submitGenerationOnce({ ...linked, fetchImpl })).rejects.toThrow(/JOURNAL_INVALID/); expect(posts).toBe(1);
  });
  it("前置配额拒绝、目录不合法、回复回显凭据均不落盘秘密或盲重试", async () => {
    const f = fixture(); let posts = 0; const fetchImpl = (async () => { posts += 1; return image(); }) as typeof fetch;
    await expect(submitGenerationOnce({ ...f, fetchImpl, beforeSubmit: () => { throw new Error("budget denied"); } })).rejects.toThrow("budget denied"); expect(posts).toBe(0);
    const echo = (async () => { posts += 1; return new Response("test-only-key"); }) as typeof fetch;
    await expect(submitGenerationOnce({ ...f, fetchImpl: echo })).rejects.toThrow(/CONTAINS_CREDENTIAL/);
    expect(readFileSync(f.journalFile, "utf8")).not.toContain("test-only-key");
    await expect(submitGenerationOnce({ ...f, fetchImpl })).rejects.toThrow(/OUTCOME_UNKNOWN/); expect(posts).toBe(1);
  });
  it("真实独立Node进程重启只复用受理响应，连接中断后的重启不重发POST", async () => {
    for (const lostResponse of [false, true]) {
      const f = fixture(); let posts = 0;
      const server = createServer((request, response) => {
        if (request.method !== "POST") { response.writeHead(405).end(); return; }
        posts += 1; request.resume();
        request.on("end", () => { if (lostResponse) response.destroy(); else response.end('{"data":[{"url":"https://synthetic.invalid/accepted.png"}]}'); });
      });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address(); if (!address || typeof address === "string") throw new Error("HTTP fixture unavailable");
      const options = { journalFile: f.journalFile, endpoint: `http://127.0.0.1:${address.port}/images/generations`, body: f.body };
      const moduleUrl = new URL("./generation-submission.mjs", import.meta.url).href;
      const source = `import { submitGenerationOnce } from ${JSON.stringify(moduleUrl)}; try { const r = await submitGenerationOnce(${JSON.stringify(options)}); console.log(JSON.stringify({resumed:r.resumed,called:r.called})); } catch (e) { console.error(e.message); process.exitCode=2; }`;
      const run = () => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", source]); let output = "";
        child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
        child.on("error", reject); child.on("close", code => resolve({ code, output }));
      });
      try {
        const first = await run(), restarted = await run();
        expect(first.code).toBe(lostResponse ? 2 : 0); expect(restarted.code).toBe(lostResponse ? 2 : 0);
        expect(restarted.output).toMatch(lostResponse ? /OUTCOME_UNKNOWN/ : /"resumed":true,"called":false/);
        expect(posts).toBe(1);
      } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    }
  });
});

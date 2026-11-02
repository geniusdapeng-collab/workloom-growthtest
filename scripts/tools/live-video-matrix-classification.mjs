const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};

export function promptDialogueField(prompt) {
  const text = String(prompt ?? "");
  return text.match(/(?:^|\s)\d+\.【台词】([\s\S]*?)(?=\s+\d+\.【|$)/u)?.[1]?.trim() ?? "";
}

export function promptSpeechViolationShotIds(shotRows, promptRows) {
  const promptsById = new Map((Array.isArray(promptRows) ? promptRows : []).map((prompt) => {
    const row = record(prompt);
    return [String(row.shotId ?? row.shot_id ?? ""), String(row.prompt ?? "")];
  }));
  return (Array.isArray(shotRows) ? shotRows : []).filter((shot) => {
    const id = String(record(shot).shotId ?? record(shot).shot_id ?? "");
    const dialogue = promptDialogueField(promptsById.get(id));
    return !dialogue || !/(?:不适用|无台词|无对白|无旁白|无口播|禁止(?:台词|对白|旁白|口播))/u.test(dialogue);
  }).map((shot) => String(record(shot).shotId ?? record(shot).shot_id ?? "?"));
}

export function effectivePipelineFailures(events, result) {
  const rows = Array.isArray(events) ? events : [];
  const outcome = record(result);
  const audit = record(outcome.preproductionAudit);
  const superseded = outcome.success === true
    && audit.status === "passed"
    && audit.scope === "preproduction-only"
    && audit.renderSubmitted === false;
  return superseded ? [] : rows.filter((event) => record(event).kind === "pipeline.failed");
}

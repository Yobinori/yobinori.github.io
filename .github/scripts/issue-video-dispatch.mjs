import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { run, validateTargetDate, defaultTargetDate } from "./create-video-issues.mjs";

const REPOSITORY = "Yobinori/yobinori.github.io";
const ISSUE = 14;
const OWNER_ID = 32870956;
const OWNER_LOGIN = "Yobinori";
const KEYS = ["request_id", "target_date", "lookback_days", "start_date", "dry_run"];

export function validateRequest(event, now = new Date()) {
  if (event.action !== "edited" || !Object.hasOwn(event.changes ?? {}, "body") ||
      event.repository?.full_name !== REPOSITORY || event.issue?.number !== ISSUE ||
      event.issue?.pull_request || event.issue?.state !== "open" ||
      event.sender?.id !== OWNER_ID || event.sender?.login !== OWNER_LOGIN ||
      event.issue?.user?.id !== OWNER_ID) throw new Error("Unauthorized or unrelated issue event.");
  const body = event.issue.body;
  if (typeof body !== "string" || body.length > 1000) throw new Error("Invalid request body.");
  const request = JSON.parse(body);
  if (!request || Array.isArray(request) || typeof request !== "object" ||
      Object.keys(request).sort().join(",") !== [...KEYS].sort().join(",")) throw new Error("Unexpected request fields.");
  if (typeof request.request_id !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(request.request_id)) throw new Error("Invalid request_id.");
  if (typeof request.target_date !== "string") throw new Error("Invalid target_date.");
  validateTargetDate(request.target_date);
  if (request.target_date > defaultTargetDate(now)) throw new Error("target_date must be yesterday or earlier in JST.");
  if (request.lookback_days !== 14 || request.start_date !== "" || typeof request.dry_run !== "boolean") {
    throw new Error("Expected exactly 14 days, an empty start_date and a boolean dry_run.");
  }
  return request;
}

async function github(path, env, options = {}) {
  const response = await fetch("https://api.github.com/repos/" + REPOSITORY + path, {
    method: options.method ?? "GET",
    headers: {Authorization: "Bearer " + env.GH_TOKEN, Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json"},
    ...(options.body ? {body: JSON.stringify(options.body)} : {}),
  });
  // Never retry a write blindly: it may already have succeeded.
  if (!response.ok) throw new Error("GitHub request failed: HTTP " + response.status);
  return response.json();
}

export async function handleIssue(event, env, dependencies = {}) {
  const request = validateRequest(event, dependencies.now);
  if (env.GITHUB_REPOSITORY !== REPOSITORY || !env.GH_TOKEN ||
      !/^\d+$/.test(env.GITHUB_RUN_ID ?? "")) throw new Error("Invalid runtime context.");
  const api = dependencies.api ?? ((path, options) => github(path, env, options));
  const runner = dependencies.runner ?? run;
  const marker = "<!-- youtube-dispatch-claim:" + request.request_id + " -->";
  const url = "https://github.com/" + REPOSITORY + "/actions/runs/" + env.GITHUB_RUN_ID;
  // The workflow's shared concurrency group serializes this check and claim
  // with all manual/scheduled runs. Bot-owned claims survive run-log expiry.
  for (let page = 1; ; page++) {
    const comments = await api("/issues/" + ISSUE + "/comments?per_page=100&page=" + page);
    if (!Array.isArray(comments)) throw new Error("Incomplete claim history.");
    if (comments.some(comment => comment.user?.login === "github-actions[bot]" &&
        comment.user?.type === "Bot" && String(comment.body).startsWith(marker + "\n"))) {
      console.log("ISSUE_DISPATCH_RESULT=" + JSON.stringify({request_id:request.request_id, status:"duplicate_skipped"}));
      return {status:"duplicate_skipped"};
    }
    if (comments.length < 100) break;
    if (page >= 1000) throw new Error("Claim history exceeds safe scan limit.");
  }
  await api("/issues/" + ISSUE + "/comments", {method:"POST", body:{body:
    marker + "\nRequest: " + request.request_id + "\nRun: " + url +
    "\nStatus: claimed (retry requires a new request_id)\nInputs: " + JSON.stringify(request)}});
  try {
    const result = await runner({...env, TARGET_DATE:request.target_date, START_DATE:"",
      LOOKBACK_DAYS:"14", DRY_RUN:String(request.dry_run)});
    const report = {request_id:request.request_id, status:"success", run_url:url, range:result.range,
      dry_run:result.dryRun, detected:result.detected, unresolved:result.unresolved.length,
      created:result.created.map(issue=>issue.html_url), duplicateSkipped:result.duplicateSkipped};
    await api("/issues/" + ISSUE + "/comments", {method:"POST", body:{body:"Result:\n" + JSON.stringify(report, null, 2)}});
    console.log("ISSUE_DISPATCH_RESULT=" + JSON.stringify(report));
    return report;
  } catch (error) {
    await api("/issues/" + ISSUE + "/comments", {method:"POST", body:{body:
      "Request: " + request.request_id + "\nRun: " + url +
      "\nStatus: failed or incomplete. Check the run before retrying with a new request_id."}}).catch(()=>{});
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    if (process.env.GITHUB_EVENT_NAME !== "issues") throw new Error("Expected issues event.");
    await handleIssue(JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8")), process.env);
  } catch {
    console.error("Issue dispatch failed; inspect the run status. No unvalidated input is executed.");
    process.exitCode = 1;
  }
}

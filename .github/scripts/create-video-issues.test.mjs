import assert from "node:assert/strict";
import test from "node:test";

import {
  buildIssueBody,
  buildVideoHtml,
  classifyCandidates,
  classifyShortVideo,
  defaultTargetDate,
  extractIssueVideoIds,
  run,
  targetDateRange,
  validateTargetDate,
} from "./create-video-issues.mjs";

function video(id, publishedAt, overrides = {}) {
  return {
    id,
    snippet: { title: `動画 ${id}`, publishedAt, ...overrides.snippet },
    status: { privacyStatus: "public", ...overrides.status },
    contentDetails: { duration: "PT10M", ...overrides.contentDetails },
    ...(overrides.liveStreamingDetails ? { liveStreamingDetails: overrides.liveStreamingDetails } : {}),
  };
}

test("defaultTargetDate uses the previous calendar day in JST", () => {
  assert.equal(defaultTargetDate(new Date("2026-08-27T00:00:00Z")), "2026-08-26");
  assert.equal(defaultTargetDate(new Date("2026-08-26T14:30:00Z")), "2026-08-25");
  assert.equal(defaultTargetDate(new Date("2026-08-26T15:30:00Z")), "2026-08-26");
});

test("target date validation rejects invalid dates", () => {
  assert.equal(validateTargetDate("2024-02-29"), "2024-02-29");
  assert.throws(() => validateTargetDate("2026-02-29"));
  assert.throws(() => validateTargetDate("2026/08/26"));
});

test("generated HTML matches the existing video card and escapes titles", () => {
  const item = video("AbCdEfGhI12", "2026-08-26T03:00:00Z", {
    snippet: { title: 'A & B <C> "D"' },
  });
  const html = buildVideoHtml(item);
  assert.match(html, /class="video-block"/);
  assert.match(html, /target="_blank" rel="noopener"/);
  assert.match(html, /A &amp; B &lt;C&gt; &quot;D&quot;/);
  assert.doesNotMatch(html, /A & B <C>/);
});

test("issue body contains metadata, checklist, code, and deduplication marker", () => {
  const item = video("AbCdEfGhI12", "2026-08-26T03:04:00Z");
  const body = buildIssueBody(item);
  assert.match(body, /2026-08-26 12:04 JST/);
  assert.match(body, /https:\/\/youtu\.be\/AbCdEfGhI12/);
  assert.match(body, /- \[ \] HTMLを追加する/);
  assert.match(body, /<!-- youtube-video-id: AbCdEfGhI12 -->/);
});

test("issue video IDs are extracted from open and closed issue bodies", () => {
  const ids = extractIssueVideoIds([
    { state: "open", body: "<!-- youtube-video-id: AbCdEfGhI12 -->" },
    { state: "closed", body: "<!-- youtube-video-id: ZxYwVuTsR98 -->" },
    { state: "open", body: "unrelated" },
  ]);
  assert.deepEqual([...ids].sort(), ["AbCdEfGhI12", "ZxYwVuTsR98"]);
});

test("Shorts URL redirecting to watch is classified as a normal video", async () => {
  const fetchImpl = async () => new Response(null, {
    status: 303,
    headers: { location: "https://www.youtube.com/watch?v=AbCdEfGhI12" },
  });
  assert.equal(await classifyShortVideo("AbCdEfGhI12", fetchImpl), false);
});

test("a recognizable Shorts page is classified as Shorts", async () => {
  const html = '<html><script>var ytInitialData={"id":"AbCdEfGhI12","webPageType":"WEB_PAGE_TYPE_SHORTS"}</script></html>';
  const fetchImpl = async () => new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
  assert.equal(await classifyShortVideo("AbCdEfGhI12", fetchImpl), true);
});

test("an unrecognized Shorts response fails closed", async () => {
  const fetchImpl = async () => new Response("<html>Before you continue to YouTube</html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });
  await assert.rejects(() => classifyShortVideo("AbCdEfGhI12", fetchImpl), /classification failed/);
});

test("a non-challenge HTML response from the Shorts URL is classified as Shorts", async () => {
  const html = '<html><script>var ytInitialData={"id":"AbCdEfGhI12"}</script></html>';
  const fetchImpl = async () => new Response(html, {
    status: 200,
    headers: { "content-type": "text/html" },
  });
  assert.equal(await classifyShortVideo("AbCdEfGhI12", fetchImpl), true);
});

test("an empty HTTP 200 response is still classified as Shorts", async () => {
  const fetchImpl = async () => new Response("", {
    status: 200,
    headers: { "content-type": "text/html" },
  });
  assert.equal(await classifyShortVideo("AbCdEfGhI12", fetchImpl), true);
});

test("candidate classification honors JST boundaries and excludes live and Shorts", async () => {
  const range = targetDateRange("2026-08-26");
  const videos = [
    video("BeforeDay01", "2026-08-25T14:59:59Z"),
    video("AtDayStart", "2026-08-25T15:00:00Z"),
    video("ShortVideo1", "2026-08-26T00:00:00Z"),
    video("LiveVideo01", "2026-08-26T03:00:00Z", { liveStreamingDetails: { actualStartTime: "2026-08-26T03:00:00Z" } }),
    video("AtNextDay0", "2026-08-26T15:00:00Z"),
  ];
  const classifier = async (id) => id === "ShortVideo1";
  const result = await classifyCandidates(videos, range, classifier);

  assert.equal(result.detected, 3);
  assert.equal(result.liveExcluded, 1);
  assert.equal(result.shortsExcluded, 1);
  assert.deepEqual(result.eligible.map((item) => item.id), ["AtDayStart"]);
});

function apiMock({ existingIssues = [] } = {}) {
  const calls = [];
  const item = video("AbCdEfGhI12", "2026-08-26T03:04:00Z");

  const fetchImpl = async (input, options = {}) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), method: options.method ?? "GET", body: options.body });

    if (url.hostname === "www.googleapis.com" && url.pathname.endsWith("/channels")) {
      return Response.json({
        items: [{ contentDetails: { relatedPlaylists: { uploads: "UPLOADS_PLAYLIST" } } }],
      });
    }
    if (url.hostname === "www.googleapis.com" && url.pathname.endsWith("/playlistItems")) {
      return Response.json({
        items: [{
          contentDetails: { videoId: item.id, videoPublishedAt: item.snippet.publishedAt },
          snippet: { publishedAt: item.snippet.publishedAt },
        }],
      });
    }
    if (url.hostname === "www.googleapis.com" && url.pathname.endsWith("/videos")) {
      return Response.json({ items: [item] });
    }
    if (url.hostname === "api.github.com" && url.pathname.endsWith("/issues") && (options.method ?? "GET") === "GET") {
      return Response.json(existingIssues);
    }
    if (url.hostname === "api.github.com" && url.pathname.endsWith("/labels/new-video")) {
      return Response.json({ message: "Not Found" }, { status: 404 });
    }
    if (url.hostname === "api.github.com" && url.pathname.endsWith("/labels") && options.method === "POST") {
      return Response.json({ name: "new-video" }, { status: 201 });
    }
    if (url.hostname === "api.github.com" && url.pathname.endsWith("/issues") && options.method === "POST") {
      return Response.json({ number: 1, html_url: "https://github.com/example/yobinori/issues/1" }, { status: 201 });
    }

    throw new Error(`Unexpected mock request: ${url}`);
  };

  return { calls, fetchImpl };
}

function runEnvironment(overrides = {}) {
  return {
    YOUTUBE_API_KEY: "test-key",
    YOUTUBE_CHANNEL_ID: "UCqmWJJolqAgjIdLqK3zD1QQ",
    GH_TOKEN: "test-token",
    GITHUB_REPOSITORY: "example/yobinori",
    TARGET_DATE: "2026-08-26",
    DRY_RUN: "false",
    ...overrides,
  };
}

test("dry run detects a video without making GitHub changes", async () => {
  const mock = apiMock();
  const result = await run(
    runEnvironment({ DRY_RUN: "true" }),
    { fetchImpl: mock.fetchImpl, classifier: async () => false },
  );

  assert.equal(result.pending.length, 1);
  assert.equal(result.created.length, 0);
  assert.equal(result.duplicateSkipped, 0);
  assert.equal(mock.calls.filter((call) => call.method !== "GET").length, 0);
});

test("an existing closed issue prevents duplicate issue creation", async () => {
  const mock = apiMock({
    existingIssues: [{ state: "closed", body: "<!-- youtube-video-id: AbCdEfGhI12 -->" }],
  });
  const result = await run(
    runEnvironment(),
    { fetchImpl: mock.fetchImpl, classifier: async () => false },
  );

  assert.equal(result.pending.length, 0);
  assert.equal(result.created.length, 0);
  assert.equal(result.duplicateSkipped, 1);
  assert.equal(mock.calls.filter((call) => call.method !== "GET").length, 0);
});

test("a normal video creates the label and one issue", async () => {
  const mock = apiMock();
  const result = await run(
    runEnvironment(),
    { fetchImpl: mock.fetchImpl, classifier: async () => false },
  );

  assert.equal(result.created.length, 1);
  const postCalls = mock.calls.filter((call) => call.method === "POST");
  assert.equal(postCalls.length, 2);
  assert.match(postCalls[0].url, /\/labels$/);
  assert.match(postCalls[1].url, /\/issues$/);
  const issueRequest = JSON.parse(postCalls[1].body);
  assert.equal(issueRequest.title, "[新着動画] 動画 AbCdEfGhI12");
  assert.match(issueRequest.body, /<!-- youtube-video-id: AbCdEfGhI12 -->/);
});

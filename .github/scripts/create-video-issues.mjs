import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";
const GITHUB_API_BASE = "https://api.github.com";
const ISSUE_LABEL = "new-video";
const USER_AGENT = "yobinori-video-issue-generator/1.0";

function pad(value) {
  return String(value).padStart(2, "0");
}

export function validateTargetDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("TARGET_DATE must use YYYY-MM-DD format.");
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error("TARGET_DATE is not a valid calendar date.");
  }

  return value;
}

export function defaultTargetDate(now = new Date()) {
  const jstYesterday = new Date(now.getTime() + JST_OFFSET_MS - DAY_MS);
  return [
    jstYesterday.getUTCFullYear(),
    pad(jstYesterday.getUTCMonth() + 1),
    pad(jstYesterday.getUTCDate()),
  ].join("-");
}

export function targetDateRange(targetDate) {
  validateTargetDate(targetDate);
  const start = new Date(`${targetDate}T00:00:00+09:00`);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

export function isWithinRange(publishedAt, range) {
  const timestamp = new Date(publishedAt).getTime();
  return Number.isFinite(timestamp) && timestamp >= range.start.getTime() && timestamp < range.end.getTime();
}

export function formatJstDateTime(value) {
  const shifted = new Date(new Date(value).getTime() + JST_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())} JST`;
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeMarkdownAlt(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

export function buildVideoHtml(video) {
  const title = escapeHtml(video.snippet.title);
  return `<section class="video-block">
\t<h2><a href="https://youtu.be/${video.id}" target="_blank" rel="noopener"><img src="https://i.ytimg.com/vi/${video.id}/mqdefault.jpg" alt="${title}"></a></h2>
\t<div class="video-txt">
\t\t<p><span>${title}</span></p>
\t</div>
</section>`;
}

function markdownFence(content) {
  const runs = content.match(/`+/g) ?? [];
  const longest = Math.max(2, ...runs.map((run) => run.length));
  return "`".repeat(longest + 1);
}

export function issueMarker(videoId) {
  return `<!-- youtube-video-id: ${videoId} -->`;
}

export function buildIssueBody(video) {
  const html = buildVideoHtml(video);
  const fence = markdownFence(html);
  const title = video.snippet.title;
  const videoUrl = `https://youtu.be/${video.id}`;
  const thumbnailUrl = `https://i.ytimg.com/vi/${video.id}/mqdefault.jpg`;

  return `## 新着動画

- 公開日時: ${formatJstDateTime(video.snippet.publishedAt)}
- YouTube: ${videoUrl}
- 動画ID: \`${video.id}\`
- 追加先: 未選択

![${escapeMarkdownAlt(title)}](${thumbnailUrl})

## 追加用HTML

${fence}html
${html}
${fence}

## 作業

- [ ] 追加先の \`video/*.html\` を決める
- [ ] HTMLを追加する
- [ ] GitHub Pagesで表示を確認する
- [ ] 確認後、このIssueを閉じる

${issueMarker(video.id)}
`;
}

export function extractIssueVideoIds(issues) {
  const ids = new Set();
  const pattern = /<!--\s*youtube-video-id:\s*([A-Za-z0-9_-]{11})\s*-->/g;
  for (const issue of issues) {
    for (const match of String(issue.body ?? "").matchAll(pattern)) {
      ids.add(match[1]);
    }
  }
  return ids;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options = {}, fetchImpl = fetch, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, options);
      if (response.status !== 429 && response.status < 500) {
        return response;
      }
      lastError = new Error(`Remote service returned HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
    }

    if (attempt < attempts) {
      await sleep(500 * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

async function youtubeApi(resource, params, apiKey, fetchImpl = fetch) {
  const url = new URL(`${YOUTUBE_API_BASE}/${resource}`);
  for (const [key, value] of Object.entries({ ...params, key: apiKey })) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetchWithRetry(url, {}, fetchImpl);
  if (!response.ok) {
    let detail = "";
    try {
      const payload = await response.json();
      detail = payload?.error?.message ? `: ${payload.error.message}` : "";
    } catch {
      // Keep API keys and response bodies out of logs.
    }
    throw new Error(`YouTube API request failed with HTTP ${response.status}${detail}`);
  }
  return response.json();
}

export async function classifyShortVideo(videoId, fetchImpl = fetch) {
  const url = `https://www.youtube.com/shorts/${videoId}`;
  const response = await fetchWithRetry(
    url,
    {
      method: "GET",
      redirect: "manual",
      headers: {
        Accept: "text/html",
        "Accept-Language": "ja,en;q=0.8",
        "User-Agent": USER_AGENT,
      },
    },
    fetchImpl,
  );

  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("location");
    if (!location) {
      throw new Error(`Shorts classification failed for ${videoId}: redirect has no location.`);
    }
    const destination = new URL(location, url);
    if (destination.hostname.endsWith("youtube.com") && destination.pathname === "/watch") {
      return false;
    }
    throw new Error(`Shorts classification failed for ${videoId}: unexpected redirect.`);
  }

  if (response.status !== 200) {
    throw new Error(`Shorts classification failed for ${videoId}: HTTP ${response.status}.`);
  }

  const html = await response.text();
  const lowerHtml = html.toLowerCase();
  const isChallenge =
    lowerHtml.includes("consent.youtube.com") ||
    lowerHtml.includes("before you continue to youtube") ||
    lowerHtml.includes("unusual traffic") ||
    lowerHtml.includes("captcha");
  if (isChallenge) {
    throw new Error(`Shorts classification failed for ${videoId}: YouTube returned a consent or verification page.`);
  }

  // YouTube does not expose a Shorts flag in the Data API. The /shorts URL
  // redirects regular videos to /watch and returns HTTP 200 for Shorts. The
  // HTTP 200 body and content type vary on GitHub-hosted runners, so the status
  // itself is the stable signal here.
  return true;
}

async function getUploadsPlaylistId(channelId, apiKey, fetchImpl) {
  const payload = await youtubeApi(
    "channels",
    { part: "contentDetails", id: channelId },
    apiKey,
    fetchImpl,
  );
  const playlistId = payload.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!playlistId) {
    throw new Error("The YouTube uploads playlist could not be found for the configured channel.");
  }
  return playlistId;
}

async function getPublishedVideoIds(playlistId, range, apiKey, fetchImpl) {
  const ids = [];
  let pageToken;
  let reachedOlderVideos = false;

  do {
    const payload = await youtubeApi(
      "playlistItems",
      {
        part: "contentDetails,snippet",
        playlistId,
        maxResults: 50,
        pageToken,
      },
      apiKey,
      fetchImpl,
    );

    for (const item of payload.items ?? []) {
      const publishedAt = item.contentDetails?.videoPublishedAt ?? item.snippet?.publishedAt;
      const videoId = item.contentDetails?.videoId;
      if (!publishedAt || !videoId) continue;

      const timestamp = new Date(publishedAt).getTime();
      if (timestamp < range.start.getTime()) {
        reachedOlderVideos = true;
        break;
      }
      if (timestamp < range.end.getTime()) {
        ids.push(videoId);
      }
    }

    pageToken = reachedOlderVideos ? undefined : payload.nextPageToken;
  } while (pageToken);

  return [...new Set(ids)];
}

async function getVideos(videoIds, apiKey, fetchImpl) {
  const videos = [];
  for (let offset = 0; offset < videoIds.length; offset += 50) {
    const payload = await youtubeApi(
      "videos",
      {
        part: "snippet,contentDetails,liveStreamingDetails,status",
        id: videoIds.slice(offset, offset + 50).join(","),
        maxResults: 50,
      },
      apiKey,
      fetchImpl,
    );
    videos.push(...(payload.items ?? []));
  }
  return videos;
}

export async function classifyCandidates(videos, range, classifier = classifyShortVideo) {
  const publicVideos = videos.filter(
    (video) => video.status?.privacyStatus === "public" && isWithinRange(video.snippet?.publishedAt, range),
  );
  const liveExcluded = publicVideos.filter((video) => Boolean(video.liveStreamingDetails));
  const candidates = publicVideos.filter((video) => !video.liveStreamingDetails);
  const eligible = [];
  let shortsExcluded = 0;

  for (const video of candidates) {
    if (await classifier(video.id)) {
      shortsExcluded += 1;
    } else {
      eligible.push(video);
    }
  }

  return {
    detected: publicVideos.length,
    liveExcluded: liveExcluded.length,
    shortsExcluded,
    eligible,
  };
}

async function githubApi(path, { method = "GET", body, token, fetchImpl = fetch } = {}) {
  const response = await fetchWithRetry(
    `${GITHUB_API_BASE}${path}`,
    {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": USER_AGENT,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    },
    fetchImpl,
  );

  if (!response.ok) {
    throw new Error(`GitHub API request failed with HTTP ${response.status}.`);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function getExistingVideoIds(repository, token, fetchImpl) {
  const issues = [];
  for (let page = 1; ; page += 1) {
    const batch = await githubApi(
      `/repos/${repository}/issues?state=all&per_page=100&page=${page}`,
      { token, fetchImpl },
    );
    issues.push(...batch);
    if (batch.length < 100) break;
  }
  return extractIssueVideoIds(issues);
}

async function ensureIssueLabel(repository, token, fetchImpl) {
  const path = `/repos/${repository}/labels/${encodeURIComponent(ISSUE_LABEL)}`;
  const response = await fetchWithRetry(
    `${GITHUB_API_BASE}${path}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": USER_AGENT,
      },
    },
    fetchImpl,
  );

  if (response.ok) return;
  if (response.status !== 404) {
    throw new Error(`GitHub label check failed with HTTP ${response.status}.`);
  }

  await githubApi(`/repos/${repository}/labels`, {
    method: "POST",
    body: {
      name: ISSUE_LABEL,
      color: "009CD3",
      description: "YouTubeの新着動画をホームページへ追加する作業",
    },
    token,
    fetchImpl,
  });
}

async function createIssue(repository, token, video, fetchImpl) {
  return githubApi(`/repos/${repository}/issues`, {
    method: "POST",
    body: {
      title: `[新着動画] ${video.snippet.title}`,
      body: buildIssueBody(video),
      labels: [ISSUE_LABEL],
    },
    token,
    fetchImpl,
  });
}

function parseBoolean(value) {
  return String(value).toLowerCase() === "true";
}

async function writeSummary(summaryPath, result) {
  if (!summaryPath) return;
  const lines = [
    "## YouTube新着動画の確認結果",
    "",
    `- 対象日: ${result.targetDate}（日本時間）`,
    `- 公開動画: ${result.detected}件`,
    `- Shorts除外: ${result.shortsExcluded}件`,
    `- ライブ除外: ${result.liveExcluded}件`,
    `- Issue作成: ${result.created.length}件`,
    `- 重複スキップ: ${result.duplicateSkipped}件`,
    `- Dry run: ${result.dryRun ? "はい" : "いいえ"}`,
    "",
  ];

  if (result.eligible.length === 0) {
    lines.push("対象となる通常動画はありませんでした。", "");
  } else {
    lines.push("### 対象動画", "");
    for (const video of result.eligible) {
      lines.push(`- [${video.snippet.title}](https://youtu.be/${video.id})（\`${video.id}\`）`);
    }
    lines.push("");
  }

  if (result.dryRun && result.pending.length > 0) {
    lines.push("### Dry run: 生成予定のIssue", "");
    for (const video of result.pending) {
      lines.push(`<details><summary>[新着動画] ${escapeHtml(video.snippet.title)}</summary>`, "", buildIssueBody(video), "</details>", "");
    }
  }

  await appendFile(summaryPath, `${lines.join("\n")}\n`, "utf8");
}

export async function run(env = process.env, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const classifier = dependencies.classifier ?? ((id) => classifyShortVideo(id, fetchImpl));
  const apiKey = env.YOUTUBE_API_KEY;
  const channelId = env.YOUTUBE_CHANNEL_ID;
  const token = env.GH_TOKEN;
  const repository = env.GITHUB_REPOSITORY;
  const dryRun = parseBoolean(env.DRY_RUN);
  const targetDate = validateTargetDate(env.TARGET_DATE || defaultTargetDate());

  if (!apiKey) throw new Error("YOUTUBE_API_KEY is not configured.");
  if (!channelId) throw new Error("YOUTUBE_CHANNEL_ID is not configured.");
  if (!token) throw new Error("GH_TOKEN is not available.");
  if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error("GITHUB_REPOSITORY is not available or invalid.");
  }

  const range = targetDateRange(targetDate);
  const playlistId = await getUploadsPlaylistId(channelId, apiKey, fetchImpl);
  const videoIds = await getPublishedVideoIds(playlistId, range, apiKey, fetchImpl);
  const videos = await getVideos(videoIds, apiKey, fetchImpl);

  // Finish all YouTube and Shorts checks before making any GitHub changes.
  const classification = await classifyCandidates(videos, range, classifier);
  const existingIds = await getExistingVideoIds(repository, token, fetchImpl);
  const pending = classification.eligible.filter((video) => !existingIds.has(video.id));
  const created = [];

  if (!dryRun && pending.length > 0) {
    await ensureIssueLabel(repository, token, fetchImpl);
    for (const video of pending) {
      created.push(await createIssue(repository, token, video, fetchImpl));
    }
  }

  const result = {
    targetDate,
    dryRun,
    ...classification,
    pending,
    created,
    duplicateSkipped: classification.eligible.length - pending.length,
  };
  await writeSummary(env.GITHUB_STEP_SUMMARY, result);
  return result;
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  run().catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `## YouTube新着動画の確認に失敗しました\n\n${message}\n`,
        "utf8",
      ).catch(() => {});
    }
    console.error(message);
    process.exitCode = 1;
  });
}

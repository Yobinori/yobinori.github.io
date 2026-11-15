import { appendFile, readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";
const GITHUB_API_BASE = "https://api.github.com";
const ISSUE_LABEL = "new-video";
const USER_AGENT = "yobinori-video-issue-generator/1.0";
const BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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

export function scanRange(targetDate, startDate = "", lookbackDays = "1") {
  const days = Number(lookbackDays);
  if (!Number.isInteger(days) || days < 1 || days > 366) {
    throw new Error("LOOKBACK_DAYS must be an integer from 1 to 366.");
  }
  const range = targetDateRange(targetDate);
  range.start = startDate ? targetDateRange(validateTargetDate(startDate)).start
    : new Date(range.start.getTime() - (days - 1) * DAY_MS);
  if (range.start >= range.end) throw new Error("START_DATE must not follow TARGET_DATE.");
  return range;
}

export function extractPublishedVideoIds(html) {
  return new Set([...html.matchAll(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/)|i\.ytimg\.com\/vi\/)([A-Za-z0-9_-]{11})/g)].map(match => match[1]));
}

async function getPublishedIds(directory = "video") {
  const ids = new Set();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".html")) continue;
    for (const id of extractPublishedVideoIds(await readFile(directory + "/" + entry.name, "utf8"))) ids.add(id);
  }
  return ids;
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
- 種別: ${video.classification === "unknown" ? "要確認（Shorts判定未完了・自動掲載不可）" : "通常動画"}

![${escapeMarkdownAlt(title)}](${thumbnailUrl})

## 追加用HTML

${fence}html
${html}
${fence}

## 作業

- [ ] 種別が未確認の場合は通常動画・Shorts・ライブを確認する
- [ ] 掲載先ページのリンク・見出し・表示名をユーザーに提案し、承認を得る
- [ ] HTMLを追加する
- [ ] GitHub Pagesで表示・動画IDの重複なし・タイトル2行以内を確認する
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

export function hasShortsMarker(video) {
  const title = String(video.snippet?.title ?? "");
  const tags = Array.isArray(video.snippet?.tags) ? video.snippet.tags.map(String) : [];
  return /(^|\s)#shorts(?:\s|$)/i.test(title) || tags.some((tag) => /^#?shorts$/i.test(tag.trim()));
}

function parseXmlAttributes(tag) {
  const attributes = new Map();
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)) {
    attributes.set(match[1], match[2].replaceAll("&amp;", "&"));
  }
  return attributes;
}

export function parseChannelFeedVideoLinks(xml) {
  const links = new Map();
  for (const entryMatch of String(xml).matchAll(/<entry\b[\s\S]*?<\/entry>/g)) {
    const entry = entryMatch[0];
    const videoId = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1]?.trim();
    if (!videoId) continue;

    for (const linkMatch of entry.matchAll(/<link\b[^>]*>/g)) {
      const attributes = parseXmlAttributes(linkMatch[0]);
      if (attributes.get("rel") === "alternate" && attributes.has("href")) {
        links.set(videoId, attributes.get("href"));
        break;
      }
    }
  }
  return links;
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

export async function classifyShortVideo(videoId, fetchImpl = fetch, knownVideoUrl = "") {
  if (knownVideoUrl) {
    const knownUrl = new URL(knownVideoUrl);
    if (knownUrl.hostname.endsWith("youtube.com") && knownUrl.pathname.startsWith("/shorts/")) {
      return true;
    }
    if (
      (knownUrl.hostname.endsWith("youtube.com") && knownUrl.pathname === "/watch") ||
      knownUrl.hostname === "youtu.be"
    ) {
      return false;
    }
    throw new Error(`Shorts classification failed for ${videoId}: channel feed returned an unexpected URL.`);
  }

  const url = `https://www.youtube.com/shorts/${videoId}`;
  const response = await fetchWithRetry(
    url,
    {
      method: "GET",
      redirect: "manual",
      headers: {
        Accept: "text/html",
        "Accept-Language": "ja,en;q=0.8",
        Cookie: "CONSENT=YES+cb.20210328-17-p0.en+FX+410; SOCS=CAI",
        "User-Agent": BROWSER_USER_AGENT,
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

  // An empty/error HTTP 200 is not evidence that this is a Short.
  if (html.includes('"webPageType":"WEB_PAGE_TYPE_SHORTS"') && html.includes(videoId)) return true;
  throw new Error(`Shorts classification failed for ${videoId}: no recognizable Shorts metadata.`);
}

async function getChannelFeedVideoLinks(channelId, fetchImpl = fetch) {
  const url = new URL("https://www.youtube.com/feeds/videos.xml");
  url.searchParams.set("channel_id", channelId);
  const response = await fetchWithRetry(
    url,
    {
      headers: {
        Accept: "application/atom+xml, application/xml;q=0.9, text/xml;q=0.8",
        "User-Agent": USER_AGENT,
      },
    },
    fetchImpl,
  );
  if (!response.ok) {
    throw new Error(`YouTube channel feed request failed with HTTP ${response.status}.`);
  }

  const links = parseChannelFeedVideoLinks(await response.text());
  if (links.size === 0) {
    throw new Error("YouTube channel feed did not contain recognizable video entries.");
  }
  return links;
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
  const seenTokens = new Set();
  let pages = 0;

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

    if (!Array.isArray(payload.items)) throw new Error("Playlist response is incomplete.");
    for (const item of payload.items) {
      const publishedAt = item.contentDetails?.videoPublishedAt;
      const videoId = item.contentDetails?.videoId;
      if (!publishedAt || !videoId || !Number.isFinite(Date.parse(publishedAt))) throw new Error("Playlist entry is missing publication metadata; coverage is incomplete.");

      const timestamp = new Date(publishedAt).getTime();
      if (timestamp >= range.start.getTime() && timestamp < range.end.getTime()) {
        ids.push(videoId);
      }
    }

    pageToken = payload.nextPageToken;
    if (pageToken && (seenTokens.has(pageToken) || ++pages >= 100)) throw new Error("Playlist coverage is incomplete.");
    if (pageToken) seenTokens.add(pageToken);
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
  const returned = new Set(videos.map(video => video.id));
  if (videoIds.some(id => !returned.has(id))) throw new Error("Video details are missing; coverage is incomplete.");
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
  const unresolved = [];

  for (const video of candidates) {
    try {
      if (await classifier(video.id)) {
        shortsExcluded += 1;
      } else {
        eligible.push(video);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      unresolved.push({ ...video, classification: "unknown" });
      console.warn(
        `Retaining video ${video.id} because Shorts classification could not be completed: ${message}`,
      );
    }
  }

  return {
    detected: publicVideos.length,
    liveExcluded: liveExcluded.length,
    shortsExcluded,
    unresolved,
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
    `- 対象範囲: ${result.range.start.toISOString()} 以上 ～ ${result.range.end.toISOString()} 未満`,
    `- 判定保留: ${result.unresolved.length}件（要確認Issueとして保持）`,
    `- 公開動画: ${result.detected}件`,
    `- Shorts除外: ${result.shortsExcluded}件`,
    `- ライブ除外: ${result.liveExcluded}件`,
    `- Issue作成: ${result.created.length}件`,
    `- 重複スキップ: ${result.duplicateSkipped}件`,
    `- Dry run: ${result.dryRun ? "はい" : "いいえ"}`,
    "",
  ];

  if (result.eligible.length === 0 && result.unresolved.length === 0) {
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

  const range = scanRange(targetDate, env.START_DATE || "", env.LOOKBACK_DAYS || "1");
  const playlistId = await getUploadsPlaylistId(channelId, apiKey, fetchImpl);
  const videoIds = await getPublishedVideoIds(playlistId, range, apiKey, fetchImpl);
  const videos = await getVideos(videoIds, apiKey, fetchImpl);
  let classifier = dependencies.classifier;

  if (!classifier && videos.length > 0) {
  const videosById = new Map(videos.map((video) => [video.id, video]));
  let feedLinks = new Map();
  try {
    feedLinks = await getChannelFeedVideoLinks(channelId, fetchImpl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `YouTube channel feed unavailable. Falling back to Shorts URL check: ${message}`,
    );
  }
  classifier = (id) => {
    const video = videosById.get(id);
    if (hasShortsMarker(video)) {
      return true;
    }
    const feedLink = feedLinks.get(id);
    if (feedLink) {
      return classifyShortVideo(id, fetchImpl, feedLink);
    }
    return classifyShortVideo(id, fetchImpl);
  };
  }

  classifier ??= (id) => classifyShortVideo(id, fetchImpl);

  // Finish all YouTube and Shorts checks before making any GitHub changes.
  const classification = await classifyCandidates(videos, range, classifier);
  const existingIds = await getExistingVideoIds(repository, token, fetchImpl);
  const publishedIds = dependencies.publishedIds ?? await getPublishedIds();
  const queue = [...classification.eligible, ...classification.unresolved];
  const pending = queue.filter(video => !existingIds.has(video.id) && !publishedIds.has(video.id));
  const created = [];

  if (!dryRun && pending.length > 0) {
    await ensureIssueLabel(repository, token, fetchImpl);
    for (const video of pending) {
      created.push(await createIssue(repository, token, video, fetchImpl));
    }
  }

  const result = {
    targetDate,
    range,
    dryRun,
    ...classification,
    pending,
    created,
    duplicateSkipped: queue.length - pending.length,
  };
  console.log("YOUTUBE_ISSUE_RESULT_JSON=" + JSON.stringify(result));
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

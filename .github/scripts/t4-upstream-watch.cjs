// Fork-only: tells the fork's upkeep issue when upstream publishes a stable
// release newer than the fork's base, or when a carried upstream PR changes
// state. scripts/t4/upstream.json holds the base and the carried PRs, and the
// upkeep updates it (scripts/t4/README.md).
//
//   node .github/scripts/t4-upstream-watch.cjs [--dry-run] [--repo <owner/name>] [--config <file>]
//
// Dependency-free, so the workflow runs it without installing the workspace.
// Each change is reported once: a comment carries a hidden marker per change,
// and the newest marker for a PR is the state the next run compares against.
// Comments name upstream PRs as code spans, so nothing links to them or
// notifies anyone upstream.
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_CONFIG = path.join(__dirname, "..", "..", "scripts", "t4", "upstream.json");
const API = "https://api.github.com";
// The issue is public: markers in anyone else's comments must not silence the watch.
const BOT_LOGIN = "github-actions[bot]";
const PULL_STATES = ["open", "closed", "merged"];
const MARKER_PATTERN = /<!-- t4-upstream-watch (?:release=(\S+)|pull=(\d+) state=(\w+)) -->/g;

function releaseMarker(tag) {
  return `<!-- t4-upstream-watch release=${tag} -->`;
}

function pullMarker(number, state) {
  return `<!-- t4-upstream-watch pull=${number} state=${state} -->`;
}

function parseStableTag(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag ?? "");
  return match ? match.slice(1).map(Number) : undefined;
}

function isNewerStable(tag, base) {
  const version = parseStableTag(tag);
  const baseVersion = parseStableTag(base);
  if (!version || !baseVersion) return false;
  for (let index = 0; index < 3; index++) {
    if (version[index] !== baseVersion[index]) return version[index] > baseVersion[index];
  }
  return false;
}

function validateConfig(value) {
  const fail = (message) => {
    throw new Error(`upstream.json: ${message}`);
  };
  if (!/^[\w.-]+\/[\w.-]+$/.test(value?.upstream ?? "")) fail("upstream must be owner/name");
  if (!Number.isSafeInteger(value.issue) || value.issue < 1) fail("issue must be a number");
  if (!parseStableTag(value.base)) fail("base must be a stable tag such as v0.1.1");
  if (!Array.isArray(value.carried)) fail("carried must be a list");
  const pulls = [];
  for (const group of value.carried) {
    if (typeof group?.name !== "string" || group.name === "") fail("each group needs a name");
    if (!Number.isSafeInteger(group.issue)) fail(`${group.name}: issue must be a number`);
    for (const [key, state] of Object.entries(group.pulls ?? {})) {
      const number = Number(key);
      if (!Number.isSafeInteger(number) || number < 1) fail(`${group.name}: bad PR number ${key}`);
      if (!PULL_STATES.includes(state)) fail(`#${key}: state must be ${PULL_STATES.join(", ")}`);
      if (pulls.some((pull) => pull.number === number)) fail(`#${key} is listed twice`);
      pulls.push({ number, state, name: group.name, issue: group.issue });
    }
  }
  if (pulls.length === 0) fail("carried lists no PRs");
  return { upstream: value.upstream, issue: value.issue, base: value.base, pulls };
}

function readConfig(file = DEFAULT_CONFIG) {
  return validateConfig(JSON.parse(fs.readFileSync(file, "utf8")));
}

function pullState(pull) {
  return pull.merged_at ? "merged" : pull.state;
}

function reportedState(comments) {
  const releases = new Set();
  const pulls = new Map();
  for (const comment of comments) {
    if (comment.user?.login !== BOT_LOGIN) continue;
    for (const match of (comment.body ?? "").matchAll(MARKER_PATTERN)) {
      if (match[1]) releases.add(match[1]);
      else pulls.set(Number(match[2]), match[3]);
    }
  }
  return { releases, pulls };
}

// `comments` are the issue's comments, oldest first; `pulls` maps each carried
// PR's number to its API object.
function findChanges({ config, comments, release, pulls }) {
  const reported = reportedState(comments);
  const newRelease =
    release &&
    !release.draft &&
    !release.prerelease &&
    isNewerStable(release.tag_name, config.base) &&
    !reported.releases.has(release.tag_name)
      ? release
      : undefined;
  const changedPulls = [];
  for (const carried of config.pulls) {
    const from = reported.pulls.get(carried.number) ?? carried.state;
    const pull = pulls.get(carried.number);
    const to = pullState(pull);
    if (to !== from) changedPulls.push({ ...carried, from, to, pull });
  }
  return { release: newRelease, pulls: changedPulls };
}

function day(timestamp) {
  return timestamp ? timestamp.slice(0, 10) : "an unknown date";
}

function describePull(pull) {
  switch (pullState(pull)) {
    case "merged":
      return `merged into \`${pull.base.ref}\` on ${day(pull.merged_at)}`;
    case "closed":
      return `closed without merging on ${day(pull.closed_at)}`;
    default:
      return "open";
  }
}

function pullLabel(carried) {
  return `\`#${carried.number}\` ${carried.name} (#${carried.issue})`;
}

// `contained` holds the merged PRs the new release contains.
function renderComment({ config, changes, pulls, contained = new Set() }) {
  const { release } = changes;
  if (!release && changes.pulls.length === 0) return undefined;
  const lines = [
    ...(release ? [releaseMarker(release.tag_name)] : []),
    ...changes.pulls.map((change) => pullMarker(change.number, change.to)),
  ];
  if (release) {
    const tag = release.tag_name;
    lines.push(
      `Upstream published the stable release \`${tag}\` on ${day(release.published_at)}, newer than the fork's base \`${config.base}\`. Time for the per-release checklist above.`,
      "",
      `Carried upstream PRs and \`${tag}\`:`,
      ...config.pulls.map((carried) => {
        const pull = pulls.get(carried.number);
        const state = contained.has(carried.number)
          ? `in \`${tag}\`: drop the fork's copy`
          : pullState(pull) === "merged"
            ? `${describePull(pull)}, not in \`${tag}\``
            : describePull(pull);
        return `- ${pullLabel(carried)}: ${state}`;
      }),
    );
  }
  if (changes.pulls.length > 0) {
    if (release) lines.push("");
    lines.push(
      "Carried upstream PRs changed state:",
      ...changes.pulls.map(
        (change) =>
          `- ${pullLabel(change)}: ${change.from} → ${change.from === "closed" && change.to === "open" ? "reopened" : describePull(change.pull)}`,
      ),
    );
  }
  return `${lines.join("\n")}\n`;
}

function createApi(request, token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "t4-upstream-watch",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const send = (method, route, body) =>
    request(`${API}${route}`, {
      method,
      headers: body ? { ...headers, "Content-Type": "application/json" } : headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const get = async (route, { allowMissing = false } = {}) => {
    const response = await send("GET", route);
    if (allowMissing && response.status === 404) return undefined;
    if (!response.ok) throw new Error(`GET ${route} failed with ${response.status}`);
    return response.json();
  };
  return {
    get,
    async list(route) {
      const items = [];
      for (let page = 1; ; page++) {
        const batch = await get(`${route}?per_page=100&page=${page}`);
        items.push(...batch);
        if (batch.length < 100) return items;
      }
    },
    async post(route, body) {
      const response = await send("POST", route, body);
      if (!response.ok) throw new Error(`POST ${route} failed with ${response.status}`);
      return response.json();
    },
  };
}

async function releaseContains(api, upstream, tag, sha) {
  const comparison = await api.get(`/repos/${upstream}/compare/${tag}...${sha}`);
  return comparison.status === "identical" || comparison.status === "behind";
}

async function run({ config, repo, token, dryRun, request = fetch, log = console.log }) {
  if (!dryRun && !token) throw new Error("GITHUB_TOKEN is required to comment; use --dry-run");
  const api = createApi(request, token);
  const [release, comments, pullList] = await Promise.all([
    api.get(`/repos/${config.upstream}/releases/latest`, { allowMissing: true }),
    api.list(`/repos/${repo}/issues/${config.issue}/comments`),
    Promise.all(
      config.pulls.map((carried) => api.get(`/repos/${config.upstream}/pulls/${carried.number}`)),
    ),
  ]);
  const pulls = new Map(pullList.map((pull) => [pull.number, pull]));
  const changes = findChanges({ config, comments, release, pulls });
  const contained = new Set();
  if (changes.release) {
    for (const pull of pullList) {
      if (
        pull.merged_at &&
        (await releaseContains(
          api,
          config.upstream,
          changes.release.tag_name,
          pull.merge_commit_sha,
        ))
      ) {
        contained.add(pull.number);
      }
    }
  }
  const body = renderComment({ config, changes, pulls, contained });
  if (!body) {
    log(`No changes since the last comment on ${repo}#${config.issue}.`);
    return undefined;
  }
  if (dryRun) {
    log(`Would comment on ${repo}#${config.issue}:\n\n${body}`);
    return body;
  }
  const comment = await api.post(`/repos/${repo}/issues/${config.issue}/comments`, { body });
  log(`Commented on ${repo}#${config.issue}: ${comment.html_url}`);
  return body;
}

function parseArgs(argv) {
  const args = { dryRun: false, repo: undefined, config: undefined };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--repo" || arg === "--config") {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} needs a value`);
      args[arg.slice(2)] = value;
    } else throw new Error(`Unknown argument ${arg}`);
  }
  return args;
}

if (require.main === module) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    const repo = args.repo ?? process.env.GITHUB_REPOSITORY;
    if (!repo) throw new Error("Pass --repo <owner/name> or set GITHUB_REPOSITORY");
    await run({
      config: readConfig(args.config),
      repo,
      token: process.env.GITHUB_TOKEN,
      dryRun: args.dryRun,
    });
  })().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  findChanges,
  parseArgs,
  readConfig,
  renderComment,
  run,
  validateConfig,
};

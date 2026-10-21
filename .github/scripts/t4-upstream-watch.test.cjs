const assert = require("node:assert/strict");
const test = require("node:test");

const {
  findChanges,
  parseArgs,
  readConfig,
  renderComment,
  run,
  validateConfig,
} = require("./t4-upstream-watch.cjs");

const BOT = { login: "github-actions[bot]" };

const config = validateConfig({
  upstream: "up/stream",
  issue: 13,
  base: "v0.1.1",
  carried: [
    { name: "Stack", issue: 1, pulls: { 101: "open", 102: "open" } },
    { name: "Tray", issue: 2, pulls: { 104: "closed" } },
    { name: "Sort", issue: 8, pulls: { 103: "open" } },
  ],
});

function pull(number, state, extra = {}) {
  return {
    number,
    state: state === "merged" ? "closed" : state,
    merged_at: state === "merged" ? "2026-11-02T10:00:00Z" : null,
    closed_at: state === "open" ? null : "2026-11-02T10:00:00Z",
    merge_commit_sha: `sha${number}`,
    base: { ref: "main" },
    ...extra,
  };
}

const unchangedPulls = {
  101: pull(101, "open"),
  102: pull(102, "open"),
  103: pull(103, "open"),
  104: pull(104, "closed"),
};

function release(tag, extra = {}) {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    published_at: "2026-11-03T00:00:00Z",
    ...extra,
  };
}

function fakeGitHub({ latest, comments = [], pulls = unchangedPulls, contained = [] }) {
  const posted = [];
  const respond = (status, body) => ({ ok: status < 300, status, json: async () => body });
  const request = async (url, init) => {
    const route = url.replace("https://api.github.com", "");
    if (init.method === "POST") {
      assert.equal(route, "/repos/fork/repo/issues/13/comments");
      posted.push(JSON.parse(init.body).body);
      return respond(201, { html_url: "comment-url" });
    }
    if (route === "/repos/up/stream/releases/latest")
      return latest ? respond(200, latest) : respond(404, {});
    let match = /^\/repos\/fork\/repo\/issues\/13\/comments\?per_page=100&page=(\d+)$/.exec(route);
    if (match) return respond(200, match[1] === "1" ? comments : []);
    match = /^\/repos\/up\/stream\/pulls\/(\d+)$/.exec(route);
    if (match) return respond(200, pulls[match[1]]);
    match = /^\/repos\/up\/stream\/compare\/v[\d.]+\.\.\.sha(\d+)$/.exec(route);
    if (match)
      return respond(200, { status: contained.includes(Number(match[1])) ? "behind" : "diverged" });
    return respond(404, {});
  };
  return { request, posted };
}

async function watch(github, options = {}) {
  return run({
    config,
    repo: "fork/repo",
    token: "token",
    dryRun: false,
    request: github.request,
    log: () => {},
    ...options,
  });
}

test("comments nothing while upstream matches the config", async () => {
  const github = fakeGitHub({ latest: release("v0.1.1") });
  assert.equal(await watch(github), undefined);
  assert.deepEqual(github.posted, []);
});

test("reports a new stable release once, with the carried PRs it contains", async () => {
  const pulls = {
    ...unchangedPulls,
    101: pull(101, "merged"),
    102: pull(102, "merged", { base: { ref: "stack/one" } }),
  };
  const first = fakeGitHub({ latest: release("v0.1.2"), pulls, contained: [101] });
  await watch(first);
  assert.equal(first.posted.length, 1);
  const [body] = first.posted;
  assert.match(body, /<!-- t4-upstream-watch release=v0\.1\.2 -->/);
  assert.match(
    body,
    /stable release `v0\.1\.2` on 2026-11-03, newer than the fork's base `v0\.1\.1`/,
  );
  assert.match(body, /- `#101` Stack \(#1\): in `v0\.1\.2`: drop the fork's copy/);
  assert.match(
    body,
    /- `#102` Stack \(#1\): merged into `stack\/one` on 2026-11-02, not in `v0\.1\.2`/,
  );
  assert.match(body, /- `#104` Tray \(#2\): closed without merging on 2026-11-02/);
  assert.match(body, /- `#103` Sort \(#8\): open/);
  assert.match(body, /- `#101` Stack \(#1\): open → merged into `main` on 2026-11-02/);

  const second = fakeGitHub({ latest: release("v0.1.2"), pulls, comments: [{ user: BOT, body }] });
  assert.equal(await watch(second), undefined);
  assert.deepEqual(second.posted, []);
});

test("ignores drafts, prereleases and releases not newer than the base", () => {
  const pulls = new Map(Object.values(unchangedPulls).map((entry) => [entry.number, entry]));
  for (const latest of [
    release("v0.1.2-nightly.20261021.3486", { prerelease: true }),
    release("v0.1.2", { prerelease: true }),
    release("v0.1.2", { draft: true }),
    release("v0.1.1-preview.20261021.3449"),
    release("v0.1.0"),
    release("v0.0.9"),
    undefined,
  ]) {
    assert.equal(findChanges({ config, comments: [], release: latest, pulls }).release, undefined);
  }
  assert.ok(findChanges({ config, comments: [], release: release("v0.2.0"), pulls }).release);
  assert.ok(findChanges({ config, comments: [], release: release("v1.0.0"), pulls }).release);
});

test("follows a PR through close and reopen, reporting each step once", async () => {
  const closed = fakeGitHub({ pulls: { ...unchangedPulls, 103: pull(103, "closed") } });
  await watch(closed);
  assert.match(closed.posted[0], /<!-- t4-upstream-watch pull=103 state=closed -->/);
  assert.match(
    closed.posted[0],
    /- `#103` Sort \(#8\): open → closed without merging on 2026-11-02/,
  );

  const comments = [{ user: BOT, body: closed.posted[0] }];
  const reopened = fakeGitHub({ comments });
  await watch(reopened);
  assert.match(reopened.posted[0], /<!-- t4-upstream-watch pull=103 state=open -->/);
  assert.match(reopened.posted[0], /- `#103` Sort \(#8\): closed → reopened/);

  const quiet = fakeGitHub({ comments: [...comments, { user: BOT, body: reopened.posted[0] }] });
  assert.equal(await watch(quiet), undefined);
});

test("markers in other people's comments don't count as reported", async () => {
  const github = fakeGitHub({
    pulls: { ...unchangedPulls, 104: pull(104, "open") },
    comments: [
      { user: { login: "someone" }, body: "<!-- t4-upstream-watch pull=104 state=open -->" },
    ],
  });
  await watch(github);
  assert.equal(github.posted.length, 1);
  assert.match(github.posted[0], /- `#104` Tray \(#2\): closed → reopened/);
});

test("names upstream PRs only as code spans, without links or mentions", () => {
  const pulls = new Map(
    [pull(101, "merged"), pull(102, "closed"), pull(103, "open"), pull(104, "open")].map(
      (entry) => [entry.number, entry],
    ),
  );
  const changes = findChanges({ config, comments: [], release: release("v0.1.2"), pulls });
  const body = renderComment({ config, changes, pulls, contained: new Set([101]) });
  for (const carried of config.pulls) {
    assert.doesNotMatch(body, new RegExp(`(?<!\`)#${carried.number}\\b`));
  }
  assert.doesNotMatch(body, /https?:|@\w|\]\(/);
});

test("a dry run prints the comment and posts nothing", async () => {
  const github = fakeGitHub({ latest: release("v0.1.2") });
  const logs = [];
  const body = await watch(github, {
    dryRun: true,
    token: undefined,
    log: (line) => logs.push(line),
  });
  assert.match(body, /release=v0\.1\.2/);
  assert.deepEqual(github.posted, []);
  assert.ok(logs[0].startsWith("Would comment on fork/repo#13:"));
  assert.ok(logs[0].endsWith(body));
});

test("refuses to comment without a token", async () => {
  await assert.rejects(watch(fakeGitHub({}), { token: undefined }), /GITHUB_TOKEN is required/);
});

test("rejects a config with duplicate PRs, unknown states or a non-stable base", () => {
  const valid = {
    upstream: "up/stream",
    issue: 13,
    base: "v0.1.1",
    carried: [{ name: "A", issue: 1, pulls: { 1: "open" } }],
  };
  assert.throws(
    () =>
      validateConfig({
        ...valid,
        carried: [...valid.carried, { name: "B", issue: 2, pulls: { 1: "open" } }],
      }),
    /#1 is listed twice/,
  );
  assert.throws(
    () => validateConfig({ ...valid, carried: [{ name: "A", issue: 1, pulls: { 1: "landed" } }] }),
    /state must be/,
  );
  assert.throws(
    () => validateConfig({ ...valid, base: "v0.1.2-nightly.20261021.3486" }),
    /base must be a stable tag/,
  );
});

test("the fork's upstream.json is valid", () => {
  assert.ok(readConfig().pulls.length > 0);
});

test("parses its arguments", () => {
  assert.deepEqual(parseArgs(["--dry-run", "--repo", "a/b", "--config", "c.json"]), {
    dryRun: true,
    repo: "a/b",
    config: "c.json",
  });
  assert.throws(() => parseArgs(["--repo"]), /--repo needs a value/);
  assert.throws(() => parseArgs(["--post"]), /Unknown argument --post/);
});

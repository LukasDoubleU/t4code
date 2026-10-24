import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ThreadMetadataMcpUpdateInput } from "./threadMetadataMcp.ts";

const decodeUpdate = Schema.decodeUnknownSync(ThreadMetadataMcpUpdateInput);

describe("ThreadMetadataMcpUpdateInput", () => {
  it("rejects malformed client request ids without normalizing valid keys", () => {
    const validKey = "metadata-\ud83d\ude80-1";
    assert.equal(
      decodeUpdate({ action: "regenerate_title", clientRequestId: validKey }).clientRequestId,
      validKey,
    );
    assert.throws(() =>
      decodeUpdate({ action: "regenerate_title", clientRequestId: "metadata-\ud800" }),
    );
    assert.throws(() =>
      decodeUpdate({ action: "regenerate_title", clientRequestId: "metadata-\udc00" }),
    );
  });

  it("accepts HTTP(S) pull request URLs and rejects other or malformed URLs", () => {
    assert.deepEqual(
      decodeUpdate({
        action: "link_pull_request",
        pullRequest: {
          repository: "engineering/t3code",
          number: 42,
          url: "https://git.corp.example/engineering/t3code/pulls/42",
        },
      }).pullRequest,
      {
        repository: "engineering/t3code",
        number: 42,
        url: "https://git.corp.example/engineering/t3code/pulls/42",
      },
    );

    for (const url of ["not a URL", "javascript:alert(1)", "file:///tmp/pull-request"]) {
      assert.throws(() =>
        decodeUpdate({
          action: "link_pull_request",
          pullRequest: { repository: "pingdotgg/t3code", number: 8690, url },
        }),
      );
    }
  });

  it("takes an icon only with set_icon", () => {
    assert.deepEqual(
      decodeUpdate({
        action: "set_icon",
        icon: { kind: "lucide", name: "flask-conical", color: "teal" },
      }).icon,
      { kind: "lucide", name: "flask-conical", color: "teal" },
    );
    assert.deepEqual(decodeUpdate({ action: "clear_icon" }).action, "clear_icon");
    assert.throws(() => decodeUpdate({ action: "set_icon" }), /set_icon requires icon/);
    assert.throws(
      () => decodeUpdate({ action: "clear_icon", icon: { kind: "emoji", emoji: "x" } }),
      /clear_icon does not accept icon/,
    );
    assert.throws(
      () => decodeUpdate({ action: "rename", title: "Docs", icon: { kind: "emoji", emoji: "x" } }),
      /rename does not accept icon/,
    );
    assert.throws(() => decodeUpdate({ action: "rename" }), /rename requires title/);
  });
});

import "../../index.css";

import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { AssistantCitationQuote } from "./AssistantCitationQuote";

const citation = {
  version: 1 as const,
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make("source"),
  text: "Keep the parser shared.",
  start: 0,
  end: 23,
  prefix: "",
  suffix: "",
};

function narrowContainer() {
  const container = document.createElement("div");
  container.style.width = "320px";
  return container;
}

describe("AssistantCitationQuote", () => {
  it("shows two lines of a long quote until expanded, then the comment", async () => {
    await using screen = await render(
      <AssistantCitationQuote
        citation={{ ...citation, text: "Long quoted words. ".repeat(40), comment: "Why this?" }}
      />,
      { container: narrowContainer() },
    );
    const quote = screen.getByRole("link").element();
    const expand = screen.getByRole("button", { name: "Show full quote" });
    await expect.element(expand).toBeVisible();
    const clampedHeight = quote.getBoundingClientRect().height;

    await userEvent.click(expand);

    expect(quote.getBoundingClientRect().height).toBeGreaterThan(clampedHeight * 3);
    await expect
      .element(screen.getByRole("button", { name: "Show less" }))
      .toHaveAttribute("aria-expanded", "true");
    await expect.element(screen.getByText("Why this?")).toBeVisible();
  });

  it("shows a short quote whole without an expand control", async () => {
    await using screen = await render(<AssistantCitationQuote citation={citation} />, {
      container: narrowContainer(),
    });

    await expect.element(screen.getByText("Keep the parser shared.")).toBeVisible();
    expect(screen.getByRole("button").query()).toBeNull();
  });

  it("goes to the cited text when the quote is clicked", async () => {
    await using screen = await render(<AssistantCitationQuote citation={citation} />);

    await userEvent.click(screen.getByRole("link"));

    expect(screen.router?.state.location.pathname).toBe("/environment/thread");
    expect(screen.router?.state.location.hash).toMatch(/^assistant-citation=/);
  });
});

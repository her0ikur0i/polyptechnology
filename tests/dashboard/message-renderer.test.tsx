import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MessageContent } from "../../src/dashboard/message-renderer.js";

describe("message markdown renderer", () => {
  it("renders hostile markdown as inert text instead of executable DOM", () => {
    render(
      <MessageContent
        content={[
          "<script>window.evil()</script>",
          '<img src=x onerror="window.evil()">',
          "[bad](javascript:alert(1)) [good](https://example.com/path)",
        ].join("\n\n")}
      />,
    );

    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("[onerror]")).toBeNull();
    expect(screen.getAllByText(/window\.evil/)).toHaveLength(2);
    expect(screen.getByText("bad").closest("a")).toBeNull();
    expect(document.body).not.toHaveTextContent("bad)");
    expect(screen.getByRole("link", { name: "good" })).toHaveAttribute(
      "href",
      "https://example.com/path",
    );
  });

  it("renders fenced code with highlighting and copy", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(
      <MessageContent
        content={[
          "Use this:",
          "",
          "```ts",
          'const answer = "safe"; // comment',
          "```",
        ].join("\n")}
      />,
    );

    expect(screen.getByText("ts")).toBeInTheDocument();
    expect(screen.getByText("const")).toHaveClass("code-token--keyword");
    expect(screen.getByText('"safe"')).toHaveClass("code-token--string");
    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith('const answer = "safe"; // comment');
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("reports clipboard failure without claiming the block was copied", async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    render(<MessageContent content={"```\ncopy me\n```"} />);

    await userEvent.click(screen.getByRole("button", { name: "Copy" }));

    expect(
      screen.getByRole("button", { name: "Copy failed" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
  });
});

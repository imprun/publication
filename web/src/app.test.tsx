import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "./app";
import type { PublicationClient } from "./fixture-client";

const client: PublicationClient = {
  async connection() {
    return {
      provider: "tistory",
      connectionId: "default",
      label: "Tistory",
      blogHost: "test.tistory.com",
      status: "ready",
    };
  },
  async categories() {
    return [{ id: 0, name: "카테고리 없음" }];
  },
  async prepare(input) {
    return {
      ...input,
      sourceHash: `sha256:${"1".repeat(64)}`,
      renderedHtmlHash: `sha256:${"2".repeat(64)}`,
      draftHash: `sha256:${"3".repeat(64)}`,
      renderedHtml: "<h1>Prepared</h1>",
    };
  },
  async connect(input) {
    return {
      provider: "tistory",
      connectionId: "default",
      label: "Tistory",
      blogHost: input.blogHost,
      status: "ready",
    };
  },
  async disconnect() {
    return {
      provider: "tistory",
      connectionId: "default",
      label: "Tistory",
      blogHost: "연결되지 않음",
      status: "missing",
    };
  },
  async requestPublish() {
    throw new Error("Fixture test client does not publish");
  },
  async approvePublish() {
    throw new Error("Fixture test client does not publish");
  },
  async cancelPublish() {},
};

describe("Publication studio", () => {
  it("keeps review disabled until a source and title exist", async () => {
    render(<App client={client} fixtureMode />);
    expect(await screen.findByRole("option", { name: /test\.tistory\.com/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "게시 검토" })).toBeDisabled();
  });

  it("manages Kakao credentials only from the Connection menu", async () => {
    const user = userEvent.setup();
    render(<App client={client} fixtureMode />);
    await screen.findByRole("option", { name: /test\.tistory\.com/ });
    expect(screen.queryByLabelText("카카오계정")).not.toBeInTheDocument();
    expect(screen.getByLabelText("게시할 Tistory 연결")).toHaveValue("default");

    await user.click(screen.getByRole("button", { name: "연결" }));
    expect(screen.getByRole("heading", { name: "Tistory" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "다시 연결" }));
    expect(screen.getByLabelText("카카오계정")).toBeInTheDocument();
    expect(screen.getByLabelText("비밀번호")).toBeInTheDocument();
  });

  it("prepares Markdown and shows the immutable approval hash", async () => {
    const user = userEvent.setup();
    render(<App client={client} fixtureMode />);
    await screen.findByRole("option", { name: /test\.tistory\.com/ });
    await user.type(screen.getByPlaceholderText("게시물 제목"), "첫 게시");
    await user.type(screen.getByLabelText(/원문 내용/), "# 본문");
    await user.click(screen.getByRole("button", { name: "게시 검토" }));
    expect(await screen.findByTitle("정화된 게시 미리보기")).toBeInTheDocument();
    expect(screen.getByText(/sha256:3333333333333/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cloud 연결 후 승인 요청" })).toBeDisabled();
  });
});

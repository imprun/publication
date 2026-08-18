import { describe, expect, it, vi } from "vitest";
import { prepareDraft } from "../src/providers/tistory/prepare.js";
import { TistoryProvider, validateEntryUrl } from "../src/providers/tistory/provider.js";
import { mockContext } from "./helpers.js";

const provider = new TistoryProvider();
const draft = {
  provider: "tistory" as const,
  connectionId: "default" as const,
  title: "Test post",
  content: { format: "markdown" as const, body: "# Body" },
  tags: ["test"],
  categoryId: 0,
};

describe("TistoryProvider publishing", () => {
  it("canonicalizes a numeric custom-domain response onto the connected Tistory host", () => {
    expect(validateEntryUrl("example.tistory.com", "https://blog.example.test/187")).toEqual({
      postId: "187",
      entryUrl: "https://example.tistory.com/187",
    });
  });

  it("rejects a non-numeric Tistory response path", () => {
    expect(() =>
      validateEntryUrl("example.tistory.com", "https://blog.example.test/entry/not-an-id"),
    ).toThrow("Tistory returned an invalid post URL");
  });

  it("rejects stale draft state before approval or HTTP", async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => new Response("{}"),
    );
    const ctx = mockContext(fetcher);
    const wait = vi.spyOn(ctx.human, "wait");
    await expect(
      provider.publish(
        { ...draft, draftHash: `sha256:${"0".repeat(64)}`, visibility: "private" },
        ctx,
      ),
    ).rejects.toThrow("draftHash");
    expect(wait).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("publishes only after approval and validates the returned blog URL", async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response('{"entryUrl":"https://example.tistory.com/123"}', {
          headers: { "content-type": "application/json" },
        }),
    );
    const ctx = mockContext(fetcher);
    const input = {
      ...draft,
      draftHash: prepareDraft(draft).draftHash,
      visibility: "private" as const,
    };
    await expect(provider.publish(input, ctx)).resolves.toMatchObject({ postId: "123" });
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://example.tistory.com/manage/post.json");
    expect(init?.method).toBe("POST");
  });

  it("updates with PUT on the path ID instead of creating another post", async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response('{"entryUrl":"https://example.tistory.com/123"}'),
    );
    const ctx = mockContext(fetcher);
    await provider.update(
      {
        ...draft,
        postId: "123",
        draftHash: prepareDraft(draft).draftHash,
        visibility: "public",
      },
      ctx,
    );
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://example.tistory.com/manage/post/123.json");
    expect(init?.method).toBe("PUT");
  });
});

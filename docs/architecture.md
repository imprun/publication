# Publication backend current-state design

Date: 2026-08-17
Status: current implementation snapshot, not a final architecture decision

## Ownership boundaries

- Publication owns provider-neutral publishing actions, approval policy, input
  and output schemas, and provider adapters.
- Windforce Core owns App execution, HumanTask holds, secret masking, App-owned
  Secret Variables, typed Resources, and runtime access enforcement.
- The workspace operator owns registration of `publication.connection@1`.
- Tistory owns the undocumented `/manage/*` HTTP behavior. The adapter must fail
  closed when authentication or response shape changes.
- A future React UI consumes action schemas and outputs. It does not own session
  credentials or Tistory HTTP behavior.

## Windforce SDK boundary

The App entry point is registered with Core's injected
`windforce-client.createApp({ actions })` contract. Publication does not inspect
`ctx.action` or implement its own action dispatcher, and it does not copy the
private `@scraping/sdk` package.

Core issue `#236` completed the scoped App-owned Variable and Resource mutation
contract used by `connection.login`. The target Cloud reports that contract as
deployed; release qualification must still probe the actual target runtime.
`src/windforce-client.d.ts` is a development-time ABI declaration because Core
currently injects the executable module only during Release preparation. A
distributable public author SDK is follow-up developer-experience work tracked
by Core issue `#239`, not a runtime blocker for this App.

Core's TypeScript release preparation installs production dependencies and
statically verifies the App entrypoint with Bun. `bunfig.toml` therefore uses a
hoisted production install, and the login adapter resolves the declared
Playwright dependency only when `connection.login` runs. This keeps Playwright's
browser internals out of the static verification graph while retaining it in
the Linux execution bundle for browser Workers.

## Security model

```text
Kakao credentials (write-only action input)
             |
             v
visible Playwright login + HumanTask
             |
             v
App Secret Variable: connections/tistory/default/session
             ^
             | $var@app reference, resolved only for authorized actions
App Resource: connections/tistory/default/profile
```

The login result, Resource value, logs, and repository never contain cookie
plaintext. The raw Secret Variable contains user agent, cookies, local storage,
and session storage. Every action declares the exact App-owned Resource and
Secret Variable paths it can read. Only `connection.login` can write them.

The first release deliberately supports one exact connection path (`default`).
Dynamic account paths are deferred because the Core authorization contract is
exact-path based rather than wildcard based.

## Publishing model

`post.prepare` is a stateless compiler step, not a database write. It returns a
canonical draft hash over provider, connection, title, Markdown, normalized
tags, and category. Publish and update recompute this hash before presenting an
approval task, preventing stale UI state from silently changing the approved
content.

The Tistory server stores rendered HTML through its current management endpoint;
it does not render raw Markdown submitted to `/manage/post.json`. Markdown is
therefore converted and sanitized inside the Tistory adapter. This is a provider
detail, not the provider-neutral content model.

The representative image is uploaded first through
`/manage/post/attach.json`. Its signed `attachmentRef` is used in the body image
substitution, `attachments`, and `thumbnail` fields so the post refers to one
asset identity. The supplied HAR confirmed the `thumbnail` field but contained
an empty value; the non-empty representative-image mapping requires a private
live smoke test before release qualification.

## HTTP contract snapshot

- session check/list: `GET /manage/posts.json`
- categories: `GET /manage/category.json`
- image upload: `POST /manage/post/attach.json`, multipart field `file`
- create: `POST /manage/post.json`
- update: `PUT /manage/post/{id}.json`
- delete: `DELETE /manage/post/{id}.json`
- visibility: `0` private, `20` public

POST is never used for update: captured behavior shows that it always creates a
new post even when an ID is supplied. Redirects, login HTML returned with status
200, and 401/403 are all treated as expired sessions.

## Deferred decisions

- additional providers and multiple simultaneous accounts;
- durable draft/version storage;
- scheduled publishing and protected posts;
- recovery or rotation UI for expired sessions;
- React framework, component system, and deployment shape;
- release qualification of non-empty Tistory `thumbnail` behavior.

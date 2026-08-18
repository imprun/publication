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
- The React SPA consumes the Cloud Action APIs and action outputs. It does not
  own session credentials or Tistory HTTP behavior. Identity authenticates the
  human; Cloud authorizes tenant and workspace access.

## Windforce SDK boundary

The App entry point is defined through the public `@imprun/app-sdk` package,
pinned to an exact public Git commit. `defineAction` owns each handler's schema,
placement, and runtime grants; `defineApp` provides the SDK-neutral `main(ctx)`
entry point and deterministic manifest description. Publication does not
inspect `ctx.action`, copy the private `@scraping/sdk` package, or depend on
Core's private transport.

Core issue `#236` completed the scoped App-owned Variable and Resource mutation
contract used by `connection.login`. The target Cloud reports that contract as
deployed; release qualification must still probe the actual target runtime.
`npm run manifest` materializes the canonical App-owned deployment artifact.
The SDK is an ordinary App dependency and does not replace Core admission,
runtime enforcement, Worker scheduling, or Release preparation.

Core's TypeScript release preparation installs production dependencies and
statically verifies the App entrypoint with Bun. `bunfig.toml` therefore uses a
hoisted production install, and the login adapter resolves the declared
Puppeteer dependency only when `connection.login` runs. This keeps Puppeteer's
browser internals out of the static verification graph while retaining it in
the Linux execution bundle for browser Workers.

## Security model

```text
Kakao credentials (ephemeral browser form state)
             |
             v
App Secret Variables: account-id + password
             | locked $var@app InputConfig
             v
isolated BrowserContext bootstrap
             |
             v
Kakao JSON login + 1-second phone-approval polling
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

The browser clears credential form state as soon as Cloud accepts the encrypted
Secret Variable writes. Credentials never become Run input, logs, Resources, or
receipts. The supplied login HAR defines the current Kakao adapter state machine:
`authenticate.json`, `verify_tms_for_login.json`, OAuth continuation, then the
Tistory callback. Browser isolation supplies the origin security model, current
CSRF/encryption/user-agent context, and the cookie/storage jar. The adapter uses
the page-loaded Kakao Account client for authentication and verification polling,
plus top-level origin navigation. It does not query, fill, click, or submit login
controls. A Kakao-issued dKaptcha challenge is rendered with Kakao's own widget
and completed by the user in Browser Edge. No separate login HumanTask completion
signal is used. Session state is persisted only after the read-only Tistory
management API succeeds.

The first release deliberately supports one exact connection path (`default`).
Dynamic account paths are deferred because the Core authorization contract is
exact-path based rather than wildcard based.

## Publishing model

`post.prepare` is a stateless compiler step, not a database write. It accepts a
provider-neutral `content` value with `format: markdown | html` and a source
`body`. It returns a canonical draft hash over provider, connection, title,
content format and source, normalized tags, and category. Publish and update
recompute this hash before presenting an approval task, preventing stale UI
state from silently changing the approved content.

The Tistory server stores rendered HTML through its current management endpoint;
it does not render raw Markdown submitted to `/manage/post.json`. Markdown is
therefore rendered and sanitized inside the Tistory adapter. HTML input skips
Markdown rendering but passes through the same sanitizer. This is a provider
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
- authenticated-principal ownership for connection Secrets and Resources;
- durable draft/version storage;
- scheduled publishing and protected posts;
- recovery or rotation UI for expired sessions;
- self-service tenant provisioning and automatic App installation;
- release qualification of non-empty Tistory `thumbnail` behavior.

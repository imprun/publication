# Publication

Publication is a Windforce App and React service for publishing Markdown and
HTML to multiple platforms. The first provider is Tistory. Imprun Identity
authenticates users, Cloud authorizes workspace access, and every mutation is
held for explicit approval.

## Backend flow

1. `connection.login` connects Puppeteer to the Job-scoped `edge-cdp` capability
   and creates an isolated BrowserContext. Browser Edge is used only as an
   origin-aware JavaScript runtime and cookie/storage jar. It starts the Tistory
   OAuth transaction with `Kakao.Auth.authorize()`, then calls the Kakao Account
   page's loaded client for `authenticate` and one-second phone-approval polling.
   It never queries, fills, or clicks login controls. If Kakao returns a dKaptcha
   challenge, the page renders Kakao's own widget for the user before retrying.
   The persisted Run input contains only the public Tistory blog host.
2. The action writes the Chrome session to the App-owned Secret Variable
   `connections/tistory/default/session`.
3. It writes safe connection metadata to the App-owned Resource
   `connections/tistory/default/profile`. The Resource stores only a `$var@app:`
   reference; it never stores cookie plaintext.
4. `metadata.categories` retrieves the selectable Tistory category list by HTTP.
5. `media.upload` uploads a representative image by HTTP and returns the signed
   Tistory attachment identity needed by the post.
6. `post.prepare` validates and normalizes title, source content, tags, and
   category. Markdown is rendered to HTML; HTML is sanitized without Markdown
   parsing. Both paths return deterministic hashes and do not persist the draft.
7. `post.publish` or `post.update` verifies the draft hash, asks for HumanTask
   approval, then calls Tistory directly by HTTP. `post.delete` is also approval
   gated.

Tistory's retired Open API is not used. Its current management endpoints are an
undocumented adapter contract and are isolated under `src/providers/tistory`.

## Windforce prerequisite

The app targets the accepted App-owned runtime configuration write contract in
Windforce Core ADR 0043. It requires Core support for scoped
`writeVariables`/`writeResources` and `ctx.variables.set`/`ctx.resources.set`.
Core issue `#236` is complete and the target Cloud reports the contract as
deployed. Release qualification still verifies the target runtime before any
live login or Tistory mutation.

The App uses the public `@imprun/app-sdk` package pinned to an exact public Git
commit. `defineAction` and `defineApp` keep handler dispatch, schemas, placement,
and runtime grants in one typed definition; `npm run manifest` regenerates the
canonical deployment manifest. Core still owns and enforces the runtime
contract, and the SDK remains an opaque App dependency.

Before publishing the App Release, register the workspace-owned ResourceType
`publication.connection@1` using
`resource-types/publication.connection@1.schema.json`.

The Worker selected for `connection.login` must advertise the `browser` label
through a ready worker-local capability gateway. Chrome remains on the enrolled
Edge device; the Worker receives only a Job-scoped BrowserSession. Other actions
do not require browser placement.

## Commands

```text
npm install
npm run manifest
npm run check
npm run build
```

## Product UI

The React product shell lives in `web` as an independent package so Windforce
release preparation does not install browser dependencies. Local development is
explicitly fixture-backed and never sends a live publish request:

```text
npm install --prefix web
npm run check --prefix web
npm run dev --prefix web
```

Production does not fall back to fixture data. Runtime `config.js` sets cloud
mode and the public Imprun Identity client values; it never contains a customer
tenant. After PKCE login, the customer selects an exact
`https://*.cloud.imprun.dev` origin and workspace. The browser persists only
those non-secret target values. Identity tokens use session storage, while
Kakao credentials are cleared from React state after encrypted App Secret
Variable provisioning.

The production image is built from `web/Dockerfile`, serves on port 8080 as an
unprivileged user, and accepts deployment-specific runtime configuration by
mounting `/usr/share/nginx/html/config.js`.

## Tistory login E2E CLI

The CLI provisions Kakao credentials as encrypted App-scoped Secret Variables,
binds them to `connection.login` through an InputConfig, waits for phone approval,
verifies the stored session, prepares `examples/tistory-e2e.md`, waits for the
publish HumanTask, and reports the resulting private post ID and URL. The local
credential file is never used as Run input and must not be committed.

Create a local file outside the repository, or under the ignored `.secrets/`
directory:

```json
{
  "accountId": "your-kakao-account",
  "password": "your-kakao-password"
}
```

Then run:

```text
npm run e2e:tistory-login -- --context my-cloud --blog-host example-blog.tistory.com --credentials C:\\private\\tistory-login.json
```

The existing ignored `.env` format is also supported:

```text
KAKAO_LOGINID=your-kakao-account
KAKAO_LOGINPWD=your-kakao-password
npm run e2e:tistory-login -- --context my-cloud --blog-host example-blog.tistory.com --env .env
```

Complete Kakao's own CAPTCHA in the Browser Edge tab if it appears. If Kakao then
sends a phone approval request, approve it on the registered device; the action
checks the page-owned verification state every second. After login, the
CLI creates a private post approval task in Imprun Cloud and waits for the user to
approve it. Use `--markdown <path>` to replace the example Markdown, or
`--configure-only` to rotate the Secret Variables without starting a Run. Remove
the plaintext credential file after provisioning or keep it in an external
secret manager; Publication never deletes user files.

No live Tistory mutation is part of the automated unit test suite. The E2E CLI
uses a private post and cannot publish until its HumanTask is explicitly approved.

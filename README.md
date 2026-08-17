# Publication

Publication is a backend-first Windforce App that publishes Markdown to multiple
platforms. The first provider is Tistory. A React UI will be added only after
the backend contract is complete.

## Backend flow

1. `connection.login` connects Puppeteer to the Job-scoped `edge-cdp` capability,
   opens a page in the Edge device's visible Chrome, fills and submits Kakao
   account fields resolved from App-scoped Secret Variables, and waits for the
   person to complete CAPTCHA or 2FA. The persisted Run input contains only the public
   Tistory blog host.
2. The action writes the Chrome session to the App-owned Secret Variable
   `connections/tistory/default/session`.
3. It writes safe connection metadata to the App-owned Resource
   `connections/tistory/default/profile`. The Resource stores only a `$var@app:`
   reference; it never stores cookie plaintext.
4. `metadata.categories` retrieves the selectable Tistory category list by HTTP.
5. `media.upload` uploads a representative image by HTTP and returns the signed
   Tistory attachment identity needed by the post.
6. `post.prepare` validates and normalizes title, Markdown, tags, and category,
   renders deterministic HTML, and returns a draft hash. It does not persist the
   draft.
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

## Tistory login E2E CLI

The CLI provisions Kakao credentials as encrypted App-scoped Secret Variables,
binds them to `connection.login` through an InputConfig, creates the Run, waits
for Browser Edge assignment, and submits the HumanTask decision. The local JSON
file is never used as the Run input and must not be committed.

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
npm run e2e:tistory-login -- --context junsik-cloud --blog-host pak2251.tistory.com --credentials C:\\private\\tistory-login.json
```

The existing ignored `.env` format is also supported:

```text
KAKAO_LOGINID=your-kakao-account
KAKAO_LOGINPWD=your-kakao-password
npm run e2e:tistory-login -- --context junsik-cloud --blog-host pak2251.tistory.com --env .env
```

The CLI fills and submits the account fields in the Edge device's Chrome.
Complete any CAPTCHA or 2FA in that Chrome, then enter `approve` in the
CLI. Use `--configure-only` to provision or rotate the Secret Variables without
starting a Run. Remove the plaintext credentials file after provisioning or
keep it in an external secret manager; Publication never deletes user files.

No live Tistory mutation is part of the automated test suite. A release smoke
test must use a private post first and must be explicitly approved.

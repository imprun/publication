# Publication

Publication is a backend-first Windforce App that publishes Markdown to multiple
platforms. The first provider is Tistory. A React UI will be added only after
the backend contract is complete.

## Backend flow

1. `connection.login` connects Playwright to the Job-scoped `edge-cdp` capability,
   opens a page in the user's visible Chrome, optionally fills supplied Kakao
   account fields, and waits for the person to enter or submit login and complete
   2FA. Production assignment needs only the public Tistory blog host.
2. The action writes the Playwright session to the App-owned Secret Variable
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

No live Tistory mutation is part of the automated test suite. A release smoke
test must use a private post first and must be explicitly approved.

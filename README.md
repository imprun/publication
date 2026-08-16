# Publication

Publication is a backend-first Windforce App that publishes Markdown to multiple
platforms. The first provider is Tistory. A React UI will be added only after
the backend contract is complete.

## Backend flow

1. `connection.login` opens a visible Playwright browser, fills the Kakao account
   fields, and waits for the person to submit login and complete 2FA.
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

Core injects the executable `windforce-client` module while preparing the App
Release. `src/windforce-client.d.ts` is only a local compile-time declaration of
that public contract; the repository does not vendor a second runtime SDK. A
stable distributable author SDK remains tracked separately in Core issue `#239`.

Before publishing the App Release, register the workspace-owned ResourceType
`publication.connection@1` using
`resource-types/publication.connection@1.schema.json`.

The Worker selected for `connection.login` must have the `browser` label and a
visible browser display. Other actions do not require browser placement.

## Commands

```text
npm install
npm run check
npm run build
```

No live Tistory mutation is part of the automated test suite. A release smoke
test must use a private post first and must be explicitly approved.

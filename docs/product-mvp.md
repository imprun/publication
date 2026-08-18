# Publication B2C MVP

Date: 2026-08-18
Status: approved implementation direction after the Tistory proof of concept

## Product promise

Publication lets a customer take a local Markdown or HTML document, choose a
connected publishing platform, review the effective post, approve the mutation,
and receive the resulting post URL.

The product is a publishing surface, not a general document editor. The source
file remains the customer's primary document. Publication owns connection,
normalization, preview, approval, delivery, and result reporting.

## First complete journey

1. Sign in through Imprun Identity.
2. Enter the customer's Imprun tenant and install the released Publication App
   if it is not already present.
3. Connect one Tistory blog. Kakao credentials are written directly to encrypted
   App Secret Variables and never become Run input, logs, Resources, or receipts.
4. Drop or paste a `.md` or `.html` document.
5. Set title, category, tags, visibility, and an optional representative image.
6. Run `post.prepare` and review the sanitized effective HTML and draft hash.
7. Request publish. Public and private mutations remain HumanTask-gated.
8. Show the terminal state, provider post ID, and canonical result URL.

The primary action is **게시 검토**. The most important state is the per-platform
delivery state: connection required, ready, waiting for approval, publishing,
succeeded, or failed.

## Tenancy and identity

- Imprun Identity is the only human authentication boundary. Publication never
  collects an Imprun Identity or Google password.
- The validated Identity `sub` identifies the human. Cloud owns tenant
  membership and role authorization.
- An Imprun tenant Cell is the customer security boundary. The MVP installs one
  Publication App in each customer Cell and stores its Tistory connection in
  that App's encrypted Secret Variable and typed Resource.
- The engine workspace is an organizational partition, not an additional
  customer security boundary.
- The first MVP supports one Tistory connection per customer Cell. Members of a
  shared organization intentionally share that connection when their Cloud role
  authorizes Publication actions.
- Multiple personal connections inside one shared tenant require a later
  principal-owned secret/resource contract or a dedicated Publication account
  store. Dynamic caller-controlled secret paths are not an acceptable shortcut.

The standalone browser client uses Authorization Code with PKCE S256 and no
client secret. Its exact production origin, callback, logout return, audience,
and allowed origin are registered in Imprun Identity. Access tokens live only in
session storage. A signed-in customer selects their `*.cloud.imprun.dev` origin
and workspace; those two non-secret values are the only persistent browser
configuration.

## Content contract

All create and update actions use this provider-neutral source shape:

```json
{
  "content": {
    "format": "markdown",
    "body": "# Source document"
  }
}
```

`format` is `markdown` or `html`. Markdown is rendered by the provider adapter.
HTML skips Markdown parsing, but it is never trusted: both paths pass through the
same sanitizer before preview, hashing, approval, and delivery. The draft hash
includes the content format and source body so the approved artifact cannot be
silently reinterpreted.

## MVP acceptance

- A signed-in customer can connect one Tistory blog without exposing credentials
  in persisted Run input or visible output.
- Stored session status can be checked by a non-interactive read-only action.
- Both Markdown and HTML produce deterministic sanitized preview HTML.
- Any effective title, content format, content body, tag, or category change
  invalidates the prepared draft hash.
- A customer can publish one private Tistory post only after explicit approval
  and receives its canonical URL.
- Public publish, update, and delete remain independently approval-gated.
- UI covers loading, empty, error, populated, waiting-for-approval, success, and
  partial platform failure states on desktop and mobile.
- No live mutation is part of automated tests. Production smoke tests use private
  posts and explicit user approval.

## Deferred after MVP

- a second provider to prove the adapter boundary;
- multiple connections for one provider inside a shared tenant;
- durable hosted drafts, versions, collaboration, and scheduling;
- billing, quotas, public signup, and self-service tenant provisioning;
- provider-specific advanced settings that do not map to the common contract.

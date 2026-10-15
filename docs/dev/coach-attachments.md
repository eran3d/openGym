# Coach attachments: a PDF or a photo of a plan, read by the Coach itself

People arrive with a plan they already have: a PDF from a trainer, a screenshot of a
spreadsheet, a photo of a sheet on the gym wall. Today the only way to hand that to the Coach is
to retype it into a chat message capped at `maxMessageLen`. This note describes letting the
person attach the file to a plan request, and having the provider's model read it directly.

It describes the change on the `feature/coach-attachments` branch.

## 1. What the API takes

`POST /api/coach/plan` gains one optional field next to `intake` and `refine`:

```json
{
  "refine": "Turn this into my plan, four days a week.",
  "lang": "en",
  "attachments": [
    { "name": "plan.pdf", "mediaType": "application/pdf", "data": "<base64>" }
  ]
}
```

- `data` is plain base64 of the file's bytes (no `data:` prefix). JSON rather than multipart,
  because every route on this server reads JSON through one `readBody`, and a second body parser
  for one field is not worth its weight.
- `name` is a label for the model and for the chat line, nothing else: it never becomes a path.
- Only `POST /api/coach/plan` (intake or refine) takes attachments. A review reads logged
  training; a debrief reads one workout. Neither has an obvious use for a file, and both can grow
  one later through the same check.

## 2. Limits

Checked in `jobs.enqueue`, before the daily cap is bumped, so a refused file costs nothing:

| Check | Default | Bound |
| --- | --- | --- |
| Media type | `application/pdf`, `image/jpeg`, `image/png` | whitelist, intersected with what the provider reads |
| Bytes per file | 10 MiB | admin, 0.1 to 15 MiB |
| Bytes per image | as per file | lower where the provider takes less (Anthropic: 7.5 MB) |
| Bytes per request | 15 MiB | admin, up to 15 MiB |
| Files per request | 3 | admin, 0 to 5 (0 switches the feature off) |
| Pages per PDF | 30 | admin, 1 to 100 (Anthropic's own ceiling per request) |

The 15 MiB ceiling is set by the transport. base64 adds a third, so 15 MiB of file is 20 MiB on
the wire. Every API route reads at most 5 MiB (`MAX_BODY`, and nginx's `client_max_body_size`
on `/api/`); `POST /api/coach/plan` alone reads up to 21 MiB (`PLAN_BODY_LIMIT`, passed to
`readBody` by that route, and an exact-match `location` in `web/nginx.conf.template` with
`client_max_body_size 21m`). The extra MiB is the rest of the request. A reverse proxy in front
of the web container needs the same room on that one path.

What the providers take, checked October 2026, so the ceiling stays inside all of them:

| Provider | Request | Per file | PDF pages |
| --- | --- | --- | --- |
| Anthropic (API and Agent SDK) | 32 MB | 10 MB of base64 per image, so 7.5 MB of image (5 MB on Bedrock and Vertex) | 100 below a 1M-token context, 600 above |
| OpenAI | 50 MB across all files | 50 MB | not stated |
| Gemini | 100 MB of inline data (since January 2026; 20 MB before) | PDFs up to 50 MB | 1000 |

So the per-image limit is the only one an adapter has to state (`attachmentLimits.maxImageBytes`
on the Anthropic and Agent SDK adapters); status reports it as `maxImageBytes`. An instance
behind an older Gemini endpoint that still caps inline data at 20 MB should set the request
limit to 14 MiB.

The declared `mediaType` must match the file's first bytes (`%PDF-`, the JPEG SOI marker, the
PNG signature). A file that claims to be a PDF and is not is refused with the same class as a
wrong type; nothing downstream has to wonder what it is holding.

Bytes are no measure of what a PDF costs. Providers read every page as text and as an image, so
a 400 KB scan of 80 pages costs far more than a 3 MB photo. Pages are the limit that bounds the
bill. They are counted roughly, without a PDF parser: page objects (`/Type /Page`, never the
`/Type /Pages` tree), and when the plain file shows none, the same inside its compressed object
streams (inflated with `node:zlib`, bounded at 16 MiB). A PDF whose pages cannot be counted is
refused rather than waved through.

A job with attachments is one job: it counts once against `perProfileDaily` and
`instanceDaily`, like any other. The provider bills it for more input, which is what the page
and size limits are for.

A refusal is a 400 (413 for size) with `code: "attachments"` and a `reason` the client can
translate: `unsupported`, `malformed`, `count`, `type`, `pages`, `size`, `total`.

## 3. What the client is told

`GET /api/coach/status` gains:

```json
"attachments": { "types": ["application/pdf", "image/jpeg", "image/png"], "maxCount": 3, "maxBytes": 10485760, "maxTotalBytes": 15728640, "maxPages": 30, "maxImageBytes": 7500000 }
```

or `null` when the configured provider cannot read files, or the admin set the count to 0. The
client shows an attach button only when this is non-null, and only offers the listed types. It
rides on the status poll for the same reason `maxMessageLen` does: an admin switching provider
reaches an open chat within one poll.

## 4. Per provider

Every adapter states what it reads (`attachmentTypes`, or `null`), the same way it states
`spawns`. Nothing above the adapter branches on provider identity.

| Provider | Types | How the file travels |
| --- | --- | --- |
| `anthropic` | pdf, jpeg, png | `document` and `image` content blocks, before the text block |
| `openai` | pdf, jpeg, png | Chat Completions `file` part (pdf) and `image_url` data URL (images) |
| `gemini` | pdf, jpeg, png | `inlineData` parts |
| `compatible` | none | servers behind this shape differ too much to promise anything |
| `claude` (Agent SDK) | pdf, jpeg, png | the same content blocks, as a streaming-input user message |
| `codex` | none | `codex exec` reads a prompt from stdin; there is no file channel that does not widen its sandbox |
| `fixture` | pdf, jpeg, png | written into the job directory; the fixture echoes name and size |

The Agent SDK adapter keeps `tools: []`. Handing the model the `Read` tool to open a file in its
job directory would work, but it is a filesystem tool, and `LOCKDOWN` exists so that one is never
granted quietly. The SDK takes an `AsyncIterable<SDKUserMessage>` as its prompt, and a user
message carries content blocks, so the file goes in the message and the lockdown stays exactly
as it is.

### The repair round, and what it costs

The repair round sends the attachments again: a model asked to fix its plan has to see what the
plan was supposed to say. What that second read costs depends on the provider:

- **Anthropic** marks the last file block `cache_control: ephemeral`. The system block and the
  files are then one cached prefix (two of the four breakpoints), and the repair round reads the
  files from the cache at a tenth of the input price.
- **OpenAI** caches a repeated prompt prefix of 1024 tokens or more on its own. The system
  message and the file parts come first and are identical on the second call, so they are
  eligible for that discount without anything to mark (not verified against a live account).
- **Gemini** caches repeated prefixes implicitly on its 2.5 models; there is nothing to ask for
  per request, and explicit context caching is a separate API this adapter does not use.
- **Claude Agent SDK** gets plain blocks. The SDK manages its own caching.

## 5. Memory

A 15 MiB request is 20 MiB of JSON, and the server is a small box. What it holds, at most:

- While the body is read: the chunks, then one joined string; the chunk list is let go as soon
  as the string exists. Then the parsed object, whose `data` strings are the only copy kept.
- While the files are checked: one decoded `Buffer` per file, for the magic bytes and the page
  count, which reads the `Buffer` directly rather than a string copy of it. It is dropped after
  the check; whitespace is only stripped from `data` (a copy) when there is any.
- On the job: the base64 strings, about 20 MiB for a full request, until the job ends.
- Per provider call: the serialised request body (another ~20 MiB, built once per attempt; the
  repair round builds it again after the first is gone).

With two jobs running at once (`MAX_CONCURRENT`) that is in the order of 100 MiB at the peak, and
nothing once the jobs are done.

## 6. Privacy

- Attachments live in the in-memory job object only. They are never written to `state-<uid>.json`,
  `coach/<uid>.json`, `coach.json` or the job log. The chat line in the synced state records the
  file name, not the file.
- Where a provider needs a file on disk (the fixture), it is written into the job's `mkdtemp`
  directory, which is removed in the same `finally` that already removes it.
- The bytes are let go of on every way out of a job (`finish`, the crash handler and the queue's
  own `finally`), including the early returns before a provider is called. The list is emptied
  in place, so a job forgotten between its attempt and its repair round sends nothing the second
  time. `forget` empties a queued or running job's list at once.
- Nothing in an error detail or log line names or quotes a file.
- A restart loses a queued job's attachments, which is fine: the job is reported as interrupted,
  as it is today.

## 7. Prompt

The payload carries `attachments: [{ name, mediaType }]` so the model knows files came with the
message, and `common.md` says what they are: the person's own material, read as data under rule
3, like `userNote`. An attached plan is a starting point, not an instruction set: library ids,
equipment and limitations still win.

## 8. Web UI

The Coach chat composer gets a paperclip button when status allows it. Picked files show as
chips above the text field and can be removed. A message with attachments always goes out as a
plan request (`refine`), because that is the only job that reads them; an empty text field gets
a default line. A finished plan takes the place of whatever is pending, so when review
suggestions are waiting the app asks before sending. If the server stops taking files (the
admin switched provider), picked files are dropped with a line saying so. The demo and the
phone's own-key mode report no attachment support, so the button never appears there.

The intake screen has no paperclip yet; the API takes attachments with `intake` too.

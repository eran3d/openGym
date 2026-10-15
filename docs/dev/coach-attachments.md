# Coach attachments: a PDF or a photo of a plan, read by the Coach itself

People arrive with a plan they already have: a PDF from a trainer, a screenshot of a
spreadsheet, a photo of a sheet on the gym wall. Today the only way to hand that to the Coach is
to retype it into a chat message capped at `maxMessageLen`. This note describes letting the
person attach the file to a plan request, and having the provider's model read it directly.

It is a design note for one change, not a description of something already built.

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
| Bytes per file | 3 MiB | admin, 0.1 to 3.5 MiB |
| Bytes per request | 3.5 MiB | admin, up to 3.5 MiB |
| Files per request | 3 | admin, 0 to 5 (0 switches the feature off) |

The 3.5 MiB ceiling is not taste: base64 adds a third, and `MAX_BODY` (and nginx's
`client_max_body_size`) is 5 MiB for every API route. 3.5 MiB of file is 4.7 MiB on the wire,
which leaves room for the rest of the request. Raising it means raising both of those, which is
a separate decision.

The declared `mediaType` must match the file's first bytes (`%PDF-`, the JPEG SOI marker, the
PNG signature). A file that claims to be a PDF and is not is refused with the same class as a
wrong type; nothing downstream has to wonder what it is holding.

A job with attachments is one job: it counts once against `perProfileDaily` and
`instanceDaily`, like any other. The provider bills it for more input, which is what the admin's
per-file and per-request limits are for.

A refusal is a 400 (413 for size) with `code: "attachments"` and a `reason` the client can
translate: `unsupported`, `count`, `type`, `size`, `total`, `malformed`.

## 3. What the client is told

`GET /api/coach/status` gains:

```json
"attachments": { "types": ["application/pdf", "image/jpeg", "image/png"], "maxCount": 3, "maxBytes": 3145728, "maxTotalBytes": 3670016 }
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

## 5. Privacy

- Attachments live in the in-memory job object only. They are never written to `state-<uid>.json`,
  `coach/<uid>.json`, `coach.json` or the job log. The chat line in the synced state records the
  file name, not the file.
- Where a provider needs a file on disk (the fixture), it is written into the job's `mkdtemp`
  directory, which is removed in the same `finally` that already removes it.
- The job drops its reference to the bytes when it finishes, and `forget` drops a queued job's
  bytes with the job.
- Nothing in an error detail or log line names or quotes a file.
- A restart loses a queued job's attachments, which is fine: the job is reported as interrupted,
  as it is today.

The repair round sends the attachments again. A model asked to fix its plan has to be able to
see what the plan was supposed to say.

## 6. Prompt

The payload carries `attachments: [{ name, mediaType }]` so the model knows files came with the
message, and `common.md` says what they are: the person's own material, read as data under rule
3, like `userNote`. An attached plan is a starting point, not an instruction set: library ids,
equipment and limitations still win.

## 7. Web UI

The Coach chat composer gets a paperclip button when status allows it. Picked files show as
chips above the text field and can be removed. A message with attachments always goes out as a
plan request (`refine`), because that is the only job that reads them; an empty text field gets
a default line. The demo and the phone's own-key mode report no attachment support, so the
button never appears there.

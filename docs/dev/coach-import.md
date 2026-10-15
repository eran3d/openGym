# Coach import: a program document, copied faithfully into a folder

People arrive with programs they did not write: a PDF from a coach, a published 12-week block, a
photo of a sheet. Attaching one to a plan request (docs/dev/coach-attachments.md) gives the
Coach's answer to "make me a plan from this": a plan for *this person*, fitted to their days,
equipment and limits, and scheduled into their week. That is the right answer to that question
and the wrong one to "put this program in my app as it is". A six-session program comes back as
three sessions, the rep scheme drifts toward the profile's goal, and the week is replaced.

This note describes a second job kind, `import`: read the document, copy every session of it as
written into a routine, file the routines in one folder named after the program, and schedule
nothing. The person picks a session from the folder when they train.

## 1. What the API takes

The same route as a plan, with a mode:

```json
POST /api/coach/plan
{
  "mode": "import",
  "note": "Only the first block, the deload week is separate.",
  "lang": "en",
  "attachments": [
    { "name": "program.pdf", "mediaType": "application/pdf", "data": "<base64>" }
  ]
}
```

- `mode: "import"` queues a job of kind `import`. Any other value, or none, is the plan request
  it always was (`intake`/`refine`); `intake` and `refine` are ignored in import mode.
- `note` is optional free text from the person, cut to `maxMessageLen` like a review's note. It
  rides as `userNote`: what the program is called, which part of a document to take.
- `attachments` exactly as for a plan: same types, limits, magic-byte check, refusal reasons and
  memory rules. An import needs a document or a note; with neither it is refused before the cap
  is spent (`400`, `code: "attachments"`, `reason: "missing"`).

### Why a mode on `/plan` and not a route of its own

| Option | For | Against |
| --- | --- | --- |
| `POST /api/coach/import` | The kind is in the URL, like `/review` and `/debrief`. | It carries the same 20 MiB of files, so it needs its own `PLAN_BODY_LIMIT` in the server, its own exact-match `location` with `client_max_body_size 21m` in `web/nginx.conf.template`, and every operator's reverse proxy needs the same room on a second path. An instance that misses one answers `413` for an import and not for a plan, with the same file. |
| **`POST /api/coach/plan` with `mode: "import"`** (chosen) | The large-body path stays one path: server, nginx and any proxy in front are unchanged. The attachment check, consent, caps and single-flight are the route's own code. | The kind is in the body. The job and the proposal still say `kind: "import"`, so nothing downstream reads the mode. |

The job kind is its own (`import`, not `create` with a flag) because three things differ by kind
and are already dispatched on it: the prompt (`taskOf`), the validator and the answer schema.

## 2. The job

| | `create` | `import` |
| --- | --- | --- |
| Payload | profile, plan, history, library slice (160, their equipment), conversation | `meta`, library slice, `userNote`, `attachments`. No profile, no plan, no history, no conversation, no declined list. |
| Library slice | 160, filtered to the profile's equipment | 300, unfiltered (`IMPORT_LIBRARY`), exercises the person already trains first, then their own exercises |
| Prompt | `common.md` + `create.md` | `common.md` + `import.md` |
| Validator | `validatePlan` (week, days per week, at most 7 routines) | `validateImport` (no week, at most 14 routines) |
| Schema | `CREATE_SCHEMA` | `IMPORT_SCHEMA` |
| Proposal | `kind: "create"`, `bundle` with `week` | `kind: "import"`, `bundle` without `week` |

The profile stays out on purpose: an import that could see "3 days, dumbbells only" is an import
that gets "helpfully" adapted. Equipment is not checked against the profile either, for the same
reason. Everything else a job does is the same: consent checked at enqueue and again before the
call, the daily caps, one job at a time per profile, the repair round, the attachments dropped on
every way out.

A message sent while an import proposal waits does not refine it: the document is not kept, so
there is nothing to re-read. Sending another import replaces the proposal, like a fresh plan does.

## 3. What the model answers

```json
{
  "coach_contract": 1,
  "opengym_import": 1,
  "programName": "Example Upper/Lower 4x",
  "description": "Four sessions a week over eight weeks ...",
  "routines": [
    {
      "id": "r1",
      "name": "Upper #1",
      "emoji": "barbell",
      "prog": "double",
      "description": "Heavy upper day ... Weeks 1-3 build, week 4 deloads ...",
      "ex": [
        {
          "id": "<library id>", "sets": 3, "mode": "reps", "reps": 8, "repsMin": 6,
          "restSec": 180, "warmupSets": 2, "lastToFailure": false, "sg": "a",
          "note": "RPE 8. Pause 1 s on the chest. Week 1 values; see the routine description."
        }
      ]
    }
  ],
  "customEx": [{ "id": "cx1", "n": "Exercise the library lacks", "bp": "back", "desc": "How to do it" }]
}
```

`validateImport` (api/coach/core/validate.js) turns that into the proposal's `bundle`:

| Field | Rule |
| --- | --- |
| `programName` → `bundle.name` | Required, cut to 60. |
| `description` → `bundle.summary` | Cut to 1200, like a plan's summary. |
| `routines` | 1 to 14 (`MAX_IMPORT_ROUTINES`); an id used twice is an error. No `week`. |
| `routines[].name` | Required, cut to 40. |
| `routines[].description` → `routines[].note` | Cut to 1000 (`ROUTINE_NOTE_MAX`). |
| `routines[].prog` | One of the app's policies, or absent. |
| `routines[].ex` | 1 to 20 each; each id from the library or this answer's `customEx`; once per routine. |
| `ex.sets` | 1 to 10. |
| `ex.mode` | `reps` (`reps` 1 to 100, `repsMin` the floor of a range), `time` (`sec`), `cardio` (`min`, `speed`). |
| `ex.restSec` | 5 to 900 seconds, else dropped. |
| `ex.warmupSets` | 1 to 5, else dropped. |
| `ex.lastToFailure` | `true` or dropped (not on cardio). |
| `ex.note` | Cut to 500, the app's own limit for an exercise note. |
| `ex.weight` | Always dropped: an import has no history to start from, and a percentage of a 1RM is not a weight. The percentage goes in the note. |
| `ex.prog`, `inc`, `repsMax`, `setsMax`, `side`, `bodyweight`, `sg` | As for a created plan. |
| `customEx` | As for a created plan, plus: one whose name is a catalogue name (case and spacing aside) becomes that catalogue exercise. |

What the app has no field for (a target RPE or RIR, a percentage of 1RM, tempo, a substitution)
goes in the exercise's `note`, which the workout screen shows under the exercise. A program that
changes week by week (waves, a percentage per week) is imported at its **week 1** values; how the
weeks move is written in the routine's description.

## 4. Applying it (`applyImport`, frontend/src/lib/coach.js)

```js
applyImport(s, proposal) → { routines: <count>, folder: <folder id or null>, logId }
```

Pure over a draft state, like `applyCreatedPlan`, and in this order:

1. `validateProposal(proposal)` (routines present, each with exercises).
2. `pushSnapshot(s, proposal.id, 'Before the Coach’s import')`.
3. `mergePlan(s, bundle, { schedule: false })` with `folders: [{ id, name: bundle.name }]` and
   every routine's `folder` set to it. So exactly what importing a plan file does:
   - custom exercises reuse one with the same name and body part, else are added (`custom: true`);
   - the folder is matched by name (case and spacing aside), else added with `addFolder`; at 50
     folders (`FOLDER_MAX`) no folder is added and the routines land outside any folder;
   - routines are added with fresh ids, nothing existing is touched;
   - `week` and `dayPlan` are not written.
4. One log entry: `{ kind: 'import', at, proposalId, summary, routines, folder, bundle: lightBundle(bundle) }`.

The `why` texts are stripped as for a created plan; the exercise `note`s and the routine `note`
stay, because they are the program. `revertLast` undoes it like a created plan: the routines go,
the folder stays (empty) because folders are not in the snapshot (ROUTINE_FOLDERS.md section 4).

### The routine's `note`

Routines had no free-text field. This adds one, `routines[].note`: a string, at most 1000
characters, absent when empty. It is an ordinary field of a routine entry, so it merges per field
(`_f.note`) on both sides of the sync like `name` does, and older clients that keep unknown fields
keep it. Plan files carry it (`buildPlanBundle`, `mergePlan`). The routine editor shows it under
the name as an editable text field; the Coach payload leaves it out, like folders.

### For a client that ports it

`applyImport` takes only the draft and the proposal and reads the clock (`Date.now`) and the id
generator (`uid`, `Math.random`) like every other apply step, so a vector generator can fix both
(the `coach` runner in OpenGym-Swift's `parity/generate.mjs` already does) and add
`{ op: 'import', proposal }` to its steps.

## 5. Web UI

- With files picked, the composer shows a choice above them: **Plan for me** (the existing plan
  request, the default) or **Import to library**. The menu has **Import a program**, which opens
  the file picker with import already chosen. Both appear only where attachments do.
- The proposal card for an import shows the program name, its description, a tab per routine
  with the routine's description and each exercise with its prescription and note, and
  **Save to library** / **Discard**. No week strip and no schedule switch.
- Saved, the chat line says how many routines went into which folder, and that nothing was
  scheduled. The history sheet lists it as a program.

## 6. Without an AI account

The fixture provider answers an import with two routines from the library slice, one custom
exercise, rest, warm-ups, notes and descriptions, and echoes the attached files' names and sizes
in the description, so the whole loop can be walked (and tested end to end) without a provider.

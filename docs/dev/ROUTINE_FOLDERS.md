# Routine folders: group routines in Plan

Design note for **routine folders**, the way the Strong app groups its templates: a folder per
program ("PPL", "Deload week", "Hotel gym"), each one collapsible, routines moved in and out of
them. Nothing about a workout, the schedule or the loop changes: a folder is only how the Routines
list in Plan is grouped.

## 1. Model

Two optional pieces of state, no migration:

```js
S.routineFolders = [{ id, name, _ts, _f? }]   // the folders, in the order Plan shows them
S.routines[i].folder = '<folder id>'         // the folder a routine is in; absent = none
```

- **A folder is an entry with an id**, like a gym card: `{ id, name }` plus the stamps every entry
  carries (`_ts`, per-field `_f`, see `lib/sync-merge.js`). The array's order is the folders'
  order on screen.
- **A routine says which folder it is in** with a `folder` field holding the folder's id. No
  `folder`, an empty one, or the id of a folder that is not in `routineFolders` (deleted, or not
  yet synced): the routine is not in a folder, and Plan shows it with the others that are not. A
  routine is never hidden or lost because of its folder.
- **The order inside a folder is the order of `S.routines`**: a folder shows its routines in the
  order the whole list has them. Reordering inside a folder moves the routine in `S.routines`
  (stamped `edited.routineOrder`, as today), so every other screen (Start, the day sheets, the
  routine pickers) keeps one order.
- **Names**: trimmed, at most 40 characters (`FOLDER_NAME_MAX`), held to that when shown too,
  whoever wrote them. Two folders may share a name; only the id tells them apart, and the app does
  not stop it (a plan file's folder is matched by name, so importing never makes a second one).
- **At most 50 folders** (`FOLDER_MAX`): New folder is off past it, and a plan file's extra folders
  leave their routines in none.
- **Which folders are collapsed** is a per-device view choice, like the Schedule/Routines toggle:
  it lives in this browser's storage (`gym_plan_folders_closed`), never in `S`.

Old copies have neither field. Readers treat that as "no folders": the Routines list looks exactly
as it did.

### Why not a map, or a folder holding its routine ids

| Option | Problem |
| --- | --- |
| `routineFolders: { id: { name, routineIds } }` (one entry holds membership) | Moving a routine is an edit of two folders; two devices moving different routines into the same folder edit the same field (`routineIds`) and one move is lost. A routine in two lists after a merge needs a tie-break. |
| A PER_KEY map `routineFolders: { id: name }` stamped in `edited` | Works for rename/add, but a delete is a key removal stamped in `edited`, and the folders have an order of their own that a map does not keep. It also makes folders a setting, while every other user-made list with ids (routines, gym cards, profiles) is an entry list with `deleted` tombstones. |
| **`folder` on the routine + an entry list of folders** (chosen) | Membership is one field of one routine, so it merges per field like a routine's name or sets already do. The folder list reuses the entry machinery as it stands: union by id, per-field merge, `deleted` tombstones, order stamp. |

## 2. Merge rules (client `lib/sync-merge.js`, server `api/sync-stamps.js`)

All of this is the existing machinery with one more list plugged in. Exact names, for a client
that ports it:

| What | Rule | Stamp |
| --- | --- | --- |
| `routines[].folder` | An ordinary field of a routine: `mergeEntry` takes it from the side whose `_f.folder` is later; on a tie, from the version edited last (`_ts`). | `routines[].\_f.folder` (stampEntry, on any change of the field, removal included) |
| `routineFolders` (membership) | Union by `id`, in the newer copy's order; a folder only the older copy has goes in after its nearest earlier neighbour there (`unionByNeighbours`, as routines). | `routineFolders[].\_ts` |
| `routineFolders[].name` (and any other field) | Per field, `mergeEntry`, as routines. | `routineFolders[].\_f.name` |
| Folder order | The order of the copy whose `edited.routineFolderOrder` is later; the newer copy's without a stamp. Same code path as `edited.routineOrder`. | `edited.routineFolderOrder` (stampEdits, when the folders both lists hold moved relative to each other) |
| Deleting a folder | Recorded in `deleted.routineFolders[<id>] = at`; a folder edited before `at` is dropped by every merge (`applyDeletions`), one edited after it (a rename made later on another device) stays. | `deleted.routineFolders` |
| Reset | A reset names every folder in `resetIds.routineFolders`; a copy that has not seen the reset loses those. Without ids: folders with `_ts` after the reset stay. | `resetIds.routineFolders` |
| Sign-in (`prefer`) | The preferred side's folders as they are, like its routines. | none |

`routineFolders` and `routineFolderOrder` are in `OWN_MERGE` on both sides, so neither is ever
stamped as a whole setting in `edited.routineFolders`.

Deleting a folder in the app does two things in one change: removes the folder from
`routineFolders` (tombstone) and clears `folder` on every routine this device has in it (each
stamped `_f.folder`). The second part is tidiness, not correctness: the rule "an unknown folder id
reads as no folder" is what keeps the routines visible on every device, whatever arrives first.

### Conflicts, worked through

1. **Rename on the web, routine moved into the same folder on the iPhone.** Different entries:
   the rename is `routineFolders[F]._f.name`, the move is `routines[R]._f.folder`. Both survive.
2. **Two devices rename the same folder.** Same field: the later `_f.name` wins on both.
3. **Folder deleted on one device, a routine moved into it on another.** The deletion
   tombstones F and clears `folder` on the routines the deleting device knew. The other device's
   move stamps `routines[R]._f.folder = F` at its time. After the merge:
   - F is gone (tombstone later than F's last edit), so R's `folder: F` points at nothing and R
     shows as "not in a folder". **R is never lost.**
   - If the move came after the deletion, `R.folder` stays `F` in the data (a dangling id).
     Readers ignore it; the next move or a folder delete on any device clears it.
4. **Folder deleted on one device, renamed later on another.** The rename (`_ts` after the
   tombstone) keeps the folder, as an edit after a removal keeps any entry. The routines the
   deleting device took out stay out (their `_f.folder` clear is later than their move into F),
   so the folder comes back empty. Rare, and nothing is lost.
5. **A routine moved into different folders on two devices.** Same field: the later move wins.
6. **Folders reordered on two devices.** The later `edited.routineFolderOrder` wins; a folder only
   the other copy has goes next to its neighbour there.
7. **Routine deleted on one device, moved into a folder on another.** Unchanged rule for
   routines: the move is an edit; an edit after the removal keeps the routine (in its folder), one
   before it loses.

## 3. Older writers

Two kinds of older writer meet these fields, and the server handles them differently.

- **Apps from before folders that stamp their own changes** (v1.4.x web and Android, which send
  `stamped: true`). The server's step 0 (`keepUnknown`) does not run for them, and their own merge
  after a 409 gets folders wrong:
  - it keeps `folder` on a routine (its `mergeEntry` handles any field), so moves survive;
  - it takes `routineFolders` whole from whichever copy is newer, so a rename or a new folder made
    on an updated device is set back when the older app's copy is newer;
  - its `mergeDeletions` and `mergeResetIds` know no `routineFolders` key, so it drops the
    tombstones and the reset's names. Its push of a folder deleted elsewhere then looked to
    `keepHeld` like a deliberate re-add, and the folder came back for good.

  So on **every** PUT (not a reset) the server merges the folder list with the stored one itself
  (`stampPut` step 2b, `mergeStoredFolders`): union by id, in the writer's order, or the stored
  order when the writer's `edited.routineFolderOrder` (as sent) is older than the stored one; a
  folder only one side has goes next to its neighbour there; a folder both have merges field by
  field (`mergeEntry`, the app's rule without Undo markers, checked against it by
  `sync-stamps-parity.test.js`). The removals on record (`deleted`, already joined with the stored
  ones in step 1) are applied after that, before `keepHeld`. For the same reset (equal `resetAt`)
  the stored `resetIds` are joined back in, every field (`keepResetIds`). When this changes what
  the writer sent, the revision moves one further (`report.changed`), so the older app reads the
  result.

  Why the server and not a capability flag in the PUT: a flag says what a writer knows, but the
  older app's push is already the outcome of its own merge; there is nothing left to keep from it.
  Doing the app's merge again on the server is idempotent for an updated app (it sent the merge of
  the same two copies, so nothing changes), costs nothing per push, and needs no client change.
- **v1.3.9 and API clients** (no stamps of their own, no `stamped: true`). Step 0 (`keepUnknown`)
  puts back a `routineFolders` list or a routine's `folder` such a writer left out (neither is in
  `V139_DROPS`). The server then stamps what it changed against the stored copy
  (`stampUnstamped`): `routineFolders` is in `ENTRY_LISTS` (per field `_f`), in `DEL_LISTS` (a
  folder it removed is tombstoned), and a reorder of the folders stamps
  `edited.routineFolderOrder` (an older copy's order of folders reordered since is put back).
  Step 2b runs after it as for every writer.
- **Other clients of the sync API** that keep fields they do not know and write them back keep
  both fields as they are; step 2b covers their 409 merge as it covers v1.4.x.

## 4. Everything else that reads routines

| Reader | What it does with folders |
| --- | --- |
| Plan → Routines | Groups by folder (section 5). |
| Start, day sheets, routine pickers, the loop | Unchanged, the flat list. Folders are Plan's grouping only. |
| Backup export/import | The whole state, so both fields travel. `stampRestore`/`stampReplace` stamp folders like routines. |
| Plan file (share) | Carries `folders: [{ id, name }]` for the folders its routines use, and `folder` on each routine. Import matches a folder by name (case and spacing ignored) or makes a new one; an older importer ignores both. |
| Coach | Left out of the plan payload on purpose: the Coach reasons about exercises, sets and the week, and a folder changes none of that. Leaving it out also keeps the plan fingerprint (`canonicalPlan`/`hashPlan`, mirrored in `api/coach`) the same, so no proposal goes stale because a routine was filed. A routine the Coach creates lands outside any folder; a revert restores routines with the `folder` they had. Folders are not in the Coach's snapshot, so a revert never adds or removes one: a folder whose routines the revert took away (a created plan filed into a folder, then undone) stays, empty, until it is deleted. |
| MCP `list_routines` | Each routine gains `folder` (the folder's name, or null), so an LLM client sees the grouping the user sees. |

## 5. UI (Plan → Routines)

- No folders: exactly the list of today, plus a **New folder** button beside **New routine**.
- With folders: the routines not in a folder first, as a plain list; then one section per folder:
  a header with the folder's name and count, tapped to collapse or open it, and a **⋯** button
  for **Rename** and **Delete folder**. An empty folder says so.
- **Delete folder** asks first and says the routines stay: they move out of the folder.
- **Edit** mode shows every folder open (a routine in a closed folder could not be moved or
  deleted otherwise) and: reorder by handle within each group (unfiled, or one folder), a folder button on
  each routine opens **Move to folder** (Not in a folder, each folder, New folder…), and each
  folder header gets up/down arrows to reorder the folders.
- Phones and desktop share the layout; the sections are the existing `.list` blocks.

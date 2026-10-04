# 3. Receive-side storage ladder

Date: 2025

## Status

Accepted

## Context

Received bytes have to land somewhere. The previous implementation chose between
a user-chosen directory via the File System Access API, an in-memory buffer
capped at 1.2 GB, and StreamSaver.

None of those work on a phone, which is the most important device class here:

- File System Access is Chromium desktop only.
- A 1.2 GB in-memory cap exceeds any mobile browser's per-tab heap budget by a
  wide margin, so receiving a large file on a phone meant the tab was killed.
- StreamSaver needs a service worker served at the origin root. This project's
  worker was an empty stub, so the import resolved and the download silently
  produced nothing on arrival.

## Decision

Try in order:

1. **A user-chosen directory** — File System Access. Preferred, because the user
   can find the file afterwards.
2. **OPFS** (`navigator.storage.getDirectory`) — the origin private file system.
   Available in Safari 17+ and Chrome on Android, so this is the only strategy
   that streams an arbitrarily large file to disk on a phone without the user
   picking a directory first.
3. **A blob**, capped at 256 MB, with the limit reported rather than discovered
   by crashing.

If none can handle the size, return a sink that fails loudly on first write so
the user is told to choose a folder, instead of dying at some arbitrary later
point.

## Consequences

- Large transfers no longer need to be resident in memory.
- The blob ceiling is far lower than before, which is the honest number for a
  phone. Anything above it requires OPFS or a chosen directory, and the UI says
  so.
- OPFS files need an explicit step to move them somewhere the user can see, or
  the app downloads them itself, which the UI handles.
- Object URLs must be revoked explicitly. Every strategy is responsible for its
  own, since forgetting leaks the whole file until the document unloads.

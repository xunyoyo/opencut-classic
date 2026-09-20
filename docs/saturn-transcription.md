# Saturn Transcription

> **Status: not live.** Everything below the front-end half exists; the
> AI-Saturn side does not. No deployment can answer these calls yet, so
> `NEXT_PUBLIC_TRANSCRIPTION_REMOTE_ENABLED` stays `false` until the two
> endpoints under [Backend Contract](#backend-contract) ship.

Captions can be generated two ways. **Local** runs Whisper in a worker through
Transformers.js — no server, no cost, but the first run pulls a few hundred
megabytes of weights and then occupies a core for the length of the audio.
**Remote** hands the audio to AI-Saturn, which bills the user's 土豆 balance
and returns the segments.

Remote is off unless `NEXT_PUBLIC_TRANSCRIPTION_REMOTE_ENABLED` is `true`.
Without it the engine selector is not rendered at all and the local path is
the only one, which is the upstream behaviour.

## How It Works

### Engine choice

`src/transcription/engines.ts` holds the `TranscriptionEngine` union and
decides the default. Remote wins when it is available: configuring an endpoint
is the deliberate act, and the reason to do it is to stop every user
downloading Whisper.

### The request path

`src/subtitles/components/assets-view.tsx` branches on the engine. Both start
from `extractTimelineAudio`, which returns a 16 kHz wav. The local path then
decodes that to Float32 samples; **the remote path does not**, because the
server wants a file and decoding is the slowest main-thread step in the
pipeline.

`src/services/transcription/remote.ts` submits and polls.
`src/app/api/transcribe/route.ts` proxies both halves — the browser cannot
reach AI-Saturn directly, which ships no CORS configuration.

### Authentication

Requests carry the user's own RuoYi token, so 土豆 are charged to whoever is
signed in. That token arrives as a query parameter on `/saturn-import` and is
stashed by `src/saturn/session.ts` in `sessionStorage`, because transcription
happens later, from the editor, when the import URL is long gone.

sessionStorage rather than localStorage, and deliberately outside the persisted
zustand stores: it is a credential and should not outlive the tab.

**A session opened directly at `/editor/:id` has no token and cannot use the
remote engine.** This is intended — OpenCut does not hold or refresh anyone's
AI-Saturn session.

## Backend Contract

None of this exists in `ai-saturn-backend` yet. It follows the convention that
`AnalysisController` already uses for expensive AI work, so the shape below
should look familiar rather than novel.

Note there is no ASR capability in the backend today, so an engine has to be
chosen and wired up as well — this is not only a controller.

### Submit

```
POST {SATURN_API_BASE}{SATURN_TRANSCRIBE_PATH}
Authorization: <the caller's token>
Content-Type: multipart/form-data
  file:     a wav, 16 kHz mono
  language: a two-letter code, or "auto" to detect

200 {"code":200,"msg":"","data":<longReqLogId>,"points":30}
```

Returning immediately matters: transcribing several minutes of audio will
outlive any sensible gateway timeout.

Insufficient balance should `throw new ServiceException("土豆不足，请充值")`
exactly as the other endpoints do. The message is shown to the user verbatim,
so saying what is missing and what it costs is worth the words.

Sketch, matching `analysisRoleByAi`:

```java
Integer points = aiAbilityService.calculatePoints(/* new type */, ...);
if (!pointsService.isEnough(userId, points)) {
    throw new ServiceException("土豆不足，请充值");
}
String bizRequestId = "transcribeAsync_" + projectId + "_" + IdUtils.simpleUUID();
pointsService.freezePoints(userId, points, "视频转字幕", bizRequestId, projectId + "", projectId);
Long id = longReqLogService.add();
aiService.transcribeAsync(file, language, userId, points, bizRequestId, id);
```

### Poll

`SATURN_TRANSCRIBE_POLL_PATH` defaults to the existing
`/project/analysis/reqResultPoll`, which reads a `LongReqLog` row by id and is
already generic. Nothing new is needed here.

```
GET {SATURN_API_BASE}{SATURN_TRANSCRIBE_POLL_PATH}?id=<longReqLogId>

200 {"code":200,"data":{"status":1,"result":"<a serialised AjaxResult>"}}
```

`status` of `1` means the job **stopped**, not that it succeeded — the same row
is written that way on both paths:

```java
longReqLogService.update(id, 1, JSON.toJSONString(AjaxResult.success(vo)));
longReqLogService.update(id, 1, JSON.toJSONString(AjaxResult.error("转录失败：...")));
```

So `result` is parsed a second time and its own `code` is what decides. The
proxy absorbs both layers; `remote.ts` only ever sees `{done, segments}` or
`{done, error}`.

On success the inner `data` is:

```json
{
  "language": "zh",
  "text": "完整文本",
  "segments": [{ "text": "这一句", "start": 0.0, "end": 1.8 }]
}
```

Segment times are seconds from the start of the audio.

## Balance

`src/app/api/saturn/points/route.ts` proxies `GET /points/getPoints` and the
panel shows `availablePoints` while the remote engine is selected, refreshing
after each run.

**It is displayed, never enforced.** Checking a balance client-side before
submitting would be a race — the backend already freezes points precisely
because concurrent jobs can spend the same balance — and a front-end guard
would only offer false confidence. `fetchSaturnPoints` returns `null` on
failure rather than throwing, so a balance that will not load never blocks a
transcription.

Polling gives up after 20 minutes without cancelling anything upstream.
`PointsCompensationJob.handleTimeoutFreeze()` releases frozen 土豆 for jobs
that never land, and that is the right place for it.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_TRANSCRIPTION_REMOTE_ENABLED` | `false` | Offer the remote engine at all |
| `SATURN_TRANSCRIBE_PATH` | `/project/media/transcribe` | Submit endpoint |
| `SATURN_TRANSCRIBE_POLL_PATH` | `/project/analysis/reqResultPoll` | Poll endpoint |
| `SATURN_API_BASE` | `http://localhost:8080` | Shared with the other AI-Saturn routes |

The first is inlined at build time, so changing it needs a rebuild rather than
a restart.

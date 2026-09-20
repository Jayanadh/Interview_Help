# Interview_Help

A real-time interview copilot. It listens to both sides of a conversation,
notices when you've been asked something, and streams a suggested answer
grounded in your actual resume onto an always-on-top panel. It can also read
a coding problem straight off your screen and write the solution in whatever
language you ask for.

Works on **macOS and Windows**. No database, no accounts, no server to run.

```
 ┌─ system audio (interviewer) ─┐
 │                              ├─→ 24kHz PCM16 ─→ STT ─→ trigger ─→ LLM ─→ overlay
 └─ microphone  (you) ──────────┘      worklet      ws     engine    stream

   Solve screen button ─→ one screenshot ─→ vision model ─→ code ─→ overlay
```

**Scope.** This is built for interview *preparation* — rehearsal, mock
interviews, reviewing how you answered afterwards — and for note-taking on
calls where everyone knows it's running. It deliberately does not hide itself
from screen sharing or attempt to evade proctoring software.

---

## Table of contents

- [Quick start](#quick-start)
- [Choosing your API keys](#choosing-your-api-keys)
- [First-run permissions](#first-run-permissions)
- [Using it](#using-it)
- [Solving what's on your screen](#solving-whats-on-your-screen)
- [What it costs](#what-it-costs)
- [Tuning](#tuning)
- [Building a standalone app](#building-a-standalone-app)
- [Troubleshooting](#troubleshooting)
- [Tests](#tests)
- [How it fits together](#how-it-fits-together)

---

## Quick start

Five minutes, start to finish.

### 1. Install Node.js 18 or newer

Check what you have:

```bash
node --version
```

If that errors or shows below v18, install it from
[nodejs.org](https://nodejs.org) (take the LTS build).

### 2. Get an API key

Go to **[console.groq.com/keys](https://console.groq.com/keys)**, sign in,
and create a key. It starts with `gsk_`. Groq has a free tier, and it is both
the cheapest and the fastest option here.

(Other providers work too — see [Choosing your API keys](#choosing-your-api-keys).)

### 3. Get the code

```bash
git clone https://github.com/Jayanadh/Interview_Help.git
cd Interview_Help
npm install
```

`npm install` downloads Electron, which is around 270 MB, so give it a
minute or two.

### 4. Add your key

**macOS / Linux:**
```bash
cp .env.example .env
```

**Windows (PowerShell):**
```powershell
Copy-Item .env.example .env
```

Open `.env` in any text editor and put your key after the `=`:

```
GROQ_API_KEY=gsk_your_key_here
```

Save it. Nothing else in that file needs changing.

### 5. Run it

```bash
npm start
```

**On macOS**, the first launch asks for Screen Recording and Microphone
access. Grant both, then **quit and reopen the app** — macOS does not apply a
fresh screen-recording grant to a process that is already running, so nothing
works until you restart. If you miss the popup, see
[First-run permissions](#first-run-permissions); macOS only offers it once.

**On Windows** there is nothing to grant.

### 6. Set up your session

In the window that opens:

1. **Choose file…** and pick your resume — PDF, TXT, or Markdown.
2. Type the **role** and **company** you're interviewing for.
3. Optionally paste the **job description** (this makes answers noticeably
   sharper, and on Claude it also makes them cheaper).
4. Press **Start listening**.

A dark overlay panel appears. It floats above everything and is draggable by
its header.

### 7. Check it's actually working

The banner at the top of the overlay should be green and read
**"Listening — Groq Whisper + Groq LLM"**.

Now test it without needing a real interviewer. Open
[text-to-speech.online](https://text-to-speech.online/en/) in a browser, type
*"Tell me about a time you solved a hard problem"*, and play it. Within about
a second the overlay should stream an answer built from your resume.

If the banner is red, or stays green but nothing ever appears, go to
[Troubleshooting](#troubleshooting).

### 8. Try the screen solver

Open any coding problem — a LeetCode page, a shared editor, a PDF — and press:

| | |
|---|---|
| macOS | `⌘` + `Shift` + `Enter` |
| Windows | `Ctrl` + `Shift` + `Enter` |

or click **Solve screen** in the overlay toolbar.

It screenshots your display, reads the problem, and writes a full solution.
Change the language in the **Code in** box first if you don't want Python —
type `cpp`, `golang`, `rust`, anything; it matches to the nearest of 236
languages and shows you what it settled on.

---

## Choosing your API keys

The app reads whatever keys you provide and routes automatically. You never
pick a provider or a model in the UI.

**Ears and brain are chosen separately:**

| | picked from, in order |
|---|---|
| **Answers** (brain) | Anthropic → Groq → OpenAI |
| **Transcription** (ears) | Deepgram → Groq → OpenAI |

So four setups make sense:

| Setup | Keys | Why |
|---|---|---|
| **Groq only** | `GROQ_API_KEY` | Cheapest and fastest. ~170ms to first token. Start here. |
| **Groq + Anthropic** | both | Best value. Groq's Whisper for ears, Claude for answers. |
| **Deepgram + Anthropic** | both | Best quality, most expensive. |
| **OpenAI only** | `OPENAI_API_KEY` | One key, if that's what you have. |

### Where to get each key

| Key | Where | Starts with |
|---|---|---|
| `GROQ_API_KEY` | [console.groq.com/keys](https://console.groq.com/keys) | `gsk_` |
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) → Settings → API keys | `sk-ant-api` |
| `OPENAI_API_KEY` | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | `sk-` |
| `DEEPGRAM_API_KEY` | [console.deepgram.com](https://console.deepgram.com) | 32-char hex |

> **Claude needs a second key, but it does *not* have to be Deepgram.**
> Anthropic doesn't offer streaming speech-to-text, so Claude can't hear the
> interview on its own. A Groq key costs pennies and does the job.

> **A Claude Pro / Max / Claude Code login token will not work.**
> Those start `sk-ant-oat…` and authenticate as a bearer token tied to the
> Claude Code client, so every request here would return 401. You need a real
> API key from the console, starting `sk-ant-api`. The app detects the wrong
> kind and tells you, rather than failing mid-interview.

You can also paste a key into the setup window instead of editing `.env`; it's
stored in the app's own settings file on your machine and never sent anywhere
except to that provider.

---

## First-run permissions

### macOS

macOS gates system-audio capture behind **Screen Recording** — that's how the
OS exposes other apps' audio. The screen solver uses the same permission.

1. Launch the app. It asks for Screen Recording and Microphone.
2. Allow both.
3. **Quit and reopen.** macOS does not apply a fresh grant to a running
   process, so nothing works until you restart.

**If you clicked "Don't Allow" the first time**, macOS will never ask again.
The popup is one-shot. Turn it on manually:

> System Settings → Privacy & Security → Screen Recording → switch it on,
> then restart the app.

The row to look for is **Electron** when running `npm start`, and
**Help Interview** when running a built app. They're separate entries; that
catches people out.

The app detects this state and stops offering a "Grant permission" button
that cannot work, showing the manual steps instead.

### Windows

Nothing to grant. Loopback audio needs no permission, screen capture needs no
permission, and the microphone prompt appears on first use. The permission
banner never shows.

---

## Using it

| Shortcut | Does |
|---|---|
| `⌘/Ctrl` + `Shift` + `Space` | Answer right now, ignoring the heuristics |
| `⌘/Ctrl` + `Shift` + `Enter` | **Read the screen and write the code** |
| `⌘/Ctrl` + `Shift` + `H` | Hide / show the overlay |
| `⌘/Ctrl` + `Shift` + `X` | Clear the panel |
| `⌘/Ctrl` + `Shift` + `B` | Toggle full answer ⟷ brief bullets |
| `⌘/Ctrl` + `Shift` + `↑` / `↓` | Text bigger / smaller |

The overlay is draggable by its header. It answers on its own when the
interviewer goes quiet for ~600ms after saying something that parses as a
question; the manual trigger is for when the heuristics miss.

Short backchannel noises — "right", "okay", "mhm" — are deliberately ignored,
as is anything under five words.

The header shows time-to-first-token for every answer. Expect **600–1200ms**
on Groq.

---

## Solving what's on your screen

The overlay's toolbar has a **Solve screen** button and a language box.

Pressing it takes **one screenshot** of the display your pointer is on, reads
whatever coding problem is there, and streams back a restatement, the
approach, a complete solution, and its complexity.

- The overlay **hides itself** for the fraction of a second the frame is
  taken, so the model reads the interview and not its own previous answer.
- Nothing is captured until you press the button. The continuous screen
  recording the audio pipeline needs has its video track dropped the moment
  it starts; this takes a single frame on demand.
- Code blocks render with real indentation, a language tag, and a copy button.

### The language box

Type anything. It matches to the nearest of **236 languages** and rewrites
itself to show what it's actually going to ask for:

| You type | It sends |
|---|---|
| `pyhton` | Python |
| `cpp`, `modern c++` | C++ |
| `golang` | Go |
| `rst` | Rust |
| `ja` | Java |
| `k8s` | Kubernetes YAML |
| `write it in rust` | Rust |
| something it's never heard of | that, verbatim |

A name it doesn't recognise is passed through untouched rather than silently
corrected to something near it. Your choice persists across restarts.

> **Screenshots are token-heavy — about 2,400 input tokens each.**
> Groq's free tier allows 7,000 input tokens per minute, so that's roughly
> **two screen reads a minute** before you hit a 429. The overlay tells you
> how long to wait. Spoken answers are far cheaper and unaffected.

---

## What it costs

Per 45-minute interview, roughly:

| | Groq | OpenAI | Groq + Claude | Deepgram + Claude |
|---|---|---|---|---|
| Transcription | ~$0.04 | ~$0.55 | ~$0.04 | ~$0.70 |
| Answers (~30) | ~$0.05 | ~$0.15 | ~$0.50 | ~$0.50 |
| **Total** | **~$0.09** | **~$0.70** | **~$0.54** | **~$1.20** |

Groq is roughly an order of magnitude cheaper *and* the fastest, which is an
unusual place to land. Groq's ears with Claude's brain is the quality/price
sweet spot: you pay for the good model and almost nothing for transcription.

Pasting the job description into setup is worth doing. It pushes your context
past Claude's 1024-token prompt-cache minimum, after which every answer reads
a cached prefix instead of re-uploading it — faster *and* cheaper.

---

## Tuning

Everything optional lives in `.env`:

```bash
SILENCE_MS=600        # pause before answering. Lower = snappier, more false fires
SPEECH_RMS=450        # voice-detection threshold (Groq path). Raise in a noisy room
ANSWER_MODE=default   # "fast" | "default" | "deep"
ANSWER_STYLE=full     # "full" prose, or "brief" headline + bullets
CODE_LANGUAGE=Python  # starting language for the screen solver
MAX_CODE_TOKENS=2200  # ceiling on a code answer
```

On Claude, `ANSWER_MODE=fast` uses Haiku instead of Opus — quicker and cheaper.

---

## Building a standalone app

```bash
npm run build      # macOS  → dist/mac-arm64/
npm run build:win  # Windows → dist/win-unpacked/
```

### macOS: do this first, or permissions will keep disappearing

```bash
npm run cert        # create a self-signed code-signing identity
npm run cert:trust  # mark it trusted
```

Without a trusted certificate, electron-builder falls back to **ad-hoc**
signing, where the app's identity is a hash of its own bytes. Every rebuild
then looks like a brand-new app to macOS, and **every permission you granted
is forgotten.** With the certificate, identity is tied to the cert and
permissions survive rebuilds.

Verify it worked:

```bash
security find-identity -v -p codesigning   # should list "Help Interview Self Signed"
codesign -dv "dist/mac-arm64/Help Interview.app" 2>&1 | grep Identifier
#   want: Identifier=com.jayanadh.helpinterview
#   not:  Identifier=Electron   ← ad-hoc, permissions will not stick
```

Windows needs none of this.

---

## Troubleshooting

### "Listening" but the transcript stays empty

Two failure modes produce a *valid* audio track carrying *pure silence*, with
no error anywhere. Run the diagnostic:

```bash
npm run spike
```

Click *Start capture* and play any audio. If the bar doesn't move:

| Cause | Fix |
|---|---|
| Missing `NSAudioCaptureUsageDescription` (macOS 14.2+) | `npm run postinstall`, then restart |
| Screen Recording not granted | System Settings → Privacy & Security → Screen Recording |
| Granted while the app was running | Quit and relaunch — required |
| Wrong loopback backend | Set `AUDIO_BACKEND=coreaudio` in `.env` and restart |

### "Grant permission" does nothing

macOS only offers the popup once. After a refusal it can never appear again,
so the button genuinely cannot work — use the System Settings toggle and
restart. The app detects this and hides the button.

### Permissions vanish every time I rebuild

Your build is ad-hoc signed. Run `npm run cert && npm run cert:trust`, then
rebuild. See [Building a standalone app](#building-a-standalone-app).

### "rate limit reached"

Groq's free tier allows 7,000 input tokens/min and a screenshot costs ~2,400.
Wait the number of seconds the overlay names, or upgrade the tier.

### Screen solve without granting Screen Recording

For development, stand a PNG in for the display:

```bash
SCREEN_FIXTURE=scripts/selftest/captured.png npm start
```

---

## Tests

No interview, no screen grant, and no microphone required:

```bash
npm run test:ui         # drives the real overlay with canned answers, writes screenshots
npm run test:vision     # renders a fake coding problem, captures it, solves it for real
npm run test:audio      # `say` stands in for the interviewer, end to end through the LLM
npm run test:routing    # every combination of keys, and what each one should do
npm run test:anthropic  # proves the Claude request shape is valid without a Claude key
npm run test:perms      # the permission banner in all four states
npm run test:windows    # checks nothing macOS-only sits on the Windows path
```

`test:vision` and `test:audio` spend real API calls; the rest are free.
`test:ui` writes screenshots to `scripts/selftest/shots/`.

Two more, run directly:

```bash
npx electron scripts/selftest/live.js     # real screen grab of the real screen, then solves it
npx electron scripts/selftest/capture.js  # the grab alone, incl. the no-permission message
```

`live.js` is the one worth knowing about. It puts a magenta window on top of a
coding problem, then scans the captured pixels for that colour — which is how
you *prove* the overlay is excluded from its own screenshot, rather than
squinting at a PNG and hoping.

---

## How it fits together

| File | Role |
|---|---|
| `src/main/config.js` | Provider routing. Decides who transcribes and who answers. |
| `src/main/stt.js` | Transcription. Websocket for Deepgram/OpenAI; local voice-detection + batched Whisper for Groq. |
| `src/main/trigger.js` | **When** to answer. Silence timing + question detection. |
| `src/main/assist.js` | Streams the answer, and the screen→code vision path. Prompt caching lives here. |
| `src/main/context.js` | Resume + setup answers → the frozen, cached prompt prefix. |
| `src/main/screen.js` | One-shot screen grab. Hides the overlay, downscales, returns a PNG. |
| `src/shared/languages.js` | The 236-language list and the fuzzy matcher behind the language box. |
| `src/renderer/overlay.js` | Capture pipeline + the panel you actually read. |

Three design notes worth keeping if you extend this:

- **Separate STT connections per speaker**, rather than one connection with
  diarization. Speaker attribution becomes structurally exact instead of
  probabilistic, at identical cost.
- **API keys never leave the main process.** The renderer gets a narrow IPC
  surface and nothing else. That's the same trust boundary a hosted
  multi-user gateway would enforce — so if this ever grows into one, the
  client code doesn't change.
- **The screen grab is on demand, not a live track.** The video track from the
  audio pipeline is stopped immediately; reviving it for the occasional
  screenshot would mean a continuous screen recording running all interview.

---

## Requirements

- Node.js 18+
- macOS 13+ (Apple Silicon or Intel) or Windows 10+
- One API key

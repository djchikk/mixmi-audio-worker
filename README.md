# mixmi Audio Worker

FFmpeg-based audio enhancement service for mixmi. Runs on Fly.io.

## Endpoints

### GET /health
Health check endpoint.

### POST /enhance
Enhance audio with FFmpeg processing.

**Request:**
```json
{
  "sourceUrl": "https://example.com/audio.wav",
  "enhancementType": "auto"
}
```

**Enhancement Types:**
| Type | Description |
|------|-------------|
| `auto` | Balanced enhancement (highpass + compression + loudnorm) |
| `voice` | Optimized for vocals/speech |
| `clean` | Minimal processing (highpass + loudnorm only) |
| `warm` | Adds low-end richness |
| `studio` | Full mastering treatment |

**Response:** Returns enhanced WAV file as binary data.

### POST /transcode-video
Transcode video (webm from MediaRecorder, or anything FFmpeg reads) to iPhone-safe MP4: H.264 main profile, yuv420p, CFR 30fps, capped at 1280px wide, AAC 192k, faststart.

**Request:**
```json
{
  "sourceUrl": "https://…/recording.webm",
  "uploadUrl": "https://…signed-supabase-upload-url…"
}
```

The worker stays stateless: the caller (Vercel `/api/video/transcode`) creates a Supabase signed upload URL and the worker PUTs the mp4 there. No storage credentials on the worker.

**Guards:** 200MB input cap, 10 minute duration cap, 8 minute FFmpeg kill timer.

**Response:**
```json
{
  "success": true,
  "jobId": "…",
  "inputSize": 5067885,
  "outputSize": 6588843,
  "durationSec": 17.9,
  "hasAudio": true
}
```

## Deployment to Fly.io

1. Install Fly CLI: https://fly.io/docs/hands-on/install-flyctl/

2. Login:
```bash
fly auth login
```

3. Launch (first time):
```bash
fly launch
```

4. Deploy:
```bash
fly deploy
```

## Local Development

```bash
npm install
npm run dev
```

Server runs at http://localhost:3001

## Architecture

```
mixmi Frontend
     ↓
Vercel API (/api/enhance/process)
     ↓
Fly.io Worker (this service)
     ↓
FFmpeg processing
     ↓
Returns enhanced WAV → Vercel uploads to Supabase
```

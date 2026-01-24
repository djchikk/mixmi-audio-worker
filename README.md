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

# Just Us 💌

A private, end-to-end encrypted chat app for exactly two people. It runs on your own server and costs $0 to run.

```
 Phone A (Expo)                 Your relay (Node)                Phone B (Expo)
 ┌──────────────┐  wss + TLS   ┌──────────────────┐  wss + TLS   ┌──────────────┐
 │ libsodium    │─────────────▶│ ciphertext only  │─────────────▶│ libsodium    │
 │ SQLCipher DB │◀─────────────│ SQLite + blobs   │◀─────────────│ SQLCipher DB │
 └──────────────┘              └──────────────────┘              └──────────────┘
        └─────────── keys exchanged by QR, in person, never via server ──────────┘
```

| Path | What |
| --- | --- |
| `packages/protocol` | Shared zod schemas and the E2EE helpers (`seal`/`open`/`sealBlob`/`safetyNumber`) |
| `server` | Fastify + WebSocket + SQLite relay. Runs as plain `node src/main.ts` with no build step |
| `mobile` | Expo SDK 57 app (development build; Expo Go can't load libsodium or SQLCipher) |
| `deploy` | docker-compose with Caddy for automatic HTTPS |

## Features

- Text, photos, voice notes, typing indicator, delivered and read ticks, online status
- Content-free push notifications: the payload is always just "New message"
- Biometric or PIN app lock, re-locking after 30 s in the background
- Screenshot blocking on Android, a blank cover in the app switcher, and a hidden screen in iOS screen recordings
- Photos are re-encoded before sending, which strips EXIF data including GPS location
- The local history is encrypted with SQLCipher. Its key lives in the Keychain/Keystore, and app data is excluded from backups

## Security model

| | |
| --- | --- |
| **Message crypto** | `crypto_box` (X25519 + XSalsa20-Poly1305), one key pair per phone. Attachments are encrypted with `crypto_secretbox` under a fresh random key, and that key travels inside the boxed message |
| **Key exchange** | Both phones scan each other's QR codes in person. Then compare the **safety number** shown on both screens. If the numbers match, nobody swapped a code |
| **Server auth** | Ed25519 challenge-response. No passwords. Enrollment needs `REGISTRATION_SECRET`, and registration closes once 2 devices exist |
| **Anti-replay** | The message id is sealed inside the ciphertext and must match the envelope id. Clients drop duplicates by id |
| **Server sees** | Two device ids, when messages are sent, and their approximate sizes. It never sees content, names (they're sealed), or photos |
| **Server retention** | A ciphertext is deleted when the recipient acks it, and an attachment when the recipient has downloaded it. Anything left undelivered is purged after `RETENTION_DAYS` |

**Known trade-offs (on purpose, to keep this simple):**

- **No forward secrecy.** If someone steals a phone's secret key later, they can decrypt ciphertext they recorded earlier. Upgrading to the Double Ratchet (Signal protocol) fixes this, but adds about 3x the complexity.
- **One device per person.** A new or lost phone means you re-pair.
- **Media is stored decrypted** in the app's sandbox, protected by the OS sandbox and the app lock. Text is in the SQLCipher database.
- **Push goes through Expo → FCM/APNs.** They learn only that "a push happened". Set `PUSH_ENABLED=false` to remove them completely, at the cost of no background alerts.

## 1. Run the server ($0)

**Recommended: Oracle Cloud "Always Free" VM + DuckDNS + Caddy.** It's free forever, runs 24/7, and you get root on the box. Oracle asks for a card only to verify you.

1. Create an Always Free Ampere (ARM) Ubuntu VM. Open ports 80 and 443 in the VCN security list **and** in the VM's firewall (`iptables`/`ufw`).
2. Get a free subdomain at [duckdns.org](https://www.duckdns.org) (e.g. `ourchat.duckdns.org`) and point it at the VM's public IP.
3. On the VM:
   ```bash
   sudo apt install -y docker.io docker-compose-v2 git
   git clone <this repo> && cd Agent-break
   cp deploy/.env.example deploy/.env
   # set DOMAIN=ourchat.duckdns.org and REGISTRATION_SECRET=$(openssl rand -base64 32)
   sudo docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
   curl https://ourchat.duckdns.org/health   # → {"ok":true}
   ```

**Alternative: a home PC or Raspberry Pi + [Tailscale](https://tailscale.com) (free).** The server is never exposed to the internet: run `node src/main.ts` and use `tailscale serve` to get HTTPS on `*.ts.net`. The catch is that both phones must keep the Tailscale VPN on.

**Admin commands** (on the server; `docker compose exec relay` prefix when using Docker):

```bash
npm run cli -- list-devices
npm run cli -- remove-device <id>   # lost phone → frees the slot so a new phone can enroll
npm run cli -- stats
```

**Server env vars:** `REGISTRATION_SECRET` (required, ≥24 chars), `PORT` (8080), `DATA_DIR` (`./data`), `MAX_DEVICES` (2), `RETENTION_DAYS` (30), `SESSION_TTL_HOURS` (24), `TRUST_PROXY`, `PUSH_ENABLED` (true), `LOG_LEVEL`.

## 2. Build the app

```bash
npm install                      # from repo root (npm workspaces)
cd mobile
npx eas-cli@latest login         # free Expo account
npx eas-cli@latest init          # writes extra.eas.projectId (needed for push)
npx eas-cli@latest build -p android --profile preview   # → installable APK, free
```

Change `com.example.justus` in `mobile/app.json` to your own identifier first.

- **Android:** free. Install the APK on both phones (allow "install unknown apps").
- **iOS:** sideloading with a free Apple ID expires every **7 days**. To get a lasting install and iOS push notifications you need the Apple Developer Program ($99/yr), then `eas build -p ios --profile preview` with ad-hoc distribution. There's no free way around this. Apple controls it.
- **Local dev:** `npx expo run:android` (or `run:ios` on a Mac) builds a dev client, then use `npx expo start`.

## 3. Pair

1. **Phone A:** "I set up the server" → server URL, registration secret, name.
2. **Phone B:** "Join my partner" → name → scan A's QR code. The code carries the server URL and secret, so B enrolls itself.
3. **Phone A:** "Scan partner's code" → scan B's QR code.
4. **Both:** check that the safety numbers match → "Start chatting".

## Development

```bash
npm test               # server + protocol integration tests (vitest)
npm run typecheck      # protocol, server, mobile
cd mobile && npx expo-doctor
```

The tests start a real relay and drive it over HTTP and WebSocket with libsodium clients. They cover enrollment limits, signature auth, nonce single-use, live and offline delivery, ack → delivered, ephemeral and silent frames, idempotent resends, blob round-trip and retention purge, path traversal, and crypto tamper and id-swap rejection.

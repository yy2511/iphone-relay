# iPhone Screenshot Inbox Relay

This relay receives an image from an Apple Shortcut, sends it to an
OpenAI-compatible vision endpoint such as Zeta, and returns note-ready text.
The provider API key stays on the relay instead of being embedded in the
Shortcut.

## Local Safety Test

Start the relay in mock mode. It accepts screenshots only from this Mac and
does not make a third-party API call:

```sh
MOCK_ANALYSIS=true ALLOW_INSECURE_LOCAL=true npm start
```

In Shortcuts, send a screenshot as a file to:

```text
http://127.0.0.1:8787/capture
```

Use `Content-Type: image/png` for an unconverted screenshot, or
`Content-Type: image/jpeg` after adding a Convert Image action.

## Real Zeta Configuration

Create `.env.local` from `.env.example`, then fill in:

```text
CAPTURE_TOKEN=<random token used only between the phone and this relay>
PROVIDER_API_KEY=<Zeta API key>
PROVIDER_MODEL=<Zeta model that supports image analysis>
```

Zeta documents its multimodal OpenAI-compatible endpoint as:

```text
https://api.zetatechs.com/v1/chat/completions
```

Start the server:

```sh
npm start
```

For a Shortcut calling a deployed relay, set:

```text
URL: https://your-relay.example.com/capture
Method: POST
Header: Content-Type = image/jpeg
Header: X-Capture-Token = <CAPTURE_TOKEN>
Request Body: File = <converted screenshot>
```

Do not put `PROVIDER_API_KEY` in the Shortcut.

## Endpoint

`POST /capture` accepts a JPEG, PNG, or WEBP request body and returns:

```json
{
  "title": "searchable title",
  "summary": "description",
  "ocr": "important visible text",
  "tags": ["tag"],
  "next_action": "optional action",
  "sensitive": false,
  "sensitive_reason": "",
  "note": "ready-to-save plain text"
}
```

`GET /health` reports whether provider mode or mock mode is active.

## Manage the Server

```sh
npm run relay          # start background relay (logs to .relay.log)
npm run relay:stop     # stop it
npm run relay:status   # check if running
```

## iPhone LAN Access

When iPhone is on the same WiFi/LAN as this Mac:

1. Set up `.env.local` and start the relay.
2. Find your Mac's LAN IP:
   ```sh
   ifconfig en0 | grep "inet "   # typical WiFi interface
   ```
3. In iPhone Shortcuts, point `POST` to `http://<MAC_LAN_IP>:8787/capture` instead of `127.0.0.1`.
4. Include `X-Capture-Token` header with your `CAPTURE_TOKEN`.

For access from a different network (mobile data, remote), use a tunnel such as Cloudflare Tunnel, Ngrok, or deploy on a VPS.

## Tests

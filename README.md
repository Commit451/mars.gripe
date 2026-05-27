# mars.gripe

Cast public x.com (Twitter) broadcasts - live or a replay - to a Chromecast device.

## Run

```bash
docker compose up -d --build
```

The app listens on port 8000.

## Deploy

The Cast SDK requires the receiver be served over HTTPS, so production needs a reverse proxy with TLS (Caddy, nginx, Traefik, etc.) in front of the container.

You'll also need your own custom Cast Receiver:

1. Register one at [cast.google.com/publish](https://cast.google.com/publish/) ($5 one-time fee), pointing at `https://<your-domain>/receiver.html`.
2. Replace `RECEIVER_APP_ID` in `app/static/app.js` with the resulting app ID.
3. For unpublished receivers, register each Chromecast's serial in the Cast Developer Console and reboot the device.

## License

mars.gripe is available under the MIT license. See the LICENSE file for more info.

\ ゜o゜)ノ

# Supreme Community desktop

The Electron shell packages the local Node service and React client. It uses
application ID `com.meetsupreme.community`, port 4757 and a separate Chromium
profile under `~/.supreme-community/desktop-profile`.

From the repository root:

```sh
npm ci
npm --prefix web ci
npm --prefix desktop ci
npm run build
npm --prefix desktop run dev
```

For a local unsigned Apple silicon bundle:

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false npm --prefix desktop run pack
```

Output: `desktop/dist/mac-arm64/Supreme Community.app`. Signing/notarization
credentials are not included. The official signed 0.1.119 installer is linked
in the root README and remains a separate artifact.

The renderer is sandboxed with Node integration disabled. A context-isolated
preload exposes the desktop operations. Model tools invoked by the backend
still execute with local user permissions; this is not VM isolation.

Community builds do not claim the official `supreme://` or `conductor://`
URL handlers and leave automatic updates disabled. Forks that implement their
own distribution must configure their own URL schemes and update feed.

The community app registers `supreme-community://` for conversation links.
New Slack and email replies use that scheme so **Open in Supreme** opens the
original community app even when Apex Supreme is also installed. The desktop
parser can still read legacy `supreme://` links passed directly to it.

`stage:auth` writes only non-secret account configuration to ignored
`desktop/.generated/.env.local`. It never stages Slack client credentials,
service-role keys, signing keys or model credentials. With no account settings,
the packaged app runs locally without sign-in.

Desktop readiness checks use a temporary home and separate Electron profile:

```sh
npm --prefix desktop run smoke
npm --prefix desktop run smoke:packaged
```

They verify service and renderer readiness with no connected models. They do
not verify real provider sign-in or optional cloud services.

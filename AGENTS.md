# Supreme Community

This public repository is based on Supreme 0.1.119. Preserve that provenance.
Later Agents, rebake and Apex work belong to separate private repositories.
Do not copy private Git history, production configuration or internal notes here.

Use Node 24 or 26. Install locked root, web and desktop dependencies with npm ci.
Build with npm run build. Before publishing, run npm test, npm run test:local
and npm run check:publication, and scan the export with Gitleaks.

Keep tests offline with synthetic model CLIs and isolated temporary data.
Never test against a user's installed app, live local workspace, customer inbox
or connected service. Do not introduce automatic releases to the official
supreme-releases feed. Community builds use port 4757 and separate data by default.

Use plain language and no em dashes in newly authored documentation.

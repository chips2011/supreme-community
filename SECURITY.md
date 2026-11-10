# Security

This community release is based on Supreme 0.1.119. Security fixes will be
reviewed on the default branch; the original installer is a separate artifact.

Please report vulnerabilities with GitHub's **Report a vulnerability** feature
under this repository's Security tab. Include reproduction steps and affected
versions. Do not include live credentials or customer data. Do not publish an
exploit in a public issue while a private report is under review.

The backend is a local, single-user service bound to 127.0.0.1. Do not expose it
to the public internet. Model tools and connected services run with the user's
permissions. Project isolation and separate conversations are not a VM sandbox.

Keep `.env.local`, local data, provider sessions, screenshots, transcripts,
signing material and integration tokens out of commits. Desktop bundles stage
only explicitly allowed public account configuration. Service-role keys and
Slack client secrets belong outside distributed applications.

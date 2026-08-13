# Hocuspocus 3 compatibility fixture

This fixture was generated before the v4 migration by running the repository at
commit `de741faac3d945c6f101f800ec26af81ecc001bb` with the installed
`@hocuspocus/server`, `@hocuspocus/extension-sqlite`, and
`@hocuspocus/provider` version `3.4.4`.

The real v3 server started with an empty data directory. The existing
`tests/e2e-client.mjs` then initialized the public one-time setup flow and wrote
the deterministic document name `legacy-v3-workspace` through a real
Hocuspocus provider. The resulting `db.sqlite`, `auth.json`, and client state
were copied without modification into this directory.

The token is test data only. It has never protected a real server.

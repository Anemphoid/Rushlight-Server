# Releasing the server

Installs update to the newest git tag that looks like `vX.Y.Z`. Nothing on
`main` reaches an install until it is tagged, so you can iterate freely.

1. Make sure CI is green on `main` (`npm test` and `npm run test:update` locally
   if you like).
2. Tag it and push the tag:

       git tag v0.2.0
       git push origin v0.2.0

3. On each install, `./update.sh` picks it up (or the optional daily timer does,
   see `install-auto-update.sh`).

Versions only need to sort correctly (`v0.2.0` before `v0.10.0`). To put an
install back on an older release: `./update.sh --tag v0.1.0`.

If a release has a bug, tag a fixed one (`v0.2.1`). Installs on auto-update
move to it the next night; others run `./update.sh`.

## What an update does to an install

Stops the service, copies the database to `backups/` (the newest 10 are kept),
checks out the tag, runs `npm ci`, starts the service and waits for
`/api/health`. If anything fails, it restores the database copy and the previous
code and starts the old version again. Database migrations run automatically
when the new version starts.

A migration that has already run is not reversed by a code rollback, which is
why migrations are written to be additive, and why the database copy is restored
as well.

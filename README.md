# nuzayets/pi-web

A personal build of [PI WEB](https://github.com/jmfederico/pi-web). The `local` branch carries a few changes as commits on the latest upstream release tag. Every six hours the workflow on this branch rebases them onto the newest upstream tag, typechecks with [tsrs](https://github.com/oxc-project/tsrs), builds, and publishes `pi-web.tgz` as release `<upstream tag>-local.<commit>`.

Install a release with `bun add -g https://github.com/nuzayets/pi-web/releases/download/<tag>/pi-web.tgz`. A rebase conflict fails the workflow; rebase `local` by hand and run the workflow again.

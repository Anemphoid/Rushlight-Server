# Moving an existing install onto git updates

For an install that was set up from a zip, with a `.env` and a database already
in its folder. Your `.env` and database are never part of the repository, so
nothing here touches them. Do this once. Run as root on the server machine.
Replace `/opt/rushlight-server` with wherever your install lives.

    cd /opt
    systemctl stop rushlight-server
    mv rushlight-server rushlight-server.old          # keep it until the end
    git clone <your-repo-url> rushlight-server
    cd rushlight-server
    git checkout "$(git tag --list 'v[0-9]*' --sort=-v:refname | head -n 1)"

    # bring your private files across
    cp ../rushlight-server.old/.env .
    cp ../rushlight-server.old/rushlight.db* .        # skip if DB_PATH points elsewhere

    npm ci --omit=dev
    bash install-service.sh                           # rewrites the unit for this folder and starts it
    curl http://127.0.0.1:4000/api/health             # {"ok":true}

If anything looks wrong, `systemctl stop rushlight-server`, move the folders back
and `bash install-service.sh` from the old one. Once you're happy, delete
`rushlight-server.old`.

From then on, to update:

    cd /opt/rushlight-server
    ./update.sh --check      # is there a newer release?
    ./update.sh              # install it (backs up first, rolls back on failure)

Optionally, update automatically each night:

    bash install-auto-update.sh

To turn that off again: `bash install-auto-update.sh --remove`.

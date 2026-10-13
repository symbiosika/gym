# Security Policy

## Reporting a vulnerability

Please do not report security issues in a public issue, discussion or pull
request.

Report them privately, either through GitHub
([Report a vulnerability](https://github.com/symbiosika/gym/security/advisories/new)
in the Security tab) or by mail to **info@symbiosika.de** with "Security" in
the subject.

Include what you found, where (file, route, version or commit) and how to
reproduce it. We confirm receipt within a few working days, keep you informed
while we work on a fix and credit you in the advisory unless you prefer not to
be named.

## Supported versions

Fixes go into `develop` and are released from `main`. Older builds receive no
backports; run the latest image.

## Scope

This repository: the GYM app (`backend/`, `frontend/`) and the data critics
(`critics/`). Issues in the
[symbiosika-framework](https://github.com/symbiosika/symbiosika-framework)
belong to that repository, but a report here reaches the same people.

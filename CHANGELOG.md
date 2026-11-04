# Changelog

GYM has one version for backend, frontend and critics
(`scripts/version.sh`). Every pull request into `develop` that changes the app
raises it, and its merge is tagged `v<version>`:

- minor (0.7.0 → 0.8.0) for a feature,
- patch (0.7.0 → 0.7.1) for a fix or a change to the documentation only,
- major once GYM is 1.0 and something breaks the API or cannot be migrated back.

The versions before 0.8.0 were given afterwards, one per merged pull request.

## 0.8.0

Robots.

- A Robots tab between Analysis and Settings: every robot with its photo,
  technical and personal name, the cell it is in, its status (in service,
  maintenance, retired) and the components that need a look.
- The robot opens in a modal: profile, platform reference (manufacturer,
  model, serial number, product version) and six capability sections
  (sensors, actuators, locomotion, compute, communication, system) as condensed
  lists. A component opens for editing on a click, is saved on the fly and
  confirmed on its row; it can be duplicated ("… copy 1").
- Component statuses ok, degraded, faulty, disconnected (light blue: there but
  not connected, e.g. on no ROS topic) and unknown.
- The history of a robot says what changed per section ("New actuator",
  "Updated sensors", "Deleted …"); a save that changes nothing leaves no entry.
- The robot field of a cell in the settings is a choice of robots, "Undefined
  robot" or "No robot yet". Every robot written as free text before became a
  robot of its own (migration 0011).
- Owners and admins maintain robots, every member reads them. MCP tools
  `list_robots` and `get_robot_audit`.
- One version for backend, frontend and critics (`scripts/version.sh`, checked
  in CI), shown small next to the GYM brand in the navbar and on
  `GET /app-info`. This changelog.

## 0.7.1 · 2026-10-21

- README: screenshots and a highlights section (#9).

## 0.7.0 · 2026-10-14

- Spec wizard workbench: questions to the model, written as "must hold" or
  "only counts"; a question reworded since the model answered counts as not
  tested; the rest under Details (#8).

## 0.6.0 · 2026-10-14

- Spec wizard: episodes picked like a print range ("0-9", "1-3,6,8"), tests
  of single episodes, the calculation of a verdict with its numbers (#7).

## 0.5.0 · 2026-10-14

- Spec wizard: how a verdict comes about, and the way to accept (#6).

## 0.4.0 · 2026-10-13

- Spec wizard: one live workbench for the whole sample, every flag of the
  sample with what it means and a switch for it, what holds the sample back
  and how to let it through (#5).

## 0.3.0 · 2026-10-13

- Spec wizard: work out a critics spec from a sample dataset (#4).

## 0.2.0 · 2026-10-13

- Large dataset uploads: the chunks stay in the storage as the parts of the
  dataset, the critics join them (#3).

## 0.1.0 · 2026-10-13

- First public release of GYM: the operator's block wizard, day protocols,
  skills, data critics, selections and exports, evaluation blocks and
  reports, key figures, audit log, MCP server (#1).

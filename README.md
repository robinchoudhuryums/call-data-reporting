# call-data-reporting

Source of truth for the call-data reporting stack:

- **Department Dashboard** — a Google Apps Script web app that serves
  per-department managers a polished view of their team's DQE call metrics.
  Replaces the legacy `DQE Report` spreadsheet.
- **Reference copies** of related Apps Script code from sibling projects
  (CDR Report, CDR Import) that the dashboard depends on. Pulled in
  gradually so changes across projects can be reviewed in one place.
- **Architecture docs** describing how data flows from the upstream CDR
  system through Raw Data, DQE Historical Data, and Neon Postgres, into
  the dashboard.

## Read first

If you're new to this codebase or chasing a bug, start with the docs:

- [`docs/architecture.md`](docs/architecture.md) — data flow across all
  the moving pieces. Look here first to figure out which layer a problem
  belongs to.
- [`docs/known-issues.md`](docs/known-issues.md) — institutional memory.
  Bugs we've fixed, quirks to respect, design rules to preserve. Read
  before changing anything in the source pipeline or the dashboard's
  data layer.
- [`docs/conventions.md`](docs/conventions.md) — naming, time windows,
  aggregation rules, scope semantics. The "why are TTT and ATT computed
  this way?" reference.

## Repository layout

```
call-data-reporting/
├── README.md                       ← this file
├── docs/                           ← architecture / known issues / conventions
├── apps-script/                    ← all Apps Script project sources
│   ├── department-dashboard/       ← the web app this repo deploys (clasp pushes from here)
│   └── cdr-report/                 ← reference copies from the CDR Report project
│       └── buildDQEHistoricalData.gs
├── .clasp.example.json             ← template; copy to .clasp.json on first checkout
├── .clasp.json                     ← per-developer, gitignored (scriptId varies per checkout)
├── .claspignore
└── .gitignore
```

This structure is mid-migration. The Department Dashboard's source has
been moved into `apps-script/department-dashboard/`; other projects (CDR
Import, the rest of CDR Report) aren't pulled in yet. See
`docs/architecture.md` for the planned end state.

## Deploying the Department Dashboard

The web app is deployed from the standalone "Department Dashboard" Apps
Script project (not container-bound to any spreadsheet). Source is pushed
via clasp from this repo.

**One-time setup (from Cloud Shell or any machine with Node):**

```bash
npm install -g @google/clasp
clasp login --no-localhost   # --no-localhost if you're in Cloud Shell

# Create your local .clasp.json from the template. It's gitignored so
# your scriptId stays per-checkout and doesn't conflict on pulls.
cp .clasp.example.json .clasp.json
# Edit .clasp.json -> set scriptId to your Apps Script project's ID
# (Project Settings -> IDs -> Script ID)
```

**Each push:**

```bash
git pull
clasp push -f
# Then in the Apps Script editor: Deploy -> Manage deployments
# -> pencil -> Version: New version -> Deploy
```

**One-time, in the Apps Script project:**

- Project Settings -> Script Properties -> add `SPREADSHEET_ID`
  pointing at the CDR Report spreadsheet's ID (from its URL).
- Run the `setup` function once to create the `Access Control` sheet.
- Add yourself as an admin email in `apps-script/department-dashboard/Config.gs` (`ADMIN_EMAILS`).
- Deploy as Web app: **Execute as: Me**, **Who has access: Anyone within
  [your domain]**.

## Applying fixes to sibling Apps Script projects

Files under `apps-script/<project>/` are reference copies of code that
lives in other Apps Script projects (CDR Report, etc.). To apply a fix:

1. Open the target Apps Script project (`script.google.com` -> open the
   relevant project).
2. Replace the corresponding file's contents with the version from this
   repo.
3. Verify and run the project's own test function (e.g., `testDQEBuild`).

Eventually these will be pushable directly via per-subfolder `.clasp.json`
files (Phase R3 in the planned reorg); for now they're paste-targets.

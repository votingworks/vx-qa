# VxSuite QA Automation Tool

Automates QA testing for VxSuite elections by orchestrating VxAdmin and VxScan apps with mock hardware.

## Features

- Clones and sets up VxSuite repository automatically
- Generates test ballots with various vote patterns (blank, overvote, valid votes)
- Automates VxAdmin for election configuration
- Automates VxScan for ballot scanning
- Captures screenshots at key steps
- Generates HTML reports for human review

## Installation

```bash
# Clone and install
cd vx-qa
pnpm install

# Install Playwright browsers
npx playwright install chromium
```

## Usage

```bash
# Create a sample config
pnpm start init -o my-config.json

# Edit the config file, then run
pnpm start run --config my-config.json
```

### CLI Options

```bash
pnpm start run [options]

Options:
  -c, --config <path>      Path to configuration file
  -s, --save-config <path> Save interactive selections to config file
  -o, --output <dir>       Override output directory
  -r, --ref <ref>          Override VxSuite tag/branch/rev
  -e, --election <path>    Override election source path
  --headless               Run browser in headless mode (default)
  --no-headless            Run browser in headed mode for debugging
```

## Configuration

Example `vx-qa-config.json`:

```json
{
  "vxsuite": {
    "repoPath": "~/.vx-qa/vxsuite",
    "ref": "v4.0.4"
  },
  "election": {
    "source": "./election.json"
  },
  "ballots": {
    "patterns": ["blank", "fully_filled", "partial", "overvote"]
  },
  "output": {
    "directory": "./qa-output"
  }
}
```

### Ballot Patterns

- `blank` - No votes (empty ballot)
- `fully_filled` - Maximum valid votes in each contest
- `partial` - Some contests voted, some left blank
- `overvote` - Too many votes in a candidate contest (should be rejected)

## Output

Each run creates a timestamped directory with:

```
qa-output/run-2024-01-15T10-30-00/
├── ballots/              # Generated ballot PDFs and PNGs
│   ├── ballot-style1-blank.pdf
│   ├── ballot-style1-fully_filled.pdf
│   └── ...
├── screenshots/          # UI screenshots at each step
│   ├── 001-admin-locked.png
│   ├── 002-admin-configured.png
│   └── ...
└── report.html           # Summary HTML report
```

## Requirements

- Node.js 20+
- pnpm 8+
- Git

## Development

```bash
# Build
pnpm build

# Run tests
pnpm test
```

## Architecture

```
src/
├── cli/                 # CLI and TUI
├── config/              # Configuration schema
├── repo/                # Git/repository management
├── apps/                # App orchestration
├── mock-hardware/       # Mock card, USB, scanner control
├── ballots/             # Ballot generation and marking
├── automation/          # Playwright browser automation
├── report/              # HTML report generation
└── utils/               # Logging, paths, processes
```

## License

GPL-3.0

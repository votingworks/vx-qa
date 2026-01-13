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
  "output": {
    "directory": "./qa-output"
  }
}
```

## Output

Each run creates a timestamped directory with an HTML report and the supporting files,
including various inputs, outputs, and screenshots.

## Troubleshooting

To see the browser as the workflows run, run with `--no-headless`. You may also consider running with the `DEBUG=1` environment variable.

## Requirements

- Node.js 20+
- pnpm 8+
- Git

If `pnpm install` returns a `ERR_PNPM_INVALID_WORKSPACE_CONFIGURATION` you may need to update your pnpm version. You can gloablly install the latest version of pnpm with `npm install -g pnpm@latest`

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

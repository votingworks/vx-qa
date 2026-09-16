import { afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateTallyResults } from './admin-tally-workflow.js';
import type { ArtifactCollection, StepOutput, WorkflowStep } from '../config/types.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeTallyCsv(rows: Array<[contestId: string, selectionId: string, votes: number]>) {
  const dir = await mkdtemp(join(tmpdir(), 'vx-qa-tally-'));
  tempDirs.push(dir);
  const path = join(dir, 'unofficial-full-election-tally-report.csv');
  await writeFile(
    path,
    [
      'unofficial-full-election-tally-report,Election ID: abc1234',
      'Contest,Contest ID,Selection,Selection ID,Total Votes',
      ...rows.map(([contestId, selectionId, votes]) =>
        [`Contest ${contestId}`, contestId, `Selection ${selectionId}`, selectionId, votes].join(
          ',',
        ),
      ),
    ].join('\n'),
  );
  return path;
}

function scanResult(votes: Record<string, string[]>): StepOutput {
  return {
    type: 'scan-result',
    label: 'Scan Result',
    accepted: true,
    expected: true,
    screenshotPath: 'screenshot.png',
    ballotStyleId: '1',
    ballotMode: 'official',
    markPattern: 'valid',
    votes,
  };
}

function collection(outputs: StepOutput[]): ArtifactCollection {
  const step: WorkflowStep = {
    id: 'step',
    name: 'Step',
    description: '',
    startTime: new Date(),
    inputs: [],
    outputs,
    screenshots: [],
    errors: [],
  };
  return {
    runId: 'run',
    startTime: new Date(),
    config: {
      vxsuite: { repoPath: '.', version: 'v4.1' },
      election: { source: 'election.zip' },
      output: { directory: '.' },
    },
    ballots: [],
    screenshots: [],
    errors: [],
    steps: [step],
  };
}

function report(path: string): StepOutput {
  return { type: 'report', label: 'Tally Report CSV', path };
}

describe('validateTallyResults', () => {
  test('passes when the CSV matches the scanned votes', async () => {
    const csv = await writeTallyCsv([
      ['mayor', 'alice', 1],
      ['mayor', 'bob', 0],
      ['mayor', 'write-in', 0],
      ['mayor', 'overvotes', 0],
      ['mayor', 'undervotes', 0],
      ['mayor', 'ballots-cast', 1],
    ]);
    const result = await validateTallyResults(
      collection([scanResult({ mayor: ['alice'] }), report(csv)]),
    );
    expect(result).toEqual({ isValid: true, message: expect.stringContaining('1 vote(s) match') });
  });

  test('flags a count that is short of the scanned votes', async () => {
    const csv = await writeTallyCsv([['mayor', 'alice', 0]]);
    const result = await validateTallyResults(
      collection([scanResult({ mayor: ['alice'] }), report(csv)]),
    );
    expect(result.isValid).toBe(false);
    expect(result.message).toContain('Contest mayor, Candidate alice: expected 1');
  });

  test('flags an unexpected vote even when the same selection ID is expected in another contest', async () => {
    const csv = await writeTallyCsv([
      ['mayor', 'write-in', 1],
      ['council', 'write-in', 1],
    ]);
    const result = await validateTallyResults(
      collection([scanResult({ mayor: ['write-in-0'] }), report(csv)]),
    );
    expect(result.isValid).toBe(false);
    expect(result.message).toContain('Unexpected votes in CSV for council/write-in: 1');
    expect(result.message).not.toContain('mayor/write-in');
  });

  test('reports a missing CSV', async () => {
    const result = await validateTallyResults(collection([scanResult({ mayor: ['alice'] })]));
    expect(result).toEqual({ isValid: false, message: 'No tally report CSV output found' });
  });
});

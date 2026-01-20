/**
 * App orchestration - starting and stopping VxSuite apps
 */

import { ChildProcess, execFile } from 'child_process';
import { createInterface } from 'readline';
import { logger } from '../utils/logger.js';
import { spawnBackground, killProcessTree, waitForPort, sleep } from '../utils/process.js';
import { getMockEnvironment, APP_PORTS, getBackendPort, type MachineType } from './env-config.js';
import { waitForDevDock } from '../mock-hardware/client.js';
import { promisify } from 'util';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Check if a port is free (not in use)
 */
async function isPortFree(port: number): Promise<boolean> {
  const execFileAsync = promisify(execFile);
  try {
    const { stdout } = await execFileAsync('lsof', [`-ti:${port}`]);
    return stdout.trim().length === 0;
  } catch {
    // If lsof errors (e.g., no process found), port is free
    return true;
  }
}

export interface AppOrchestrator {
  /**
   * Start a VxSuite app (admin or scan)
   */
  startApp(app: MachineType): Promise<void>;

  /**
   * Stop the currently running app
   */
  stopApp(): Promise<void>;

  /**
   * Check if an app is currently running
   */
  isRunning(): boolean;

  /**
   * Get the current app type
   */
  getCurrentApp(): MachineType | null;

  /**
   * Wait for the app to be fully ready
   */
  waitForReady(timeout?: number): Promise<boolean>;
}

interface OrchestratorState {
  process: ChildProcess | null;
  currentApp: MachineType | null;
  appLogPath: string | null;
  appOutput: string[];
}

/**
 * Create an app orchestrator for a VxSuite repository
 */
export function createAppOrchestrator(repoPath: string, logDir?: string): AppOrchestrator {
  const state: OrchestratorState = {
    process: null,
    currentApp: null,
    appLogPath: null,
    appOutput: [],
  };

  return {
    async startApp(app: MachineType): Promise<void> {
      if (state.process) {
        throw new Error(`App already running: ${state.currentApp}. Stop it first.`);
      }

      const spinner = logger.spinner(`Starting ${app} app...`);

      try {
        // Start the app using pnpm run-dev
        const env = getMockEnvironment();

        logger.debug(`Starting ${app} with mock environment`);

        // Set up app log file
        if (logDir) {
          state.appLogPath = join(logDir, `${app}-app.log`);
          state.appOutput = [];
        }

        state.process = spawnBackground('pnpm', ['-w', 'run-dev', app], {
          cwd: repoPath,
          env,
        });

        state.currentApp = app;

        // Log output for debugging and capture to file
        const { stdout, stderr } = state.process;
        if (stdout) {
          createInterface({ input: stdout, crlfDelay: Infinity }).on('line', (line) => {
            if (line) {
              const trimmedLine = line.trim();
              logger.debug(`[${app}] ${trimmedLine}`);

              // Write to app log file
              if (state.appLogPath) {
                const timestamp = new Date().toISOString();
                const logLine = `[${timestamp}] [stdout] ${trimmedLine}\n`;
                try {
                  appendFileSync(state.appLogPath, logLine, 'utf-8');
                } catch {
                  // Ignore write errors
                }
              }

              // Store recent output for error reporting (keep last 100 lines)
              state.appOutput.push(`[stdout] ${trimmedLine}`);
              if (state.appOutput.length > 100) {
                state.appOutput.shift();
              }
            }
          });
        }

        if (stderr) {
          createInterface({ input: stderr, crlfDelay: Infinity }).on('line', (line) => {
            if (line) {
              const trimmedLine = line.trim();
              logger.debug(`[${app}:err] ${trimmedLine}`);

              // Write to app log file
              if (state.appLogPath) {
                const timestamp = new Date().toISOString();
                const logLine = `[${timestamp}] [stderr] ${trimmedLine}\n`;
                try {
                  appendFileSync(state.appLogPath, logLine, 'utf-8');
                } catch {
                  // Ignore write errors
                }
              }

              // Store recent output for error reporting (keep last 100 lines)
              state.appOutput.push(`[stderr] ${trimmedLine}`);
              if (state.appOutput.length > 100) {
                state.appOutput.shift();
              }
            }
          });
        }

        state.process.on('exit', (code) => {
          logger.debug(`${app} process exited with code ${code}`);
          state.process = null;
          state.currentApp = null;
        });

        // Wait for frontend to be ready
        spinner.text = `Waiting for ${app} frontend (port ${APP_PORTS.frontend})...`;
        const frontendReady = await waitForPort(APP_PORTS.frontend, 'localhost', 60000);
        if (!frontendReady) {
          throw new Error(`${app} frontend did not start on port ${APP_PORTS.frontend}`);
        }

        // Wait for backend to be ready
        const backendPort = getBackendPort(app);
        spinner.text = `Waiting for ${app} backend (port ${backendPort})...`;
        const backendReady = await waitForPort(backendPort, 'localhost', 60000);
        if (!backendReady) {
          throw new Error(`${app} backend did not start on port ${backendPort}`);
        }

        // Wait for dev-dock to be available
        spinner.text = `Waiting for dev-dock API...`;
        const devDockReady = await waitForDevDock(backendPort, 30000);
        if (!devDockReady) {
          logger.warn('Dev-dock API not responding, continuing anyway...');
        }

        // Give the app a moment to fully initialize
        await sleep(2000);

        spinner.succeed(`${app} app started successfully`);
      } catch (error) {
        spinner.fail(`Failed to start ${app} app`);

        // Print app output to console for debugging
        if (state.appOutput.length > 0) {
          logger.error(`\n${app} app output (last ${state.appOutput.length} lines):`);
          for (const line of state.appOutput) {
            console.error(`  ${line}`);
          }
        }

        // Inform user about log file location
        if (state.appLogPath) {
          logger.error(`Full app output saved to: ${state.appLogPath}`);
        }

        // Clean up if start failed
        if (state.process) {
          await this.stopApp();
        }

        throw error;
      }
    },

    async stopApp(): Promise<void> {
      if (!state.process || !state.currentApp) {
        logger.debug('No app running to stop');
        return;
      }

      const appName = state.currentApp;
      const spinner = logger.spinner(`Stopping ${appName} app...`);

      try {
        const pid = state.process.pid;
        if (pid) {
          await killProcessTree(pid);
        }

        // Wait for process to exit
        await new Promise<void>((resolve) => {
          if (!state.process) {
            resolve();
            return;
          }

          const timeout = setTimeout(() => {
            resolve();
          }, 5000);

          state.process.on('exit', () => {
            clearTimeout(timeout);
            resolve();
          });
        });

        state.process = null;
        state.currentApp = null;
        state.appLogPath = null;
        state.appOutput = [];

        // Wait for ports to be released by checking they're actually free
        const backendPort = getBackendPort(appName);
        const maxWaitTime = 5000; // 5 seconds max
        const startTime = Date.now();

        while (Date.now() - startTime < maxWaitTime) {
          const portFree = await isPortFree(backendPort);
          if (portFree) {
            break;
          }
          await sleep(200);
        }

        // Additional short wait for good measure
        await sleep(500);

        spinner.succeed(`${appName} app stopped`);
      } catch (error) {
        spinner.fail(`Error stopping app: ${(error as Error).message}`);
        state.process = null;
        state.currentApp = null;
        state.appLogPath = null;
        state.appOutput = [];
      }
    },

    isRunning(): boolean {
      return state.process !== null;
    },

    getCurrentApp(): MachineType | null {
      return state.currentApp;
    },

    async waitForReady(timeout = 30000): Promise<boolean> {
      if (!state.process || !state.currentApp) {
        return false;
      }

      const backendPort = getBackendPort(state.currentApp);
      const frontendReady = await waitForPort(APP_PORTS.frontend, 'localhost', timeout);
      const backendReady = await waitForPort(backendPort, 'localhost', timeout);

      return frontendReady && backendReady;
    },
  };
}

/**
 * Ensure no VxSuite apps are running (useful for cleanup)
 */
export async function ensureNoAppsRunning(): Promise<void> {
  const execFileAsync = promisify(execFile);

  try {
    // Find any processes using our ports
    for (const port of Object.values(APP_PORTS)) {
      try {
        const { stdout } = await execFileAsync('lsof', [`-ti:${port}`]);
        const pids = stdout.trim().split('\n').filter(Boolean);

        for (const pid of pids) {
          try {
            await killProcessTree(parseInt(pid, 10));
            logger.debug(`Killed process ${pid} on port ${port}`);
          } catch {
            // Ignore errors killing processes
          }
        }
      } catch {
        // No process on this port
      }
    }
  } catch {
    // lsof might not be available
    logger.debug('Could not check for running processes');
  }
}

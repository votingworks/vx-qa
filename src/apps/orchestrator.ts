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
}

/**
 * Create an app orchestrator for a VxSuite repository
 */
export function createAppOrchestrator(repoPath: string): AppOrchestrator {
  const state: OrchestratorState = {
    process: null,
    currentApp: null,
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

        state.process = spawnBackground('pnpm', ['-w', 'run-dev', app], {
          cwd: repoPath,
          env,
        });

        state.currentApp = app;

        // Log output for debugging
        const { stdout, stderr } = state.process;
        if (stdout) {
          createInterface({ input: stdout, crlfDelay: Infinity }).on('line', (line) => {
            if (line) {
              logger.debug(`[${app}] ${line.trim()}`);
            }
          });
        }

        if (stderr) {
          createInterface({ input: stderr, crlfDelay: Infinity }).on('line', (line) => {
            if (line) {
              logger.debug(`[${app}:err] ${line.trim()}`);
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

        // Wait a moment for ports to be released
        await sleep(1000);

        spinner.succeed(`${appName} app stopped`);
      } catch (error) {
        spinner.fail(`Error stopping app: ${(error as Error).message}`);
        state.process = null;
        state.currentApp = null;
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

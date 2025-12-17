/**
 * App orchestration - starting and stopping VxSuite apps
 */

import { ChildProcess } from 'child_process';
import { logger } from '../utils/logger.js';
import { spawnBackground, killProcessTree, waitForPort, sleep } from '../utils/process.js';
import { getMockEnvironment, APP_PORTS, type MachineType } from './env-config.js';
import { waitForDevDock } from '../mock-hardware/client.js';

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
        state.process.stdout?.on('data', (data) => {
          const line = data.toString().trim();
          if (line) {
            logger.debug(`[${app}] ${line}`);
          }
        });

        state.process.stderr?.on('data', (data) => {
          const line = data.toString().trim();
          if (line && !line.includes('warning')) {
            logger.debug(`[${app}:err] ${line}`);
          }
        });

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
        spinner.text = `Waiting for ${app} backend (port ${APP_PORTS.backend})...`;
        const backendReady = await waitForPort(APP_PORTS.backend, 'localhost', 60000);
        if (!backendReady) {
          throw new Error(`${app} backend did not start on port ${APP_PORTS.backend}`);
        }

        // Wait for dev-dock to be available
        spinner.text = `Waiting for dev-dock API...`;
        const devDockReady = await waitForDevDock(APP_PORTS.backend, 30000);
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

      const spinner = logger.spinner(`Stopping ${state.currentApp} app...`);

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

        const appName = state.currentApp;
        state.process = null;
        state.currentApp = null;

        // Wait a moment for ports to be released
        await sleep(1000);

        spinner.succeed(`${appName} app stopped`);
      } catch (error) {
        spinner.fail(`Error stopping app: ${error}`);
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
      if (!state.process) {
        return false;
      }

      const frontendReady = await waitForPort(APP_PORTS.frontend, 'localhost', timeout);
      const backendReady = await waitForPort(APP_PORTS.backend, 'localhost', timeout);

      return frontendReady && backendReady;
    },
  };
}

/**
 * Ensure no VxSuite apps are running (useful for cleanup)
 */
export async function ensureNoAppsRunning(): Promise<void> {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);

  try {
    // Find any processes using our ports
    const ports = [APP_PORTS.frontend, APP_PORTS.backend];

    for (const port of ports) {
      try {
        const { stdout } = await execAsync(`lsof -ti:${port}`);
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

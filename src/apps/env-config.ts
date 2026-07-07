/**
 * Environment configuration for mock hardware
 */

/**
 * Environment variables to enable mock hardware
 */
export const MOCK_ENV_VARS: Record<string, string> = {
  // Enable mock hardware
  REACT_APP_VX_USE_MOCK_CARDS: 'TRUE',
  REACT_APP_VX_USE_MOCK_USB_DRIVE: 'TRUE',
  REACT_APP_VX_USE_MOCK_PRINTER: 'TRUE',
  REACT_APP_VX_USE_MOCK_PDI_SCANNER: 'TRUE',
  REACT_APP_VX_USE_MOCK_PAPER_HANDLER: 'TRUE',

  // Enable dev-dock UI
  REACT_APP_VX_ENABLE_DEV_DOCK: 'TRUE',

  // Skip election package authentication for testing
  REACT_APP_VX_SKIP_ELECTION_PACKAGE_AUTHENTICATION: 'TRUE',

  // Enable write-in adjudication
  REACT_APP_VX_ENABLE_WRITE_IN_ADJUDICATION: 'TRUE',

  // Use all-zero PIN for test cards
  REACT_APP_VX_ENABLE_ALL_ZERO_SMARTCARD_PIN_GENERATION: 'TRUE',
};

/**
 * Get environment variables for running VxSuite apps with mocks
 */
export function getMockEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...MOCK_ENV_VARS,
    NODE_ENV: 'development',
  };
}

/**
 * Machine type identifiers
 */
export const MACHINE_TYPES = {
  admin: 'admin',
  scan: 'scan',
  mark: 'mark',
  'mark-scan': 'mark-scan',
  'central-scan': 'central-scan',
} as const;

export type MachineType = keyof typeof MACHINE_TYPES;

/**
 * Ports used by VxSuite apps in dev mode. The frontend (Vite) serves on
 * FRONTEND_PORT and each app's backend runs on FRONTEND_PORT + 1 (see
 * apps/*\/backend/src/globals.ts: `PORT = Number(FRONTEND_PORT || 3000) + 1`).
 * Only one app runs at a time, so a single frontend/backend pair covers every
 * machine type.
 */
export const FRONTEND_PORT = 3000;
export const BACKEND_PORT = FRONTEND_PORT + 1;

/** Ports to watch/clean up when starting or stopping apps. */
export const APP_PORTS = {
  frontend: FRONTEND_PORT,
  backend: BACKEND_PORT,
} as const;

/**
 * Get the backend port for a machine type. Every VxSuite app uses
 * FRONTEND_PORT + 1 for its backend and only one runs at a time, so the machine
 * type doesn't affect the port.
 */
export function getBackendPort(_machineType: MachineType): number {
  return BACKEND_PORT;
}

/**
 * Environment configuration for mock hardware
 */

import assert from 'node:assert';

/**
 * Environment variables to enable mock hardware
 */
export const MOCK_ENV_VARS: Record<string, string> = {
  // Generic mock/test flag
  IS_INTEGRATION_TEST: 'TRUE',

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
 * Default ports used by VxSuite apps
 */
export const APP_PORTS = {
  frontend: 3000,
  mark: 3001,
  scan: 3002,
  'mark-scan': 3003,
  admin: 3004,
  'central-scan': 3005,
} as const;

/**
 * Get backend port for a specific machine type
 */
export function getBackendPort(machineType: MachineType): number {
  const port = APP_PORTS[machineType];
  assert(port !== undefined, `No port for machine type '${machineType}'`);
  return port;
}

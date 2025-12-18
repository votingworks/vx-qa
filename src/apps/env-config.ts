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
 * Default ports used by VxSuite apps
 */
export const APP_PORTS = {
  frontend: 3000,
  backend: 3004, // Default for VxAdmin
} as const;

/**
 * Get backend port for a specific machine type
 */
export function getBackendPort(machineType: MachineType): number {
  switch (machineType) {
    case 'admin':
      return 3004;
    case 'scan':
      return 3002;
    case 'mark':
      return 3001;
    case 'mark-scan':
      return 3003;
    case 'central-scan':
      return 3005;
    default:
      return 3004;
  }
}

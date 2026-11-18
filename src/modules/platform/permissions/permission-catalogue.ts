import { Role } from '@prisma/client';

/**
 * Every action the platform can authorise.
 *
 * Keys are `<resource>:<action>` so they stay readable in the database, in API
 * responses and in the permission editor. Endpoints declare the key they need
 * with `@RequirePermission(...)`; nothing checks a role name directly.
 */
export type PermissionGroup =
  | 'Organisation'
  | 'Branches'
  | 'Staff'
  | 'Catalogue'
  | 'Inventory'
  | 'Sales'
  | 'Expiry'
  | 'Transfers'
  | 'Reports'
  | 'Notifications';

export interface PermissionDefinition {
  key: string;
  group: PermissionGroup;
  label: string;
  description: string;
}

export const PERMISSION_CATALOGUE: readonly PermissionDefinition[] = [
  {
    key: 'organisation:read',
    group: 'Organisation',
    label: 'View organisation',
    description: 'See the pharmacy profile, currency and time zone.',
  },
  {
    key: 'organisation:manage',
    group: 'Organisation',
    label: 'Manage organisation',
    description: 'Change organisation-wide settings such as currency and time zone.',
  },
  {
    key: 'branch:read',
    group: 'Branches',
    label: 'View branches',
    description: 'See the branches the member is assigned to.',
  },
  {
    key: 'branch:manage',
    group: 'Branches',
    label: 'Manage branches',
    description: 'Create, edit, activate and close branches, and assign managers.',
  },
  {
    key: 'branch:all',
    group: 'Branches',
    label: 'Access every branch',
    description:
      'Reach stock, sales and reports in all branches without a branch assignment.',
  },
  {
    key: 'staff:read',
    group: 'Staff',
    label: 'View staff',
    description: 'See staff members, their roles, branches and recent activity.',
  },
  {
    key: 'staff:manage',
    group: 'Staff',
    label: 'Manage staff',
    description: 'Invite staff, edit details, resend invitations and suspend or remove access.',
  },
  {
    key: 'staff:permissions',
    group: 'Staff',
    label: 'Configure permissions',
    description: 'Change what each role may do and grant or deny permissions per member.',
  },
  {
    key: 'audit:read',
    group: 'Staff',
    label: 'View audit trail',
    description: 'Read the recorded history of important actions.',
  },
  {
    key: 'product:read',
    group: 'Catalogue',
    label: 'View medicines',
    description: 'Browse the shared medicine catalogue.',
  },
  {
    key: 'product:manage',
    group: 'Catalogue',
    label: 'Manage medicines',
    description: 'Add, edit, import and deactivate catalogue entries.',
  },
  {
    key: 'supplier:read',
    group: 'Catalogue',
    label: 'View suppliers',
    description: 'See supplier records.',
  },
  {
    key: 'supplier:manage',
    group: 'Catalogue',
    label: 'Manage suppliers',
    description: 'Add and edit suppliers.',
  },
  {
    key: 'inventory:read',
    group: 'Inventory',
    label: 'View stock',
    description: 'See batches, quantities, valuation and stock movements in a branch.',
  },
  {
    key: 'inventory:receive',
    group: 'Inventory',
    label: 'Receive stock',
    description: 'Record stock receipts that create or top up batches.',
  },
  {
    key: 'inventory:adjust',
    group: 'Inventory',
    label: 'Adjust stock',
    description: 'Record manual movements such as damage, expiry write-off and corrections.',
  },
  {
    key: 'inventory:count',
    group: 'Inventory',
    label: 'Run stock counts',
    description: 'Open, record and approve physical stock counts.',
  },
  {
    key: 'sale:read',
    group: 'Sales',
    label: 'View sales',
    description: 'See recorded sales, receipts and returns in a branch.',
  },
  {
    key: 'sale:record',
    group: 'Sales',
    label: 'Record sales',
    description: 'Sell stock and issue a receipt.',
  },
  {
    key: 'sale:void',
    group: 'Sales',
    label: 'Void sales',
    description: 'Cancel a recorded sale and return the units to stock.',
  },
  {
    key: 'sale:return',
    group: 'Sales',
    label: 'Record returns',
    description: 'Accept customer returns against a completed sale.',
  },
  {
    key: 'expiry:read',
    group: 'Expiry',
    label: 'View expiry',
    description: 'See near-expiry, expired and unknown-expiry batches.',
  },
  {
    key: 'transfer:read',
    group: 'Transfers',
    label: 'View transfers',
    description: 'See stock transfers in and out of the branches the member can reach.',
  },
  {
    key: 'transfer:request',
    group: 'Transfers',
    label: 'Request transfers',
    description: 'Draft and submit stock transfers between branches.',
  },
  {
    key: 'transfer:approve',
    group: 'Transfers',
    label: 'Approve transfers',
    description: 'Approve or reject a transfer that is waiting for approval.',
  },
  {
    key: 'transfer:dispatch',
    group: 'Transfers',
    label: 'Dispatch transfers',
    description: 'Send approved stock out of the source branch.',
  },
  {
    key: 'transfer:receive',
    group: 'Transfers',
    label: 'Receive transfers',
    description: 'Confirm what arrived at the destination branch.',
  },
  {
    key: 'report:read',
    group: 'Reports',
    label: 'View reports',
    description: 'See dashboard, stock, expiry and sales reports for the branches the member can reach.',
  },
  {
    key: 'report:compare',
    group: 'Reports',
    label: 'Compare branches',
    description: 'Compare performance, stock and wastage across every branch.',
  },
  {
    key: 'notification:read',
    group: 'Notifications',
    label: 'View notifications',
    description: 'Read in-app alerts.',
  },
  {
    key: 'notification:manage',
    group: 'Notifications',
    label: 'Manage notification settings',
    description: 'Change alert recipients and reporting preferences.',
  },
];

export type PermissionKey = (typeof PERMISSION_CATALOGUE)[number]['key'];

export const PERMISSION_KEYS: readonly PermissionKey[] = PERMISSION_CATALOGUE.map(
  (entry) => entry.key as PermissionKey,
);

const ALL_PERMISSIONS: readonly PermissionKey[] = PERMISSION_KEYS;

/** Read-only set shared by the legacy viewer role and any viewer-like role. */
const VIEWER: readonly PermissionKey[] = [
  'organisation:read',
  'branch:read',
  'product:read',
  'supplier:read',
  'inventory:read',
  'sale:read',
  'expiry:read',
  'report:read',
  'notification:read',
];

const PHARMACIST: readonly PermissionKey[] = [
  'organisation:read',
  'branch:read',
  'staff:read',
  'product:read',
  'supplier:read',
  'inventory:read',
  'inventory:adjust',
  'inventory:count',
  'sale:read',
  'sale:record',
  'sale:return',
  'expiry:read',
  'transfer:read',
  'transfer:request',
  'report:read',
  'notification:read',
];

const INVENTORY_OFFICER: readonly PermissionKey[] = [
  'organisation:read',
  'branch:read',
  'product:read',
  'product:manage',
  'supplier:read',
  'supplier:manage',
  'inventory:read',
  'inventory:receive',
  'inventory:adjust',
  'inventory:count',
  'expiry:read',
  'transfer:read',
  'transfer:request',
  'transfer:dispatch',
  'transfer:receive',
  'report:read',
  'notification:read',
];

const BRANCH_MANAGER: readonly PermissionKey[] = [
  'organisation:read',
  'branch:read',
  'staff:read',
  'audit:read',
  'product:read',
  'supplier:read',
  'inventory:read',
  'inventory:receive',
  'inventory:adjust',
  'inventory:count',
  'sale:read',
  'sale:record',
  'sale:return',
  'sale:void',
  'expiry:read',
  'transfer:read',
  'transfer:request',
  'transfer:approve',
  'transfer:receive',
  'report:read',
  'notification:read',
];

const CASHIER: readonly PermissionKey[] = [
  'organisation:read',
  'branch:read',
  'product:read',
  'inventory:read',
  'sale:read',
  'sale:record',
  'expiry:read',
  'report:read',
  'notification:read',
];

/**
 * The permission set a role starts with in a new organisation.
 *
 * These rows are copied into `RolePermission` on first use so an administrator
 * can adjust them afterwards; the catalogue is only the starting point.
 */
export const ROLE_DEFAULT_PERMISSIONS: Record<Role, readonly PermissionKey[]> = {
  OWNER: ALL_PERMISSIONS,
  // Administrators run the organisation, but only the owner may rewrite the
  // permission matrix itself.
  ADMIN: ALL_PERMISSIONS.filter((key) => key !== 'staff:permissions'),
  BRANCH_MANAGER,
  PHARMACIST,
  INVENTORY_OFFICER,
  CASHIER,
  // Legacy roles keep the reach they had before branches existed. MANAGER was a
  // workspace-wide role, so it keeps `branch:all`; the others are limited to the
  // branch assignments they received during the migration.
  MANAGER: [...BRANCH_MANAGER, 'staff:manage', 'transfer:dispatch', 'branch:all'],
  INVENTORY_STAFF: INVENTORY_OFFICER,
  READ_ONLY: VIEWER,
};

/** Roles whose permission set may be edited. The owner always keeps everything. */
export const EDITABLE_ROLES: readonly Role[] = (Object.values(Role) as Role[]).filter(
  (role) => role !== Role.OWNER,
);

export const ROLE_LABELS: Record<Role, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  BRANCH_MANAGER: 'Branch manager',
  PHARMACIST: 'Pharmacist',
  INVENTORY_OFFICER: 'Inventory officer',
  CASHIER: 'Cashier',
  MANAGER: 'Manager (legacy)',
  INVENTORY_STAFF: 'Inventory staff (legacy)',
  READ_ONLY: 'Read only (legacy)',
};

const KNOWN_KEYS = new Set<string>(PERMISSION_KEYS);

export function isPermissionKey(value: string): value is PermissionKey {
  return KNOWN_KEYS.has(value);
}

/** Keeps only recognised keys, so an unknown string can never grant anything. */
export function sanitisePermissions(values: readonly string[]): PermissionKey[] {
  const unique = new Set<PermissionKey>();
  for (const value of values) {
    if (isPermissionKey(value)) unique.add(value);
  }
  return [...unique];
}

import { SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '../../modules/platform/permissions/permission-catalogue';

export const PERMISSIONS_KEY = 'permissions';

/**
 * Declares the permissions an endpoint needs. Every listed permission must be
 * held, so a handler can require both `inventory:read` and `report:compare`.
 */
export const RequirePermission = (...permissions: PermissionKey[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

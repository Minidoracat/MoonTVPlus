import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getConfig } from '@/lib/config';
import { db } from '@/lib/db';
import {
  ALL_FEATURE_PERMISSION_KEYS,
  type FeaturePermissionKey,
  sanitizeFeaturePermissions,
} from '@/lib/feature-permissions';
import type { MangaAdultView } from '@/lib/manga.types';

export type FeatureAccessMap = Record<FeaturePermissionKey, boolean>;

export function createEmptyFeatureAccessMap(): FeatureAccessMap {
  return ALL_FEATURE_PERMISSION_KEYS.reduce((acc, key) => {
    acc[key] = false;
    return acc;
  }, {} as FeatureAccessMap);
}

function createFullFeatureAccessMap(): FeatureAccessMap {
  return ALL_FEATURE_PERMISSION_KEYS.reduce((acc, key) => {
    acc[key] = true;
    return acc;
  }, {} as FeatureAccessMap);
}

function isPrivilegedRole(role?: string) {
  return role === 'owner' || role === 'admin';
}

async function getUserFeatureAccessMap(username: string): Promise<FeatureAccessMap> {
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  if (storageType === 'localstorage') {
    return createFullFeatureAccessMap();
  }

  const userInfo = await db.getUserInfoV2(username);
  if (!userInfo || userInfo.banned) {
    return createEmptyFeatureAccessMap();
  }

  if (username === process.env.USERNAME || isPrivilegedRole(userInfo.role)) {
    return createFullFeatureAccessMap();
  }

  const config = await getConfig();
  const tags = Array.isArray(userInfo.tags) ? userInfo.tags : [];

  // 兼容旧用户：未分配用户组时，默认拥有全部功能权限
  if (tags.length === 0) {
    return createFullFeatureAccessMap();
  }

  const allowedPermissions = new Set<FeaturePermissionKey>();

  tags.forEach((tagName) => {
    const group = config.UserConfig.Tags?.find((item) => item.name === tagName);
    sanitizeFeaturePermissions(group?.permissions).forEach((permission) =>
      allowedPermissions.add(permission)
    );
  });

  return ALL_FEATURE_PERMISSION_KEYS.reduce((acc, key) => {
    acc[key] = allowedPermissions.has(key);
    return acc;
  }, {} as FeatureAccessMap);
}

export async function getUserFeatureAccess(username?: string | null): Promise<FeatureAccessMap> {
  if (!username) return createEmptyFeatureAccessMap();
  try {
    return await getUserFeatureAccessMap(username);
  } catch (error) {
    console.error('[Permissions] Failed to load feature access:', error);
    return username === process.env.USERNAME
      ? createFullFeatureAccessMap()
      : createEmptyFeatureAccessMap();
  }
}

/**
 * 這位使用者看不看得到漫畫成人源，以及有沒有開安全模式。
 * 站長一律開放；其他人（含管理員）要管理員在使用者列表逐一開放，沒開就是 none。
 */
export async function getMangaAdultView(
  username?: string | null
): Promise<MangaAdultView> {
  if (!username) return 'none';
  // localstorage 模式只有站長一人，伺服器端也沒有地方存安全模式
  if ((process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage') === 'localstorage') {
    return 'shown';
  }
  try {
    const info = await db.getUserInfoV2(username);
    const isOwner = username === process.env.USERNAME;
    if (!isOwner && (!info || info.banned || info.mangaAdult !== true)) {
      return 'none';
    }
    return info?.mangaSafeMode ? 'hidden' : 'shown';
  } catch (error) {
    // 讀不到就當沒開放：DB 故障時寧可藏起來，也不能露出
    console.error('[Permissions] Failed to load manga adult view:', error);
    return 'none';
  }
}

export async function hasFeaturePermission(
  username: string,
  permission: FeaturePermissionKey
): Promise<boolean> {
  const accessMap = await getUserFeatureAccessMap(username);
  return accessMap[permission] === true;
}

export async function requireFeaturePermission(
  request: NextRequest,
  permission: FeaturePermissionKey,
  errorMessage = '无权限访问该功能'
): Promise<{ username: string } | NextResponse> {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo?.username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const allowed = await hasFeaturePermission(authInfo.username, permission);
  if (!allowed) {
    return NextResponse.json({ error: errorMessage }, { status: 403 });
  }

  return { username: authInfo.username };
}

import type { Principal } from '@di-framework/auth';
import type { PolicySubject } from '@di-framework/authz';

export type Membership = {
  org: string;
  team?: string;
  roles: string[];
};

export type MembershipTable = Record<string, Membership>;

export function parseMembers(raw: string | undefined): MembershipTable {
  if (raw === undefined || raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const table: MembershipTable = {};
    for (const [sub, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      if (typeof record.org !== 'string' || record.org.trim() === '') continue;
      const roles = Array.isArray(record.roles)
        ? record.roles.filter((role): role is string => typeof role === 'string')
        : [];
      table[sub] = {
        org: record.org,
        team: typeof record.team === 'string' ? record.team : undefined,
        roles,
      };
    }
    return table;
  } catch {
    return {};
  }
}

function stringClaim(claims: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined {
  const value = claims?.[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function roleClaim(claims: Readonly<Record<string, unknown>> | undefined): string[] {
  const roles = claims?.roles;
  return Array.isArray(roles) ? roles.filter((role): role is string => typeof role === 'string') : [];
}

export function resolveMembership(principal: Principal, table: MembershipTable): Membership | undefined {
  const listed = table[principal.sub];
  const org = listed?.org ?? stringClaim(principal.claims, 'org');
  if (org === undefined) return undefined;
  const team = listed?.team ?? stringClaim(principal.claims, 'team');
  const roles = listed?.roles.length ? listed.roles : roleClaim(principal.claims);
  return { org, team, roles };
}

export function mapSubject(principal: Principal, table: MembershipTable): PolicySubject {
  const membership = resolveMembership(principal, table);
  return {
    id: principal.sub,
    roles: membership?.roles ?? [],
    scopes: [...(principal.scope ?? [])],
    claims: {
      ...(principal.claims ?? {}),
      ...(membership?.org !== undefined ? { org: membership.org } : {}),
      ...(membership?.team !== undefined ? { team: membership.team } : {}),
    },
  };
}

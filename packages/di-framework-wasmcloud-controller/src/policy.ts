import { Allow, HasRole, Owner, Policy } from '@di-framework/authz';
import type { PolicyDocument } from '@di-framework/authz';

@Policy('application')
export class ApplicationPolicy {
  @Allow('create', 'read')
  @Owner({ subjectPath: 'subject.claims.org', resourcePath: 'resource.org' })
  sameOrg() {}

  @Allow('update', 'delete')
  @Owner({ subjectPath: 'subject.claims.org', resourcePath: 'resource.org' })
  @Owner({ subjectPath: 'subject.claims.team', resourcePath: 'resource.team' })
  sameTeam() {}

  @Allow('create', 'update', 'delete')
  @HasRole('org-admin')
  orgAdmin() {}
}

/** Frozen at module load so later `policyRegistry.clear()` in other tests cannot empty it. */
export const APPLICATION_POLICY_DOCUMENT: PolicyDocument = {
  policies: [
    {
      name: 'ApplicationPolicy',
      resource: 'application',
      rules: [
        {
          id: 'ApplicationPolicy.sameOrg',
          effect: 'allow',
          actions: ['create', 'read'],
          conditions: [
            { type: 'owner', subjectPath: 'subject.claims.org', resourcePath: 'resource.org' },
          ],
        },
        {
          id: 'ApplicationPolicy.sameTeam',
          effect: 'allow',
          actions: ['delete', 'update'],
          conditions: [
            { type: 'owner', subjectPath: 'subject.claims.org', resourcePath: 'resource.org' },
            { type: 'owner', subjectPath: 'subject.claims.team', resourcePath: 'resource.team' },
          ],
        },
        {
          id: 'ApplicationPolicy.orgAdmin',
          effect: 'allow',
          actions: ['create', 'delete', 'read', 'update'],
          conditions: [{ type: 'has-role', roles: ['org-admin'] }],
        },
      ],
    },
  ],
};

export type ApplicationResource = {
  org: string;
  team?: string;
  owner?: string;
};

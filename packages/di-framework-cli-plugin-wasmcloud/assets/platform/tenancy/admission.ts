import { INSTALLATION, TENANT, type Resource } from './resources';

/** The controller's runtime credentials must never become guest capabilities. */
export function admissionResources(installation: string, namespace: string): Resource[] {
  const result: Resource[] = [];
  function policy(
    name: string,
    apiGroups: string[],
    resources: string[],
    validations: { expression: string; message: string }[],
    variables?: { name: string; expression: string }[],
  ): void {
    const fullName = `${installation}-${name}`;
    result.push({
      apiVersion: 'admissionregistration.k8s.io/v1',
      kind: 'ValidatingAdmissionPolicy',
      metadata: { name: fullName },
      spec: {
        failurePolicy: 'Fail',
        matchConstraints: {
          resourceRules: [
            { apiGroups, apiVersions: ['*'], operations: ['CREATE', 'UPDATE'], resources },
          ],
        },
        ...(variables ? { variables } : {}),
        validations,
      },
    });
    result.push({
      apiVersion: 'admissionregistration.k8s.io/v1',
      kind: 'ValidatingAdmissionPolicyBinding',
      metadata: { name: fullName },
      spec: {
        policyName: fullName,
        validationActions: ['Deny'],
        matchResources: {
          namespaceSelector: {
            matchLabels: { [INSTALLATION]: installation },
            matchExpressions: [{ key: TENANT, operator: 'Exists' }],
          },
        },
      },
    });
  }
  policy(
    'workloads',
    ['runtime.wasmcloud.dev'],
    ['workloaddeployments'],
    [
      {
        expression:
          'has(variables.w.environment) && variables.w.environment == object.metadata.namespace && !has(variables.w.hostId)',
        message: 'Tenant workloads must target their own environment and cannot select a host ID',
      },
      {
        expression: '!has(variables.w.volumes) || size(variables.w.volumes) == 0',
        message: 'Tenant workloads cannot mount host volumes',
      },
      {
        expression:
          'variables.locals.all(l, (!has(l.allowedHosts) || size(l.allowedHosts) == 0) && (!has(l.allowedHostLoopbackPorts) || size(l.allowedHostLoopbackPorts) == 0) && (!has(l.volumeMounts) || size(l.volumeMounts) == 0))',
        message: 'Tenant guests cannot request network or host filesystem capabilities',
      },
      {
        expression: `!has(variables.w.hostInterfaces) || variables.w.hostInterfaces.all(h,
      (!has(h.name) || h.name == '') &&
      (!has(h.secretFrom) || size(h.secretFrom) == 0) &&
      ((h['namespace'] == 'wasi' && h['package'] in ['http', 'config']) ||
       (h['namespace'] == 'wasmcloud' && h['package'] in ['keyvalue', 'messaging'])) &&
      (!has(h.configFrom) || size(h.configFrom) == 0 || (h['package'] == 'keyvalue' && h.configFrom.all(c, c.name == 'di-tenant-stock'))) &&
      (!has(h.config) ||
        (h['package'] == 'http' && h.config.all(k, k in ['host', 'path'])) ||
        h['package'] == 'config' ||
        (h['package'] == 'messaging' && h.config.all(k, k in ['subscriptions', 'consumer_group', 'max_in_flight', 'admission_wait'])) ||
        (h['package'] == 'keyvalue' && size(h.config) == 0)))`,
        message:
          'Only tenant-scoped native host interfaces are allowed; use di-tenant-stock for Redis',
      },
    ],
    [
      { name: 'w', expression: 'object.spec.template.spec' },
      {
        name: 'locals',
        expression:
          '(has(variables.w.components) ? variables.w.components.filter(c, has(c.localResources)).map(c, c.localResources) : []) + (has(variables.w.service) && has(variables.w.service.localResources) ? [variables.w.service.localResources] : [])',
      },
    ],
  );
  // Reserve the backend configuration against create/update/delete, including deletecollection.
  const reservedName = `${installation}-backend-config`;
  result.push({
    apiVersion: 'admissionregistration.k8s.io/v1',
    kind: 'ValidatingAdmissionPolicy',
    metadata: { name: reservedName },
    spec: {
      failurePolicy: 'Fail',
      matchConstraints: {
        resourceRules: [
          {
            apiGroups: [''],
            apiVersions: ['v1'],
            operations: ['CREATE', 'UPDATE', 'DELETE'],
            resources: ['configmaps'],
          },
        ],
      },
      validations: [
        {
          expression: `!request.userInfo.username.startsWith('system:serviceaccount:${namespace}:di-user-') || (request.operation == 'DELETE' ? oldObject.metadata.name : object.metadata.name) != 'di-tenant-stock'`,
          message: 'di-tenant-stock is managed by the platform controller',
        },
      ],
    },
  });
  result.push({
    apiVersion: 'admissionregistration.k8s.io/v1',
    kind: 'ValidatingAdmissionPolicyBinding',
    metadata: { name: reservedName },
    spec: {
      policyName: reservedName,
      validationActions: ['Deny'],
      matchResources: {
        namespaceSelector: {
          matchLabels: { [INSTALLATION]: installation },
          matchExpressions: [{ key: TENANT, operator: 'Exists' }],
        },
      },
    },
  });
  policy(
    'services',
    [''],
    ['services'],
    [
      {
        expression:
          "(!has(object.spec.type) || object.spec.type == 'ClusterIP') && (!has(object.spec.externalIPs) || size(object.spec.externalIPs) == 0)",
        message: 'Tenant services must be ClusterIP services without external IPs',
      },
    ],
  );
  return result;
}

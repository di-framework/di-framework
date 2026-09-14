import {
  DEFAULT_CLASS_NAMES,
  GROUP,
  INSTALLATION,
  OWNER,
  type Resource,
  TENANT,
} from './resources';

/** Controller-managed ConfigMap prefix for BackingService backend config (#450). */
export const BS_CONFIG_PREFIX = 'di-bs-';
/** Controller-managed Secret/ConfigMap prefix for ServiceBinding projection (#451). */
export const BINDING_CONFIG_PREFIX = 'di-binding-';
/** Transitional warehouse keyvalue ConfigMap; still admitted alongside di-bs-*. */
export const STOCK_CONFIG_NAME = 'di-tenant-stock';

const APPROVED_CLASS_NAMES = new Set<string>(Object.values(DEFAULT_CLASS_NAMES));

export function isManagedConfigName(name: string): boolean {
  return (
    name === STOCK_CONFIG_NAME ||
    name.startsWith(BS_CONFIG_PREFIX) ||
    name.startsWith(BINDING_CONFIG_PREFIX)
  );
}

export function isManagedSecretName(name: string): boolean {
  return name.startsWith(BINDING_CONFIG_PREFIX) || name.startsWith(BS_CONFIG_PREFIX);
}

export function tenantNameFromNamespace(namespace: string): string | undefined {
  const match = /^di-tenant-(.+)$/.exec(namespace);
  return match?.[1];
}

/** Fail-closed: platform ownership labels must match the trusted namespace, or be absent. */
export function ownershipLabelsAllowed(
  labels: Record<string, string> | undefined,
  namespace: string,
  installation?: string,
): boolean {
  if (!labels) return true;
  const tenant = tenantNameFromNamespace(namespace);
  if (!tenant) return false;
  if (labels[TENANT] !== undefined && labels[TENANT] !== tenant) return false;
  if (labels[OWNER] !== undefined) return false;
  if (installation !== undefined && labels[INSTALLATION] !== undefined) {
    if (labels[INSTALLATION] !== installation) return false;
  }
  return true;
}

export function approvedClassName(className: string | undefined, type: string): boolean {
  if (className === undefined || className === '') {
    return type === 'keyvalue' || type === 'messaging';
  }
  return APPROVED_CLASS_NAMES.has(className);
}

export function serviceNameSameNamespace(serviceName: string): boolean {
  return (
    typeof serviceName === 'string' &&
    serviceName.length > 0 &&
    serviceName.length <= 40 &&
    !serviceName.includes('/') &&
    !serviceName.includes('.') &&
    /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(serviceName)
  );
}

export interface HostInterfaceLike {
  name?: string;
  namespace?: string;
  package?: string;
  configFrom?: { name: string }[];
  secretFrom?: { name: string }[];
  config?: Record<string, unknown>;
}

/**
 * Mirrors the workload ValidatingAdmissionPolicy CEL (fail-closed).
 * Unnamed backend selection is denied except the transitional stock keyvalue path.
 */
export function hostInterfaceAllowed(h: HostInterfaceLike): boolean {
  const ns = h.namespace ?? '';
  const pkg = h.package ?? '';
  const named = typeof h.name === 'string' && h.name.length > 0;
  const configFrom = h.configFrom ?? [];
  const secretFrom = h.secretFrom ?? [];
  const config = h.config ?? {};
  const configKeys = Object.keys(config);

  if (ns === 'wasi' && (pkg === 'http' || pkg === 'config')) {
    if (named) return false;
    if (secretFrom.length > 0 || configFrom.length > 0) return false;
    if (pkg === 'http') return configKeys.every((k) => k === 'host' || k === 'path');
    return true;
  }

  if (ns === 'wasmcloud' && (pkg === 'keyvalue' || pkg === 'messaging')) {
    const configFromOk =
      configFrom.length === 0 || configFrom.every((c) => isManagedConfigName(c.name));
    const secretFromOk =
      secretFrom.length === 0 || secretFrom.every((s) => isManagedSecretName(s.name));
    if (!configFromOk || !secretFromOk) return false;

    if (pkg === 'keyvalue') {
      if (configKeys.length > 0) return false;
      // Transitional: unnamed + only di-tenant-stock.
      if (!named) {
        return (
          secretFrom.length === 0 &&
          configFrom.length > 0 &&
          configFrom.every((c) => c.name === STOCK_CONFIG_NAME)
        );
      }
      return configFrom.length > 0 || secretFrom.length > 0;
    }

    // messaging: inline config is subscription knobs only (no url/backend).
    // Unnamed is allowed only without configFrom/secretFrom (transitional default NATS).
    // Named backend selection requires controller-managed di-bs-/di-binding- refs.
    if (
      configKeys.some(
        (k) => !['subscriptions', 'consumer_group', 'max_in_flight', 'admission_wait'].includes(k),
      )
    )
      return false;
    if (!named) return secretFrom.length === 0 && configFrom.length === 0;
    return configFrom.length > 0 || secretFrom.length > 0 || configKeys.length > 0;
  }

  return false;
}

export function validateBackingServiceAdmission(input: {
  namespace: string;
  type: string;
  className?: string;
  labels?: Record<string, string>;
  installation?: string;
}): string | undefined {
  if (!ownershipLabelsAllowed(input.labels, input.namespace, input.installation))
    return 'BackingService ownership labels must derive from the tenant namespace';
  if (input.type !== 'keyvalue' && input.type !== 'messaging')
    return 'BackingService type must be keyvalue or messaging';
  if (!approvedClassName(input.className, input.type))
    return 'BackingService className must be an approved platform default (fail-closed)';
  return undefined;
}

export function validateServiceBindingAdmission(input: {
  namespace: string;
  serviceName: string;
  capability: string;
  labels?: Record<string, string>;
  installation?: string;
}): string | undefined {
  if (!ownershipLabelsAllowed(input.labels, input.namespace, input.installation))
    return 'ServiceBinding ownership labels must derive from the tenant namespace';
  if (!serviceNameSameNamespace(input.serviceName))
    return 'ServiceBinding serviceName must reference a BackingService in the same namespace';
  if (input.capability !== 'keyvalue' && input.capability !== 'messaging')
    return 'ServiceBinding capability must be keyvalue or messaging';
  return undefined;
}

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
      ((h['namespace'] == 'wasi' && h['package'] in ['http', 'config'] &&
        (!has(h.name) || h.name == '') &&
        (!has(h.secretFrom) || size(h.secretFrom) == 0) &&
        (!has(h.configFrom) || size(h.configFrom) == 0) &&
        (!has(h.config) ||
          (h['package'] == 'http' && h.config.all(k, k in ['host', 'path'])) ||
          h['package'] == 'config'))
      ||
      (h['namespace'] == 'wasmcloud' && h['package'] == 'keyvalue' &&
        (!has(h.config) || size(h.config) == 0) &&
        (!has(h.secretFrom) || size(h.secretFrom) == 0 || h.secretFrom.all(s, s.name.startsWith('${BINDING_CONFIG_PREFIX}') || s.name.startsWith('${BS_CONFIG_PREFIX}'))) &&
        (!has(h.configFrom) || size(h.configFrom) == 0 || h.configFrom.all(c, c.name == '${STOCK_CONFIG_NAME}' || c.name.startsWith('${BS_CONFIG_PREFIX}') || c.name.startsWith('${BINDING_CONFIG_PREFIX}'))) &&
        (((!has(h.name) || h.name == '') && has(h.configFrom) && size(h.configFrom) > 0 && h.configFrom.all(c, c.name == '${STOCK_CONFIG_NAME}') && (!has(h.secretFrom) || size(h.secretFrom) == 0)) ||
         (has(h.name) && h.name != '' && ((has(h.configFrom) && size(h.configFrom) > 0) || (has(h.secretFrom) && size(h.secretFrom) > 0)))))
      ||
      (h['namespace'] == 'wasmcloud' && h['package'] == 'messaging' &&
        (!has(h.secretFrom) || size(h.secretFrom) == 0 || h.secretFrom.all(s, s.name.startsWith('${BINDING_CONFIG_PREFIX}') || s.name.startsWith('${BS_CONFIG_PREFIX}'))) &&
        (!has(h.configFrom) || size(h.configFrom) == 0 || h.configFrom.all(c, c.name.startsWith('${BS_CONFIG_PREFIX}') || c.name.startsWith('${BINDING_CONFIG_PREFIX}'))) &&
        (!has(h.config) || h.config.all(k, k in ['subscriptions', 'consumer_group', 'max_in_flight', 'admission_wait'])) &&
        (((!has(h.name) || h.name == '') && (!has(h.configFrom) || size(h.configFrom) == 0) && (!has(h.secretFrom) || size(h.secretFrom) == 0)) ||
         (has(h.name) && h.name != '' && ((has(h.configFrom) && size(h.configFrom) > 0) || (has(h.secretFrom) && size(h.secretFrom) > 0) || (has(h.config) && size(h.config) > 0))))))`,
        message:
          'Only wasi http/config or wasmcloud keyvalue/messaging with controller-managed di-bs-/di-binding- (or transitional di-tenant-stock / default NATS) references are allowed',
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
  // Reserve controller-managed configuration and credentials against tenant-user mutation.
  const reservedName = `${installation}-backend-config`;
  const reservedObjectName =
    "(request.operation == 'DELETE' ? oldObject.metadata.name : object.metadata.name)";
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
            resources: ['configmaps', 'secrets'],
          },
        ],
      },
      validations: [
        {
          expression: `!request.userInfo.username.startsWith('system:serviceaccount:${namespace}:di-user-') || !(${reservedObjectName} == '${STOCK_CONFIG_NAME}' || ${reservedObjectName}.startsWith('${BS_CONFIG_PREFIX}') || ${reservedObjectName}.startsWith('${BINDING_CONFIG_PREFIX}'))`,
          message:
            'di-tenant-stock, di-bs-*, and di-binding-* ConfigMaps/Secrets are managed by the platform controller',
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
  policy(
    'backingservices',
    [GROUP],
    ['backingservices'],
    [
      {
        expression: `!has(object.metadata.labels) || (
          (!has(object.metadata.labels['${OWNER}'])) &&
          (!has(object.metadata.labels['${TENANT}']) || object.metadata.namespace == 'di-tenant-' + object.metadata.labels['${TENANT}']) &&
          (!has(object.metadata.labels['${INSTALLATION}']) || object.metadata.labels['${INSTALLATION}'] == '${installation}')
        )`,
        message: 'BackingService ownership labels must derive from the tenant namespace',
      },
      {
        expression: `object.spec.type in ['keyvalue', 'messaging'] && (!has(object.spec.className) || object.spec.className == '' || object.spec.className in ['${DEFAULT_CLASS_NAMES.keyvalue}', '${DEFAULT_CLASS_NAMES.messaging}'])`,
        message:
          'BackingService className must be an approved platform default (fail-closed for unknown classes)',
      },
    ],
  );
  policy(
    'servicebindings',
    [GROUP],
    ['servicebindings'],
    [
      {
        expression: `!has(object.metadata.labels) || (
          (!has(object.metadata.labels['${OWNER}'])) &&
          (!has(object.metadata.labels['${TENANT}']) || object.metadata.namespace == 'di-tenant-' + object.metadata.labels['${TENANT}']) &&
          (!has(object.metadata.labels['${INSTALLATION}']) || object.metadata.labels['${INSTALLATION}'] == '${installation}')
        )`,
        message: 'ServiceBinding ownership labels must derive from the tenant namespace',
      },
      {
        expression:
          "object.spec.capability in ['keyvalue', 'messaging'] && object.spec.serviceName != '' && !object.spec.serviceName.contains('/') && !object.spec.serviceName.contains('.')",
        message:
          'ServiceBinding must reference a same-namespace BackingService with capability keyvalue or messaging',
      },
    ],
  );
  return result;
}

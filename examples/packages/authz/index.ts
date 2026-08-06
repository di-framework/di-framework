import { registerAuth } from '@di-framework/auth';
import { withAuthErrors, withAuthRoutes } from '@di-framework/auth/http';
import {
  Allow,
  Deny,
  Equals,
  HasRole,
  HasScope,
  Owner,
  Policy,
  policyAuthorizationManager,
  type ResourceProvider,
} from '@di-framework/authz';
import { ResourceAuthorization } from '@di-framework/authz/http';
import { Container } from '@di-framework/core/decorators';
import { Controller, Endpoint, json, TypedRouter } from '@di-framework/http';

export interface DocumentRecord {
  id: string;
  ownerId: string;
  locked: boolean;
  title: string;
}
export const documents = new Map<string, DocumentRecord>([
  ['open', { id: 'open', ownerId: 'ada', locked: false, title: 'Open notes' }],
  ['locked', { id: 'locked', ownerId: 'ada', locked: true, title: 'Final record' }],
]);

@Policy('document')
export class DocumentPolicy {
  @Allow('read') @HasScope('documents:read') read() {}
  @Allow('update', 'delete') @Owner() own() {}
  @Allow('delete') @HasRole('admin') admin() {}
  @Deny('update', 'delete') @Equals('resource.locked', true) locked() {}
}

@Container()
export class DocumentResourceProvider implements ResourceProvider<DocumentRecord> {
  load(id: string) {
    return documents.get(id);
  }
}

export const authorization = policyAuthorizationManager({
  providers: { document: DocumentResourceProvider },
});
export const auth = registerAuth({
  secret: 'example-secret-please-replace-me-32b+',
  jwt: { issuer: 'https://api.example.com', audience: 'documents', accessTtlSeconds: 900 },
  authorization,
});
export const router = TypedRouter({ catch: withAuthErrors() });
const secure = withAuthRoutes(router);

@ResourceAuthorization(DocumentPolicy)
@Controller()
export class DocumentsController {
  @Endpoint({ summary: 'List documents' })
  static list = secure.get('/documents', () => json([...documents.values()]));
  @Endpoint({ summary: 'Read document' })
  static read = secure.get('/documents/:id', (request) =>
    json(documents.get(request.params.id ?? '') ?? null),
  );
  @Endpoint({ summary: 'Update document' })
  static update = secure.patch('/documents/:id', (request) => json({ updated: request.params.id }));
  @Endpoint({ summary: 'Delete document' })
  static delete = secure.delete('/documents/:id', (request) =>
    json({ deleted: request.params.id }),
  );
}

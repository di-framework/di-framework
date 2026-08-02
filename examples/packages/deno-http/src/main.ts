import { Bootstrap, Component, Container, Telemetry } from '@di-framework/di-framework/decorators';
import {
  Controller,
  Endpoint,
  json,
  type RequestSpec,
  type ResponseSpec,
  TypedRouter,
} from '@di-framework/di-framework-http';
import { tokens, Utils } from './lib';

@Container()
class NaturalLanguageService {
  @Telemetry({ logging: true })
  getText(sentenceCount: number): string {
    return Array.from({ length: sentenceCount }, () => {
      const sentence = `${Utils.pick(tokens.subjects)} ${Utils.pick(tokens.verbs)} ${Utils.pick(tokens.objects)} ${Utils.pick(tokens.modifiers)}.`;
      return Utils.capitalize(sentence);
    }).join(' ');
  }
}

// Additional params to the router (placeholders to make the compiler happy)
type Env = {};
type ExecutionContext = {};

export const router = TypedRouter<[Env, ExecutionContext]>();
const env: Env = {};
const ctx: ExecutionContext = {};

// Response Types
type SentencesResponse = { nonsense: string; count: number };
type SentenceResponse = { nonsense: string };

// Denosaur Language Model
@Bootstrap()
@Controller()
export class NaturalLanguageController {
  constructor(@Component(NaturalLanguageService) private service: NaturalLanguageService) {}

  @Endpoint({
    summary: 'Get random sentence',
    responses: { '200': { description: 'Sentences' } },
  })
  getRoot = router.get<RequestSpec<void>, ResponseSpec<SentenceResponse>>('/', () => {
    return json({ nonsense: this.service.getText(5) });
  });

  @Endpoint({
    summary: 'Get N sentences',
    responses: { '200': { description: 'N Sentences' } },
  })
  getCount = router.get<RequestSpec<void>, ResponseSpec<SentencesResponse>>('/:count', (req) => {
    const count = parseInt(req.params.count as string) || 5;
    return json({ nonsense: this.service.getText(count), count });
  });
}

if (import.meta.main) {
  Deno.serve({ port: 8000 }, (request: Request) => router.fetch(request, env, ctx));
}

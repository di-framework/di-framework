import { useContainer } from '@di-framework/core';
import { Component } from '@di-framework/core/decorators';
import {
  Controller,
  Endpoint,
  type Json,
  json,
  type RequestSpec,
  type ResponseSpec,
  TypedRouter,
} from '@di-framework/http';
import { LoggerService } from '@di-framework/services-example/LoggerService';

const router = TypedRouter();

type EchoPayload = { message: string };
type EchoResponse = { echoed: string; timestamp: string };

@Controller()
export class EchoController {
  // Because @Controller composes the core @Container decorator, this class is
  // automatically registered with the DI container. We can inject services.
  @Component(LoggerService)
  private logger!: LoggerService;

  echoMessage(message: string): EchoResponse {
    this.logger.log(`Echoing: ${message}`);
    return { echoed: message, timestamp: new Date().toISOString() };
  }

  @Endpoint({
    summary: 'Echo a message',
    description: 'Returns the provided message with a server timestamp.',
    responses: {
      '200': { description: 'Successful echo' },
    },
  })
  static post = router.post<RequestSpec<Json<EchoPayload>>, ResponseSpec<EchoResponse>>(
    '/echo',
    (req) => {
      // Demonstrate auto DI registration: resolve the controller instance from
      // the global container without any manual registration.
      const controller = useContainer().resolve(EchoController);
      return json(controller.echoMessage(req.content.message));
    },
  );
}

router.get('/', () => json({ message: 'API is healthy' }));

export default {
  fetch: (request: Request, env: any, ctx: any) => router.fetch(request, env, ctx),
};
export { router };

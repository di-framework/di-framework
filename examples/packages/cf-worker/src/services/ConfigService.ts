import { Component, Container } from '@di-framework/core/decorators';

type Env = unknown | any;

@Container()
export class ConfigService {
  constructor(@Component('APP_NAME') private readonly appName: string) {}

  info(env: Env) {
    return {
      appName: this.appName,
      hasDurableObject: Boolean(env?.MY_DURABLE_OBJECT),
      compatibilityDate: env?.__STATIC_CONTENT_MANIFEST ? undefined : undefined,
    };
  }
}

import { Component, Container } from '@di-framework/core/decorators';

@Container()
export class ConfigService {
  constructor(@Component('APP_NAME') private readonly appName: string) {}

  info(env: any) {
    return {
      appName: this.appName,
      hasDurableObject: Boolean((env as any)?.MY_DURABLE_OBJECT),
      compatibilityDate: (env as any)?.__STATIC_CONTENT_MANIFEST ? undefined : undefined,
    };
  }
}

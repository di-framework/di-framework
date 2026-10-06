@Configuration()
export class AppConfiguration {
  @Bean()
  port() {
    return 8080;
  }

  @Bean()
  serverUrl(port: number) {
    return `http://localhost:${port}`;
  }
}

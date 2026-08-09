import { useContainer } from '@di-framework/core/container';
import { Component, Container } from '@di-framework/core/decorators';

// Top-level function declarations get runtime checks from @di-framework/tsc on emit.
// Class methods are not transformed yet (MVP limitation).
function greet(name: string): string {
  return `Hello, ${name}!`;
}

@Container()
class Greeter {
  hello(name: string) {
    return greet(name);
  }
}

@Container()
class App {
  constructor(@Component(Greeter) private greeter: Greeter) {}

  run() {
    console.log(this.greeter.hello('di-framework'));
  }
}

const app = useContainer().resolve(App);
app.run();

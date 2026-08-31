import { useContainer } from '@di-framework/core/container';
import { Component, Container } from '@di-framework/core/decorators';

@Container()
class Greeter {
  hello(name: string) {
    return `Hello, ${name}!`;
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
